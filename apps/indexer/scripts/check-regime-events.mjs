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
  const r = await pool.query(`SELECT event_date, from_regime, to_regime, block_height FROM regime_change_events ORDER BY event_date ASC LIMIT 50`);
  console.table(r.rows);
} finally { await closePool(); }
