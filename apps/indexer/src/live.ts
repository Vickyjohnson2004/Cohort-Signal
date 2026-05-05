/**
 * Live-edge indexer.
 *
 * Strategy:
 *   1) Every INDEXER_POLL_INTERVAL_MS (default 5 min):
 *      a) Find current chain-tip height via Esplora (no auth).
 *      b) If yesterday's Blockchair dump is now available and we don't have
 *         yesterday's final snapshot, run a one-day bootstrap pass. This
 *         advances our final (non-provisional) frontier by 1 day.
 *      c) Compute a provisional "today" snapshot:
 *         - Start from yesterday's final snapshot (LTH/STH supply, HODL waves).
 *         - Add today's coinbase issuance to STH (under_1m band).
 *         - Resolve LTH-SOPR for today's blocks by streaming Esplora for new
 *           blocks since last_block_processed and aggregating spends with
 *           prevout age >= cohortBoundaryDays.
 *         - Mark snapshot as provisional=true, blockHeight = chain tip.
 *
 * The provisional path NEVER mutates the long-running CohortAggregator
 * state — we materialize a one-shot derived snapshot for "today" each
 * cycle and overwrite it in Postgres. This means:
 *   - We never drift out of the deterministic from-Blockchair state.
 *   - The provisional flag is honest: yesterday is final; today is the
 *     best estimate from RPC + yesterday's authoritative state.
 */

import {
  CORE_VERSION,
  DEFAULT_COHORT_BOUNDARY_DAYS,
  HODL_AGE_BANDS,
  type CohortSnapshot,
  type HodlAgeBand,
  type HodlWavesDistribution,
  METHODOLOGY_VERSION,
} from "@cohortsignal/core";
import { circulatingSupplyBtcAt } from "@cohortsignal/core/util";
import {
  getLatestSnapshot,
  getPoolAsync,
  setIndexerState,
  upsertSnapshot,
} from "@cohortsignal/core/db";
import { EsploraClient } from "@cohortsignal/core/rpc";
import { runBootstrap } from "./bootstrap.js";

const INDEXER_VERSION = `cohortsignal-indexer-${CORE_VERSION}`;
const SAT_PER_BTC = 100_000_000;

interface LiveOptions {
  cohortBoundaryDays?: number;
  pollIntervalMs?: number;
  finalityConfirmations?: number;
}

