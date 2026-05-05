import { describe, expect, it } from "vitest";
import { CohortAggregator } from "./aggregator.js";

const SAT = 100_000_000;

describe("CohortAggregator — basic accounting", () => {
  it("accumulates outputs into the survived set", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 100, date: "2018-01-01" });
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT * 2,
      valueUsdAtCreation: 30_000,
      isSpendable: true,
    });
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT * 3,
      valueUsdAtCreation: 45_000,
      isSpendable: true,
    });
    expect(agg.totalUnspentSat()).toBe(SAT * 5);
    expect(agg.trackedBlockCount()).toBe(1);
  });

  it("ignores unspendable outputs (OP_RETURN)", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 100, date: "2018-01-01" });
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT,
      valueUsdAtCreation: 0,
      isSpendable: false,
    });
    expect(agg.totalUnspentSat()).toBe(0);
    expect(agg.trackedBlockCount()).toBe(0);
  });

  it("subtracts spent inputs", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 100, date: "2018-01-01" });
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT * 5,
      valueUsdAtCreation: 75_000,
      isSpendable: true,
    });
    agg.ingestInputSpent(
      {
        creationBlockId: 100,
        spendBlockId: 200,
        valueSat: SAT * 2,
        valueUsdAtCreation: 30_000,
        valueUsdAtSpend: 40_000,
        lifespanSeconds: 86_400 * 100, // 100 days = STH spend
      },
      "2018-04-11",
    );
    expect(agg.totalUnspentSat()).toBe(SAT * 3);
  });

  it("removes a tracking entry once fully spent", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 100, date: "2018-01-01" });
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT,
      valueUsdAtCreation: 15_000,
      isSpendable: true,
    });
    agg.ingestInputSpent(
      {
        creationBlockId: 100,
        spendBlockId: 200,
        valueSat: SAT,
        valueUsdAtCreation: 15_000,
        valueUsdAtSpend: 18_000,
        lifespanSeconds: 86_400 * 200, // LTH spend
      },
      "2018-07-20",
    );
    expect(agg.totalUnspentSat()).toBe(0);
    expect(agg.trackedBlockCount()).toBe(0);
  });
});

describe("CohortAggregator — LTH-SOPR", () => {
  it("computes daily LTH-SOPR only for spends >= cohort boundary", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 100, date: "2018-01-01" });
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT * 2,
      valueUsdAtCreation: 30_000,
      isSpendable: true,
    });

    // STH spend: ignored
    agg.ingestInputSpent(
      {
        creationBlockId: 100,
        spendBlockId: 200,
        valueSat: SAT,
        valueUsdAtCreation: 15_000,
        valueUsdAtSpend: 20_000,
        lifespanSeconds: 86_400 * 50,
      },
      "2018-02-20",
    );
    expect(agg.lthSoprFor("2018-02-20")).toBeNull();

    // LTH spend at profit
    agg.ingestInputSpent(
      {
        creationBlockId: 100,
        spendBlockId: 300,
        valueSat: SAT,
        valueUsdAtCreation: 15_000,
        valueUsdAtSpend: 30_000,
        lifespanSeconds: 86_400 * 200,
      },
      "2018-07-20",
    );
    expect(agg.lthSoprFor("2018-07-20")).toBeCloseTo(30_000 / 15_000, 6);
  });

  it("filters out zero or non-finite USD values", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 100, date: "2018-01-01" });
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT * 5,
      valueUsdAtCreation: 0,
      isSpendable: true,
    });
    agg.ingestInputSpent(
      {
        creationBlockId: 100,
        spendBlockId: 200,
        valueSat: SAT,
        valueUsdAtCreation: 0, // Bad data
        valueUsdAtSpend: 30_000,
        lifespanSeconds: 86_400 * 200,
      },
      "2018-07-20",
    );
    expect(agg.lthSoprFor("2018-07-20")).toBeNull();
  });
});

describe("CohortAggregator — buildSnapshot", () => {
  it("partitions BTC into LTH and STH bands by age", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 100, date: "2018-01-01" }); // older
    agg.ingestBlock({ height: 200, date: "2018-06-01" }); // newer
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT * 10,
      valueUsdAtCreation: 150_000,
      isSpendable: true,
    });
    agg.ingestOutputCreated({
      blockId: 200,
      valueSat: SAT * 5,
      valueUsdAtCreation: 75_000,
      isSpendable: true,
    });

    // As of 2018-12-31: blockId 100 is 364 days old -> LTH (6m_12m band)
    //                  blockId 200 is 213 days old -> LTH (6m_12m band)
    // Both fall into the 6m_12m band because that's [180, 365) days.
    const snap = agg.buildSnapshot({
      snapshotDate: "2018-12-31",
      snapshotBlockId: 200,
      prevLthBtc: 0,
    });
    expect(snap.lthSupplyBtc).toBeCloseTo(15, 6);
    expect(snap.sthSupplyBtc).toBeCloseTo(0, 6);
    expect(snap.hodlWaves.btc["6m_12m"]).toBeCloseTo(15, 6);
    expect(snap.cohortBoundaryDays).toBe(155);
  });

  it("computes a non-null daily delta when prevLthBtc is provided", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 100, date: "2018-01-01" });
    agg.ingestOutputCreated({
      blockId: 100,
      valueSat: SAT * 10,
      valueUsdAtCreation: 150_000,
      isSpendable: true,
    });
    const snap = agg.buildSnapshot({
      snapshotDate: "2019-01-01",
      snapshotBlockId: 100,
      prevLthBtc: 5,
    });
    expect(snap.lthSupplyBtc).toBeCloseTo(10, 6);
    expect(snap.lthNetPositionChangeBtc1d).toBeCloseTo(5, 6);
  });

  it("hodl_waves percentages sum to 1 across non-empty bands", () => {
    const agg = new CohortAggregator({ cohortBoundaryDays: 155 });
    agg.ingestBlock({ height: 1, date: "2010-01-01" });
    agg.ingestBlock({ height: 2, date: "2024-01-01" });
    agg.ingestOutputCreated({
      blockId: 1,
      valueSat: SAT * 1,
      valueUsdAtCreation: 0.0,
      isSpendable: true,
    });
    agg.ingestOutputCreated({
      blockId: 2,
      valueSat: SAT * 4,
      valueUsdAtCreation: 0.0,
      isSpendable: true,
    });
    const snap = agg.buildSnapshot({
      snapshotDate: "2026-01-01",
      snapshotBlockId: 2,
      prevLthBtc: 0,
    });
    const total = Object.values(snap.hodlWaves.pctOfSupply).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});
