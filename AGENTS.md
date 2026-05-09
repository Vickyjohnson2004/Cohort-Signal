# AGENTS.md — Cohort-Signal session handoff

This file is the **source of truth for any new Cursor / Codex / Claude
session** working on this repository. Read it first; treat its contents as
context to avoid re-discovering what's been built.

> Last updated: 2026-05-09.

---

## Project goal

**Cohort-Signal** is an MCP tool for the Context Protocol marketplace that
answers Bitcoin LTH/STH supply regime questions deterministically:

- `lthSupplyBtc`, `sthSupplyBtc`, splits as a fraction of circulating supply
- `lthNetPositionChangeBtc` (1d, 7d-avg, 30d-avg, 90d-avg)
- `lthSopr` (current and 30d-avg) plus a behavioral state label
- HODL waves distribution by age band, with 30d/90d shifts
- Deterministic regime classifier: `accumulation` / `equilibrium` / `distribution`
- A regime narrative built mechanically from structured fields (no LLM call)
- `evidenceURL` pointing at a public block-explorer block height for proof

**Tier-S Context Protocol grant ($1,000 USDC) approved May 2026.** This
repo is the production implementation. The proposal commitments are
enumerated in `README.md` ("Tier-S grant compliance" section).

---

## High-level architecture

```
BigQuery (crypto_bitcoin)  ──► utxo_daily_creations / utxo_daily_spends_by_creation
                                          │
                                          ▼
CryptoCompare histoday    ──► btc_price_daily
                                          │
                                          ▼
                deterministic rebuild engine
                                          │
                                          ▼
                cohort_snapshots + regime_change_events
                                          │
                                          ▼
                MCP server (8 tools, structuredContent, _meta)
                                          │
                                          ▼
                          Context Protocol marketplace
```

---

## Repo layout

```
packages/core/                shared TS package
  src/bigquery/client.ts      minimal BigQuery REST client (no @google-cloud sdk)
  src/cohort/                 bands, rolling stats, regime classifier, narrative, rebuild engine
    rebuild.ts                deterministic streaming rebuilder (creations + spends + prices → snapshots)
    rebuild.test.ts           8 unit tests for the engine
  src/db/
    pool.ts                   IPv4-pinned + SNI-preserving Neon pool
    snapshots.ts              cohort_snapshots upsert / read + bulk upsert (multi-row INSERT)
    utxoFlow.ts               flow tables + iterateSpendsRange async generator (cursor-based)
    prices.ts                 btc_price_daily upsert / read
    migrations/
      0001_initial.sql        cohort_snapshots, btc_price_daily, regime_change_events, indexer_state, schema_migrations
      0002_utxo_age_flow.sql  utxo_daily_creations, utxo_daily_spends_by_creation, bootstrap_runs, +columns on cohort_snapshots
  src/price/cryptocompare.ts  histoday client (replaces CoinGecko, which capped free tier to 365d)
  src/rpc/esplora.ts          chain tip + block-explorer evidenceURL builder
  src/schemas/                canonical TS types and HODL bands
  src/util/                   date, circulating-supply, redis cache, errors
  src/constants.ts            METHODOLOGY_VERSION = "cohortsignal-v1.0", DEFAULT_COHORT_BOUNDARY_DAYS = 155

apps/mcp-server/              public-facing MCP server (Express + Streamable HTTP)
  src/server.ts               entry: createContextMiddleware on /mcp; /health is open
  src/tools.ts                8 tool descriptors with full inputSchema + outputSchema + _meta
  src/handlers.ts             tool dispatcher, structured error returns
  src/handlers.test.ts        15 integration tests with FakeCohortService
  src/service.ts              Postgres-backed CohortService (regime view builder)
  railway.json                per-service Railway config
  package.json

apps/indexer/                 worker (BigQuery extract + rebuild + live edge)
  src/main.ts                 CLI: bq-bootstrap | rebuild | prices | live
  src/bigquery.ts             BigQuery extract (creations + spends), supports --creations-only / --spends-only
  src/rebuildSnapshots.ts     reads flow tables → calls core rebuild engine → writes snapshots
  src/prices.ts               CryptoCompare backfill
  src/live.ts                 5-min poll, projects today's provisional snapshot from chain tip
  scripts/                    operator-friendly DB inspection scripts (check-db-size, check-snapshots, etc.)
  railway.json                per-service Railway config
  package.json

nixpacks.toml                 Railway build config (Node 20 + pnpm 9.12 via corepack, --prod=false to keep devDependencies)
README.md                     public docs
docs/methodology.md           regime classifier rules, exact thresholds
docs/deployment.md            step-by-step Railway runbook
docs/optimization.md          notes for Context optimization skill
.env.example                  every env var documented
.gitignore                    .env, .secrets/, GCP keys, etc.
```

---

## Database state (as of 2026-05-06)

Neon **Launch tier** ($5/mo, 10 GB).

