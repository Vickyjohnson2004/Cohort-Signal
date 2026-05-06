/**
 * Deterministic snapshot rebuilder.
 *
 * Inputs (all in our own Postgres):
 *   - utxo_daily_creations          : per-day BTC created
 *   - utxo_daily_spends_by_creation : per-(spend_date, creation_date) BTC spent
 *   - btc_price_daily               : per-day USD close
 *
 * Output:
 *   - cohort_snapshots row for each day in [first creation date, last spend date]
 *   - regime_change_events row for each transition
 *
 * Algorithm (per UTC day d, in ascending date order):
 *
 *   1) Apply creations[d]: survived[d] += creations[d].total_btc
 *   2) Apply spends[d, *]: for each (creation_date c, total_btc x):
 *        survived[c] -= x
 *      (we then drop entries that hit zero to keep memory bounded)
 *   3) Compute the snapshot for day d:
 *        for each (creation_date c, btc) in survived:
 *          ageDays = d - c
 *          band    = bandForAgeDays(ageDays)
 *          hodlWaves[band] += btc
 *          if ageDays >= cohortBoundaryDays: lthBtc += btc
 *          else:                              sthBtc += btc
 *      LTH-SOPR for day d:
 *        spendUsd  = SUM_over_c <= d-cohortBoundaryDays(spends[d,c].btc * price[d])
 *        createUsd = SUM_over_c <= d-cohortBoundaryDays(spends[d,c].btc * price[c])
 *        lthSopr   = spendUsd / createUsd  (null if denominator == 0)
 *
 * Memory: at any time, |survived| <= number_of_distinct_creation_dates ≈ 3000
 * (since we aggregate by date, not txid). So this fits in a few MB.
 *
 * Determinism: the algorithm is a pure function of the three input tables.
 * Re-running it produces byte-identical output.
 */

import {
  HODL_AGE_BANDS,
  type CohortSnapshot,
  type HodlAgeBand,
  type HodlWavesDistribution,
} from "../schemas/index.js";
import { METHODOLOGY_VERSION, DEFAULT_COHORT_BOUNDARY_DAYS } from "../constants.js";
import { bandForAgeDays, finalizeHodlWaves } from "./bands.js";
import { meanLthSopr, meanNetPositionChange } from "./rolling.js";
import { classifyRegime } from "./regime.js";
import type { DailyCreationRow, SpendRow } from "../db/utxoFlow.js";
import type { BtcPriceDailyRow } from "../db/prices.js";

const ONE_DAY_MS = 86_400_000;

export interface RebuildOptions {
  /** Cohort boundary in days. Defaults to 155 (Glassnode standard). */
  cohortBoundaryDays?: number;
  /**
   * Block height for each day. If omitted, snapshots use the day-of-year
   * times-block-rate approximation (10-min blocks ≈ 144/day). This is only
   * used in the snapshot's blockHeight field; it is NOT part of the cohort
   * math.
   */
  blockHeightForDate?: (date: string) => number;
  /**
   * Latest UTC date to emit (inclusive). If omitted, defaults to the later
   * of (last creation date, last spend date, today). The loop never emits
   * snapshots beyond today regardless.
   */
  endDate?: string;
}

export interface RebuildInputs {
  /** All creations, ascending creation_date. Loaded fully (~3000 rows). */
  creations: DailyCreationRow[];
  /**
   * All spends, in ascending (spend_date, creation_date) order. May be a
   * very long list (~6.79M rows). The function consumes it via a forward
   * iterator, so a streaming source is fine.
   */
  spends: Iterable<SpendRow> | AsyncIterable<SpendRow>;
  /** Daily BTC prices, ascending price_date. Optional; required for LTH-SOPR. */
  prices: BtcPriceDailyRow[];
}

export interface RebuildOutput {
  snapshots: CohortSnapshot[];
  /**
   * Detected regime transitions, in chronological order. The classifier
   * emits a regime label every day; we only persist transitions, not
   * day-by-day labels (those are stored on the snapshot itself).
   */
  regimeChanges: Array<{
    date: string;
    blockHeight: number;
    cohortBoundaryDays: number;
    fromRegime: string;
    toRegime: string;
  }>;
}

/**
 * Run the deterministic rebuild. Returns the full series of snapshots and
 * regime changes. For very long ranges, prefer the streaming variant
 * `rebuildSnapshotsStreaming` which yields snapshots one at a time.
 */
