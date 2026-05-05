/**
 * Historical bootstrap from Blockchair dumps.
 *
 * For each UTC day from startDate (default 2018-01-01) to endDate
 * (default yesterday):
 *   1) Fetch+stream the blocks dump for that day, populate block-id ->
 *      block-date in the aggregator. Track the last block id of the day.
 *   2) Fetch+stream the outputs dump, ingest every spendable output.
 *   3) Fetch+stream the inputs dump, ingest every spend (subtracts from
 *      survivedSat and feeds the LTH-SOPR bucket).
 *   4) Build the cohort_snapshot for that day and UPSERT into Postgres.
 *   5) Drop the day's SOPR bucket and continue.
 *
 * The aggregator state persists across days. After processing day N, the
 * survivedSat map reflects "all UTXOs created on or before day N that are
 * unspent as of end-of-day N". Compute the snapshot by walking the map
 * and binning each blockId by age.
 *
 * Resumability: at startup we read indexer_state. If bootstrap_completed_at
 * is set, refuse to re-run unless --force. If last_block_processed_at is
 * set but bootstrap is incomplete, we read the latest cohort_snapshots row
 * and resume from the day after.
 */

import {
  CohortAggregator,
  type BlockMeta,
} from "./aggregator.js";
import {
  blocksHeader,
  inputsHeader,
  iterateDateRange,
  outputsHeader,
  readBlock,
  readInput,
  readOutput,
  streamDump,
  type InputData,
  type OutputData,
} from "./blockchair.js";
import { upsertSnapshot, getLatestSnapshot, setIndexerState, getPoolAsync } from "@cohortsignal/core/db";
import {
  CORE_VERSION,
  DEFAULT_COHORT_BOUNDARY_DAYS,
  type CohortSnapshot,
} from "@cohortsignal/core";

export interface BootstrapOptions {
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string;   // YYYY-MM-DD inclusive
  cohortBoundaryDays?: number;
  /** When true, skip days that already have snapshots (resume from stop point). */
  resume?: boolean;
  /** Optional callback invoked after each persisted day. Useful for progress UIs. */
  onProgress?: (info: BootstrapProgressInfo) => void;
}

export interface BootstrapProgressInfo {
  date: string;
  blockHeight: number;
  trackedBlocks: number;
  totalUnspentBtc: number;
  lthSupplyBtc: number;
  sthSupplyBtc: number;
  lthSopr: number | null;
  elapsedMs: number;
  daysRemaining: number;
}

const INDEXER_VERSION = `cohortsignal-indexer-${CORE_VERSION}`;