| Table | Rows | Size |
|---|---|---|
| `utxo_daily_creations` | 3,046 | 400 kB |
| `utxo_daily_spends_by_creation` | 6,782,670 | 766 MB |
| `btc_price_daily` | 3,047 | 768 kB |
| `cohort_snapshots` | 3,048 | ~3 MB |
| `regime_change_events` | 279 | small |
| `indexer_state` | 1 | small |
| `bootstrap_runs` | ~6 | small |

Total DB: ~776 MB.

Snapshot date range: **2018-01-01 → 2026-05-06**. All snapshots non-provisional, written by the deterministic rebuild engine.

`btc_price_daily` covers 2018-01-01 → 2026-05-05 from CryptoCompare.

---

## Deployment

**Two Railway services** in one project, both watching `main`:

1. **cohortsignal-mcp** — Root Directory `apps/mcp-server`, public domain on port 3000.
2. **cohortsignal-indexer** — Root Directory `apps/indexer`, no public domain, runs `node apps/indexer/dist/main.js live`.

Both services share the same Neon DB (`DATABASE_URL`) and Upstash Redis.

`railway.json` per service overrides `buildCommand` (`pnpm -F core build && pnpm -F <service> build`) and `startCommand`. `nixpacks.toml` at repo root pins Node 20 + pnpm 9.12 via corepack and runs `pnpm install --frozen-lockfile --prod=false` so `tsc` is available at build time despite Railway setting `NODE_ENV=production`.

Required env vars per service: see `.env.example`. Critical:
- **MCP**: `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `ESPLORA_API_URL`, `CONTEXT_AUTH_ENABLED=true`. Railway injects `PORT` automatically.
- **Indexer**: same as above, plus `GCP_SA_KEY_JSON` (single-line JSON string of service-account key). The BigQuery client parses the JSON directly; no key file is written.

The MCP server binds to `0.0.0.0:$PORT` (set explicitly in `apps/mcp-server/src/server.ts`).

### Daily incremental updates (Railway Cron)

A third Railway service (`cohortsignal-cron`) runs the daily incremental pipeline at 06:00 UTC. Same monorepo, same image as the indexer, but uses `apps/indexer/railway.cron.json` (start command `bash apps/indexer/scripts/daily-update.sh`, `restartPolicyType: NEVER`).

The script runs three idempotent phases:

```
1. bq-bootstrap --from <yesterday> --to <today>     (~150 MB BigQuery scan)
2. prices --from <7-days-ago>                       (~50 KB CryptoCompare)
3. rebuild --from <60-days-ago>                     (no external network)
```

The 60-day rolling rebuild keeps trailing 30/90d stats correct without redoing 6 years of history. Total runtime ~1-2 minutes per run.

See `docs/deployment.md` step 4b for the Railway dashboard wiring.

---

## Tooling contracts (MCP)

8 tools live in `apps/mcp-server/src/tools.ts`. Every successful response includes the **envelope fields**:

```
asOf, asOfDate, blockHeight, cohortBoundaryDays,
methodology, methodologyVersion, indexerVersion,
dataFreshnessSeconds, freshnessWarning, provisional,
evidenceURL
```

Plus tool-specific structured content per the `outputSchema` declared in `tools.ts`. Errors return `{ isError: true, structuredContent: { error, message, details } }`.

Tools:
- `get_current_lth_sth_regime` (Query)
- `get_lth_supply_historical_context` (Query)
- `get_lth_net_position_change` (Query)
- `get_hodl_waves_distribution` (Query)
- `get_lth_sopr_signal` (Query)
- `get_combined_cohort_regime_brief` (Query)
- `get_cohort_snapshot` (Execute)
- `get_cohort_timeseries` (Execute)

Pricing per `_meta`: `$0.10` per Query response, `$0.001` per Execute call.

`createContextMiddleware()` is mounted on `/mcp` (POST/GET/DELETE). `CONTEXT_AUTH_ENABLED=true` is the production default; setting `false` is allowed only for local dev. **Health endpoint `/health` is public**, used by Railway for the deploy check.

---

## Methodology (verbatim, version cohortsignal-v1.0)

LTH boundary: **155 days** (Glassnode standard).

Regime classifier inputs:
1. LTH supply 30d % delta — growing > +0.20%, shrinking < -0.20%, else flat.
2. LTH-SOPR vs 1.0 — profit > 1.01, loss < 0.99, else neutral. Null treated as neutral.
3. under_1m HODL waves share trend over 30d — rotating_to_young > +1.0pp, rotating_to_old < -1.0pp, else flat.

First-match decision rules:
- A. growing AND not-profit AND not-young-rotating → **accumulation**
- B. shrinking AND (profit OR young-rotating) → **distribution**
- C. shrinking AND loss AND not-young-rotating → **distribution**
- D. growing AND profit → **equilibrium**
- E. else → **equilibrium**

LTH-SOPR for date d:
```
sum_over_LTH_spends_today(spend_value_btc * price[spend_date])
                  /