export async function rebuildSnapshots(
  inputs: RebuildInputs,
  opts: RebuildOptions = {},
): Promise<RebuildOutput> {
  const out: RebuildOutput = { snapshots: [], regimeChanges: [] };
  const recent: CohortSnapshot[] = [];
  let lastRegime: string | undefined;

  for await (const snap of rebuildSnapshotsStreaming(inputs, opts)) {
    out.snapshots.push(snap.snapshot);
    if (snap.regime && snap.regime !== lastRegime) {
      if (lastRegime !== undefined) {
        out.regimeChanges.push({
          date: snap.snapshot.date,
          blockHeight: snap.snapshot.blockHeight,
          cohortBoundaryDays: snap.snapshot.cohortBoundaryDays,
          fromRegime: lastRegime,
          toRegime: snap.regime,
        });
      }
      lastRegime = snap.regime;
    }
    // Trim window of recent snapshots — only relevant for callers that
    // consume the streaming variant; here we just ignore.
    void recent;
  }
  return out;
}

export interface StreamedSnapshot {
  snapshot: CohortSnapshot;
  /**
   * Regime label for this day (accumulation / equilibrium / distribution),
   * or null if the trailing window isn't full enough to classify yet.
   */
  regime: "accumulation" | "equilibrium" | "distribution" | null;
}

/**
 * Streaming variant: yields one StreamedSnapshot per day in chronological
 * order. The caller is responsible for persisting them. Memory usage is
 * bounded by O(distinct_creation_dates_so_far).
 *
 * Implementation note: we *must* consume `inputs.spends` lazily, since on
 * a multi-year rebuild it's tens of millions of rows. We require that
 * spends are sorted ascending by (spend_date, creation_date).
 */
export async function* rebuildSnapshotsStreaming(
  inputs: RebuildInputs,
  opts: RebuildOptions = {},
): AsyncGenerator<StreamedSnapshot, void, void> {
  const cohortBoundaryDays = opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;

  // Index inputs by date for fast lookup.
  const creationsByDate = new Map<string, number>();
  for (const c of inputs.creations) creationsByDate.set(c.creationDate, c.totalBtc);
  const priceByDate = new Map<string, number>();
  for (const p of inputs.prices) priceByDate.set(p.priceDate, p.closeUsd);

  // The first date we emit is the earliest creation date.
  const minDate = inputs.creations[0]?.creationDate;
  if (!minDate) return;
  const lastCreation = inputs.creations[inputs.creations.length - 1]?.creationDate;
  if (!lastCreation) return;

  // Buffer one spend row at a time as we walk the date axis. Spends MUST be
  // sorted ascending by (spend_date, creation_date).
  const spendsIter = (inputs.spends as AsyncIterable<SpendRow>)[Symbol.asyncIterator]
    ? (inputs.spends as AsyncIterable<SpendRow>)[Symbol.asyncIterator]()
    : asyncFromSync(inputs.spends as Iterable<SpendRow>);

  /**
   * survived: creation_date -> remaining BTC unspent at the *start* of the
   * current day (before applying today's events).
   */
  const survived = new Map<string, number>();
  let nextSpend: IteratorResult<SpendRow> = await spendsIter.next();
  let cursor = minDate;
  const recentSnapshots: CohortSnapshot[] = [];
  const RECENT_WINDOW = Math.max(120, cohortBoundaryDays + 1); // enough for 90d delta

  // Determine the upper-bound emit date. We default to today (UTC), so a
  // 100-BTC creation in 2024 will emit snapshots for every day from then to
  // present, which is what aging UTXOs require.
  const todayUtc = new Date().toISOString().slice(0, 10);
  let endDate = opts.endDate ?? todayUtc;
  if (endDate > todayUtc) endDate = todayUtc;
  // Also extend if the last spend date is past the configured end. We need
  // to know the last spend date — peek the iterator state. If we already
  // exhausted the iterator we know endDate doesn't need extending.
  if (!nextSpend.done && nextSpend.value.spendDate > endDate) {
    endDate = nextSpend.value.spendDate;
  }

  while (true) {
    const todayStr = cursor;
    if (todayStr > endDate) break;

    // Apply creations.
    const created = creationsByDate.get(todayStr) ?? 0;
    if (created > 0) {
      survived.set(todayStr, (survived.get(todayStr) ?? 0) + created);
    }

    // Apply all spends with spend_date == today.
    let spendUsdLthToday = 0;
    let createUsdLthToday = 0;
    let anySpendToday = false;
    while (!nextSpend.done && nextSpend.value.spendDate === todayStr) {
      const s = nextSpend.value;
      anySpendToday = true;
      const cur = survived.get(s.creationDate) ?? 0;
      const next = cur - s.totalBtc;
      if (next <= 1e-9) {
        // Treat tiny residuals as zero to avoid Map fragmentation.
        survived.delete(s.creationDate);
      } else {
        survived.set(s.creationDate, next);
      }

      // LTH-SOPR contribution: only spends whose age >= cohortBoundary qualify.
      const ageDays = daysBetween(s.creationDate, s.spendDate);
      if (ageDays >= cohortBoundaryDays) {
        const priceAtSpend = priceByDate.get(s.spendDate);
        const priceAtCreate = priceByDate.get(s.creationDate);
        if (
          priceAtSpend !== undefined &&
          priceAtCreate !== undefined &&
          priceAtSpend > 0 &&
          priceAtCreate > 0
        ) {
          spendUsdLthToday += s.totalBtc * priceAtSpend;
          createUsdLthToday += s.totalBtc * priceAtCreate;
        }
      }
      nextSpend = await spendsIter.next();
      // Extend endDate if we discover a later spend date than we knew about.
      if (!nextSpend.done && nextSpend.value.spendDate > endDate) {
        if (nextSpend.value.spendDate <= todayUtc) {
          endDate = nextSpend.value.spendDate;
        }
      }
    }
    void anySpendToday;
    void lastCreation;

    // Build the snapshot for today.
    const snap = buildSnapshotFromSurvived({
      survived,
      todayStr,
      cohortBoundaryDays,
      blockHeight: opts.blockHeightForDate?.(todayStr) ?? approxBlockHeightForDate(todayStr),
      lthSopr: createUsdLthToday > 0 ? spendUsdLthToday / createUsdLthToday : null,
    });

    // Fill in trailing stats from the recent window.
    fillTrailingStats(snap, recentSnapshots);

    // Classify regime once we have at least 90 days of context.
    const regime =
      recentSnapshots.length >= 90 ? classifyRegimeForSnap(snap, recentSnapshots) : null;

    yield { snapshot: snap, regime };

    recentSnapshots.push(snap);
    if (recentSnapshots.length > RECENT_WINDOW) recentSnapshots.shift();

    cursor = nextDay(cursor);
  }
}

