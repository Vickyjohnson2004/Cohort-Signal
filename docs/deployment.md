# Deployment runbook

Step-by-step deployment. Assumes you have:

- A GitHub repository (private during dev, public for Context submission)
- A [Railway](https://railway.app) account (project ready)
- A [Neon](https://neon.tech) Postgres database. **Required: at least the Launch tier** (~10 GB) — the historical flow tables together use ~700 MB, which exceeds the Free 0.5 GB cap. The indexer pipeline needs them on disk for re-runnable rebuilds; you can drop them after a final rebuild if you want to shrink Neon back down (see "Storage management" below).
- An [Upstash](https://upstash.com) Redis REST instance (free tier is fine)
- A Google Cloud project with the BigQuery API enabled and a service-account JSON key

## 1. Apply Postgres migrations

Locally, with `DATABASE_URL` set in `.env`:

```bash
pnpm migrate
```

This applies all SQL files under `packages/core/src/db/migrations/` (currently `0001_initial.sql` and `0002_utxo_age_flow.sql`) and records each in the `schema_migrations` ledger. Migrations are idempotent and safe to re-run.

## 2. Run the historical bootstrap

This is a one-time job composed of three sub-jobs that run in order. Use a local laptop or a temp VPS — Railway's free tier has too short a job lifetime for the BigQuery extract.

### 2a. BigQuery flow extract (creations + spends)

```bash
pnpm install && pnpm --filter @cohortsignal/core build

# Either set GOOGLE_APPLICATION_CREDENTIALS=<path-to-json>
# or set GCP_SA_KEY_JSON=<the-entire-json-as-one-line>.
pnpm --filter @cohortsignal/indexer bq-bootstrap -- --from 2018-01-01
```

Expected runtime: 30–60 minutes (~613 GB of BigQuery scan; well within the 1 TB/month free tier). The job writes:

- `utxo_daily_creations` — one row per UTC date (~3,000 rows total)
- `utxo_daily_spends_by_creation` — one row per (spend_date, creation_date) pair (~6.8 M rows total, ~480 MB)

If the job is interrupted (transient network issue, laptop sleep), resume with `--spends-only --from <next-day-after-last-loaded-spend-date>`. The creations phase is safe to skip on a resume — its rows are already idempotent and the cost (~125 GB) is small compared to the spends phase.

Verification:

```sql
SELECT MIN(creation_date), MAX(creation_date), COUNT(*) FROM utxo_daily_creations;
SELECT MIN(spend_date),    MAX(spend_date),    COUNT(*) FROM utxo_daily_spends_by_creation;
```

### 2b. BTC daily price backfill

```bash
pnpm --filter @cohortsignal/indexer prices -- --from 2018-01-01
```

~30 seconds via CryptoCompare's free `histoday` endpoint. Required for LTH-SOPR.

### 2c. Deterministic snapshot rebuild

```bash
pnpm --filter @cohortsignal/indexer rebuild
```

Reads the flow tables and prices, replays the deterministic engine in `@cohortsignal/core`, and writes ~3,000 rows to `cohort_snapshots` plus regime-change events. ~1–2 minutes, no external network calls.

Verification:

```sql
SELECT MIN(snapshot_date), MAX(snapshot_date), COUNT(*)
FROM cohort_snapshots WHERE cohort_boundary_days = 155;
-- Expected: 2018-01-01, <yesterday or today>, ~3000 rows
```

### Storage management (optional)

After step 2c, the MCP server only reads from `cohort_snapshots`, `btc_price_daily`, `regime_change_events`, and `indexer_state`. The big flow tables can be dropped to save ~480 MB if you want to shrink the database, at the cost of needing to re-run step 2a if you ever want to re-replay step 2c with a different methodology. To drop them safely:

```sql
DROP TABLE utxo_daily_spends_by_creation;
DROP TABLE utxo_daily_creations;
```

`bootstrap_runs` is small and worth keeping as an audit log.

## 3. Deploy the MCP server to Railway

The repo ships a per-service [`apps/mcp-server/railway.json`](../apps/mcp-server/railway.json) and a root-level [`nixpacks.toml`](../nixpacks.toml). The nixpacks config pins Node 20 and pnpm 9.12 via corepack and runs `pnpm install --frozen-lockfile`; the railway.json then builds the workspace and starts the server.

1. **Create a service** in Railway from your GitHub repo.
2. In Settings → **Root Directory**, set it to `apps/mcp-server`. Railway will auto-pick `apps/mcp-server/railway.json`. The build still has access to the full monorepo because pnpm is workspace-aware.
   *Alternative*: leave Root Directory blank, then in Settings → Config-as-Code, set Path to `apps/mcp-server/railway.json`.
3. **Watch path** (Settings → Deploy): `apps/mcp-server/**` and `packages/core/**` so this service redeploys when either changes.
4. **Environment variables** (Settings → Variables):
   - `DATABASE_URL` — your Neon connection string (use the **direct** URL for writes; pooler URL is fine here for read-mostly traffic).
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   - `ESPLORA_API_URL=https://blockstream.info/api`
   - `BITCOIN_RPC_URL` — optional (used only by the live-edge path if you ever switch to it; the BigQuery + rebuild path doesn't need it).
   - `CONTEXT_AUTH_ENABLED=true` (**mandatory in production**; only set to `false` for local dev).
   - `PORT` — Railway sets this automatically; do not override.
   - `INDEXER_FRESHNESS_WARNING_SECONDS=14400` — optional (4h default).
5. **Generate domain**: Settings → Networking → Public Networking → Generate Domain.
6. **Health check**: `GET /health` returns 200 with `{ "status": "ok", "indexer": {...} }`.

```bash
curl https://<your-railway-domain>/health
```

## 4. Deploy the indexer to Railway

1. Add a **second service** in the same Railway project from the same repo.
2. **Root Directory**: `apps/indexer` (so Railway picks `apps/indexer/railway.json`).
3. **Watch path**: `apps/indexer/**` and `packages/core/**`.
4. **Environment variables** — same as the MCP server, plus:
   - **`GCP_SA_KEY_JSON`** — the entire JSON content of your service-account key, single-line (paste it into Railway as one variable; quoting is handled by the dashboard). The indexer's BigQuery client parses this directly and never writes the key to disk.
   - **`GCP_PROJECT_ID`** — optional if `project_id` is present in the JSON.
   - For the **live mode** (default, started by the railway.json), the indexer only needs `DATABASE_URL` and `ESPLORA_API_URL`. GCP credentials are only required if you switch the start command to a `bq-bootstrap` run.
5. **Start command**: `node apps/indexer/dist/main.js live` — set in `apps/indexer/railway.json`.
6. **Operations**: the worker polls every 5 minutes (`INDEXER_POLL_INTERVAL_MS`), updating the provisional today-snapshot from the chain tip via Esplora. The historical frontier (every day from 2018-01-01 to yesterday) is advanced offline by re-running `bq-bootstrap` (incremental — only new dates are billed) followed by `rebuild`. Schedule that combination as a daily Railway Cron service if you want zero-touch operation:
   - Cron service start command: `node apps/indexer/dist/main.js bq-bootstrap --from $(date -u -d 'yesterday' +%Y-%m-%d) --to $(date -u +%Y-%m-%d) && node apps/indexer/dist/main.js prices --from $(date -u -d '7 days ago' +%Y-%m-%d) && node apps/indexer/dist/main.js rebuild --from $(date -u -d '60 days ago' +%Y-%m-%d)`
   - Cron schedule: `0 6 * * *` (06:00 UTC daily).

## 5. Register on Context

1. Go to [Context's developer dashboard](https://ctxprotocol.com).
2. Create a new tool listing.
3. Set the MCP endpoint URL to your Railway public domain + `/mcp`.
4. Pricing: $0.10 per Query response, $0.001 per Execute call.
5. Submit the listing and your wallet address (USDC payouts).
6. Run the optimization skill (see [docs/optimization.md](optimization.md)).

## 6. Post-deploy verification

A quick end-to-end check from any MCP-aware client:

```bash
# Initialize a session
curl -i -X POST https://<your-domain>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <CONTEXT_API_KEY>" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{...},"id":1}'

# Save session id from response header, then call a tool
curl -s -X POST https://<your-domain>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <CONTEXT_API_KEY>" \
  -H "mcp-session-id: <SID>" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_current_lth_sth_regime","arguments":{}},"id":2}'
```

A successful response contains `structuredContent` with `lthSupplyBtc`, `regimeClassifier`, `regimeNarrative`, and an `evidenceURL`.
