# Deployment runbook

Step-by-step deployment. Assumes you have:

- A GitHub repository (private during dev, public for Context submission)
- A [Railway](https://railway.app) account (project ready)
- A [Neon](https://neon.tech) Postgres database (free tier is fine)
- An [Upstash](https://upstash.com) Redis REST instance (free tier is fine)
- A Google Cloud project with the BigQuery API enabled and a service-account JSON key

## 1. Apply Postgres migrations

Locally, with `DATABASE_URL` set in `.env`:

```bash
pnpm migrate
```

This applies `packages/core/src/db/migrations/0001_initial.sql` and creates the `schema_migrations` ledger.

## 2. Run the historical bootstrap

This is a one-time job. Pick whichever of these works for your situation:

### Option A — local laptop / temp VPS

```bash
# Install deps and build the indexer
pnpm install && pnpm --filter @cohortsignal/core build

# Run the BigQuery-based bootstrap from 2018-01-01 to yesterday.
GOOGLE_APPLICATION_CREDENTIALS=./gcp-key.json \
  pnpm --filter @cohortsignal/indexer start bootstrap
```

Expected runtime: ~30–60 minutes for the full backfill. The indexer writes one cohort_snapshots row per UTC day starting 2018-01-01.

### Option B — Railway one-off worker

Create a service from the same repo, run `node apps/indexer/dist/main.js bootstrap` once, then delete the service.

### Verifying the bootstrap

```sql
-- Connect to Postgres and run:
SELECT MIN(snapshot_date), MAX(snapshot_date), COUNT(*)
FROM cohort_snapshots WHERE cohort_boundary_days = 155;
```

Expected: `2018-01-01`, `<yesterday>`, ~3000 rows.

## 3. Deploy the MCP server to Railway

1. New service from the repo. Watch path: `apps/mcp-server/**`.
2. Set environment variables (see `.env.example`):
   - `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
   - `BITCOIN_RPC_URL` (only used by the live edge if no GCP creds)
   - `ESPLORA_API_URL=https://blockstream.info/api`
   - `CONTEXT_AUTH_ENABLED=true` (mandatory in production)
   - `PORT=3000`
3. Build: `pnpm install && pnpm --filter @cohortsignal/core build && pnpm --filter @cohortsignal/mcp-server build`
4. Start: `node apps/mcp-server/dist/server.js`
5. Health check: `GET /health`
6. Confirm the public URL responds:

```bash
curl https://<your-railway-domain>/health
```

## 4. Deploy the indexer to Railway

1. Second service from the same repo.
2. Same env vars as the MCP server, plus:
   - `GCP_SA_KEY_JSON` (the entire JSON content of your service-account key, single-line)
   - The startup script writes `GCP_SA_KEY_JSON` → `/tmp/gcp-key.json` and sets `GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-key.json`.
3. Build: same as MCP, replacing `mcp-server` with `indexer`.
4. Start: `node apps/indexer/dist/main.js live`
5. The worker polls every 5 minutes, advances the daily-final frontier when yesterday's BigQuery aggregate is published, and refreshes the provisional today snapshot.

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