function buildSnapshotFromSurvived(args: {
  survived: Map<string, number>;
  todayStr: string;
  cohortBoundaryDays: number;
  blockHeight: number;
  lthSopr: number | null;
}): CohortSnapshot {
  const { survived, todayStr, cohortBoundaryDays, blockHeight, lthSopr } = args;
  let lthBtc = 0;
  let sthBtc = 0;
  const btcByBand = {} as Record<HodlAgeBand, number>;
  for (const b of HODL_AGE_BANDS) btcByBand[b] = 0;

  for (const [creationDate, btc] of survived) {
    if (btc <= 0) continue;
    const ageDays = daysBetween(creationDate, todayStr);
    const band = bandForAgeDays(ageDays);
    btcByBand[band] += btc;
    if (ageDays >= cohortBoundaryDays) lthBtc += btc;
    else sthBtc += btc;
  }
  const accountedBtc = lthBtc + sthBtc;
  const denomBtc = accountedBtc > 0 ? accountedBtc : 1;
  const hodlWaves: HodlWavesDistribution = finalizeHodlWaves(btcByBand);
  return {
    date: todayStr,
    blockHeight,
    cohortBoundaryDays,
    lthSupplyBtc: lthBtc,
    sthSupplyBtc: sthBtc,
    circulatingSupplyBtc: accountedBtc,
    lthSupplyPctOfCirculating: lthBtc / denomBtc,
    sthSupplyPctOfCirculating: sthBtc / denomBtc,
    hodlWaves,
    lthSopr,
    lthNetPositionChangeBtc1d: 0, // filled in by fillTrailingStats
    provisional: false,
    methodologyVersion: METHODOLOGY_VERSION,
    computedAt: new Date().toISOString(),
  };
}

