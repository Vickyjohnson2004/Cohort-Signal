/**
 * Parse a flexible date input (ISO timestamp, plain date, or relative
 * keyword "now"/"today"/"yesterday"). Returns a UTC ISO date (YYYY-MM-DD).
 *
 * Throws on invalid or future dates; the caller is expected to translate
 * the error into a Context-friendly response.
 */
export class DateInputError extends Error {
  override readonly name = "DateInputError";
  constructor(
    message: string,
    public readonly code:
      | "future_date"
      | "invalid_format"
      | "out_of_range",
  ) {
    super(message);
  }
}

export interface ParsedDateInput {
  isoDate: string;
  isoTimestamp: string;
}

export function parseAsOfDate(input: unknown, nowIso?: string): ParsedDateInput {
  const now = nowIso ? new Date(nowIso) : new Date();
  if (input === undefined || input === null || input === "" || input === "now") {
    return { isoDate: toUtcIsoDate(now), isoTimestamp: now.toISOString() };
  }
  if (typeof input !== "string") {
    throw new DateInputError(`asOfDate must be a string, got ${typeof input}`, "invalid_format");
  }
  const lowered = input.trim().toLowerCase();
  if (lowered === "today" || lowered === "now") {
    return { isoDate: toUtcIsoDate(now), isoTimestamp: now.toISOString() };
  }
  if (lowered === "yesterday") {
    const y = new Date(now);
    y.setUTCDate(y.getUTCDate() - 1);
    return { isoDate: toUtcIsoDate(y), isoTimestamp: y.toISOString() };
  }
  // ISO date or timestamp
  const d = new Date(lowered);
  if (Number.isNaN(d.getTime())) {
    throw new DateInputError(
      `Could not parse asOfDate=${input}. Use 'YYYY-MM-DD' or an ISO timestamp.`,
      "invalid_format",
    );
  }
  if (d.getTime() > now.getTime() + 60_000) {
    throw new DateInputError(
      `asOfDate=${input} is in the future. The latest available date is ${toUtcIsoDate(now)}.`,
      "future_date",
    );
  }
  return { isoDate: toUtcIsoDate(d), isoTimestamp: d.toISOString() };
}

export function toUtcIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function diffDays(aIsoDate: string, bIsoDate: string): number {
  const a = new Date(`${aIsoDate}T00:00:00Z`).getTime();
  const b = new Date(`${bIsoDate}T00:00:00Z`).getTime();
  return Math.floor((a - b) / (1000 * 60 * 60 * 24));
}

export function shiftDateByDaysUtc(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toUtcIsoDate(d);
}
