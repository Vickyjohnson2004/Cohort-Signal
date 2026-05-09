import type {
  CohortSnapshot,
  RegimeClassifier,
} from "../schemas/index.js";

/**
 * Inputs to the deterministic regime classifier.
 *
 * All inputs are derived from data already published in our snapshots —
 * this lets a reviewer reproduce the classifier output by hand from any
 * cohort_snapshots row plus rolling 7d/30d windows.
 */
export interface RegimeInputs {
  /** Current LTH supply (BTC). */
  lthSupplyBtc: number;
  /** Trailing-30d % delta of LTH supply (signed). */
  lthSupplyDelta30dPct: number;
  /** Trailing-7d % delta of LTH supply (signed). */
  lthSupplyDelta7dPct: number;
  /** Mean daily LTH net position change over the trailing 30 days (BTC). */
  lthNetPositionChange30dAvgBtc: number;
  /** Current LTH-SOPR (or null if no LTH spends today). */
  lthSopr: number | null;
  /** 30-day mean LTH-SOPR (or null). */
  lthSopr30dAvg: number | null;
  /** Current under_1m HODL waves share (fraction in [0,1]). */
  under1mPct: number;
  /** under_1m HODL waves share 30d ago (fraction in [0,1]). */
  under1mPct30dAgo: number;
}

/**
 * REGIME CLASSIFIER — explicit decision tree.
 *
 * The classifier produces one of {accumulation, equilibrium, distribution}
 * from three orthogonal signals:
 *
 *   1) LTH supply trajectory (30d % delta)
 *      - growing  : delta30d_pct >  +0.20%   (LTH cohort net-expanding)
 *      - shrinking: delta30d_pct <  -0.20%   (LTH cohort net-contracting)
 *      - flat     : within ±0.20%
 *
 *   2) LTH spending pressure (LTH-SOPR vs 1.0; null treated as neutral)
 *      - profit  : sopr > 1.01 (LTHs realizing material gains on spends)
 *      - loss    : sopr < 0.99 (LTHs realizing material losses on spends)
 *      - neutral : 0.99 .. 1.01
 *
 *   3) Young-supply rotation (under_1m HODL waves share trend over 30d)
 *      - rotating_to_young : under_1m share grew by >+1.0pp in 30d
 *      - rotating_to_old   : under_1m share fell by >-1.0pp in 30d
 *      - flat              : within ±1.0pp
 *
 * The combinations map to regimes as follows. Decision-tree rules are
 * applied top-down — first match wins.
 *
 *   A0. supply=growing-strongly (delta30d_pct > +1.0%) AND
 *       lth_net_position_change_30d_avg > 0 AND
 *       spending != profit
 *        => accumulation  (LTH cohort is unambiguously net-accumulating; the
 *                          rotation signal is overridden because under_1m
 *                          share can grow during accumulation phases purely
 *                          from new STH inflow rather than LTH distribution)
 *
 *   A. supply=growing AND spending != profit AND rotation != rotating_to_young
 *        => accumulation  (LTHs are absorbing supply, not selling it)
 *
 *   B. supply=shrinking AND (spending=profit OR rotation=rotating_to_young)
 *        => distribution  (LTHs are selling AND new supply is rotating into
 *                          short-term cohorts)
 *
 *   C. supply=shrinking AND rotation != rotating_to_young AND spending=loss
 *        => distribution  (capitulation-like: LTHs are spending at a loss
 *                          and the cohort is shrinking)
 *
 *   D. supply=growing AND spending=profit
 *        => equilibrium   (mixed signal: cohort growing but realizing gains)
 *
 *   E. otherwise
 *        => equilibrium   (no signal dominates)
 *
 * The exact thresholds above are surfaced in the methodology field of every
 * response. They are conservative on purpose: noisy daily flips of the
 * regime label are useless to a buyer. With these thresholds, regime flips
 * historically align with the well-known Bitcoin cycle inflection points.
 *
 * Rule A0 is a deterministic-implementation refinement of Rule A: it does
 * not change the published rule set's intent (LTHs absorbing supply is
 * accumulation), it just removes a false-equilibrium edge case where a fast
 * accumulation phase produces young-rotation as a side effect of new STH
 * inflow. The rule's two guards (>1% supply growth AND positive
 * net-position-change-30d-avg) require unambiguous LTH-side accumulation
 * before the rotation signal is overridden.
 */
export const STRONG_GROWTH_DELTA30D_PCT = 0.01;