export async function runLiveLoop(opts: LiveOptions = {}): Promise<void> {
  const cohortBoundaryDays = opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;
  const pollMs = opts.pollIntervalMs ?? Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 300_000);
  const esplora = new EsploraClient(process.env.ESPLORA_API_URL);
  const pool = await getPoolAsync();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tickOnce({ pool, esplora, cohortBoundaryDays });
    } catch (err) {
      console.error("[live] tick error", err);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function tickOnce(args: {
  pool: Awaited<ReturnType<typeof getPoolAsync>>;
  esplora: EsploraClient;
  cohortBoundaryDays: number;
}): Promise<void> {
  const { pool, esplora, cohortBoundaryDays } = args;

  const tipHeight = await esplora.getTipHeight().catch(() => null);
  if (!tipHeight) {
    console.warn("[live] could not fetch chain tip height; skipping");
    return;
  }

  const latest = await getLatestSnapshot(pool, cohortBoundaryDays, false);
  const todayUtc = new Date().toISOString().slice(0, 10);
  const yesterdayUtc = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // Step 1: Advance final frontier by 1 day if yesterday's dump is now available.
  if (!latest || latest.date < yesterdayUtc) {
    const fromDate = latest ? nextDateOf(latest.date) : "2018-01-01";
    if (fromDate <= yesterdayUtc) {
      console.log(`[live] advancing final frontier ${fromDate} -> ${yesterdayUtc}`);
      try {
        await runBootstrap({
          startDate: fromDate,
          endDate: yesterdayUtc,
          cohortBoundaryDays,
        });
      } catch (err) {
        console.warn("[live] frontier advance failed (dumps may not be published yet):", (err as Error).message);
      }
    }
  }

  // Step 2: Build provisional today snapshot from latest non-provisional.
  const base = await getLatestSnapshot(pool, cohortBoundaryDays, false);
  if (!base) {
    console.warn("[live] no final snapshot yet; provisional snapshot skipped");
    await setIndexerState(pool, {
      lastBlockProcessed: 0,
      lastBlockProcessedAt: new Date().toISOString(),
      chainTipHeight: tipHeight,
      chainTipSeenAt: new Date().toISOString(),
      methodologyVersion: METHODOLOGY_VERSION,
      indexerVersion: INDEXER_VERSION,
    });
    return;
  }

  const provisional = projectForwardToToday({
    base,
    cohortBoundaryDays,
    todayDate: todayUtc,
    chainTipHeight: tipHeight,
  });

  await upsertSnapshot(pool, provisional);
  await setIndexerState(pool, {
    lastBlockProcessed: tipHeight,
    lastBlockProcessedAt: new Date().toISOString(),
    chainTipHeight: tipHeight,
    chainTipSeenAt: new Date().toISOString(),
    methodologyVersion: METHODOLOGY_VERSION,
    indexerVersion: INDEXER_VERSION,
  });
  console.log(
    `[live] provisional snapshot for ${provisional.date} at block ${provisional.blockHeight} written (LTH ${provisional.lthSupplyBtc.toFixed(0)} BTC).`,
  );
}

/**
 * Project the previous final snapshot forward by adding today's coinbase
 * issuance to the STH bucket. Marks the result as provisional.
 *
 * The math:
 *   - Δ blocks = chainTipHeight - base.blockHeight
 *   - Δ supply (BTC) = circulatingSupplyBtcAt(chainTipHeight) - circulatingSupplyBtcAt(base.blockHeight)
 *   - That supply is brand-new (UTXO age 0) -> goes into STH and under_1m band.
 *   - LTH supply is unchanged in this projection (we don't know about
 *     today's LTH spends without a deeper RPC walk; the daily-dump pass
 *     in step 1 will reconcile this once yesterday's dump is published).
 *   - LTH-SOPR for today is left null in the provisional snapshot (we
 *     don't have enough resolved spends to compute it confidently here).
 */
function projectForwardToToday(args: {
  base: CohortSnapshot;
  cohortBoundaryDays: number;
  todayDate: string;
  chainTipHeight: number;
}): CohortSnapshot {
  const { base, cohortBoundaryDays, todayDate, chainTipHeight } = args;
  const newIssuanceBtc = Math.max(
    0,
    circulatingSupplyBtcAt(chainTipHeight) - circulatingSupplyBtcAt(base.blockHeight),
  );

  const sthSupplyBtc = base.sthSupplyBtc + newIssuanceBtc;
  const lthSupplyBtc = base.lthSupplyBtc;
  const circulatingSupplyBtc = base.circulatingSupplyBtc + newIssuanceBtc;
  const denom = circulatingSupplyBtc > 0 ? circulatingSupplyBtc : 1;

  const btcByBand = {} as Record<HodlAgeBand, number>;
  for (const band of HODL_AGE_BANDS) btcByBand[band] = base.hodlWaves.btc[band] ?? 0;
  btcByBand.under_1m += newIssuanceBtc;

  const pctByBand = {} as Record<HodlAgeBand, number>;
  let total = 0;
  for (const band of HODL_AGE_BANDS) total += btcByBand[band];
  for (const band of HODL_AGE_BANDS) pctByBand[band] = total > 0 ? btcByBand[band] / total : 0;
  const hodlWaves: HodlWavesDistribution = { btc: btcByBand, pctOfSupply: pctByBand };

  return {
    date: todayDate,
    blockHeight: chainTipHeight,
    cohortBoundaryDays,
    lthSupplyBtc,
    sthSupplyBtc,
    circulatingSupplyBtc,
    lthSupplyPctOfCirculating: lthSupplyBtc / denom,
    sthSupplyPctOfCirculating: sthSupplyBtc / denom,
    hodlWaves,
    lthSopr: null,
    lthNetPositionChangeBtc1d: lthSupplyBtc - base.lthSupplyBtc,
    provisional: true,
    methodologyVersion: METHODOLOGY_VERSION,
    computedAt: new Date().toISOString(),
  };
}

function nextDateOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export { projectForwardToToday };
