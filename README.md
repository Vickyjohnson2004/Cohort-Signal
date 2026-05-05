# CohortSignal

**Bitcoin LTH/STH supply regime intelligence — for the Context Protocol marketplace.**

CohortSignal is an MCP tool that answers one question precisely: *where are Bitcoin's long-term holders in the cycle right now?* It returns LTH and STH supply levels, LTH net position change (7d, 30d, 90d), LTH-SOPR with status and behavioral state, HODL waves distribution with 30d and 90d shifts, and a deterministic regime classifier (`accumulation` / `equilibrium` / `distribution`) — all reproducible from raw Bitcoin chain data using the Glassnode-standard 155-day cohort definition.

Sourced from a self-maintained UTXO-age indexer running on top of the [Google BigQuery `crypto_bitcoin` public dataset](https://cloud.google.com/blog/topics/public-datasets/bitcoin-in-bigquery-blockchain-analytics-on-public-data). All cohort math is deterministic and surfaced in the `methodology` field of every response.

> Approved for a Tier S grant ($1,000 USDC) by the Context Protocol team in May 2026. This repository contains the production implementation.

---

## What it provides

### 6 Query prompts

Each Query returns a typed `structuredContent` payload with `methodology`, `methodologyVersion`, `indexerVersion`, `dataFreshnessSeconds`, `freshnessWarning`, `provisional`, and a public `evidenceURL` pointing at the underlying block on a block explorer.

| Tool | Question it answers |
|---|---|
| `get_current_lth_sth_regime` | What's the current Bitcoin LTH/STH regime? Are LTHs accumulating, in equilibrium, or distributing? |
| `get_lth_supply_historical_context` | How does today's LTH supply compare to its 6-month and 12-month range, and where in the cycle are we? |
| `get_lth_net_position_change` | Are LTHs net buying or selling, and is that pace accelerating, decelerating, or flat? |
| `get_hodl_waves_distribution` | What does the HODL waves distribution look like right now? Which age band is dominant, and which moved the most over 30 days? |
| `get_lth_sopr_signal` | Is LTH-SOPR signaling profit-taking, capitulation, or HODL-dominant behavior? When was the last drop below 1.0? |
| `get_combined_cohort_regime_brief` | The full one-shot regime brief: supply, deltas, SOPR, HODL waves, regime call, deterministic narrative, and key drivers. |

### 2 Execute methods

| Method | Purpose |
|---|---|
| `get_cohort_snapshot` | A single typed cohort snapshot at `asOfDate` (or latest). Designed for SDK developers building backtests, research workflows, agent pipelines. |
| `get_cohort_timeseries` | Daily- or weekly-granularity time-series of one metric (`lth_supply`, `sth_supply`, `lth_sopr`, `lth_net_position_change`, `hodl_waves`) over `[startDate, endDate]`, plus regime-change events that fall in the window. |

### Why this is differentiated vs. asking GPT/Claude directly

A free LLM cannot give you accurate, reproducible LTH/STH cohort numbers. There is no public chat assistant that knows today's exact LTH supply to the BTC, and they confidently fabricate when asked. CohortSignal computes the numbers from chain data with a documented deterministic methodology and returns the same answer to anyone who asks the same question.

---

## Architecture

```
┌────────────────────┐      ┌──────────────────────┐      ┌─────────────────────────┐
│ BigQuery public    │      │ Indexer worker       │      │ Postgres (Neon)         │
│ crypto_bitcoin     │ ───► │ (Node.js / Railway)  │ ───► │ cohort_snapshots, etc.  │
│ dataset            │      │                      │      │                         │
└────────────────────┘      │ - daily backfill     │      └────────────┬────────────┘
                            │ - live-edge polling  │                   │
                            │ - regime change det. │                   │
                            └──────────────────────┘                   │
                                                                       ▼
                                                         ┌─────────────────────────┐
                                                         │ MCP server              │
                                                         │ (Node.js / Railway)     │
                                                         │                         │
                                                         │ - createContextMiddleware│
                                                         │   wired in directly     │
                                                         │ - 6 Query + 2 Execute   │
                                                         │ - Redis hot cache       │
                                                         │ - sub-2s cached latency │
                                                         └─────────────────────────┘
                                                                       │
                                                                       ▼
                                                         ┌─────────────────────────┐
                                                         │ Context Protocol        │
                                                         │ (ctxprotocol.com)       │
                                                         └─────────────────────────┘
```

**Key design decisions:**

- **Self-maintained UTXO indexer, not a free API** — we compute LTH/STH cohort sums ourselves from raw Bitcoin transaction data. The indexer queries the canonical [BigQuery crypto_bitcoin](https://cloud.google.com/blog/topics/public-datasets/bitcoin-in-bigquery-blockchain-analytics-on-public-data) dataset, walks every output and spend in deterministic order, and bins UTXOs by age using the Glassnode-standard 155-day boundary. Anyone with a Google Cloud account can paste our SQL and reproduce our snapshots to the satoshi.
- **Pre-computed snapshots, never live-RPC at request time** — the MCP server only reads from Postgres + Redis. The query path never touches Bitcoin RPC, BigQuery, or any external service that could time out. Cached latency target: < 2 seconds.
- **Daily snapshots stored permanently** — six years of historical context (2018-01-01 → today) means we can answer "how does today compare to the 2021 cycle top?" with one Postgres scan.
- **`createContextMiddleware()` is wired in directly** — never commented out, never optional in production. CONTEXT_AUTH_ENABLED defaults to true.
- **Provisional flag for the live edge** — today's snapshot is marked `provisional: true` until the next daily reconciliation pass turns it final.

---

## Repository layout

```
cohortsignal/
├── packages/
│   └── core/                      # shared cohort logic (used by both apps)
│       ├── src/cohort/            # bands, rolling stats, regime classifier, deterministic narrative
│       ├── src/db/                # Postgres pool, migrations, snapshot read/write
│       ├── src/price/             # CoinGecko price client (used for live-edge SOPR)
│       ├── src/rpc/               # Bitcoin Core RPC + Esplora fallback
│       ├── src/schemas/           # canonical TS types and HODL waves bands
│       └── src/util/              # date, circulating-supply formula, Redis, errors
│
├── apps/
│   ├── mcp-server/                # the public-facing MCP server (Express + StreamableHTTP)
│   │   ├── src/server.ts          # entry: createContextMiddleware wired in directly
│   │   ├── src/tools.ts           # 8 tools w/ inputSchema + outputSchema + _meta
│   │   ├── src/handlers.ts        # tool dispatcher with structured error returns
│   │   └── src/service.ts         # Postgres-backed cohort regime view builder
│   │
│   └── indexer/                   # the worker (bootstrap + live-edge)
│       ├── src/aggregator.ts      # deterministic in-memory UTXO-age aggregator
│       ├── src/bigquery.ts        # streams daily aggregates from BigQuery
│       ├── src/bootstrap.ts       # one-time historical backfill 2018-now
│       ├── src/live.ts            # daily incremental + provisional projection
│       ├── src/prices.ts          # CoinGecko OHLC backfill (for live-edge SOPR)
│       └── src/main.ts            # CLI entrypoint (bootstrap | live | prices)
│
├── package.json                   # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .env.example                   # all env vars documented
```

---

## Local development

### Prerequisites

- Node.js >= 20
- pnpm >= 9 (`npm i -g pnpm`)
- A Postgres database (recommended: a free [Neon](https://neon.tech) project)
- A free [Upstash](https://upstash.com) Redis REST instance
- A Google Cloud account with the BigQuery API enabled and a service-account JSON key

### Setup

```bash
git clone <repo-url> cohortsignal
cd cohortsignal
pnpm install

# Copy and fill in env values (see .env.example for details)
cp .env.example .env
$EDITOR .env

# Apply Postgres migrations
pnpm migrate

# Run the unit tests
pnpm test
```

### Running locally

```bash
# Run the MCP server (with Context auth disabled for local dev only)
CONTEXT_AUTH_ENABLED=false pnpm dev:mcp
# -> http://localhost:3000/health
# -> POST http://localhost:3000/mcp

# In another shell, run the indexer in live mode (assumes bootstrap has been done)
pnpm dev:indexer

# Or run a backfill for a specific date range
pnpm --filter @cohortsignal/indexer start bootstrap --from 2024-01-01 --to 2024-01-31
```

`CONTEXT_AUTH_ENABLED=false` MUST NOT be used in production — it disables the Context Protocol auth middleware. The default is `true`.

---

## Deployment

CohortSignal is deployed as **two Railway services** sharing the same Postgres (Neon) and Redis (Upstash) backends.

### 1) MCP server (web service)

- **Service name:** `cohortsignal-mcp`
- **Build command:** `pnpm install && pnpm --filter @cohortsignal/core build && pnpm --filter @cohortsignal/mcp-server build`
- **Start command:** `node apps/mcp-server/dist/server.js`
- **Env vars:** `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `BITCOIN_RPC_URL`, `ESPLORA_API_URL`, `CONTEXT_AUTH_ENABLED=true`, `PORT=3000`
- **Health check:** `GET /health`

### 2) Indexer worker

- **Service name:** `cohortsignal-indexer`
- **Build command:** same as above, replacing `mcp-server` with `indexer`
- **Start command:** `node apps/indexer/dist/main.js live`
- **Env vars:** same as MCP plus `GOOGLE_APPLICATION_CREDENTIALS` (path to service-account JSON written from a `GCP_SA_KEY_JSON` env var at boot)
- **Cron behaviour:** the worker polls every 5 minutes (configurable via `INDEXER_POLL_INTERVAL_MS`).

### Initial bootstrap (one-time)

The historical backfill from 2018-01-01 needs ~30 minutes and only needs to run once. It can run anywhere with outbound HTTPS and a Postgres connection — local laptop, temp VPS, or Railway one-off worker.

```bash
# Set DATABASE_URL and GOOGLE_APPLICATION_CREDENTIALS in your shell
pnpm --filter @cohortsignal/indexer start bootstrap --from 2018-01-01
# After completion, the live-edge worker takes over for daily increments.
```

---

## Methodology — published in every response

Every successful response includes a `methodology` field with the verbatim rules used to compute the regime classifier. This is *not* documentation that lives separately from the system — it's the actual rules the code follows, embedded in the response so reviewers can verify by hand.

### Long-term holder boundary

A UTXO is "long-term held" if its age (in days) at the snapshot date is **>= 155 days**. This matches Glassnode's standard. The boundary is configurable per-call via `cohortBoundaryDays`.

### Regime classifier — deterministic decision tree

The classifier produces one of `{accumulation, equilibrium, distribution}` from three orthogonal signals:

1. **LTH supply trajectory** (30d % delta of LTH supply)
   - growing: `delta30d_pct > +0.20%`
   - shrinking: `delta30d_pct < -0.20%`
   - flat: within ±0.20%

2. **LTH spending pressure** (LTH-SOPR vs 1.0; null treated as neutral)
   - profit: `sopr > 1.01`
   - loss: `sopr < 0.99`
   - neutral: 0.99..1.01

3. **Young-supply rotation** (under_1m HODL waves share trend over 30d)
   - rotating_to_young: `under_1m share grew by >+1.0pp`
   - rotating_to_old: `under_1m share fell by >-1.0pp`
   - flat: within ±1.0pp

### Decision rules (first match wins)

- **A.** `growing AND not-profit AND not-young-rotating` → `accumulation` (LTHs absorbing supply, not selling it)
- **B.** `shrinking AND (profit OR young-rotating)` → `distribution` (LTHs selling AND new supply rotating into short-term cohorts)
- **C.** `shrinking AND loss AND not-young-rotating` → `distribution` (capitulation-like: LTHs spending at a loss and the cohort is shrinking)
- **D.** `growing AND profit` → `equilibrium` (mixed signal: cohort growing but realizing gains)
- **E.** else → `equilibrium`

### LTH-SOPR

For each spend `s` of a UTXO whose age at spend was `>= cohortBoundaryDays` days:

```
LTH-SOPR(date) = sum(spend_value_usd) / sum(create_value_usd)   over all such spends on `date`
```

Returns `null` when no LTH spends are observed on a given day. Status thresholds:
- `above_one`: `> 1.005`
- `below_one`: `< 0.995`
- `neutral`: in between

State labels:
- `capitulation`: SOPR < 0.97
- `profit_taking`: SOPR > 1.03 AND 30d-avg > 1.03
- `hodl_dominant`: 30d-avg of |daily LTH net position change| / lthSupply < 0.05% (i.e. cohort is essentially still)
- `neutral_spending`: everything else

### HODL waves age bands

| Band | Range (days) |
|---|---|
| `under_1m` | [0, 30) |
| `1m_3m` | [30, 90) |
| `3m_6m` | [90, 180) |
| `6m_12m` | [180, 365) |
| `1y_2y` | [365, 730) |
| `2y_3y` | [730, 1095) |
| `3y_5y` | [1095, 1825) |
| `5y_7y` | [1825, 2555) |
| `7y_10y` | [2555, 3650) |
| `over_10y` | [3650, ∞) |

These match Glassnode's HODL waves dashboard exactly.

### Determinism guarantee

Re-running the indexer against a clean Postgres on the same date yields identical snapshot rows to the satoshi. The regime narrative is mechanically formatted from the structured fields — no LLM call, no randomness, no subjective judgement.

---

## Tier-S grant compliance

This implementation explicitly addresses every commitment from the [proposal](docs/proposal.md) and [Alex's approval email](docs/approval.md):

- ✅ **Self-maintained UTXO-age indexer back to 2018-01-01** — implemented as a deterministic Node.js worker that walks BigQuery's `crypto_bitcoin` per-event tables.
- ✅ **Glassnode-standard 155-day LTH/STH cohort definition** — default; configurable per-call via `cohortBoundaryDays`.
- ✅ **Sub-2-second cached latency** — MCP server reads from Postgres + Redis; never touches RPC at request time.
- ✅ **6 Query prompts + 2 Execute methods** — all 8 tools shipped; full `outputSchema` + `structuredContent` + `_meta` (`surface: "both"`, `queryEligible: true`, `latencyClass`, `pricing`, `rateLimit`).
- ✅ **Methodology transparency** — `methodology`, `methodologyVersion`, `cohortBoundaryDays`, `indexerVersion` on every response.
- ✅ **Freshness/provisional flags** — `dataFreshnessSeconds`, `freshnessWarning`, `provisional` on every response.
- ✅ **Public evidence URL** — every response includes a block-explorer URL anchoring its block height.
- ✅ **Context Protocol middleware wired in directly** — `createContextMiddleware()` mounted on `/mcp`; not commented out; `CONTEXT_AUTH_ENABLED=true` is the production default.
- ✅ **Deterministic regime narrative** — `regimeNarrative` is mechanically formatted from structured fields, not LLM-synthesized.

---

## License

MIT.
