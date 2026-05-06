import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
for (const c of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(process.cwd(), "../../../.env"),
]) {
  if (existsSync(c)) { loadDotenv({ path: c, override: false }); break; }
}
const { getPoolAsync, closePool } = await import("@cohortsignal/core/db");
const pool = await getPoolAsync();
try {
  console.log("\n=== bootstrap_runs (most recent first) ===");
  const runs = await pool.query(`
    SELECT id, started_at, finished_at, job_kind, range_start, range_end,
           rows_written, bytes_billed, success, error, notes
    FROM bootstrap_runs
    ORDER BY id DESC
  `);
  console.table(runs.rows.map(r => ({
    id: r.id,
    kind: r.job_kind,
    range: `${r.range_start ?? "—"}..${r.range_end ?? "—"}`,
    rows: r.rows_written,
    bytes_GB: r.bytes_billed ? (Number(r.bytes_billed) / 1e9).toFixed(2) : null,
    success: r.success,
    notes: (r.notes ?? "").slice(0, 70),
    error: (r.error ?? "").slice(0, 70),
  })));

  console.log("\n=== creations bounds ===");
  const cb = await pool.query(`SELECT MIN(creation_date) AS min, MAX(creation_date) AS max, COUNT(*)::int AS n FROM utxo_daily_creations`);
  console.log(cb.rows[0]);

  console.log("\n=== spends bounds ===");
  const sb = await pool.query(`SELECT MIN(spend_date) AS min, MAX(spend_date) AS max, COUNT(*)::bigint AS n FROM utxo_daily_spends_by_creation`);
  console.log(sb.rows[0]);

  console.log("\n=== rows-by-spend-month tail (last 10 months loaded) ===");
  const tail = await pool.query(`
    SELECT date_trunc('month', spend_date)::date AS month, COUNT(*)::int AS rows
    FROM utxo_daily_spends_by_creation
    GROUP BY month ORDER BY month DESC LIMIT 10
  `);
  console.table(tail.rows);

  console.log("\n=== prices bounds ===");
  const pb = await pool.query(`SELECT MIN(price_date) AS min, MAX(price_date) AS max, COUNT(*)::int AS n FROM btc_price_daily`);
  console.log(pb.rows[0]);
} finally {
  await closePool();
}
