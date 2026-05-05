import { describe, expect, it } from "vitest";
import { DateInputError, diffDays, parseAsOfDate, shiftDateByDaysUtc } from "./date.js";

const NOW = "2026-05-05T12:00:00.000Z";

describe("parseAsOfDate", () => {
  it("defaults to now", () => {
    expect(parseAsOfDate(undefined, NOW).isoDate).toBe("2026-05-05");
    expect(parseAsOfDate(null, NOW).isoDate).toBe("2026-05-05");
    expect(parseAsOfDate("now", NOW).isoDate).toBe("2026-05-05");
  });

  it("handles 'today' and 'yesterday'", () => {
    expect(parseAsOfDate("today", NOW).isoDate).toBe("2026-05-05");
    expect(parseAsOfDate("yesterday", NOW).isoDate).toBe("2026-05-04");
  });

  it("parses ISO date and timestamp", () => {
    expect(parseAsOfDate("2024-01-15", NOW).isoDate).toBe("2024-01-15");
    expect(parseAsOfDate("2024-01-15T08:30:00Z", NOW).isoDate).toBe("2024-01-15");
  });

  it("rejects future dates", () => {
    expect(() => parseAsOfDate("2030-01-01", NOW)).toThrow(DateInputError);
  });

  it("rejects unparseable strings", () => {
    expect(() => parseAsOfDate("not-a-date", NOW)).toThrow(DateInputError);
  });
});

describe("date math helpers", () => {
  it("shifts dates", () => {
    expect(shiftDateByDaysUtc("2024-01-01", -7)).toBe("2023-12-25");
    expect(shiftDateByDaysUtc("2024-02-29", 1)).toBe("2024-03-01");
  });

  it("computes day diffs", () => {
    expect(diffDays("2024-02-01", "2024-01-25")).toBe(7);
    expect(diffDays("2024-01-01", "2024-01-01")).toBe(0);
  });
});
