/**
 * Read utxo_daily_creations + utxo_daily_spends_by_creation + btc_price_daily,
 * call the deterministic rebuild engine in @cohortsignal/core, and persist
 * the resulting CohortSnapshot rows + RegimeChangeEvent rows.
 *
 * This is the canonical "compute snapshots from flow tables" job. It is
 * idempotent and re-runnable: if you delete a window of cohort_snapshots
 * rows and re-run, you'll get byte-identical results back.
 *
 * Memory: <100 MB. Runtime: ~1-2 minutes for the full 2018→today rebuild.
 */

import {
  CORE_VERSION,
  DEFAULT_COHORT_BOUNDARY_DAYS,
  bulkUpsertSnapshots,
  finishBootstrapRun,
  getCreationsRange,
  getDailyPriceRange,
  getCreationsDateBounds,
  getSpendsDateBounds,
  getPoolAsync,
  iterateSpendsRange,
  rebuildSnapshotsStreaming,
  setIndexerState,
  startBootstrapRun,
  upsertSnapshot,
  type CohortSnapshot,
  type SnapshotExtras,
} from "@cohortsignal/core";

const INDEXER_VERSION = `cohortsignal-indexer-${CORE_VERSION}`;

export interface RebuildOptions {
  cohortBoundaryDays?: number;
  /** Inclusive UTC start date. Defaults to earliest creation date in DB. */
  fromDate?: string;
  /** Inclusive UTC end date. Defaults to latest spend date in DB or today. */
  toDate?: string;
  onProgress?: (info: { date: string; lthBtc: number; sthBtc: number; daysWritten: number }) => void;
}

