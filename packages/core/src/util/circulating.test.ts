import { describe, expect, it } from "vitest";
import { circulatingSupplyBtcAt } from "./circulating.js";

describe("circulatingSupplyBtcAt", () => {
  it("matches well-known checkpoints", () => {
    // After 209,999 blocks: exactly 50 BTC * 210,000 = 10,500,000 BTC
    expect(circulatingSupplyBtcAt(209_999)).toBeCloseTo(10_500_000, 6);

    // After 419,999: + 25 BTC * 210,000 = 5,250,000 -> 15,750,000 total
    expect(circulatingSupplyBtcAt(419_999)).toBeCloseTo(15_750_000, 6);

    // After 629,999: + 12.5 BTC * 210,000 = 2,625,000 -> 18,375,000 total
    expect(circulatingSupplyBtcAt(629_999)).toBeCloseTo(18_375_000, 6);

    // After 839,999: + 6.25 BTC * 210,000 = 1,312,500 -> 19,687,500 total
    expect(circulatingSupplyBtcAt(839_999)).toBeCloseTo(19_687_500, 6);
  });

  it("interpolates within a halving era", () => {
    // Block 100,000: 100,001 blocks * 50 BTC = 5,000,050 BTC
    expect(circulatingSupplyBtcAt(100_000)).toBeCloseTo(5_000_050, 6);
  });

  it("never exceeds 21M asymptotically", () => {
    expect(circulatingSupplyBtcAt(10_000_000)).toBeLessThanOrEqual(21_000_000);
  });
});
