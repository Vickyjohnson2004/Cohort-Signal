import type {
  CohortSnapshot,
  HodlAgeBand,
  HodlWavesDistribution,
  LthSoprState,
  LthSoprStatus,
  RegimeTrend,
} from "../schemas/index.js";
import { HODL_AGE_BANDS } from "../schemas/index.js";

/**
 * Linear search for a snapshot dated `date` within a series sorted by
 * date ascending. Returns null if missing.
 */
export function findByDate(
  series: CohortSnapshot[],
  date: string,
): CohortSnapshot | null {
  for (const snap of series) {
    if (snap.date === date) return snap;
  }
  return null;
}

/**
 * Subtract N days from a YYYY-MM-DD date string and return the result.
 * Pure UTC-based arithmetic.
 */
export function shiftDateByDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute deltas vs. the snapshot from N days ago. If the prior snapshot
 * is missing, falls back to the oldest available snapshot in the series.
 */
export function priorSnapshotDaysAgo(
  series: CohortSnapshot[],
  current: CohortSnapshot,
  daysAgo: number,
): CohortSnapshot | null {
  const targetDate = shiftDateByDays(current.date, -daysAgo);
  const exact = findByDate(series, targetDate);
  if (exact) return exact;
  // Fall back to the closest earlier snapshot we have.
  let best: CohortSnapshot | null = null;
  for (const snap of series) {
    if (snap.date <= targetDate) {
      if (!best || snap.date > best.date) best = snap;
    }
  }
  return best;
}

export function deltaBtc(current: CohortSnapshot, prior: CohortSnapshot | null): number {
  if (!prior) return 0;
  return current.lthSupplyBtc - prior.lthSupplyBtc;
}

export function deltaPct(current: CohortSnapshot, prior: CohortSnapshot | null): number {
  if (!prior || prior.lthSupplyBtc <= 0) return 0;
  return (current.lthSupplyBtc - prior.lthSupplyBtc) / prior.lthSupplyBtc;
}

/**
 * Mean LTH net position change (BTC) over the last `windowDays` days,
 * inclusive of the current snapshot.
 */
export function meanNetPositionChange(
  series: CohortSnapshot[],
  current: CohortSnapshot,
  windowDays: number,
): number {
  const fromDate = shiftDateByDays(current.date, -(windowDays - 1));
  const window = series.filter((s) => s.date >= fromDate && s.date <= current.date);
  if (window.length === 0) return 0;
  const sum = window.reduce((acc, s) => acc + s.lthNetPositionChangeBtc1d, 0);
  return sum / window.length;
}

/**
 * Average non-null LTH-SOPR over a window. Returns null if no non-null
 * values exist in the window.
 */
export function meanLthSopr(
  series: CohortSnapshot[],
  current: CohortSnapshot,
  windowDays: number,
): number | null {
  const fromDate = shiftDateByDays(current.date, -(windowDays - 1));
  const window = series.filter(
    (s) => s.date >= fromDate && s.date <= current.date && s.lthSopr !== null,
  );
  if (window.length === 0) return null;
  const sum = window.reduce((acc, s) => acc + (s.lthSopr ?? 0), 0);
  return sum / window.length;
}

/**
 * Difference of pctOfSupply per age band vs. N days ago, expressed in
 * percentage points (i.e. current_pct - prior_pct).
 */
export function hodlWavesDelta(
  series: CohortSnapshot[],
  current: CohortSnapshot,
  daysAgo: number,
): Record<HodlAgeBand, number> {
  const prior = priorSnapshotDaysAgo(series, current, daysAgo);
  const out = {} as Record<HodlAgeBand, number>;
  for (const band of HODL_AGE_BANDS) {
    const cur = current.hodlWaves.pctOfSupply[band] ?? 0;
    const past = prior?.hodlWaves.pctOfSupply[band] ?? cur;
    out[band] = cur - past;
  }
  return out;
}

