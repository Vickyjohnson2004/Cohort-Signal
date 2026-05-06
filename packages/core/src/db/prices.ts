import type { Pool } from "pg";

export interface DailyPrice {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
}

/**
 * Same row shape, but using the database column naming convention used by
 * the rebuild pipeline. Aliased separately so the rebuild code reads
 * naturally.
 */
export interface BtcPriceDailyRow {
  priceDate: string;
  closeUsd: number;
}

export async function getDailyPriceRange(
  pool: Pool,
  from: string,
  to: string,
): Promise<BtcPriceDailyRow[]> {
  const r = await pool.query(
    `SELECT price_date, close_usd::float8 AS close_usd
     FROM btc_price_daily
     WHERE price_date BETWEEN $1 AND $2
     ORDER BY price_date ASC`,
    [from, to],
  );
  return r.rows.map((row) => ({
    priceDate:
      row.price_date instanceof Date
        ? row.price_date.toISOString().slice(0, 10)
        : String(row.price_date).slice(0, 10),
    closeUsd: Number(row.close_usd),
  }));
}

export async function upsertDailyPrice(pool: Pool, p: DailyPrice): Promise<void> {
  await pool.query(
    `INSERT INTO btc_price_daily (price_date, open_usd, high_usd, low_usd, close_usd, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (price_date) DO UPDATE SET
       open_usd = EXCLUDED.open_usd,
       high_usd = EXCLUDED.high_usd,
       low_usd = EXCLUDED.low_usd,
       close_usd = EXCLUDED.close_usd,
       source = EXCLUDED.source,
       fetched_at = now()`,
    [p.date, p.open, p.high, p.low, p.close, p.source],
  );
}

/**
 * Bulk-upsert many daily prices in chunks, dramatically faster than the
 * per-row helper for backfills.
 */
export async function bulkUpsertDailyPrices(pool: Pool, rows: DailyPrice[]): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const r of slice) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(r.date, r.open, r.high, r.low, r.close, r.source);
    }
    await pool.query(
      `INSERT INTO btc_price_daily (price_date, open_usd, high_usd, low_usd, close_usd, source)
       VALUES ${placeholders.join(", ")}
       ON CONFLICT (price_date) DO UPDATE SET
         open_usd  = EXCLUDED.open_usd,
         high_usd  = EXCLUDED.high_usd,
         low_usd   = EXCLUDED.low_usd,
         close_usd = EXCLUDED.close_usd,
         source    = EXCLUDED.source,
         fetched_at = now()`,
      params,
    );
  }
}

export async function getDailyPrice(pool: Pool, date: string): Promise<DailyPrice | null> {
  const res = await pool.query(
    `SELECT price_date, open_usd, high_usd, low_usd, close_usd, source
     FROM btc_price_daily WHERE price_date = $1`,
    [date],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  return {
    date: row.price_date instanceof Date ? row.price_date.toISOString().slice(0, 10) : String(row.price_date).slice(0, 10),
    open: Number(row.open_usd),
    high: Number(row.high_usd),
    low: Number(row.low_usd),
    close: Number(row.close_usd),
    source: String(row.source),
  };
}
