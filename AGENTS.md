# AGENTS.md — Cohort-Signal session handoff

This file is the **source of truth for any new Cursor / Codex / Claude
session** working on this repository. Read it first; treat its contents as
context to avoid re-discovering what's been built.

> Last updated: 2026-05-06.

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

### Daily incremental updates (recommended Railway Cron)

```
0 6 * * *
node apps/indexer/dist/main.js bq-bootstrap --from <yesterday> --to <today> &&
node apps/indexer/dist/main.js prices --from <7-days-ago> &&
node apps/indexer/dist/main.js rebuild --from <60-days-ago>
```

The 60-day rolling rebuild keeps trailing 30/90d stats correct without redoing 6 years of history.

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
| MCP server deployed on Railway | ✅ (verify at /health) |
| Indexer deployed on Railway | 🟡 in progress |
| Context Protocol listing submitted | ⬜ |
| Optimization skill run + tweaks applied | ⬜ |
| Daily Cron service on Railway for incremental updates | ⬜ |

---

## Open follow-ups

- **Rotate the GCP service-account key** that was leaked in chat earlier in the project. Generate a new key in IAM → Service Accounts → Keys, paste it into Railway as `GCP_SA_KEY_JSON`, then disable the old one in IAM.
- **Generate domain for the MCP service** in Railway → Networking → Public Networking → Generate Domain (port 3000).
- **Test the live `/health` endpoint** end-to-end after deploy.
- **Submit the listing on Context** at https://ctxprotocol.com (developer dashboard → new tool listing → MCP endpoint URL → pricing → submit). Then run the optimization skill (`docs/optimization.md`).
- **Set up Railway Cron** for daily incremental updates.

---

## Notes for future agents

- **Don't rebuild the whole rebuild engine.** It's deterministic, well-tested, and the canonical algorithm. Touching it requires updating the unit tests.
- **Don't edit `methodology` constants without bumping `METHODOLOGY_VERSION`.** Every response carries that version; changing math without changing the version is a methodology-fidelity violation.
- **Don't paste secrets in chat.** The GCP key paste earlier in the project is the one ongoing security concern; everything else is in `.env` (gitignored) or Railway variables.
- **Context Protocol's exact requirements** are: structured `outputSchema`, `structuredContent` matching that schema on every response, `_meta` with `surface`, `queryEligible`, `latencyClass`, `pricing`, `rateLimit`, and `createContextMiddleware()` not commented out. All implemented.
- **Cohort boundary** is per-call configurable via `cohortBoundaryDays` (default 155, range 7–1825). Don't drop the validation in `apps/mcp-server/src/handlers.ts:pickCohortBoundary`.
- For DB inspection, prefer the helper scripts in `apps/indexer/scripts/` over ad-hoc one-liners — they handle dotenv loading correctly.