/**
 * Bucket a numeric LTH-SOPR reading into a categorical status.
 *
 * Threshold rationale (deterministic, surfaced in methodology):
 *   - above_one  : sopr > 1.005 (LTHs spending at a profit margin > 0.5%)
 *   - below_one  : sopr < 0.995 (LTHs spending at a loss > 0.5%)
 *   - neutral    : 0.995 <= sopr <= 1.005
 */
export function lthSoprStatusFor(sopr: number | null): LthSoprStatus {
  if (sopr === null || !Number.isFinite(sopr)) return "neutral";
  if (sopr > 1.005) return "above_one";
  if (sopr < 0.995) return "below_one";
  return "neutral";
}

/**
 * Map raw LTH-SOPR + 30d average into one of four behavioral states.
 * These thresholds are surfaced in methodology and are intentionally
 * conservative.
 *
 *   - capitulation     : sopr < 0.97 (LTHs realizing > 3% losses; rare and significant)
 *   - profit_taking    : sopr > 1.03 AND 30d avg also > 1.03
 *   - hodl_dominant    : 30d avg of |daily LTH net position change| close to zero
 *                        AND sopr in neutral band (≈1.0). Determined upstream
 *                        because we need net-position context; here we treat
 *                        it as the default "no signal" state.
 *   - neutral_spending : everything else
 */
export function lthSoprStateFor(
  sopr: number | null,
  sopr30dAvg: number | null,
  netPosChange30dAvg: number,
  lthSupply: number,
): LthSoprState {
  if (sopr !== null && sopr < 0.97) return "capitulation";
  if (sopr !== null && sopr > 1.03 && sopr30dAvg !== null && sopr30dAvg > 1.03) {
    return "profit_taking";
  }
  // hodl_dominant: 30d-avg of net position change is small relative to total LTH supply.
  if (lthSupply > 0) {
    const relMag = Math.abs(netPosChange30dAvg) / lthSupply;
    if (relMag < 0.0005) {
      return "hodl_dominant";
    }
  }
  return "neutral_spending";
}

/**
 * Derive a trend label from the 7d, 30d, and 90d LTH supply deltas.
 * Pure deterministic decision tree.
 *
 * Sign convention:
 *   - +ve delta = LTH cohort growing (net accumulation by long-term holders)
 *   - -ve delta = LTH cohort shrinking (net distribution)
 *
 * Intuition for the labels:
 *   - accelerating_up   : growth, with 7d > 30d > 90d (recent pace exceeds the older pace)
 *   - decelerating_up   : growth, but 7d < 30d (recent pace slower than older pace)
 *   - accelerating_down : shrink, with 7d more negative than 30d more negative than 90d
 *   - decelerating_down : shrink, but 7d less negative than 30d
 *   - flat              : all three within 0.05% of zero (relative to LTH supply)
 */
export function trendFor(
  delta7dPct: number,
  delta30dPct: number,
  delta90dPct: number,
): RegimeTrend {
  const flatThreshold = 0.0005; // 0.05%
  const all = [delta7dPct, delta30dPct, delta90dPct];
  if (all.every((v) => Math.abs(v) < flatThreshold)) return "flat";

  const allUp = all.every((v) => v >= 0);
  const allDown = all.every((v) => v <= 0);

  if (allUp) {
    // Compare DAILY rates so we don't bias the comparison by window length.
    const r7 = delta7dPct / 7;
    const r30 = delta30dPct / 30;
    const r90 = delta90dPct / 90;
    return r7 > r30 && r30 > r90 ? "accelerating_up" : "decelerating_up";
  }
  if (allDown) {
    const r7 = delta7dPct / 7;
    const r30 = delta30dPct / 30;
    const r90 = delta90dPct / 90;
    return r7 < r30 && r30 < r90 ? "accelerating_down" : "decelerating_down";
  }
  return "flat";
}