export async function rebuildAllSnapshots(opts: RebuildOptions = {}): Promise<{
  daysWritten: number;
  regimeChanges: number;
}> {
  const cohortBoundaryDays = opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;
  const pool = await getPoolAsync();

  const cBounds = await getCreationsDateBounds(pool);
  const sBounds = await getSpendsDateBounds(pool);
  if (!cBounds) {
    throw new Error("rebuildAllSnapshots: utxo_daily_creations is empty. Run the BigQuery bootstrap first.");
  }

  const fromDate = opts.fromDate ?? cBounds.min;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const toDate = opts.toDate ?? maxDate(sBounds?.max ?? cBounds.max, todayUtc);

  console.log(
    `[rebuild] cohort=${cohortBoundaryDays} range=${fromDate}..${toDate} ` +
      `creations=${cBounds.min}..${cBounds.max} spends=${sBounds?.min ?? "—"}..${sBounds?.max ?? "—"}`,
  );

  // Safety guard: a partial rebuild is fundamentally incorrect with the
  // current engine. rebuildSnapshotsStreaming starts its UTXO age tracking
  // from inputs.creations[0].creationDate, so passing only the trailing N
  // days of creations causes every emitted snapshot to think the chain
  // has zero history and report LTH=0. The 2026-05-09 cron run hit this
  // and corrupted 61 days of cohort_snapshots. Refuse to proceed unless
  // the rebuild starts from the earliest creation we have on file. To
  // re-emit only a trailing window, the engine itself needs an explicit
  // "skip emit until cursor >= fromDate" gate (currently it always emits
  // from inputs.creations[0].creationDate forward).
  if (fromDate > cBounds.min) {
    throw new Error(
      `rebuildAllSnapshots: refusing partial rebuild. fromDate=${fromDate} is later than the earliest ` +
        `creation on file (${cBounds.min}). The deterministic engine starts UTXO age tracking from the ` +
        `earliest creation in its input, so a partial rebuild would emit LTH=0 across the window. Either ` +
        `omit --from to do a full rebuild, or extend the engine with an explicit emit-from gate.`,
    );
  }

  const runId = await startBootstrapRun(pool, {
    jobKind: "rpc-day", // reuse channel; rebuild is conceptually a same-data replay
    rangeStart: fromDate,
    rangeEnd: toDate,
    notes: `rebuild cohort=${cohortBoundaryDays}`,
  });

  // Load the small datasets (creations + prices) fully; stream the big one
  // (spends) via cursor.
  const creations = await getCreationsRange(pool, fromDate, toDate);
  const prices = await getDailyPriceRange(pool, fromDate, toDate);

  const spendsStream = iterateSpendsRange(pool, fromDate, toDate, 50_000);

  let daysWritten = 0;
  let regimeChanges = 0;
  let lastRegime: string | undefined;
  const writeBuffer: Array<{ snap: CohortSnapshot; extras: SnapshotExtras }> = [];
  const FLUSH = 200;

  for await (const out of rebuildSnapshotsStreaming(
    { creations, spends: spendsStream, prices },
    { cohortBoundaryDays, endDate: toDate },
  )) {
    const ext = out.snapshot as CohortSnapshot & {
      lthNetPositionChangeBtc7d?: number;
      lthNetPositionChangeBtc30d?: number;
      lthNetPositionChangeBtc90d?: number;
      lthSopr30dMean?: number | null;
    };
    const extras: SnapshotExtras = {
      lthNetPositionChangeBtc7d:  ext.lthNetPositionChangeBtc7d  ?? null,
      lthNetPositionChangeBtc30d: ext.lthNetPositionChangeBtc30d ?? null,
      lthNetPositionChangeBtc90d: ext.lthNetPositionChangeBtc90d ?? null,
      lthSopr30dMean:             ext.lthSopr30dMean             ?? null,
      regime: out.regime,
    };
    writeBuffer.push({ snap: out.snapshot, extras });

    if (out.regime && out.regime !== lastRegime) {
      if (lastRegime !== undefined) {
        await pool.query(
          `INSERT INTO regime_change_events
             (event_date, block_height, cohort_boundary_days, from_regime, to_regime, methodology_version)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (event_date, cohort_boundary_days) DO UPDATE SET
             block_height = EXCLUDED.block_height,
             from_regime  = EXCLUDED.from_regime,
             to_regime    = EXCLUDED.to_regime,
             methodology_version = EXCLUDED.methodology_version,
             computed_at  = now()`,
          [
            out.snapshot.date,
            out.snapshot.blockHeight,
            cohortBoundaryDays,
            lastRegime,
            out.regime,
            out.snapshot.methodologyVersion,
          ],
        );
        regimeChanges++;
      }
      lastRegime = out.regime;
    }

    if (writeBuffer.length >= FLUSH) {
      await bulkUpsertSnapshots(pool, writeBuffer);
      daysWritten += writeBuffer.length;
      const last = writeBuffer[writeBuffer.length - 1];
      if (last) {
        opts.onProgress?.({
          date: last.snap.date,
          lthBtc: last.snap.lthSupplyBtc,
          sthBtc: last.snap.sthSupplyBtc,
          daysWritten,
        });
      }
      writeBuffer.length = 0;
    }
  }
  if (writeBuffer.length > 0) {
    await bulkUpsertSnapshots(pool, writeBuffer);
    daysWritten += writeBuffer.length;
    const last = writeBuffer[writeBuffer.length - 1];
    if (last) {
      opts.onProgress?.({
        date: last.snap.date,
        lthBtc: last.snap.lthSupplyBtc,
        sthBtc: last.snap.sthSupplyBtc,
        daysWritten,
      });
    }
  }

  await setIndexerState(pool, {
    methodologyVersion: "cohortsignal-v1.0",
    indexerVersion: INDEXER_VERSION,
    bootstrapSource: "bigquery+rebuild",
    notes: `rebuild ${fromDate}..${toDate} cohort=${cohortBoundaryDays}`,
  });
  await finishBootstrapRun(pool, runId, {
    success: true,
    rowsWritten: daysWritten,
    notes: `rebuild done; regime_changes=${regimeChanges}`,
  });

  // Avoid eslint unused variable warning for upsertSnapshot import; we use
  // bulkUpsertSnapshots which calls it under the hood.
  void upsertSnapshot;

  return { daysWritten, regimeChanges };
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}
