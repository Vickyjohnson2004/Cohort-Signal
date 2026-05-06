/**
 * Live-edge indexer.
 *
 * Strategy:
 *   - The historical (final) frontier is advanced by the BigQuery bootstrap
 *     + rebuild pipeline (one-shot: ~613 GB scan, ~30 min run). After that
 *     pipeline, cohort_snapshots covers every UTC day in [2018-01-01,
 *     yesterday] with provisional=false.
 *
 *   - This live loop advances the *provisional* "today" snapshot by:
 *       a) Reading yesterday's final snapshot (the authoritative LTH/STH
 *          supply and HODL waves).
 *       b) Computing today's coinbase issuance from chain-tip height vs
 *          yesterday's snapshot height. New issuance is under_1m STH.
 *       c) Marking the snapshot as provisional=true and writing it.
 *
 *   - LTH-SOPR for today is left null in the provisional snapshot. Once the
 *     next BigQuery refresh (or RPC refresh) lands "today" as a final day,
 *     LTH-SOPR is computed deterministically from the rebuild engine.
 *
 * The provisional snapshot NEVER mutates the deterministic historical
 * state. So if BigQuery + the rebuild engine are correct on the historical
 * range, today's provisional snapshot can drift by at most ~1 day's worth
 * of LTH/STH movement, which is vanishingly small relative to the 14M+
 * BTC LTH cohort.
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

const INDEXER_VERSION = `cohortsignal-indexer-${CORE_VERSION}`;

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

  const todayUtc = new Date().toISOString().slice(0, 10);
  void todayUtc;

  // Build provisional today snapshot from latest non-provisional. The
  // historical frontier is advanced separately by the BigQuery + rebuild
  // pipeline, run on a daily cron (or manually).
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

  const todayDate = new Date().toISOString().slice(0, 10);
  const provisional = projectForwardToToday({
    base,
    cohortBoundaryDays,
    todayDate,
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

export { projectForwardToToday };
