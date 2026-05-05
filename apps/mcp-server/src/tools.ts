/**
 * Tool catalog for the CohortSignal MCP server.
 *
 * Six Query prompts and two Execute methods, all with strict outputSchema
 * + structuredContent + _meta as required by Context Protocol. The
 * methodology, cohort boundary, indexer version, freshness fields, and
 * an evidence URL pointing at a public block-explorer query are returned
 * on every successful response.
 *
 * Pricing model:
 *   - Listing response price: $0.10 (~5 minutes of Glassnode dashboard work
 *     unbundled into one structured answer).
 *   - Per-method execute price: $0.001 (1/100 of listing per Context's
 *     guidance, reflecting that one Query response can fan out to up to
 *     100 method calls).
 *
 * Latency classification:
 *   - All methods serve from pre-computed Postgres rows (+ Redis cache).
 *     They never touch Bitcoin RPC at request time. Hence latencyClass:
 *     "instant" for snapshot reads and "fast" for time-series queries
 *     (which scan a date range).
 */

import { DEFAULT_COHORT_BOUNDARY_DAYS } from "@cohortsignal/core";
import { HODL_AGE_BANDS } from "@cohortsignal/core/schemas";

export const EXECUTE_PRICE_USD = "0.001";
export const LISTING_RESPONSE_PRICE_USD = "0.10";

const HODL_BAND_KEYS = HODL_AGE_BANDS;

const HODL_OBJECT_SCHEMA = {
  type: "object",
  description:
    "HODL waves distribution. Each key is an age band; values are fractions of total circulating supply (sum across keys ≈ 1.0).",
  properties: Object.fromEntries(
    HODL_BAND_KEYS.map((b) => [
      b,
      {
        type: "number",
        description: `Fraction of supply in age band ${b} (0..1).`,
      },
    ]),
  ),
  required: [...HODL_BAND_KEYS],
} as const;

const HODL_BTC_OBJECT_SCHEMA = {
  type: "object",
  description: "HODL waves BTC values per age band.",
  properties: Object.fromEntries(
    HODL_BAND_KEYS.map((b) => [
      b,
      { type: "number", description: `BTC supply in age band ${b}.` },
    ]),
  ),
  required: [...HODL_BAND_KEYS],
} as const;

const HODL_DELTA_OBJECT_SCHEMA = {
  type: "object",
  description:
    "Change in HODL waves percent share per age band (current_pct - prior_pct, expressed as a fraction).",
  properties: Object.fromEntries(
    HODL_BAND_KEYS.map((b) => [
      b,
      {
        type: "number",
        description: `Signed change in fraction-of-supply for age band ${b} (e.g. +0.012 means +1.2pp).`,
      },
    ]),
  ),
  required: [...HODL_BAND_KEYS],
} as const;

const COMMON_META_HEADER_FIELDS = {
  asOf: {
    type: "string",
    description:
      "ISO-8601 UTC timestamp at which the response was assembled (cache hit safe; reflects logical retrieval time).",
  },
  asOfDate: {
    type: "string",
    description:
      "ISO date (YYYY-MM-DD) of the cohort snapshot used. Matches the requested asOfDate or the latest available date if the request was open-ended.",
  },
  blockHeight: {
    type: "number",
    description:
      "Bitcoin block height the snapshot was computed at (last block of the snapshot's UTC day).",
  },
  cohortBoundaryDays: {
    type: "number",
    description:
      "UTXO age (in days) used to separate LTH from STH for this response. Default is 155 (Glassnode-standard).",
  },
  methodology: {
    type: "string",
    description:
      "Plain-English methodology summary (deterministic, surfaced verbatim from CohortSignal's published rules).",
  },
  methodologyVersion: {
    type: "string",
    description: "Versioned identifier for the methodology rules.",
  },
  indexerVersion: {
    type: "string",
    description: "Versioned identifier for the UTXO-age indexer that produced these snapshots.",
  },
  dataFreshnessSeconds: {
    type: "number",
    description:
      "Total seconds between now and the chain time of the underlying snapshot, including any indexer lag.",
  },
  freshnessWarning: {
    type: "boolean",
    description:
      "True if the indexer is more than INDEXER_FRESHNESS_WARNING_SECONDS (default 4h) behind the chain tip.",
  },
  provisional: {
    type: "boolean",
    description:
      "True for snapshots whose underlying chain tip has fewer than 6 confirmations. Subject to revision on reorg.",
  },
  evidenceURL: {
    type: "string",
    description:
      "Public block-explorer URL anchoring the snapshot's block height. Lets any user verify the cohort sums against the chain.",
  },
};

