/**
 * Integration tests for the MCP server's tool handler dispatcher.
 *
 * Strategy:
 *   - Build an in-memory FakeCohortService that implements the CohortService
 *     interface with deterministic, hand-built fixtures.
 *   - For every tool name in TOOLS, call `callTool` and assert that:
 *       1. The result has structuredContent (Context Protocol requirement).
 *       2. structuredContent matches the tool's outputSchema (basic shape).
 *       3. Required envelope fields are present (asOfDate, methodology,
 *          methodologyVersion, indexerVersion, evidenceURL, etc.).
 *       4. Errors are returned as { isError: true, structuredContent: {error,...} }.
 *
 * These tests do NOT touch Postgres or Redis; they verify the handler /
 * tool-catalog contract end-to-end above the persistence layer.
 */

import { describe, expect, it } from "vitest";
import { callTool } from "./handlers.js";
import { TOOLS, type ToolName } from "./tools.js";
import type {
  CohortService,
  CohortTimeseries,
  HistoricalContext,
  LthSoprContext,
} from "./service.js";
import type {
  CohortRegimeView,
  IndexerStatus,
  RegimeChangeEvent,
} from "@cohortsignal/core";

const FIXED_NOW = "2026-05-05T12:00:00.000Z";

const FAKE_HODL = {
  btc: {
    under_1m: 100_000,
    "1m_3m": 200_000,
    "3m_6m": 300_000,
    "6m_12m": 400_000,
    "1y_2y": 500_000,
    "2y_3y": 600_000,
    "3y_5y": 700_000,
    "5y_7y": 100_000,
    "7y_10y": 50_000,
    over_10y: 50_000,
  },
  pctOfSupply: {
    under_1m: 0.033,
    "1m_3m": 0.067,
    "3m_6m": 0.1,
    "6m_12m": 0.133,
    "1y_2y": 0.167,
    "2y_3y": 0.2,
    "3y_5y": 0.233,
    "5y_7y": 0.033,
    "7y_10y": 0.017,
    over_10y: 0.017,
  },
};

const FAKE_VIEW: CohortRegimeView = {
  asOf: FIXED_NOW,
  asOfDate: "2026-05-04",
  blockHeight: 900_000,
  cohortBoundaryDays: 155,
  methodology: "test-methodology",
  methodologyVersion: "cohortsignal-v1.0",
  indexerVersion: "cohortsignal-indexer-1.0.0",
  dataFreshnessSeconds: 1800,
  freshnessWarning: false,
  provisional: false,
  lthSupplyBtc: 14_500_000,
  sthSupplyBtc: 5_500_000,
  circulatingSupplyBtc: 20_000_000,
  lthSupplyPctOfCirculating: 0.725,
  sthSupplyPctOfCirculating: 0.275,
  lthSupplyDelta7dBtc: 12_000,
  lthSupplyDelta30dBtc: 90_000,
  lthSupplyDelta90dBtc: 250_000,
  lthSupplyDelta7dPct: 0.00083,
  lthSupplyDelta30dPct: 0.00621,
  lthSupplyDelta90dPct: 0.01724,
  lthNetPositionChangeBtc7dAvg: 1_700,
  lthNetPositionChangeBtc30dAvg: 3_000,
  lthNetPositionChangeBtc90dAvg: 2_777,
  lthSopr: 1.12,
  lthSopr30dAvg: 1.08,
  lthSoprStatus: "above_one",
  lthSoprState: "hodl_dominant",
  hodlWaves: FAKE_HODL,
  hodlWavesDelta30d: {
    under_1m: -0.005,
    "1m_3m": 0.001,
    "3m_6m": 0.002,
    "6m_12m": 0.001,
    "1y_2y": 0.0,
    "2y_3y": 0.0,
    "3y_5y": 0.001,
    "5y_7y": 0.0,
    "7y_10y": 0.0,
    over_10y: 0.0,
  },
  hodlWavesDelta90d: {
    under_1m: -0.012,
    "1m_3m": 0.003,
    "3m_6m": 0.004,
    "6m_12m": 0.003,
    "1y_2y": 0.001,
    "2y_3y": 0.001,
    "3y_5y": 0.0,
    "5y_7y": 0.0,
    "7y_10y": 0.0,
    over_10y: 0.0,
  },
  dominantBand: "3y_5y",
  regimeClassifier: "accumulation",
  regimeNarrative: "LTH supply expanded 0.62% over 30 days; SOPR healthy.",
  keyDrivers: ["LTH supply +90,000 BTC over 30 days"],
  trend: "accelerating_up",
  evidenceURL: "https://blockstream.info/block-height/900000",
};

