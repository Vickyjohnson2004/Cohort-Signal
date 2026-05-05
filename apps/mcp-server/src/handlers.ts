import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CohortToolError, DateInputError, parseAsOfDate } from "@cohortsignal/core/util";
import { DEFAULT_COHORT_BOUNDARY_DAYS } from "@cohortsignal/core";
import type { CohortService } from "./service.js";
import type { ToolName } from "./tools.js";

/**
 * Translate a CohortToolError or DateInputError into the canonical
 * structuredContent + isError MCP shape.
 */
function errorResult(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CallToolResult {
  const payload = {
    error: code,
    message,
    details: details ?? {},
  };
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: payload,
    isError: true,
  };
}

function ok<T extends Record<string, unknown>>(data: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function pickCohortBoundary(args: Record<string, unknown> | undefined): number {
  const v = args?.cohortBoundaryDays;
  if (v === undefined || v === null) return DEFAULT_COHORT_BOUNDARY_DAYS;
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COHORT_BOUNDARY_DAYS;
  if (n < 7 || n > 1825) {
    throw new CohortToolError(
      "invalid_input",
      `cohortBoundaryDays must be between 7 and 1825 days, got ${n}.`,
    );
  }
  return Math.floor(n);
}

function pickAsOfDate(args: Record<string, unknown> | undefined): string | undefined {
  const raw = args?.asOfDate;
  if (raw === undefined || raw === null || raw === "" || raw === "now") return undefined;
  return parseAsOfDate(raw).isoDate;
}

function pickStartDate(args: Record<string, unknown> | undefined): string {
  const raw = args?.startDate;
  if (raw === undefined || raw === null || raw === "") {
    throw new CohortToolError("invalid_input", "startDate is required.");
  }
  return parseAsOfDate(raw).isoDate;
}

function pickEndDate(args: Record<string, unknown> | undefined): string {
  const raw = args?.endDate;
  if (raw === undefined || raw === null || raw === "" || raw === "now") {
    return parseAsOfDate("now").isoDate;
  }
  return parseAsOfDate(raw).isoDate;
}

function pickMetric(
  args: Record<string, unknown> | undefined,
):
  | "lth_supply"
  | "sth_supply"
  | "lth_sopr"
  | "lth_net_position_change"
  | "hodl_waves" {
  const raw = args?.metric;
  if (
    raw === "lth_supply" ||
    raw === "sth_supply" ||
    raw === "lth_sopr" ||
    raw === "lth_net_position_change" ||
    raw === "hodl_waves"
  ) {
    return raw;
  }
  throw new CohortToolError(
    "invalid_input",
    `metric must be one of lth_supply, sth_supply, lth_sopr, lth_net_position_change, hodl_waves; got ${String(raw)}`,
  );
}

function pickGranularity(args: Record<string, unknown> | undefined): "daily" | "weekly" {
  const raw = args?.granularity ?? "daily";
  if (raw !== "daily" && raw !== "weekly") {
    throw new CohortToolError("invalid_input", `granularity must be daily or weekly`);
  }
  return raw;
}

export async function callTool(
  service: CohortService,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  try {
    switch (name as ToolName) {
      case "get_current_lth_sth_regime":
      case "get_combined_cohort_regime_brief":
      case "get_cohort_snapshot": {
        const view = await service.getRegimeView({
          asOfDate: pickAsOfDate(args),
          cohortBoundaryDays: pickCohortBoundary(args),
        });
        return ok(view as unknown as Record<string, unknown>);
      }

      case "get_lth_supply_historical_context": {
        const ctx = await service.getHistoricalContext({
          asOfDate: pickAsOfDate(args),
          cohortBoundaryDays: pickCohortBoundary(args),
        });
        return ok(ctx as unknown as Record<string, unknown>);
      }

      case "get_lth_net_position_change": {
        const view = await service.getRegimeView({
          asOfDate: pickAsOfDate(args),
          cohortBoundaryDays: pickCohortBoundary(args),
        });
        const payload = {
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
          evidenceURL: view.evidenceURL,
          lthNetPositionChangeCurrent: view.lthNetPositionChangeBtc7dAvg, // 7d centroid ≈ "current"
          lthNetPositionChange7dAvg: view.lthNetPositionChangeBtc7dAvg,
          lthNetPositionChange30dAvg: view.lthNetPositionChangeBtc30dAvg,
          lthNetPositionChange90dAvg: view.lthNetPositionChangeBtc90dAvg,
          trend: view.trend,
          regimeClassifier: view.regimeClassifier,
        };
        return ok(payload);
      }

      case "get_hodl_waves_distribution": {
        const view = await service.getRegimeView({
          asOfDate: pickAsOfDate(args),
          cohortBoundaryDays: pickCohortBoundary(args),
        });
        const payload = {
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
          evidenceURL: view.evidenceURL,
          hodlWaves: view.hodlWaves,
          hodlWavesDelta30d: view.hodlWavesDelta30d,
          hodlWavesDelta90d: view.hodlWavesDelta90d,
          dominantBand: view.dominantBand,
        };
        return ok(payload);
      }

      case "get_lth_sopr_signal": {
        const ctx = await service.getLthSoprContext({
          asOfDate: pickAsOfDate(args),
          cohortBoundaryDays: pickCohortBoundary(args),
        });
        return ok(ctx as unknown as Record<string, unknown>);
      }

      case "get_cohort_timeseries": {
        const series = await service.getCohortTimeseries({
          startDate: pickStartDate(args),
          endDate: pickEndDate(args),
          metric: pickMetric(args),
          granularity: pickGranularity(args),
          cohortBoundaryDays: pickCohortBoundary(args),
        });
        return ok(series as unknown as Record<string, unknown>);
      }

      default:
        return errorResult("invalid_input", `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof CohortToolError) {
      return errorResult(err.code, err.message, err.details);
    }
    if (err instanceof DateInputError) {
      return errorResult(err.code, err.message);
    }
    console.error("[handlers] unexpected error", { name, err });
    return errorResult("internal_error", (err as Error).message ?? "internal_error");
  }
}