const REGIME_VIEW_PROPERTIES = {
  ...COMMON_META_HEADER_FIELDS,
  lthSupplyBtc: {
    type: "number",
    description: "Total long-term-holder supply in BTC at this snapshot.",
  },
  sthSupplyBtc: {
    type: "number",
    description: "Total short-term-holder supply in BTC at this snapshot.",
  },
  circulatingSupplyBtc: {
    type: "number",
    description: "Total issued (circulating) BTC supply at this block height.",
  },
  lthSupplyPctOfCirculating: {
    type: "number",
    description: "LTH supply / circulating supply, in [0, 1].",
  },
  sthSupplyPctOfCirculating: {
    type: "number",
    description: "STH supply / circulating supply, in [0, 1].",
  },
  lthSupplyDelta7dBtc: { type: "number", description: "LTH supply change vs 7 days ago (BTC, signed)." },
  lthSupplyDelta30dBtc: { type: "number", description: "LTH supply change vs 30 days ago (BTC, signed)." },
  lthSupplyDelta90dBtc: { type: "number", description: "LTH supply change vs 90 days ago (BTC, signed)." },
  lthSupplyDelta7dPct: { type: "number", description: "LTH supply % change vs 7 days ago (signed fraction)." },
  lthSupplyDelta30dPct: { type: "number", description: "LTH supply % change vs 30 days ago (signed fraction)." },
  lthSupplyDelta90dPct: { type: "number", description: "LTH supply % change vs 90 days ago (signed fraction)." },
  lthNetPositionChangeBtc7dAvg: {
    type: "number",
    description: "Mean daily LTH net position change (BTC) over the trailing 7d window.",
  },
  lthNetPositionChangeBtc30dAvg: {
    type: "number",
    description: "Mean daily LTH net position change (BTC) over the trailing 30d window.",
  },
  lthNetPositionChangeBtc90dAvg: {
    type: "number",
    description: "Mean daily LTH net position change (BTC) over the trailing 90d window.",
  },
  lthSopr: {
    type: ["number", "null"],
    description: "LTH-SOPR for this date; null if no LTH spends were observed.",
  },
  lthSopr30dAvg: {
    type: ["number", "null"],
    description: "Mean LTH-SOPR over the trailing 30 days; null if no readings exist in the window.",
  },
  lthSoprStatus: {
    type: "string",
    enum: ["above_one", "below_one", "neutral"],
    description: "Bucketed LTH-SOPR status (>1.005 / <0.995 / between).",
  },
  lthSoprState: {
    type: "string",
    enum: ["capitulation", "profit_taking", "neutral_spending", "hodl_dominant"],
    description: "Behavioral state derived from LTH-SOPR + 30d-avg + net-position context.",
  },
  hodlWaves: {
    type: "object",
    description: "Current HODL waves distribution (BTC and pct per band).",
    properties: {
      btc: HODL_BTC_OBJECT_SCHEMA,
      pctOfSupply: HODL_OBJECT_SCHEMA,
    },
    required: ["btc", "pctOfSupply"],
  },
  hodlWavesDelta30d: HODL_DELTA_OBJECT_SCHEMA,
  hodlWavesDelta90d: HODL_DELTA_OBJECT_SCHEMA,
  dominantBand: {
    type: "string",
    enum: [...HODL_BAND_KEYS],
    description: "The single age band with the largest share of circulating supply at this snapshot.",
  },
  regimeClassifier: {
    type: "string",
    enum: ["accumulation", "equilibrium", "distribution"],
    description:
      "Deterministic regime label. See the methodology field for the full decision tree.",
  },
  regimeNarrative: {
    type: "string",
    description:
      "Deterministic prose summary built mechanically from the structured fields. NOT LLM-generated.",
  },
  keyDrivers: {
    type: "array",
    items: { type: "string" },
    description:
      "The 2-3 metrics whose trailing-30d deviation most strongly informs the current regime call.",
  },
  trend: {
    type: "string",
    enum: [
      "accelerating_up",
      "decelerating_up",
      "flat",
      "accelerating_down",
      "decelerating_down",
    ],
    description: "Cross-window trend over (7d, 30d, 90d) LTH supply % deltas.",
  },
} as const;

