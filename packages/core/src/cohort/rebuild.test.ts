import { describe, expect, it } from "vitest";
import { rebuildSnapshots, type RebuildInputs } from "./rebuild.js";
import type { DailyCreationRow, SpendRow } from "../db/utxoFlow.js";
import type { BtcPriceDailyRow } from "../db/prices.js";

/**
 * Tests for the deterministic snapshot rebuilder.
 *
 * Strategy: hand-craft small, fully-traceable scenarios where we can compute
 * the expected LTH/STH numbers on paper, then assert that the rebuilder
 * produces those exact numbers.
 */

function row(creationDate: string, totalBtc: number): DailyCreationRow {
  return { creationDate, totalBtc, source: "test" };
}

function spend(spendDate: string, creationDate: string, totalBtc: number): SpendRow {
  return { spendDate, creationDate, totalBtc, source: "test" };
}

function price(priceDate: string, closeUsd: number): BtcPriceDailyRow {
  return { priceDate, closeUsd };
}

describe("rebuildSnapshots", () => {
  it("emits one snapshot per day from first creation onward", async () => {
    const inputs: RebuildInputs = {
      creations: [row("2024-01-01", 100), row("2024-01-02", 50)],
      spends: [],
      prices: [],
    };
    const out = await rebuildSnapshots(inputs, {
      cohortBoundaryDays: 155,
      endDate: "2024-01-05",
    });
    expect(out.snapshots.length).toBe(5); // 01..05 inclusive
    const day1 = out.snapshots.find((s) => s.date === "2024-01-01");
    const day2 = out.snapshots.find((s) => s.date === "2024-01-02");
    expect(day1).toBeTruthy();
    expect(day2).toBeTruthy();
    expect(day1?.sthSupplyBtc).toBeCloseTo(100, 6);
    expect(day1?.lthSupplyBtc).toBeCloseTo(0, 6);
    expect(day1?.hodlWaves.btc.under_1m).toBeCloseTo(100, 6);
    expect(day2?.sthSupplyBtc).toBeCloseTo(150, 6);
    expect(day2?.lthSupplyBtc).toBeCloseTo(0, 6);
  });

  it("ages a UTXO into the LTH cohort once it crosses 155 days", async () => {
    // A single 100-BTC creation on 2024-01-01.
    // On 2024-06-04 (155 days later), it should become LTH.
    const creations = [row("2024-01-01", 100)];
    const inputs: RebuildInputs = { creations, spends: [], prices: [] };
    const out = await rebuildSnapshots(inputs, { cohortBoundaryDays: 155 });

    const beforeBoundary = out.snapshots.find((s) => s.date === "2024-06-03");
    const onBoundary     = out.snapshots.find((s) => s.date === "2024-06-04");
    expect(beforeBoundary?.lthSupplyBtc).toBeCloseTo(0, 6);
    expect(beforeBoundary?.sthSupplyBtc).toBeCloseTo(100, 6);
    expect(onBoundary?.lthSupplyBtc).toBeCloseTo(100, 6);
    expect(onBoundary?.sthSupplyBtc).toBeCloseTo(0, 6);
  });

  it("subtracts spends from the originating creation_date bucket", async () => {
    // Create 200 BTC on 2024-01-01, spend 30 of them on 2024-02-01.
    const creations = [row("2024-01-01", 200)];
    const spends    = [spend("2024-02-01", "2024-01-01", 30)];
    const inputs: RebuildInputs = { creations, spends, prices: [] };
    const out = await rebuildSnapshots(inputs, {
      cohortBoundaryDays: 155,
      endDate: "2024-02-05",
    });

    const dayBeforeSpend = out.snapshots.find((s) => s.date === "2024-01-31");
    const daySpend       = out.snapshots.find((s) => s.date === "2024-02-01");
    expect(dayBeforeSpend?.sthSupplyBtc).toBeCloseTo(200, 6);
    expect(daySpend?.sthSupplyBtc).toBeCloseTo(170, 6);
  });

  it("computes LTH-SOPR using prices at creation vs spend", async () => {
    // Create 10 BTC on 2024-01-01 (price $40k), spend on 2024-12-01 (price $80k).
    // Age at spend: 335 days, well above 155 -> qualifies as LTH spend.
    // SOPR = (10 * 80000) / (10 * 40000) = 2.0
    const creations = [row("2024-01-01", 10)];
    const spends    = [spend("2024-12-01", "2024-01-01", 10)];
    const prices    = [price("2024-01-01", 40_000), price("2024-12-01", 80_000)];
    const inputs: RebuildInputs = { creations, spends, prices };

    const out = await rebuildSnapshots(inputs, {
      cohortBoundaryDays: 155,
      endDate: "2024-12-05",
    });
    const spendDay = out.snapshots.find((s) => s.date === "2024-12-01");
    expect(spendDay?.lthSopr).toBeCloseTo(2.0, 6);
  });

  it("returns null LTH-SOPR when no LTH spends occurred", async () => {
    // Spend a young UTXO -> not an LTH spend, no SOPR contribution.
    const creations = [row("2024-01-01", 10)];
    const spends    = [spend("2024-01-15", "2024-01-01", 5)]; // age 14 days
    const prices    = [price("2024-01-01", 40_000), price("2024-01-15", 50_000)];
    const inputs: RebuildInputs = { creations, spends, prices };

    const out = await rebuildSnapshots(inputs, {
      cohortBoundaryDays: 155,
      endDate: "2024-01-20",
    });
    const spendDay = out.snapshots.find((s) => s.date === "2024-01-15");
    expect(spendDay?.lthSopr).toBeNull();
  });

  it("computes 1d net position change correctly across the cohort boundary", async () => {
    // Two creations: 50 BTC on 2024-01-01, 30 BTC on 2024-01-02.
    // Watch the LTH supply at days 154, 155, 156 (relative to first creation):
    //   day 155 (= 2024-06-04): 50 BTC has crossed boundary -> LTH=50
    //   day 156 (= 2024-06-05): 30 BTC also crosses -> LTH=80
    // 1d delta on 2024-06-05: 80 - 50 = +30
    const creations = [row("2024-01-01", 50), row("2024-01-02", 30)];
    const inputs: RebuildInputs = { creations, spends: [], prices: [] };
    const out = await rebuildSnapshots(inputs, {
      cohortBoundaryDays: 155,
      endDate: "2024-06-10",
    });

    const day155 = out.snapshots.find((s) => s.date === "2024-06-04");
    const day156 = out.snapshots.find((s) => s.date === "2024-06-05");
    expect(day155?.lthSupplyBtc).toBeCloseTo(50, 6);
    expect(day156?.lthSupplyBtc).toBeCloseTo(80, 6);
    expect(day156?.lthNetPositionChangeBtc1d).toBeCloseTo(30, 6);
  });

  it("HODL bands sum to total supply and percentages sum to 1.0", async () => {
    // Five creations spaced apart so every snapshot lives in at least 2 bands.
    const creations = [
      row("2020-01-01", 100), // very old by 2024-01-01 -> 3y_5y
      row("2022-01-01", 50),  // ~2y by 2024-01-01     -> 1y_2y or 2y_3y
      row("2023-12-01", 25),  // ~1m by 2024-01-01     -> 1m_3m
      row("2023-12-15", 10),  // ~17 days              -> under_1m
      row("2024-01-01", 5),   // 0 days                -> under_1m
    ];
    const inputs: RebuildInputs = { creations, spends: [], prices: [] };
    const out = await rebuildSnapshots(inputs, {
      cohortBoundaryDays: 155,
      endDate: "2024-01-01",
    });
    const day = out.snapshots.find((s) => s.date === "2024-01-01");
    expect(day).toBeTruthy();
    if (!day) return;
    const totalBtc = Object.values(day.hodlWaves.btc).reduce((a, b) => a + b, 0);
    expect(totalBtc).toBeCloseTo(190, 6);
    const totalPct = Object.values(day.hodlWaves.pctOfSupply).reduce((a, b) => a + b, 0);
    expect(totalPct).toBeCloseTo(1.0, 6);
  });

  it("supply invariant: sum of survived = sum(creations) - sum(spends-applied-so-far)", async () => {
    // Mixed events over a 100-day window.
    const creations = [
      row("2024-01-01", 100),
      row("2024-01-15", 200),
      row("2024-02-01", 50),
    ];
    const spends = [
      spend("2024-01-10", "2024-01-01", 20),
      spend("2024-01-20", "2024-01-15", 10),
      spend("2024-02-15", "2024-01-15", 5),
    ];
    const inputs: RebuildInputs = { creations, spends, prices: [] };
    const out = await rebuildSnapshots(inputs, {
      cohortBoundaryDays: 155,
      endDate: "2024-02-20",
    });

    const lookup = new Map<string, number>();
    for (const s of out.snapshots) {
      lookup.set(s.date, s.lthSupplyBtc + s.sthSupplyBtc);
    }
    // After 2024-01-01: 100 created, 0 spent -> 100
    expect(lookup.get("2024-01-01")).toBeCloseTo(100, 6);
    // After 2024-01-10: 100 - 20 = 80
    expect(lookup.get("2024-01-10")).toBeCloseTo(80, 6);
    // After 2024-01-15: 80 + 200 = 280
    expect(lookup.get("2024-01-15")).toBeCloseTo(280, 6);
    // After 2024-01-20: 280 - 10 = 270
    expect(lookup.get("2024-01-20")).toBeCloseTo(270, 6);
    // After 2024-02-01: 270 + 50 = 320
    expect(lookup.get("2024-02-01")).toBeCloseTo(320, 6);
    // After 2024-02-15: 320 - 5 = 315
    expect(lookup.get("2024-02-15")).toBeCloseTo(315, 6);
  });
});