export function classifyRegime(inputs: RegimeInputs): RegimeClassifier {
  const supplyTrajectory = supplyTrajectoryOf(inputs.lthSupplyDelta30dPct);
  const spending = spendingPressureOf(inputs.lthSopr);
  const rotation = rotationOf(inputs.under1mPct, inputs.under1mPct30dAgo);

  // Rule A0 — strong-growth override for accumulation
  if (
    inputs.lthSupplyDelta30dPct > STRONG_GROWTH_DELTA30D_PCT &&
    inputs.lthNetPositionChange30dAvgBtc > 0 &&
    spending !== "profit"
  ) {
    return "accumulation";
  }

  // Rule A — accumulation
  if (
    supplyTrajectory === "growing" &&
    spending !== "profit" &&
    rotation !== "rotating_to_young"
  ) {
    return "accumulation";
  }

  // Rule B — distribution (sell + young-rotation)
  if (
    supplyTrajectory === "shrinking" &&
    (spending === "profit" || rotation === "rotating_to_young")
  ) {
    return "distribution";
  }

  // Rule C — distribution (capitulation-like)
  if (
    supplyTrajectory === "shrinking" &&
    spending === "loss" &&
    rotation !== "rotating_to_young"
  ) {
    return "distribution";
  }

  // Rule D — equilibrium (mixed: growing but realizing gains)
  if (supplyTrajectory === "growing" && spending === "profit") {
    return "equilibrium";
  }

  return "equilibrium";
}

export type SupplyTrajectory = "growing" | "shrinking" | "flat";
export type SpendingPressure = "profit" | "loss" | "neutral";
export type Rotation = "rotating_to_young" | "rotating_to_old" | "flat";

export function supplyTrajectoryOf(delta30dPct: number): SupplyTrajectory {
  if (delta30dPct > 0.002) return "growing";
  if (delta30dPct < -0.002) return "shrinking";
  return "flat";
}

export function spendingPressureOf(sopr: number | null): SpendingPressure {
  if (sopr === null || !Number.isFinite(sopr)) return "neutral";
  if (sopr > 1.01) return "profit";
  if (sopr < 0.99) return "loss";
  return "neutral";
}

export function rotationOf(currentUnder1mPct: number, prior30dUnder1mPct: number): Rotation {
  const delta = currentUnder1mPct - prior30dUnder1mPct; // expressed as fraction
  if (delta > 0.01) return "rotating_to_young";
  if (delta < -0.01) return "rotating_to_old";
  return "flat";
}

/**
 * Detect regime change events within a contiguous series. Used to feed
 * the regimeChangeEvents field on Query/Execute responses.
 *
 * The series should be sorted ascending by date. The classifier output for
 * each snapshot must already be computed and stored on the snapshot via
 * the same rules used here (we re-run classifier here for safety so this
 * function is independent of caller pre-state).
 */
export function findRegimeChangeEvents(
  series: Array<{
    snapshot: CohortSnapshot;
    inputs: RegimeInputs;
  }>,
): Array<{
  date: string;
  blockHeight: number;
  fromRegime: RegimeClassifier;
  toRegime: RegimeClassifier;
}> {
  const out: Array<{
    date: string;
    blockHeight: number;
    fromRegime: RegimeClassifier;
    toRegime: RegimeClassifier;
  }> = [];
  let prev: RegimeClassifier | null = null;
  for (const { snapshot, inputs } of series) {
    const cur = classifyRegime(inputs);
    if (prev !== null && prev !== cur) {
      out.push({
        date: snapshot.date,
        blockHeight: snapshot.blockHeight,
        fromRegime: prev,
        toRegime: cur,
      });
    }
    prev = cur;
  }
  return out;
}

/**
 * The methodology string we attach to every response. Updating this string
 * (and bumping methodologyVersion in schemas/index.ts) is the only
 * supported way to change the rules.
 */
export const REGIME_METHODOLOGY = [
  "CohortSignal v1.0 deterministic regime classifier.",
  "Long-term holder boundary: 155 days of UTXO age (Glassnode-standard, configurable).",
  "Inputs: 30d LTH supply delta, 30d-avg LTH net position change, current LTH-SOPR, 30d under_1m HODL waves rotation.",
  "Thresholds: supply-trajectory ±0.20% over 30d; strong-growth override at +1.00% over 30d; spending-pressure ±1.0% from 1.0; rotation ±1.0pp over 30d.",
  "Rules (first match wins): A0) supply >+1.0% over 30d & npc30 > 0 & not-profit -> accumulation (strong-growth override); A) growing & not-profit & not-young-rotating -> accumulation; B) shrinking & (profit OR young-rotating) -> distribution; C) shrinking & loss & not-young-rotating -> distribution; D) growing & profit -> equilibrium; E) else -> equilibrium.",
  "All inputs are reproducible from cohort_snapshots rows; no proprietary data, no LLM synthesis.",
].join(" ");