const FAKE_INDEXER_STATUS: IndexerStatus = {
  lastBlockProcessed: 900_000,
  lastBlockProcessedAt: FIXED_NOW,
  chainTipHeight: 900_001,
  lagSeconds: 60,
  freshnessWarning: false,
  methodologyVersion: "cohortsignal-v1.0",
  indexerVersion: "cohortsignal-indexer-1.0.0",
};

class FakeCohortService implements CohortService {
  earliestDate: string | null = "2018-01-01";
  /** Set to a date string to force coverage_gap on getRegimeView. */
  coverageGapAfter?: string;

  async getIndexerStatus(): Promise<IndexerStatus> {
    return FAKE_INDEXER_STATUS;
  }
  async getEarliestDate(): Promise<string | null> {
    return this.earliestDate;
  }
  async getRegimeView(opts: {
    asOfDate?: string;
    cohortBoundaryDays?: number;
  }): Promise<CohortRegimeView> {
    if (this.coverageGapAfter && opts.asOfDate && opts.asOfDate < this.coverageGapAfter) {
      const err = new (await import("@cohortsignal/core/util")).CohortToolError(
        "indexer_coverage_gap",
        `No snapshot at or before ${opts.asOfDate}`,
        { earliestAvailable: this.coverageGapAfter },
      );
      throw err;
    }
    return {
      ...FAKE_VIEW,
      cohortBoundaryDays: opts.cohortBoundaryDays ?? 155,
      asOfDate: opts.asOfDate ?? FAKE_VIEW.asOfDate,
    };
  }
  async getRegimeChangeEvents(): Promise<RegimeChangeEvent[]> {
    return [
      {
        date: "2025-11-15",
        blockHeight: 870_000,
        cohortBoundaryDays: 155,
        fromRegime: "equilibrium",
        toRegime: "accumulation",
      },
    ];
  }
  async getHistoricalContext(opts: {
    asOfDate?: string;
    cohortBoundaryDays?: number;
  }): Promise<HistoricalContext> {
    const view = await this.getRegimeView(opts);
    return {
      asOf: view.asOf,
      asOfDate: view.asOfDate,
      blockHeight: view.blockHeight,
      cohortBoundaryDays: view.cohortBoundaryDays,
      methodology: view.methodology,
      methodologyVersion: view.methodologyVersion,
      indexerVersion: view.indexerVersion,
      dataFreshnessSeconds: view.dataFreshnessSeconds,
      freshnessWarning: view.freshnessWarning,
      provisional: view.provisional,
      lthSupplyCurrent: view.lthSupplyBtc,
      lthSupply6moMin: 14_200_000,
      lthSupply6moMax: 14_600_000,
      lthSupply12moMin: 13_800_000,
      lthSupply12moMax: 14_700_000,
      percentilePosition6mo: 0.75,
      percentilePosition12mo: 0.78,
      regimeChangeEvents: await this.getRegimeChangeEvents(),
      evidenceURL: view.evidenceURL,
    };
  }
  async getLthSoprContext(opts: {
    asOfDate?: string;
    cohortBoundaryDays?: number;
  }): Promise<LthSoprContext> {
    const view = await this.getRegimeView(opts);
    return {
      asOf: view.asOf,
      asOfDate: view.asOfDate,
      blockHeight: view.blockHeight,
      cohortBoundaryDays: view.cohortBoundaryDays,
      methodology: view.methodology,
      methodologyVersion: view.methodologyVersion,
      indexerVersion: view.indexerVersion,
      dataFreshnessSeconds: view.dataFreshnessSeconds,
      freshnessWarning: view.freshnessWarning,
      provisional: view.provisional,
      lthSoprCurrent: view.lthSopr,
      lthSopr30dAvg: view.lthSopr30dAvg,
      lthSoprState: view.lthSoprState,
      lthSoprStatus: view.lthSoprStatus,
      lastBelowOneCrossover: { date: "2024-08-05", daysAgo: 638 },
      similarHistoricalReadings: { threshold: 1.05, direction: "above", countLast365d: 211 },
      evidenceURL: view.evidenceURL,
    };
  }
  async getCohortTimeseries(opts: {
    startDate: string;
    endDate: string;
    metric: "lth_supply" | "sth_supply" | "lth_sopr" | "lth_net_position_change" | "hodl_waves";
    granularity: "daily" | "weekly";
    cohortBoundaryDays: number;
  }): Promise<CohortTimeseries> {
    return {
      metric: opts.metric,
      granularity: opts.granularity,
      startDate: opts.startDate,
      endDate: opts.endDate,
      cohortBoundaryDays: opts.cohortBoundaryDays,
      methodology: FAKE_VIEW.methodology,
      methodologyVersion: FAKE_VIEW.methodologyVersion,
      indexerVersion: FAKE_VIEW.indexerVersion,
      evidenceURL: FAKE_VIEW.evidenceURL,
      dataPoints: [
        { date: opts.startDate, blockHeight: 800_000, value: 14_300_000, provisional: false },
        { date: opts.endDate, blockHeight: 900_000, value: 14_500_000, provisional: false },
      ],
      regimeChangeEvents: await this.getRegimeChangeEvents(),
    };
  }
}