sum_over_LTH_spends_today(spend_value_btc * price[creation_date])
```
Returns null when no LTH spends occurred. Status: `above_one` (>1.005) / `below_one` (<0.995) / `neutral`. State: `capitulation` / `profit_taking` / `hodl_dominant` / `neutral_spending` (thresholds in `packages/core/src/cohort/regime.ts`).

HODL bands match Glassnode dashboard exactly (`under_1m`, `1m_3m`, `3m_6m`, `6m_12m`, `1y_2y`, `2y_3y`, `3y_5y`, `5y_7y`, `7y_10y`, `over_10y`).

**Determinism guarantee**: re-running the rebuild engine against the same flow tables and prices produces byte-identical output.

---

## Tests

- **48 unit tests** in `packages/core` (regime, bands, rebuild, dates, circulating supply).
- **15 integration tests** in `apps/mcp-server/src/handlers.test.ts` against an in-memory `FakeCohortService` (verifies envelope fields, structured content, error paths, bounds validation across all 8 tools).
- All green; run with `pnpm test` at repo root.

---

## Status checklist

| Item | Status |
|---|---|
| Monorepo + core math | ✅ |
| Postgres schema + migrations | ✅ |
| BigQuery extract (creations + spends, 2018→today) | ✅ — 6.78M spend rows loaded |
| Price backfill (CryptoCompare) | ✅ — 3,047 daily rows |
| Deterministic rebuild engine + tests | ✅ — 11min full rebuild, 18× faster than original |
| `cohort_snapshots` populated 2018-01-01 → today | ✅ — 3,048 rows |
| MCP server with 8 tools + outputSchema + _meta | ✅ |
| `createContextMiddleware()` wired in directly | ✅ |
| Redis hot cache | ✅ (TTL: 60s for "now", 3600s for historical asOfDate) |
| Freshness / provisional / evidenceURL on every response | ✅ |
| README + methodology + deployment docs | ✅ |
| Push to GitHub (`Victorvalour/Cohort-Signal`, `main` branch) | ✅ |
| MCP server deployed on Railway | ✅ |
| Indexer deployed on Railway | ✅ — chainTipHeight live, lagSeconds < 200 |
| Per-session MCP `Server` instance fix (post-deploy crash repair) | ✅ — see `apps/mcp-server/src/server.ts:createMcpServer` |
| Multi-initialize smoke test (5x sequential `initialize` returns 200) | ✅ verified 2026-05-09 against production |
| Context Protocol listing re-submitted | ✅ re-listed 2026-05-09 after per-session fix; in review |
| Daily Cron service on Railway for incremental updates | 🟡 wrapper script + `railway.cron.json` committed, awaiting Railway dashboard wiring per `docs/deployment.md` step 4b |
| Optimization skill run + tweaks applied | ⬜ |

---

## Open follow-ups

- **Wire the cron service in the Railway dashboard** per `docs/deployment.md` step 4b. Wrapper script and config-as-code file are committed; Railway-side wiring (third service, schedule `0 6 * * *`, env vars) is the only remaining manual step.
- **Run the optimization skill** (`docs/optimization.md`) once the listing is approved and routing live traffic.

### Multi-initialize smoke test (the test we should have run before the first listing)

After any change to `apps/mcp-server/src/server.ts`, run this against the deployed Railway URL. It catches the per-session-server bug class:

```bash
URL=https://<your-mcp-domain>/mcp
TOKEN=<your-CONTEXT_API_KEY>
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "init#$i: %{http_code}\n" -X POST "$URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke\",\"version\":\"0.1\"}}}"
done
# Expect: init#1..5 all return 200. Pre-fix would return 200 on init#1 then crash the container.
```

---

## Notes for future agents

- **Don't rebuild the whole rebuild engine.** It's deterministic, well-tested, and the canonical algorithm. Touching it requires updating the unit tests.
- **Don't edit `methodology` constants without bumping `METHODOLOGY_VERSION`.** Every response carries that version; changing math without changing the version is a methodology-fidelity violation.
- **Don't paste secrets in chat.** The GCP key paste earlier in the project is the one ongoing security concern; everything else is in `.env` (gitignored) or Railway variables.
- **Context Protocol's exact requirements** are: structured `outputSchema`, `structuredContent` matching that schema on every response, `_meta` with `surface`, `queryEligible`, `latencyClass`, `pricing`, `rateLimit`, and `createContextMiddleware()` not commented out. All implemented.
- **Cohort boundary** is per-call configurable via `cohortBoundaryDays` (default 155, range 7–1825). Don't drop the validation in `apps/mcp-server/src/handlers.ts:pickCohortBoundary`.
- **Don't share a single MCP `Server` across sessions.** `apps/mcp-server/src/server.ts:createMcpServer` exists for a reason — the MCP SDK throws `"Already connected to a transport"` on the second `initialize` if the same `Server` is reused. Each session must get its own `Server`, and `transport.onclose` must call `server.close()` to free the per-session resources. The 2026-05-06 production crash-loop traced back to this exact mistake; the smoke test in "Open follow-ups" above is the regression check.
- For DB inspection, prefer the helper scripts in `apps/indexer/scripts/` over ad-hoc one-liners — they handle dotenv loading correctly.
