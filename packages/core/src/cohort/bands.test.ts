import { describe, expect, it } from "vitest";
import {
  bandForAgeDays,
  dominantBand,
  emptyHodlWaves,
  finalizeHodlWaves,
} from "./bands.js";
import { HODL_AGE_BAND_RANGES } from "../schemas/index.js";

describe("bandForAgeDays", () => {
  it.each([
    [0, "under_1m"],
    [29, "under_1m"],
    [30, "1m_3m"],
    [89, "1m_3m"],
    [90, "3m_6m"],
    [180, "6m_12m"],
    [365, "1y_2y"],
    [730, "2y_3y"],
    [1095, "3y_5y"],
    [1825, "5y_7y"],
    [2555, "7y_10y"],
    [3650, "over_10y"],
    [10_000, "over_10y"],
  ])("age %d days -> %s", (age, expected) => {
    expect(bandForAgeDays(age)).toBe(expected);
  });

  it("rejects negative ages", () => {
    expect(() => bandForAgeDays(-1)).toThrow();
  });
});

describe("finalizeHodlWaves", () => {
  it("normalizes pct of supply to a fraction", () => {
    const seed = emptyHodlWaves().btc;
    seed.under_1m = 250_000;
    seed["1m_3m"] = 250_000;
    seed.over_10y = 500_000;
    const waves = finalizeHodlWaves(seed);
    expect(waves.btc.under_1m).toBe(250_000);
    expect(waves.pctOfSupply.under_1m).toBeCloseTo(0.25, 8);
    expect(waves.pctOfSupply.over_10y).toBeCloseTo(0.5, 8);
    const total = Object.values(waves.pctOfSupply).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 8);
  });

  it("returns zero pcts when total is zero", () => {
    const waves = finalizeHodlWaves(emptyHodlWaves().btc);
    for (const v of Object.values(waves.pctOfSupply)) expect(v).toBe(0);
  });
});

describe("dominantBand", () => {
  it("picks the highest-share band", () => {
    const seed = emptyHodlWaves().btc;
    seed.under_1m = 100;
    seed["1y_2y"] = 500;
    seed.over_10y = 200;
    const waves = finalizeHodlWaves(seed);
    expect(dominantBand(waves)).toBe("1y_2y");
  });
});

describe("HODL_AGE_BAND_RANGES", () => {
  it("covers 0..infinity with no gaps or overlaps", () => {
    const ranges = Object.values(HODL_AGE_BAND_RANGES).sort((a, b) => a.minDays - b.minDays);
    expect(ranges[0]?.minDays).toBe(0);
    for (let i = 0; i < ranges.length - 1; i++) {
      expect(ranges[i]!.maxDays).toBe(ranges[i + 1]!.minDays);
    }
    expect(ranges[ranges.length - 1]!.maxDays).toBe(Number.POSITIVE_INFINITY);
  });
});