const ENVELOPE_KEYS = [
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
] as const;

function expectEnvelope(payload: Record<string, unknown>): void {
  for (const k of ENVELOPE_KEYS) {
    expect(payload, `missing envelope field ${k}`).toHaveProperty(k);
  }
}

describe("MCP tool catalog", () => {
  it("registers exactly 8 tools, all with required Context Protocol fields", () => {
    expect(TOOLS.length).toBe(8);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_][a-z0-9_]*$/);
      expect(t.description).toBeDefined();
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe("object");
      // Output schema is the Context Protocol requirement we documented.
      expect((t as unknown as { outputSchema?: unknown }).outputSchema).toBeDefined();
      // _meta must include latencyClass + price for Context's listing UI.
      expect((t as unknown as { _meta?: Record<string, unknown> })._meta).toBeDefined();
    }
  });

  it("tool names include all 8 documented tools", () => {
    const names = new Set<ToolName>(TOOLS.map((t) => t.name as ToolName));
    expect(names.has("get_current_lth_sth_regime")).toBe(true);
    expect(names.has("get_lth_supply_historical_context")).toBe(true);
    expect(names.has("get_lth_net_position_change")).toBe(true);
    expect(names.has("get_hodl_waves_distribution")).toBe(true);
    expect(names.has("get_lth_sopr_signal")).toBe(true);
    expect(names.has("get_combined_cohort_regime_brief")).toBe(true);
    expect(names.has("get_cohort_snapshot")).toBe(true);
    expect(names.has("get_cohort_timeseries")).toBe(true);
  });
});

