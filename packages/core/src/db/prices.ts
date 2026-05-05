import type { Pool } from "pg";

export interface DailyPrice {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
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
