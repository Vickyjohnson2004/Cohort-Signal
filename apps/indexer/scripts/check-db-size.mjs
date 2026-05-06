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
  console.log("\n=== Database total size ===");
  const totalSize = await pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS total, pg_database_size(current_database()) AS bytes`);
  console.log(totalSize.rows[0]);

  console.log("\n=== Per-table size (top 20) ===");
  const tables = await pool.query(`
    SELECT
      n.nspname AS schema,
      c.relname AS table,
      pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
      pg_size_pretty(pg_relation_size(c.oid)) AS heap_size,
      pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS index_toast,
      pg_total_relation_size(c.oid) AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema')
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 20
  `);
  console.table(tables.rows);

  console.log("\n=== Row counts ===");
  for (const t of ["cohort_snapshots","utxo_daily_creations","utxo_daily_spends_by_creation","btc_price_daily","bootstrap_runs","regime_change_events","indexer_state"]) {
    try {
      const r = await pool.query(`SELECT COUNT(*)::bigint AS n FROM ${t}`);
      console.log(`  ${t}: ${r.rows[0].n}`);
    } catch (e) {
      console.log(`  ${t}: <not found> (${e.message.split('\n')[0]})`);
    }
  }
} finally {
  await closePool();
}