export async function runBootstrap(opts: BootstrapOptions): Promise<void> {
  const cohortBoundaryDays = opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;
  const pool = await getPoolAsync();
  const aggregator = new CohortAggregator({ cohortBoundaryDays });

  // Resume support: if there is already a latest snapshot for our boundary,
  // skip ahead. NOTE: we cannot rebuild the in-memory survivedSat from a
  // snapshot row alone, so resuming truly mid-bootstrap requires re-running
  // from startDate. We expose --resume mostly to skip re-writing identical
  // rows for the early years; for full correctness, full-from-scratch is
  // what we recommend on a clean DB.
  const latestExisting = await getLatestSnapshot(pool, cohortBoundaryDays, true);
  let prevLthBtc = 0;
  let cursor = opts.startDate;
  if (opts.resume && latestExisting && latestExisting.date >= opts.startDate) {
    console.warn(
      `[bootstrap] resume requested; latest existing snapshot is ${latestExisting.date}. ` +
        `WARNING: resume cannot rebuild in-memory UTXO state, so cohort sums may diverge from a from-scratch run. Use --force-restart for full correctness.`,
    );
    cursor = nextDate(latestExisting.date);
    prevLthBtc = latestExisting.lthSupplyBtc;
  }

  await setIndexerState(pool, {
    methodologyVersion: "cohortsignal-v1.0",
    indexerVersion: INDEXER_VERSION,
    bootstrapSource: "blockchair-dumps",
    notes: `bootstrap ${opts.startDate}..${opts.endDate} cohortBoundary=${cohortBoundaryDays}`,
  });

  const totalDays = countDays(cursor, opts.endDate);
  let processed = 0;
  const bootStart = Date.now();

  for (const date of iterateDateRange(cursor, opts.endDate)) {
    const dayStart = Date.now();

    let lastBlockHeightOfDay = aggregator.maxObservedBlockId();

    // 1) blocks
    let blockRows = 0;
    const tBlocks = Date.now();
    await streamDump(
      "blocks",
      date,
      blocksHeader,
      (parser, fields) => {
        const meta = readBlock(parser, fields);
        if (!meta) return;
        const blockMeta: BlockMeta = { height: meta.height, date: meta.date };
        aggregator.ingestBlock(blockMeta);
        if (meta.height > lastBlockHeightOfDay) lastBlockHeightOfDay = meta.height;
        blockRows++;
      },
      { okOn404: true },
    );
    console.log(`[bootstrap] ${date} blocks: ${blockRows} rows in ${Date.now() - tBlocks}ms`);

    // 2) outputs — reuse a single output buffer across rows.
    let outputRows = 0;
    const tOutputs = Date.now();
    const outBuf: OutputData = {
      blockId: 0,
      valueSat: 0,
      valueUsdAtCreation: 0,
      isSpendable: false,
    };
    await streamDump(
      "outputs",
      date,
      outputsHeader,
      (parser, fields) => {
        if (!readOutput(parser, fields, outBuf)) return;
        aggregator.ingestOutputCreated(outBuf);
        outputRows++;
        if (outputRows % 500_000 === 0) {
          console.log(`[bootstrap] ${date} outputs progress: ${outputRows} rows`);
        }
      },
      { okOn404: true },
    );
    console.log(`[bootstrap] ${date} outputs: ${outputRows} rows in ${Date.now() - tOutputs}ms`);

    // 3) inputs (spends)
    let inputRows = 0;
    const tInputs = Date.now();
    const inBuf: InputData = {
      creationBlockId: 0,
      spendBlockId: 0,
      spendDate: "",
      valueSat: 0,
      valueUsdAtCreation: 0,
      valueUsdAtSpend: 0,
      lifespanSeconds: 0,
    };
    await streamDump(
      "inputs",
      date,
      inputsHeader,
      (parser, fields) => {
        if (!readInput(parser, fields, inBuf)) return;
        aggregator.ingestInputSpent(
          {
            creationBlockId: inBuf.creationBlockId,
            spendBlockId: inBuf.spendBlockId,
            valueSat: inBuf.valueSat,
            valueUsdAtCreation: inBuf.valueUsdAtCreation,
            valueUsdAtSpend: inBuf.valueUsdAtSpend,
            lifespanSeconds: inBuf.lifespanSeconds,
          },
          inBuf.spendDate,
        );
        inputRows++;
        if (inputRows % 500_000 === 0) {
          console.log(`[bootstrap] ${date} inputs progress: ${inputRows} rows`);
        }
      },
      { okOn404: true },
    );
    console.log(`[bootstrap] ${date} inputs: ${inputRows} rows in ${Date.now() - tInputs}ms`);

    if (lastBlockHeightOfDay <= 0) {
      // No blocks for this date; skip snapshot creation but advance cursor.
      console.warn(`[bootstrap] no blocks for ${date}, skipping snapshot`);
      continue;
    }

    const snap: CohortSnapshot = aggregator.buildSnapshot({
      snapshotDate: date,
      snapshotBlockId: lastBlockHeightOfDay,
      prevLthBtc,
      provisional: false,
    });
    prevLthBtc = snap.lthSupplyBtc;

    await upsertSnapshot(pool, snap);
    aggregator.forgetSoprFor(date);

    await setIndexerState(pool, {
      lastBlockProcessed: lastBlockHeightOfDay,
      lastBlockProcessedAt: new Date().toISOString(),
    });

    processed += 1;
    const info: BootstrapProgressInfo = {
      date: snap.date,
      blockHeight: snap.blockHeight,
      trackedBlocks: aggregator.trackedBlockCount(),
      totalUnspentBtc: aggregator.totalUnspentSat() / 100_000_000,
      lthSupplyBtc: snap.lthSupplyBtc,
      sthSupplyBtc: snap.sthSupplyBtc,
      lthSopr: snap.lthSopr,
      elapsedMs: Date.now() - dayStart,
      daysRemaining: Math.max(0, totalDays - processed),
    };
    opts.onProgress?.(info);
  }

  await setIndexerState(pool, {
    bootstrapCompletedAt: new Date().toISOString(),
    notes: `bootstrap finished in ${Math.floor((Date.now() - bootStart) / 1000)}s`,
  });
}

function nextDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function countDays(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((b - a) / 86_400_000) + 1);
}