const REGIME_VIEW_REQUIRED = [
  "asOf",
  "asOfDate",
  "blockHeight",
  "cohortBoundaryDays",
  "methodology",
  "methodologyVersion",
  "indexerVersion",
  "dataFreshnessSeconds",
  "freshnessWarning",
  "provisional",
  "evidenceURL",
  "lthSupplyBtc",
  "sthSupplyBtc",
  "circulatingSupplyBtc",
  "lthSupplyPctOfCirculating",
  "sthSupplyPctOfCirculating",
  "lthSupplyDelta7dBtc",
  "lthSupplyDelta30dBtc",
  "lthSupplyDelta90dBtc",
  "lthSupplyDelta7dPct",
  "lthSupplyDelta30dPct",
  "lthSupplyDelta90dPct",
  "lthNetPositionChangeBtc7dAvg",
  "lthNetPositionChangeBtc30dAvg",
  "lthNetPositionChangeBtc90dAvg",
  "lthSoprStatus",
  "lthSoprState",
  "hodlWaves",
  "hodlWavesDelta30d",
  "hodlWavesDelta90d",
  "dominantBand",
  "regimeClassifier",
  "regimeNarrative",
  "keyDrivers",
  "trend",
];

// ---------- Common input fragments ----------

const ASOF_DATE_INPUT = {
  type: "string",
  description:
    "Optional. ISO date (YYYY-MM-DD), ISO timestamp, or relative keyword: 'now', 'today', 'yesterday'. Defaults to the most recent indexed snapshot.",
  default: "now",
  examples: ["now", "yesterday", "2024-11-01", "2025-03-12T00:00:00Z"],
};

const COHORT_BOUNDARY_INPUT = {
  type: "number",
  description:
    "Optional. UTXO age (in days) separating LTH from STH. Defaults to 155 (Glassnode standard). Use 90 for a tighter boundary or 365 for a stricter one.",
  default: DEFAULT_COHORT_BOUNDARY_DAYS,
  examples: [155, 90, 180, 365],
};

const STD_META_BOTH = {
  surface: "both" as const,
  queryEligible: true,
  latencyClass: "instant" as const,
  pricing: { executeUsd: EXECUTE_PRICE_USD },
  rateLimit: {
    maxRequestsPerMinute: 240,
    cooldownMs: 0,
    maxConcurrency: 16,
    supportsBulk: true,
    notes:
      "All methods serve from pre-computed Postgres + Redis cache. No upstream RPC at request time.",
  },
};

const TIMESERIES_META = {
  ...STD_META_BOTH,
  latencyClass: "fast" as const,
  rateLimit: {
    maxRequestsPerMinute: 60,
    cooldownMs: 100,
    maxConcurrency: 4,
    supportsBulk: false,
    notes:
      "Time-series queries scan a date range from Postgres. Prefer get_cohort_snapshot for one-shot questions about a single date.",
  },
};

// =============================================================================
// QUERY PROMPT TOOLS — six Query-primary methods, each shaped for a single
// must-win prompt from the proposal. They share an underlying view but slice
// it differently so the runtime can pick the right one.
// =============================================================================

