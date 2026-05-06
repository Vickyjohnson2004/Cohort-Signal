/**
 * BigQuery extractors that materialise the UTXO age-flow tables.
 *
 * There are two queries:
 *
 *   1) Daily creations: total BTC created (sum of spendable outputs) per
 *      UTC date. Cost: ~126 GB scan over 2018-01-01 → today.
 *
 *   2) Daily spends grouped by creation date: for every spend, find the
 *      creation date of the spent output, and roll up by (spend_date,
 *      creation_date). Cost: ~487 GB over 2018-01-01 → today.
 *
 * BigQuery free tier is 1 TB/month; one full historical run is ~613 GB,
 * comfortably within budget. Subsequent live updates do NOT use BigQuery
 * — they use the Bitcoin RPC live-edge path so we can update daily
 * forever without burning more BigQuery quota.
 *
 * We stream both queries with backpressure: each batch of ~5000 rows is
 * flushed to Postgres before the next page is fetched. Peak memory stays
 * under ~50 MB even for the 6.79M-row spends stream.
 */

import {
  BigQueryClient,
  bulkUpsertCreations,
  bulkUpsertSpends,
  finishBootstrapRun,
  getPoolAsync,
  startBootstrapRun,
  type DailyCreationRow,
  type SpendRow,
} from "@cohortsignal/core";
import type { JWTInput } from "google-auth-library";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INDEXER_DIR = fileURLToPath(new URL(".", import.meta.url));
/** Monorepo root (apps/indexer/src → ../../../). */
const REPO_ROOT = resolve(INDEXER_DIR, "../../..");

const SOURCE_LABEL = "bigquery:crypto_bitcoin";

const SQL_DAILY_CREATIONS = `
  SELECT
    DATE(block_timestamp) AS creation_date,
    SAFE_DIVIDE(SUM(value), 100000000) AS total_btc
  FROM \`bigquery-public-data.crypto_bitcoin.outputs\`
  WHERE DATE(block_timestamp) >= @since
    AND DATE(block_timestamp) < @until
    AND type != 'nulldata'
  GROUP BY creation_date
  ORDER BY creation_date
`;

const SQL_SPENDS_BY_CREATION = `
  SELECT
    DATE(i.block_timestamp) AS spend_date,
    DATE(o.block_timestamp) AS creation_date,
    SAFE_DIVIDE(SUM(i.value), 100000000) AS total_btc
  FROM \`bigquery-public-data.crypto_bitcoin.inputs\` AS i
  JOIN \`bigquery-public-data.crypto_bitcoin.outputs\` AS o
    ON i.spent_transaction_hash = o.transaction_hash
   AND i.spent_output_index    = o.\`index\`
  WHERE DATE(i.block_timestamp) >= @since
    AND DATE(i.block_timestamp) < @until
    AND o.type != 'nulldata'
  GROUP BY spend_date, creation_date
  ORDER BY spend_date, creation_date
`;

const DATE_PARAMS = (fromDate: string, toDate: string) =>
  [
    { name: "since", parameterType: { type: "DATE" }, parameterValue: { value: fromDate } },
    { name: "until", parameterType: { type: "DATE" }, parameterValue: { value: toDate } },
  ] as const;

/** Long scans need long poll timeout (default client is 10 min). */
const BQ_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function createBigQueryClient(maxBytesBilled: number): BigQueryClient {
  const rawJson = process.env.GCP_SA_KEY_JSON?.trim();
  if (rawJson) {
    const credentials = JSON.parse(rawJson) as JWTInput;
    return new BigQueryClient({
      credentials,
      projectId: process.env.GCP_PROJECT_ID,
      defaultMaximumBytesBilled: maxBytesBilled,
      timeoutMs: BQ_TIMEOUT_MS,
    });
  }
  const keyEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!keyEnv) {
    throw new Error(
      "BigQuery auth missing: set GOOGLE_APPLICATION_CREDENTIALS (path to JSON) or GCP_SA_KEY_JSON (raw JSON).",
    );
  }
  const keyFilename = keyEnv.startsWith("/") ? keyEnv : resolve(REPO_ROOT, keyEnv);
  return new BigQueryClient({
    keyFilename,
    projectId: process.env.GCP_PROJECT_ID,
    defaultMaximumBytesBilled: maxBytesBilled,
    timeoutMs: BQ_TIMEOUT_MS,
  });
}

export interface BigQueryBootstrapOptions {
  /** Inclusive UTC start date, e.g. "2018-01-01". */
  fromDate: string;
  /** Exclusive UTC end date, e.g. "2026-05-05". */
  toDate: string;
  /** Cap bytes billed (per query). Default: 700 GB. */
  maxBytesBilled?: number;
  /**
   * If true, skip the (very expensive) spends query and only refresh
   * creations. Useful for sanity-checks or dry-runs.
   */
  creationsOnly?: boolean;
  /**
   * If true, skip the creations query and only run the spends query.
   * Useful when resuming a partially-completed bootstrap where creations
   * are already loaded but the spends extract was interrupted.
   */
  spendsOnly?: boolean;
  /** Optional progress callback. */
  onProgress?: (info: ProgressInfo) => void;
}

export interface ProgressInfo {
  phase: "creations" | "spends";
  rowsSeen: number;
  rowsWritten: number;
  pageBytes: number;
}

