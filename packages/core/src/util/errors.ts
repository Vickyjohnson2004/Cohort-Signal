/**
 * A small set of typed error classes the MCP server translates into
 * structured error responses (preserving isError: true and a structured
 * code field). We never throw raw Error objects across the MCP boundary.
 */

export type ErrorCode =
  | "future_date"
  | "indexer_coverage_gap"
  | "invalid_input"
  | "indexer_not_ready"
  | "stale_data"
  | "internal_error";

export class CohortToolError extends Error {
  override readonly name = "CohortToolError";
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