export const TOOLS = [
  // ---------------------------------------------------------------------------
  // Query 1 — current LTH/STH regime call
  // ---------------------------------------------------------------------------
  {
    name: "get_current_lth_sth_regime",
    description:
      "Whether Bitcoin long-term holders are accumulating, in equilibrium, or distributing right now. Returns LTH and STH supply levels, the LTH supply 7d/30d/90d deltas, LTH-SOPR with status, and a deterministic regime classifier with a published rule-set. Sourced from a self-maintained UTXO-age indexer using the Glassnode-standard 155-day cohort definition.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: ASOF_DATE_INPUT,
        cohortBoundaryDays: COHORT_BOUNDARY_INPUT,
      },
    },
    outputSchema: {
      type: "object",
      properties: REGIME_VIEW_PROPERTIES,
      required: REGIME_VIEW_REQUIRED,
    },
    _meta: STD_META_BOTH,
  },

  // ---------------------------------------------------------------------------
  // Query 2 — historical regime context
  // ---------------------------------------------------------------------------
  {
    name: "get_lth_supply_historical_context",
    description:
      "How today's Bitcoin LTH supply compares to its 6-month and 12-month range, with percentile position and a list of regime change events in the trailing 12 months. Useful for cycle-position calls and weekly research notes.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: ASOF_DATE_INPUT,
        cohortBoundaryDays: COHORT_BOUNDARY_INPUT,
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        ...COMMON_META_HEADER_FIELDS,
        lthSupplyCurrent: { type: "number", description: "Current LTH supply (BTC) at asOfDate." },
        lthSupply6moMin: { type: ["number", "null"], description: "Trailing 6-month minimum LTH supply (BTC)." },
        lthSupply6moMax: { type: ["number", "null"], description: "Trailing 6-month maximum LTH supply (BTC)." },
        lthSupply12moMin: { type: ["number", "null"], description: "Trailing 12-month minimum LTH supply (BTC)." },
        lthSupply12moMax: { type: ["number", "null"], description: "Trailing 12-month maximum LTH supply (BTC)." },
        percentilePosition6mo: {
          type: ["number", "null"],
          description: "Position of current LTH supply within trailing 6-month range, in [0, 1].",
        },
        percentilePosition12mo: {
          type: ["number", "null"],
          description: "Position of current LTH supply within trailing 12-month range, in [0, 1].",
        },
        regimeChangeEvents: {
          type: "array",
          description: "Dates within the trailing 12 months where the regime classifier flipped.",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "ISO date the flip was first observed." },
              blockHeight: { type: "number", description: "Block height at the date of the flip." },
              fromRegime: {
                type: "string",
                enum: ["accumulation", "equilibrium", "distribution"],
              },
              toRegime: {
                type: "string",
                enum: ["accumulation", "equilibrium", "distribution"],
              },
              cohortBoundaryDays: { type: "number" },
            },
            required: ["date", "blockHeight", "fromRegime", "toRegime", "cohortBoundaryDays"],
          },
        },
      },
      required: [
        "asOf",
        "asOfDate",
        "blockHeight",
        "cohortBoundaryDays",
        "methodology",
        "methodologyVersion",
        "indexerVersion",
        "dataFreshnessSeconds",
        "freshnessWarning",
        "provisional",
        "evidenceURL",
        "lthSupplyCurrent",
        "regimeChangeEvents",
      ],
    },
    _meta: STD_META_BOTH,
  },

  // ---------------------------------------------------------------------------
  // Query 3 — LTH net position change (trend)
  // ---------------------------------------------------------------------------
  {
    name: "get_lth_net_position_change",
    description:
      "The Bitcoin LTH net-position-change reading (BTC, signed) for the current day plus 7d/30d/90d rolling means, with a deterministic trend label (accelerating_up, decelerating_up, flat, decelerating_down, accelerating_down). Answers 'is LTH accumulation accelerating or decelerating?'.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: ASOF_DATE_INPUT,
        cohortBoundaryDays: COHORT_BOUNDARY_INPUT,
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        ...COMMON_META_HEADER_FIELDS,
        lthNetPositionChangeCurrent: {
          type: "number",
          description: "Trailing-24h LTH supply change in BTC (signed).",
        },
        lthNetPositionChange7dAvg: { type: "number" },
        lthNetPositionChange30dAvg: { type: "number" },
        lthNetPositionChange90dAvg: { type: "number" },
        trend: {
          type: "string",
          enum: [
            "accelerating_up",
            "decelerating_up",
            "flat",
            "accelerating_down",
            "decelerating_down",
          ],
        },
        regimeClassifier: {
          type: "string",
          enum: ["accumulation", "equilibrium", "distribution"],
        },
      },
      required: [
        "asOf",
        "asOfDate",
        "blockHeight",
        "cohortBoundaryDays",
        "methodology",
        "methodologyVersion",
        "indexerVersion",
        "dataFreshnessSeconds",
        "freshnessWarning",
        "provisional",
        "evidenceURL",
        "lthNetPositionChangeCurrent",
        "lthNetPositionChange7dAvg",
        "lthNetPositionChange30dAvg",
        "lthNetPositionChange90dAvg",
        "trend",
        "regimeClassifier",
      ],
    },
    _meta: STD_META_BOTH,
  },

  // ---------------------------------------------------------------------------
  // Query 4 — HODL waves snapshot + 30d/90d shifts
  // ---------------------------------------------------------------------------
  {
    name: "get_hodl_waves_distribution",
    description:
      "Bitcoin HODL waves distribution by age band (under_1m, 1m_3m, 3m_6m, 6m_12m, 1y_2y, 2y_3y, 3y_5y, 5y_7y, 7y_10y, over_10y), each with current pct of supply and 30d / 90d signed shifts. Identifies the dominant band and the band with the largest 30d move.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: ASOF_DATE_INPUT,
        cohortBoundaryDays: COHORT_BOUNDARY_INPUT,
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        ...COMMON_META_HEADER_FIELDS,
        hodlWaves: {
          type: "object",
          properties: {
            btc: HODL_BTC_OBJECT_SCHEMA,
            pctOfSupply: HODL_OBJECT_SCHEMA,
          },
          required: ["btc", "pctOfSupply"],
        },
        hodlWavesDelta30d: HODL_DELTA_OBJECT_SCHEMA,
        hodlWavesDelta90d: HODL_DELTA_OBJECT_SCHEMA,
        dominantBand: { type: "string", enum: [...HODL_BAND_KEYS] },
      },
      required: [
        "asOf",
        "asOfDate",
        "blockHeight",
        "cohortBoundaryDays",
        "methodology",
        "methodologyVersion",
        "indexerVersion",
        "dataFreshnessSeconds",
        "freshnessWarning",
        "provisional",
        "evidenceURL",
        "hodlWaves",
        "hodlWavesDelta30d",
        "hodlWavesDelta90d",
        "dominantBand",
      ],
    },
    _meta: STD_META_BOTH,
  },

  // ---------------------------------------------------------------------------
  // Query 5 — LTH-SOPR signal check
  // ---------------------------------------------------------------------------
  {
    name: "get_lth_sopr_signal",
    description:
      "LTH-SOPR (Spent Output Profit Ratio for UTXOs >= cohortBoundaryDays old) reading with status, behavioral state, 30d average, last cross-below-1.0 timestamp + days since, and a count of similar readings in the last 365 days. Tells you whether long-term holders are spending at a profit, a loss, or in capitulation.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: ASOF_DATE_INPUT,
        cohortBoundaryDays: COHORT_BOUNDARY_INPUT,
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        ...COMMON_META_HEADER_FIELDS,
        lthSoprCurrent: {
          type: ["number", "null"],
          description: "Current LTH-SOPR (null if no LTH spends today).",
        },
        lthSopr30dAvg: { type: ["number", "null"] },
        lthSoprStatus: {
          type: "string",
          enum: ["above_one", "below_one", "neutral"],
        },
        lthSoprState: {
          type: "string",
          enum: ["capitulation", "profit_taking", "neutral_spending", "hodl_dominant"],
        },
        lastBelowOneCrossover: {
          type: ["object", "null"],
          properties: {
            date: { type: "string", description: "ISO date of the last cross from >=1.0 to <1.0." },
            daysAgo: { type: "number" },
          },
          required: ["date", "daysAgo"],
        },
        similarHistoricalReadings: {
          type: "object",
          properties: {
            threshold: { type: "number" },
            direction: { type: "string", enum: ["below", "above"] },
            countLast365d: { type: "number" },
          },
          required: ["threshold", "direction", "countLast365d"],
        },
      },
      required: [
        "asOf",
        "asOfDate",
        "blockHeight",
        "cohortBoundaryDays",
        "methodology",
        "methodologyVersion",
        "indexerVersion",
        "dataFreshnessSeconds",
        "freshnessWarning",
        "provisional",
        "evidenceURL",
        "lthSoprStatus",
        "lthSoprState",
        "similarHistoricalReadings",
      ],
    },
    _meta: STD_META_BOTH,
  },

  // ---------------------------------------------------------------------------
  // Query 6 — combined regime brief
  // ---------------------------------------------------------------------------
  {
    name: "get_combined_cohort_regime_brief",
    description:
      "Full Bitcoin LTH/STH cohort regime brief: supply levels, net-position-change, LTH-SOPR state, HODL waves shifts, dominant band, deterministic regime classifier with deterministic prose summary, and 2-3 keyDrivers explaining the call. The single end-to-end answer for 'where are LTHs in the cycle right now?'.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: ASOF_DATE_INPUT,
        cohortBoundaryDays: COHORT_BOUNDARY_INPUT,
      },
    },
    outputSchema: {
      type: "object",
      properties: REGIME_VIEW_PROPERTIES,
      required: REGIME_VIEW_REQUIRED,
    },
    _meta: STD_META_BOTH,
  },

  // ---------------------------------------------------------------------------
  // Execute 1 — get_cohort_snapshot
  // ---------------------------------------------------------------------------
  {
    name: "get_cohort_snapshot",
    description:
      "Execute primitive: a single typed cohort snapshot at asOfDate (or latest). Returns the full structured cohort regime view with deterministic methodology and indexer status. Designed for SDK developers building backtests, research workflows, and downstream agent pipelines.",
    inputSchema: {
      type: "object",
      properties: {
        asOfDate: ASOF_DATE_INPUT,
        cohortBoundaryDays: COHORT_BOUNDARY_INPUT,
      },
    },
    outputSchema: {
      type: "object",
      properties: REGIME_VIEW_PROPERTIES,
      required: REGIME_VIEW_REQUIRED,
    },
    _meta: STD_META_BOTH,
  },

  // ---------------------------------------------------------------------------
  // Execute 2 — get_cohort_timeseries
  // ---------------------------------------------------------------------------
  {
    name: "get_cohort_timeseries",
    description:
      "Execute primitive: a daily- or weekly-granularity time-series of one cohort metric across [startDate, endDate]. Supported metrics: lth_supply, sth_supply, lth_sopr, lth_net_position_change, hodl_waves. Returns dataPoints + regimeChangeEvents + methodology + evidenceURL. Designed for backtests, charting, and historical comparisons.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Required. ISO date (YYYY-MM-DD) or ISO timestamp; window start, inclusive.",
          examples: ["2018-01-01", "2024-01-01", "2025-01-01"],
        },
        endDate: {
          type: "string",
          description:
            "Optional. ISO date or timestamp; window end, inclusive. Defaults to the most recent indexed snapshot.",
          default: "now",
          examples: ["now", "2025-12-31"],
        },
        metric: {
          type: "string",
          enum: [
            "lth_supply",
            "sth_supply",
            "lth_sopr",
            "lth_net_position_change",
            "hodl_waves",
          ],
          description:
            "Which metric to project across the date range. For hodl_waves, dataPoints[i].value is null and the band breakdown lives in dataPoints[i].bandBreakdown.",
          examples: ["lth_supply", "lth_sopr", "hodl_waves"],
        },
        granularity: {
          type: "string",
          enum: ["daily", "weekly"],
          description: "Daily snapshots are stored natively; weekly returns Sunday-of-week samples.",
          default: "daily",
          examples: ["daily", "weekly"],
        },
        cohortBoundaryDays: COHORT_BOUNDARY_INPUT,
      },
      required: ["startDate", "metric"],
    },
    outputSchema: {
      type: "object",
      properties: {
        metric: { type: "string" },
        granularity: { type: "string", enum: ["daily", "weekly"] },
        startDate: { type: "string" },
        endDate: { type: "string" },
        cohortBoundaryDays: { type: "number" },
        methodology: { type: "string" },
        methodologyVersion: { type: "string" },
        indexerVersion: { type: "string" },
        evidenceURL: { type: "string" },
        dataPoints: {
          type: "array",
          description: "One entry per granularity step. Sorted by date ascending.",
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "ISO date." },
              blockHeight: { type: "number" },
              value: {
                type: ["number", "null"],
                description:
                  "Value of the requested metric for this date. Null when the metric is hodl_waves (see bandBreakdown) or when the metric had no observations on this date (e.g. LTH-SOPR with no LTH spends).",
              },
              provisional: { type: "boolean" },
              bandBreakdown: {
                type: "object",
                description:
                  "Only present when metric=hodl_waves. Each key is an HODL waves age band; values are fractions of supply.",
                properties: Object.fromEntries(
                  HODL_BAND_KEYS.map((b) => [b, { type: "number" }]),
                ),
              },
            },
            required: ["date", "blockHeight", "value", "provisional"],
          },
        },
        regimeChangeEvents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              blockHeight: { type: "number" },
              fromRegime: {
                type: "string",
                enum: ["accumulation", "equilibrium", "distribution"],
              },
              toRegime: {
                type: "string",
                enum: ["accumulation", "equilibrium", "distribution"],
              },
              cohortBoundaryDays: { type: "number" },
            },
            required: ["date", "blockHeight", "fromRegime", "toRegime", "cohortBoundaryDays"],
          },
        },
      },
      required: [
        "metric",
        "granularity",
        "startDate",
        "endDate",
        "cohortBoundaryDays",
        "methodology",
        "methodologyVersion",
        "indexerVersion",
        "evidenceURL",
        "dataPoints",
        "regimeChangeEvents",
      ],
    },
    _meta: TIMESERIES_META,
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];
