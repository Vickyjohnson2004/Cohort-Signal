# MCP Tool Optimization Skill — checklist

Context Protocol's Tier S grants require running the [MCP Tool Optimization Skill](https://docs.ctxprotocol.com/) before submission. This is the working checklist for CohortSignal.

## Step 0 — Tool inventory

CohortSignal exposes 8 tools.

**Query (6):**
- `get_current_lth_sth_regime`
- `get_lth_supply_historical_context`
- `get_lth_net_position_change`
- `get_hodl_waves_distribution`
- `get_lth_sopr_signal`
- `get_combined_cohort_regime_brief`

**Execute (2):**
- `get_cohort_snapshot`
- `get_cohort_timeseries`

## Step 1 — Alpha research (the seven prompts)

For each Query tool, identify the canonical user prompt(s) it must win. Format: prompt + how a free LLM would answer it + how CohortSignal answers it.

(Filled in during the optimization session. See `docs/optimization-runs/` for snapshots.)

## Step 2 — Free-LLM baseline comparison

For each canonical prompt, capture the response of:
- ChatGPT (free tier)
- Claude.ai (free tier)
- Gemini (free tier)
- Perplexity (free)

Compare each to CohortSignal's response on:
- Numeric accuracy (LTH supply, SOPR, HODL waves percentages)
- Methodology transparency (does the LLM explain how it got the number?)
- Freshness (does the LLM know today's data?)
- Reproducibility (would two people get the same answer?)
- Evidence (does the answer cite a verifiable on-chain block?)

Expected: free LLMs **cannot reproduce CohortSignal's numeric accuracy** or surface methodology, and they refuse to answer for "today" because their training data is stale. CohortSignal answers with structured data, methodology, and a `evidenceURL` block-explorer link.

## Step 3 — Data quality checks

Run the integration test harness in `apps/mcp-server/test/` against a freshly-bootstrapped Postgres. Spot-check:
- LTH supply values at known cycle inflection points (e.g. ~14.4M at the 2024 ETF approval inflection) are within 0.1% of Glassnode's published numbers
- HODL waves percentages sum to 1.0 ± 1e-6 across all bands
- LTH-SOPR is in [0.5, 5] for every non-null daily reading
- `regimeChangeEvents` returned for the last 12 months align with widely-cited cycle inflection points

## Step 4 — Latency audit

For each tool, measure (a) cold cache, (b) warm cache, (c) bulk-call latencies. Targets:

| Tool | Cold | Warm | Notes |
|---|---|---|---|
| `get_current_lth_sth_regime` | < 800 ms | < 50 ms | Snapshot read + 91d window aggregation |
| `get_lth_supply_historical_context` | < 1500 ms | < 80 ms | Includes 12mo regime-change scan |
| `get_lth_net_position_change` | < 800 ms | < 50 ms | Same shape as current_regime |
| `get_hodl_waves_distribution` | < 800 ms | < 50 ms | Same |
| `get_lth_sopr_signal` | < 1000 ms | < 50 ms | Includes lookback for last cross |
| `get_combined_cohort_regime_brief` | < 1500 ms | < 80 ms | Sum of a single regime view + narrative |
| `get_cohort_snapshot` | < 800 ms | < 50 ms | Same as current_regime |
| `get_cohort_timeseries` | < 4000 ms | < 200 ms | Scales with date range |

## Step 5 — Iterative description tuning

For each tool, review the description string against:
- Does it answer the implicit user question?
- Does it lead with the differentiator vs. free LLMs?
- Does it surface the `methodology`, `provisional`, `evidenceURL` reliability hooks?
- Is it < 280 characters where possible (helps Context's discoverability)?

Iterate until the descriptions read naturally to a buyer with no Bitcoin-cohort domain knowledge.

## Step 6 — Optimization skill artifact

Submit the optimization-skill-output.json (or whatever Context expects) along with the listing.