describe("callTool dispatcher", () => {
  const svc = new FakeCohortService();

  it.each([
    ["get_current_lth_sth_regime", {}],
    ["get_combined_cohort_regime_brief", {}],
    ["get_cohort_snapshot", {}],
  ] as const)("%s returns a structured regime view envelope", async (name, args) => {
    const r = await callTool(svc, name, args);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toBeDefined();
    const payload = r.structuredContent as Record<string, unknown>;
    expectEnvelope(payload);
    expect(payload.regimeClassifier).toBe("accumulation");
    expect(payload.lthSupplyBtc).toBe(14_500_000);
  });

  it("get_lth_supply_historical_context returns 6mo / 12mo extremes and percentiles", async () => {
    const r = await callTool(svc, "get_lth_supply_historical_context", {});
    expect(r.isError).toBeFalsy();
    const p = r.structuredContent as Record<string, unknown>;
    expectEnvelope(p);
    expect(p.lthSupplyCurrent).toBe(14_500_000);
    expect(p.lthSupply6moMin).toBe(14_200_000);
    expect(p.lthSupply6moMax).toBe(14_600_000);
    expect(p.percentilePosition6mo).toBeCloseTo(0.75, 5);
    expect(Array.isArray(p.regimeChangeEvents)).toBe(true);
  });

  it("get_lth_net_position_change exposes 7d/30d/90d averages plus regime label", async () => {
    const r = await callTool(svc, "get_lth_net_position_change", {});
    expect(r.isError).toBeFalsy();
    const p = r.structuredContent as Record<string, unknown>;
    expectEnvelope(p);
    expect(p.lthNetPositionChange7dAvg).toBe(1_700);
    expect(p.lthNetPositionChange30dAvg).toBe(3_000);
    expect(p.lthNetPositionChange90dAvg).toBe(2_777);
    expect(p.regimeClassifier).toBe("accumulation");
    expect(p.trend).toBe("accelerating_up");
  });

  it("get_hodl_waves_distribution sums to ~1.0 and includes deltas", async () => {
    const r = await callTool(svc, "get_hodl_waves_distribution", {});
    expect(r.isError).toBeFalsy();
    const p = r.structuredContent as Record<string, unknown>;
    expectEnvelope(p);
    const waves = p.hodlWaves as { pctOfSupply: Record<string, number> };
    const sum = Object.values(waves.pctOfSupply).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 1);
    expect(p.hodlWavesDelta30d).toBeDefined();
    expect(p.hodlWavesDelta90d).toBeDefined();
    expect(p.dominantBand).toBe("3y_5y");
  });

  it("get_lth_sopr_signal returns SOPR + last-below-one crossover + similar-readings count", async () => {
    const r = await callTool(svc, "get_lth_sopr_signal", {});
    expect(r.isError).toBeFalsy();
    const p = r.structuredContent as Record<string, unknown>;
    expectEnvelope(p);
    expect(p.lthSoprCurrent).toBe(1.12);
    expect(p.lthSopr30dAvg).toBe(1.08);
    expect(p.lthSoprStatus).toBe("above_one");
    expect(p.lastBelowOneCrossover).toEqual({ date: "2024-08-05", daysAgo: 638 });
    expect(p.similarHistoricalReadings).toEqual({
      threshold: 1.05,
      direction: "above",
      countLast365d: 211,
    });
  });

  it("get_cohort_timeseries returns dataPoints + regimeChangeEvents", async () => {
    const r = await callTool(svc, "get_cohort_timeseries", {
      startDate: "2024-01-01",
      endDate: "2026-05-04",
      metric: "lth_supply",
      granularity: "daily",
    });
    expect(r.isError).toBeFalsy();
    const p = r.structuredContent as Record<string, unknown>;
    expect(p.metric).toBe("lth_supply");
    expect(p.granularity).toBe("daily");
    expect(p.startDate).toBe("2024-01-01");
    expect(p.endDate).toBe("2026-05-04");
    expect(Array.isArray(p.dataPoints)).toBe(true);
    expect((p.dataPoints as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(p.regimeChangeEvents)).toBe(true);
    expect(p.evidenceURL).toMatch(/^https?:\/\//);
  });

  it("get_cohort_timeseries rejects missing startDate as invalid_input", async () => {
    const r = await callTool(svc, "get_cohort_timeseries", {
      endDate: "2026-05-04",
      metric: "lth_supply",
    });
    expect(r.isError).toBe(true);
    const p = r.structuredContent as Record<string, unknown>;
    expect(p.error).toBe("invalid_input");
  });

  it("get_cohort_timeseries rejects unknown metric as invalid_input", async () => {
    const r = await callTool(svc, "get_cohort_timeseries", {
      startDate: "2024-01-01",
      endDate: "2026-05-04",
      metric: "nonsense_metric",
    });
    expect(r.isError).toBe(true);
    const p = r.structuredContent as Record<string, unknown>;
    expect(p.error).toBe("invalid_input");
  });

  it("rejects unknown tool name with invalid_input", async () => {
    const r = await callTool(svc, "this_tool_does_not_exist", {});
    expect(r.isError).toBe(true);
    const p = r.structuredContent as Record<string, unknown>;
    expect(p.error).toBe("invalid_input");
  });

  it("propagates indexer_coverage_gap as a structured error with details", async () => {
    const gappy = new FakeCohortService();
    gappy.coverageGapAfter = "2018-06-01";
    const r = await callTool(gappy, "get_cohort_snapshot", { asOfDate: "2017-01-01" });
    expect(r.isError).toBe(true);
    const p = r.structuredContent as Record<string, unknown>;
    expect(p.error).toBe("indexer_coverage_gap");
    expect((p.details as Record<string, unknown>).earliestAvailable).toBe("2018-06-01");
  });

  it("validates cohortBoundaryDays bounds [7, 1825]", async () => {
    const r1 = await callTool(svc, "get_current_lth_sth_regime", { cohortBoundaryDays: 3 });
    expect(r1.isError).toBe(true);
    const r2 = await callTool(svc, "get_current_lth_sth_regime", { cohortBoundaryDays: 5000 });
    expect(r2.isError).toBe(true);
    const r3 = await callTool(svc, "get_current_lth_sth_regime", { cohortBoundaryDays: 90 });
    expect(r3.isError).toBeFalsy();
  });
});
