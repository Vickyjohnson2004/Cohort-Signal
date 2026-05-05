import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { getPoolAsync, closePool } from "./pool.js";

// Load .env from monorepo root if DATABASE_URL isn't already set.
if (!process.env.DATABASE_URL) {
  for (const p of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), "../../../.env"),
  ]) {
    if (existsSync(p)) {
      const env = readFileSync(p, "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const i = l.indexOf("=");
          return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")] : null;
        })
        .filter((kv): kv is [string, string] => kv !== null);
      for (const [k, v] of env) {
        if (!process.env[k]) process.env[k] = v;
      }
      console.log(`[migrate] loaded env from ${p}`);
      break;
    }
  }
}

/**
 * Tiny forward-only migration runner. Each *.sql file in ./migrations is
 * applied once, in lexicographic order, and recorded in the
 * schema_migrations table. Designed to be safe to re-run.
 */
async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(here, "migrations");

  const pool = await getPoolAsync();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id           text PRIMARY KEY,
        applied_at   timestamptz NOT NULL DEFAULT now()
      );
    `);

    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const id = file.replace(/\.sql$/, "");
      const exists = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [id]);
      if (exists.rowCount && exists.rowCount > 0) {
        console.log(`[migrate] skip ${id}`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      console.log(`[migrate] apply ${id}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log("[migrate] done");
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