/**
 * Run both BigQuery extracts and persist into utxo_daily_creations and
 * utxo_daily_spends_by_creation. Idempotent on (creation_date) and
 * (spend_date, creation_date).
 */
export async function bigQueryBootstrap(opts: BigQueryBootstrapOptions): Promise<{
  creationsRows: number;
  spendsRows: number;
  bytesBilled: number;
}> {
  const pool = await getPoolAsync();
  const maxBytes = opts.maxBytesBilled ?? 700 * 1024 * 1024 * 1024;
  const bq = createBigQueryClient(maxBytes);

  const totals = { creationsRows: 0, spendsRows: 0, bytesBilled: 0 };

  if (opts.spendsOnly && opts.creationsOnly) {
    throw new Error("bigQueryBootstrap: cannot set both creationsOnly and spendsOnly");
  }

  if (opts.spendsOnly) {
    return runSpendsPhase(pool, bq, opts, totals);
  }

  // --- Phase 1: creations ---------------------------------------------------
  const runIdC = await startBootstrapRun(pool, {
    jobKind: "bigquery-creations",
    rangeStart: opts.fromDate,
    rangeEnd: opts.toDate,
    notes: SOURCE_LABEL,
  });
  try {
    const FLUSH = 500;
    let buffer: DailyCreationRow[] = [];
    let written = 0;
    const startC = Date.now();

    const rc = await bq.runQueryStream(
      {
        query: SQL_DAILY_CREATIONS,
        parameters: [...DATE_PARAMS(opts.fromDate, opts.toDate)],
        maxResults: 5000,
      },
      async (row) => {
        const creationDate = String(row.creation_date);
        const totalBtc = Number(row.total_btc);
        if (!creationDate || !Number.isFinite(totalBtc)) return;
        buffer.push({ creationDate, totalBtc, source: SOURCE_LABEL });
        if (buffer.length >= FLUSH) {
          await bulkUpsertCreations(pool, buffer);
          written += buffer.length;
          buffer = [];
        }
      },
    );
    if (buffer.length > 0) {
      await bulkUpsertCreations(pool, buffer);
      written += buffer.length;
    }
    totals.creationsRows = written;
    totals.bytesBilled += rc.totalBytesProcessed;

    await finishBootstrapRun(pool, runIdC, {
      success: true,
      rowsWritten: written,
      bytesBilled: rc.totalBytesProcessed,
      notes: `creations elapsed=${Math.floor((Date.now() - startC) / 1000)}s`,
    });
    opts.onProgress?.({ phase: "creations", rowsSeen: rc.totalRows, rowsWritten: written, pageBytes: rc.totalBytesProcessed });
  } catch (err) {
    await finishBootstrapRun(pool, runIdC, { success: false, error: (err as Error).message });
    throw err;
  }

  if (opts.creationsOnly) return totals;

  // --- Phase 2: spends ------------------------------------------------------
  return runSpendsPhase(pool, bq, opts, totals);
}

async function runSpendsPhase(
  pool: Awaited<ReturnType<typeof getPoolAsync>>,
  bq: BigQueryClient,
  opts: BigQueryBootstrapOptions,
  totals: { creationsRows: number; spendsRows: number; bytesBilled: number },
): Promise<{ creationsRows: number; spendsRows: number; bytesBilled: number }> {
  const runIdS = await startBootstrapRun(pool, {
    jobKind: "bigquery-spends",
    rangeStart: opts.fromDate,
    rangeEnd: opts.toDate,
    notes: SOURCE_LABEL,
  });
  try {
    let buffer: SpendRow[] = [];
    const FLUSH = 1000;
    let written = 0;
    let lastReport = Date.now();
    let rowsSeenLive = 0;
    const startS = Date.now();

    const rs = await bq.runQueryStream(
      {
        query: SQL_SPENDS_BY_CREATION,
        parameters: [...DATE_PARAMS(opts.fromDate, opts.toDate)],
        maxResults: 10000,
      },
      async (row) => {
        rowsSeenLive++;
        const spendDate = String(row.spend_date);
        const creationDate = String(row.creation_date);
        const totalBtc = Number(row.total_btc);
        if (!spendDate || !creationDate || !Number.isFinite(totalBtc)) return;
        buffer.push({ spendDate, creationDate, totalBtc, source: SOURCE_LABEL });
        if (buffer.length >= FLUSH) {
          await bulkUpsertSpends(pool, buffer);
          written += buffer.length;
          buffer = [];
        }
        const now = Date.now();
        if (now - lastReport > 5000) {
          opts.onProgress?.({ phase: "spends", rowsSeen: rowsSeenLive, rowsWritten: written, pageBytes: 0 });
          lastReport = now;
        }
      },
    );
    if (buffer.length > 0) {
      await bulkUpsertSpends(pool, buffer);
      written += buffer.length;
    }
    totals.spendsRows = written;
    totals.bytesBilled += rs.totalBytesProcessed;

    await finishBootstrapRun(pool, runIdS, {
      success: true,
      rowsWritten: written,
      bytesBilled: rs.totalBytesProcessed,
      notes: `spends elapsed=${Math.floor((Date.now() - startS) / 1000)}s`,
    });
    opts.onProgress?.({ phase: "spends", rowsSeen: rs.totalRows, rowsWritten: written, pageBytes: rs.totalBytesProcessed });
  } catch (err) {
    await finishBootstrapRun(pool, runIdS, { success: false, error: (err as Error).message });
    throw err;
  }
  return totals;
}