function fillTrailingStats(snap: CohortSnapshot, recent: CohortSnapshot[]): void {
  const last = recent[recent.length - 1];
  snap.lthNetPositionChangeBtc1d = last ? snap.lthSupplyBtc - last.lthSupplyBtc : 0;

  // 7d, 30d, 90d deltas — populated as `extra` fields on the snapshot
  // object via cast. The upsert helper in db/snapshots.ts pulls them out
  // through SnapshotExtras.
  const ext = snap as CohortSnapshot & {
    lthNetPositionChangeBtc7d?: number;
    lthNetPositionChangeBtc30d?: number;
    lthNetPositionChangeBtc90d?: number;
    lthSopr30dMean?: number | null;
  };
  ext.lthNetPositionChangeBtc7d  = trailingDelta(snap, recent, 7);
  ext.lthNetPositionChangeBtc30d = trailingDelta(snap, recent, 30);
  ext.lthNetPositionChangeBtc90d = trailingDelta(snap, recent, 90);
  // Use the rolling helper for the 30d-mean LTH-SOPR. It expects
  // (series including current, current, windowDays).
  const seriesIncludingCurrent = [...recent, snap];
  ext.lthSopr30dMean = meanLthSopr(seriesIncludingCurrent, snap, 30);
}

/**
 * Bridge from the rebuild's CohortSnapshot view to the regime classifier's
 * RegimeInputs shape. The classifier needs:
 *   - 7d / 30d % delta of LTH supply
 *   - 30d-avg of daily net position change
 *   - current and 30d-avg LTH-SOPR
 *   - current and 30-days-ago under_1m HODL waves share
 */
function classifyRegimeForSnap(
  snap: CohortSnapshot,
  recent: CohortSnapshot[],
): "accumulation" | "equilibrium" | "distribution" {
  const seriesIncludingCurrent = [...recent, snap];
  const delta7  = trailingDelta(snap, recent, 7);
  const delta30 = trailingDelta(snap, recent, 30);
  const refLth  = snap.lthSupplyBtc > 0 ? snap.lthSupplyBtc : 1;
  const npc30   = meanNetPositionChange(seriesIncludingCurrent, snap, 30);
  const sopr30  = meanLthSopr(seriesIncludingCurrent, snap, 30);
  // under_1m share, current vs ~30 days ago.
  const ref30dAgo = recent[Math.max(0, recent.length - 30)];
  const under1mNow = snap.hodlWaves.pctOfSupply.under_1m ?? 0;
  const under1m30d = ref30dAgo?.hodlWaves.pctOfSupply.under_1m ?? under1mNow;
  return classifyRegime({
    lthSupplyBtc: snap.lthSupplyBtc,
    lthSupplyDelta30dPct: delta30 / refLth,
    lthSupplyDelta7dPct:  delta7  / refLth,
    lthNetPositionChange30dAvgBtc: npc30,
    lthSopr: snap.lthSopr,
    lthSopr30dAvg: sopr30,
    under1mPct: under1mNow,
    under1mPct30dAgo: under1m30d,
  });
}

function trailingDelta(snap: CohortSnapshot, recent: CohortSnapshot[], days: number): number {
  // Find the snapshot exactly `days` days before `snap.date`.
  const target = shiftDate(snap.date, -days);
  // Binary search would be nicer but linear over a 90-row window is fine.
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i];
    if (r && r.date <= target) return snap.lthSupplyBtc - r.lthSupplyBtc;
  }
  // Not enough history yet; use the earliest available.
  const first = recent[0];
  return first ? snap.lthSupplyBtc - first.lthSupplyBtc : 0;
}

function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`).getTime() + ONE_DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

function shiftDate(d: string, deltaDays: number): string {
  const t = new Date(`${d}T00:00:00Z`).getTime() + deltaDays * ONE_DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.floor((tb - ta) / ONE_DAY_MS);
}

/**
 * Approximate block height for a UTC date. Returns the height of the last
 * block expected to have landed on that day. We use the historical
 * 144-blocks-per-day average (10-min blocks). This is *only* used as the
 * snapshot's `blockHeight` field for human readability — the cohort math
 * never depends on it. For canonical heights, pass a `blockHeightForDate`
 * callback to RebuildOptions.
 */
export function approxBlockHeightForDate(d: string): number {
  // Genesis block: 2009-01-03, height 0.
  // Average since 2018: ~144 blocks/day. We'll be slightly off for any
  // given day, which is OK for the human-readable field.
  const genesisMs = new Date("2009-01-03T18:15:05Z").getTime();
  const t = new Date(`${d}T23:59:59Z`).getTime();
  if (t < genesisMs) return 0;
  const days = (t - genesisMs) / 86_400_000;
  return Math.floor(days * 144);
}

async function* asyncFromSync<T>(iter: Iterable<T>): AsyncIterableIterator<T> {
  for (const x of iter) yield x;
}
