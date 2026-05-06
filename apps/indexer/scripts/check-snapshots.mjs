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
  const r = await pool.query(`SELECT COUNT(*)::int AS n, MIN(snapshot_date) AS first, MAX(snapshot_date) AS last FROM cohort_snapshots`);
  console.log("cohort_snapshots:", r.rows[0]);
  const e = await pool.query(`SELECT COUNT(*)::int AS n FROM regime_change_events`);
  console.log("regime_change_events:", e.rows[0]);
  if (r.rows[0].n > 0) {
    const recent = await pool.query(`SELECT snapshot_date, lth_supply_btc::float8 AS lth, sth_supply_btc::float8 AS sth, lth_sopr::float8 AS sopr, regime FROM cohort_snapshots ORDER BY snapshot_date DESC LIMIT 5`);
    console.log("\nMost recent 5 snapshots:");
    console.table(recent.rows);
  }
} finally {
  await closePool();
}
