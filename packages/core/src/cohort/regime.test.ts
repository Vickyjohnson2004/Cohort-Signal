import { describe, expect, it } from "vitest";
import {
  classifyRegime,
  rotationOf,
  spendingPressureOf,
  supplyTrajectoryOf,
  type RegimeInputs,
} from "./regime.js";

const baseInputs: RegimeInputs = {
  lthSupplyBtc: 14_000_000,
  lthSupplyDelta30dPct: 0,
  lthSupplyDelta7dPct: 0,
  lthNetPositionChange30dAvgBtc: 0,
  lthSopr: 1.0,
  lthSopr30dAvg: 1.0,
  under1mPct: 0.05,
  under1mPct30dAgo: 0.05,
};

describe("supplyTrajectoryOf", () => {
  it("classifies growing/shrinking/flat", () => {
    expect(supplyTrajectoryOf(0.005)).toBe("growing");
    expect(supplyTrajectoryOf(-0.005)).toBe("shrinking");
    expect(supplyTrajectoryOf(0.001)).toBe("flat");
    expect(supplyTrajectoryOf(-0.001)).toBe("flat");
  });
});

describe("spendingPressureOf", () => {
  it("treats null as neutral", () => {
    expect(spendingPressureOf(null)).toBe("neutral");
  });
  it("classifies profit/loss/neutral", () => {
    expect(spendingPressureOf(1.02)).toBe("profit");
    expect(spendingPressureOf(0.98)).toBe("loss");
    expect(spendingPressureOf(1.005)).toBe("neutral");
  });
});

describe("rotationOf", () => {
  it("classifies young/old/flat rotation in pp", () => {
    expect(rotationOf(0.07, 0.05)).toBe("rotating_to_young"); // +2pp
    expect(rotationOf(0.04, 0.06)).toBe("rotating_to_old"); // -2pp
    expect(rotationOf(0.05, 0.05)).toBe("flat");
    expect(rotationOf(0.055, 0.05)).toBe("flat"); // +0.5pp under threshold
  });
});

describe("classifyRegime — rule A (accumulation)", () => {
  it("LTH growing, neutral SOPR, no young rotation -> accumulation", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.01, // +1%
      }),
    ).toBe("accumulation");
  });

  it("LTH growing, loss SOPR, no young rotation -> accumulation", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.01,
        lthSopr: 0.97,
      }),
    ).toBe("accumulation");
  });
});

describe("classifyRegime — rule B (distribution by spend or rotation)", () => {
  it("LTH shrinking + profit SOPR -> distribution", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: -0.01,
        lthSopr: 1.05,
      }),
    ).toBe("distribution");
  });

  it("LTH shrinking + young rotation -> distribution", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: -0.01,
        under1mPct: 0.07,
        under1mPct30dAgo: 0.04, // +3pp
      }),
    ).toBe("distribution");
  });
});

describe("classifyRegime — rule C (capitulation-like)", () => {
  it("LTH shrinking + loss SOPR + no young rotation -> distribution", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: -0.01,
        lthSopr: 0.95,
      }),
    ).toBe("distribution");
  });
});

describe("classifyRegime — rule D (mixed: growing + profit)", () => {
  it("LTH growing + profit SOPR -> equilibrium", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.01,
        lthSopr: 1.05,
      }),
    ).toBe("equilibrium");
  });
});

describe("classifyRegime — rule E (default equilibrium)", () => {
  it("flat supply, neutral SOPR, no rotation -> equilibrium", () => {
    expect(classifyRegime(baseInputs)).toBe("equilibrium");
  });
});

describe("classifyRegime — null SOPR robustness", () => {
  it("null SOPR + growing supply -> accumulation", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.01,
        lthSopr: null,
      }),
    ).toBe("accumulation");
  });
});

describe("classifyRegime — rule A0 (strong-growth override)", () => {
  // Background: when LTH supply is unambiguously net-accumulating (>1% in 30d
  // AND positive 30d net position change), under_1m share growing is a
  // side-effect of new STH inflow rather than LTH distribution. Rule A0
  // overrides the rotation guard in that scenario.
  it("strong growth + positive npc30 + young rotation + neutral SOPR -> accumulation", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.0964, // +9.64% — observed real-world value
        lthNetPositionChange30dAvgBtc: 36_712,
        under1mPct: 0.07,
        under1mPct30dAgo: 0.04, // +3pp young rotation
      }),
    ).toBe("accumulation");
  });

  it("strong growth + positive npc30 + young rotation + null SOPR -> accumulation", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.05,
        lthNetPositionChange30dAvgBtc: 20_000,
        lthSopr: null,
        under1mPct: 0.08,
        under1mPct30dAgo: 0.05,
      }),
    ).toBe("accumulation");
  });

  it("strong growth but profit SOPR -> falls through to rule D (equilibrium)", () => {
    // Profit SOPR is a real LTH-side distribution signal even if growth is
    // strong; A0 must not override it. Falls through to rule D.
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.05,
        lthNetPositionChange30dAvgBtc: 20_000,
        lthSopr: 1.05,
        under1mPct: 0.07,
        under1mPct30dAgo: 0.04,
      }),
    ).toBe("equilibrium");
  });

  it("strong growth but negative npc30 -> falls through (rule A blocked by rotation, hits E)", () => {
    // Strong delta but cohort is actually losing coins on a daily basis (only
    // appears to be growing on the 30d window because of an earlier surge).
    // A0 should not fire.
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.05,
        lthNetPositionChange30dAvgBtc: -5_000,
        under1mPct: 0.07,
        under1mPct30dAgo: 0.04,
      }),
    ).toBe("equilibrium");
  });

  it("borderline growth (exactly +1.0%) does NOT trigger A0 (uses strict >)", () => {
    expect(
      classifyRegime({
        ...baseInputs,
        lthSupplyDelta30dPct: 0.01,
        lthNetPositionChange30dAvgBtc: 10_000,
        under1mPct: 0.07,
        under1mPct30dAgo: 0.04, // young rotation blocks rule A
      }),
    ).toBe("equilibrium"); // falls through to E
  });
});
