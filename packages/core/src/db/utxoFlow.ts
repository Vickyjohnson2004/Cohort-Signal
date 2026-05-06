/**
 * Data access for the UTXO age-flow tables.
 *
 * Two tables:
 *
 *   utxo_daily_creations         (creation_date PK, total_btc, source, fetched_at)
 *   utxo_daily_spends_by_creation(spend_date, creation_date PK pair, total_btc, ...)
 *
 * Together they let us deterministically reconstruct cohort_snapshots for
 * any UTC day in range. See docs/methodology.md for the math.
 */

import type { Pool, PoolClient } from "pg";

export interface DailyCreationRow {
  creationDate: string;
  totalBtc: number;
  source: string;
}

export interface SpendRow {
  spendDate: string;
  creationDate: string;
  totalBtc: number;
  source: string;
}

/**
 * Bulk-upsert daily creations. Uses a single multi-row INSERT for speed.
 * Pass at most ~1000 rows per call to keep the parameter count under
 * Postgres' 32k-parameter ceiling.
 */
export async function bulkUpsertCreations(
  pool: Pool | PoolClient,
  rows: DailyCreationRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push(`($${p++}, $${p++}, $${p++})`);
    params.push(r.creationDate, r.totalBtc, r.source);
  }
  const sql = `
    INSERT INTO utxo_daily_creations (creation_date, total_btc, source)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (creation_date) DO UPDATE SET
      total_btc  = EXCLUDED.total_btc,
      source     = EXCLUDED.source,
      fetched_at = now()
  `;
  await pool.query(sql, params);
}

/**
 * Bulk-upsert spend rollups. Same chunking caveat as creations.
 */
export async function bulkUpsertSpends(
  pool: Pool | PoolClient,
  rows: SpendRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const placeholders: string[] = [];
  let p = 1;
  for (const r of rows) {
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(r.spendDate, r.creationDate, r.totalBtc, r.source);
  }
  const sql = `
    INSERT INTO utxo_daily_spends_by_creation
      (spend_date, creation_date, total_btc, source)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (spend_date, creation_date) DO UPDATE SET
      total_btc  = EXCLUDED.total_btc,
      source     = EXCLUDED.source,
      fetched_at = now()
  `;
  await pool.query(sql, params);
}

/**
 * Stream all creations in [from, to] in ascending date order. Loads
 * everything into memory; for our use case (~3000 rows max) that's fine.
 */
export async function getCreationsRange(
  pool: Pool,
  from: string,
  to: string,
): Promise<DailyCreationRow[]> {
  const r = await pool.query(
    `SELECT creation_date, total_btc::float8 AS total_btc, source
     FROM utxo_daily_creations
     WHERE creation_date BETWEEN $1 AND $2
     ORDER BY creation_date ASC`,
    [from, to],
  );
  return r.rows.map((row) => ({
    creationDate: toIsoDate(row.creation_date),
    totalBtc: Number(row.total_btc),
    source: String(row.source),
  }));
}

/**
 * Stream all spends with spend_date in [from, to] in ascending spend_date,
 * creation_date order via a server-side cursor.
 *
 * For a multi-year rebuild this can be ~6.79M rows. The callback variant
 * is preserved for backwards compatibility, but new callers should prefer
 * `iterateSpendsRange` which is an async generator and avoids the
 * promise-bridging overhead a callback-driven path imposes on consumers.
 */
export async function streamSpendsRange(
  pool: Pool,
  from: string,
  to: string,
  onRow: (row: SpendRow) => void,
  batchSize = 50_000,
): Promise<number> {
  let total = 0;
  for await (const row of iterateSpendsRange(pool, from, to, batchSize)) {
    onRow(row);
    total++;
  }
  return total;
}

/**
 * Async-iterator variant of streamSpendsRange. Yields each SpendRow in
 * ascending (spend_date, creation_date) order. Internally uses a Postgres
 * server-side cursor with batched FETCH so peak memory stays at O(batchSize)
 * rows.
 */
export async function* iterateSpendsRange(
  pool: Pool,
  from: string,
  to: string,
  batchSize = 50_000,
): AsyncGenerator<SpendRow, void, void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DECLARE c_spends CURSOR FOR
         SELECT spend_date, creation_date, total_btc::float8 AS total_btc, source
         FROM utxo_daily_spends_by_creation
         WHERE spend_date BETWEEN $1 AND $2
         ORDER BY spend_date ASC, creation_date ASC`,
      [from, to],
    );
    while (true) {
      const r = await client.query(`FETCH ${batchSize} FROM c_spends`);
      if (r.rowCount === 0) break;
      for (const row of r.rows) {
        yield {
          spendDate: toIsoDate(row.spend_date),
          creationDate: toIsoDate(row.creation_date),
          totalBtc: Number(row.total_btc),
          source: String(row.source),
        };
      }
      if ((r.rowCount ?? 0) < batchSize) break;
    }
    await client.query("CLOSE c_spends");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function getCreationsCount(pool: Pool): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM utxo_daily_creations`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function getSpendsCount(pool: Pool): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::bigint AS n FROM utxo_daily_spends_by_creation`);
  return Number(r.rows[0]?.n ?? 0);
}

export async function getCreationsDateBounds(
  pool: Pool,
): Promise<{ min: string; max: string } | null> {
  const r = await pool.query(
    `SELECT MIN(creation_date) AS min, MAX(creation_date) AS max FROM utxo_daily_creations`,
  );
  if (!r.rows[0] || !r.rows[0].min) return null;
  return { min: toIsoDate(r.rows[0].min), max: toIsoDate(r.rows[0].max) };
}

export async function getSpendsDateBounds(
  pool: Pool,
): Promise<{ min: string; max: string } | null> {
  const r = await pool.query(
    `SELECT MIN(spend_date) AS min, MAX(spend_date) AS max FROM utxo_daily_spends_by_creation`,
  );
  if (!r.rows[0] || !r.rows[0].min) return null;
  return { min: toIsoDate(r.rows[0].min), max: toIsoDate(r.rows[0].max) };
}

export interface BootstrapRunMeta {
  jobKind: "bigquery-creations" | "bigquery-spends" | "rpc-day";
  rangeStart?: string;
  rangeEnd?: string;
  rowsWritten?: number;
  bytesBilled?: number;
  notes?: string;
}

export async function startBootstrapRun(
  pool: Pool,
  meta: BootstrapRunMeta,
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO bootstrap_runs (job_kind, range_start, range_end, notes)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [meta.jobKind, meta.rangeStart ?? null, meta.rangeEnd ?? null, meta.notes ?? null],
  );
  return Number(r.rows[0].id);
}

export async function finishBootstrapRun(
  pool: Pool,
  id: number,
  result: { success: boolean; rowsWritten?: number; bytesBilled?: number; error?: string; notes?: string },
): Promise<void> {
  await pool.query(
    `UPDATE bootstrap_runs SET
       finished_at  = now(),
       success      = $2,
       rows_written = COALESCE($3, rows_written),
       bytes_billed = COALESCE($4, bytes_billed),
       error        = COALESCE($5, error),
       notes        = COALESCE($6, notes)
     WHERE id = $1`,
    [id, result.success, result.rowsWritten ?? null, result.bytesBilled ?? null, result.error ?? null, result.notes ?? null],
  );
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  throw new Error(`toIsoDate: unexpected ${typeof value} ${String(value)}`);
}
