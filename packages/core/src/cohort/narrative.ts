import type {
  CohortRegimeView,
  HodlAgeBand,
} from "../schemas/index.js";
import { HODL_AGE_BANDS } from "../schemas/index.js";

/**
 * DETERMINISTIC NARRATIVE BUILDER.
 *
 * Given a fully-computed CohortRegimeView, produces a short prose summary
 * of the regime by mechanically formatting numeric fields. There is NO
 * randomness, NO LLM call, and NO subjective judgement here — the output
 * is a function of the inputs, and re-running this on the same inputs
 * always yields the same string.
 *
 * Why this matters for the contract: the proposal explicitly commits to a
 * regimeNarrative that is "deterministically generated from the structured
 * data, not LLM-generated freeform." Any reviewer feeding the same numbers
 * into this function gets the same sentences. That is the differentiation
 * vs. a free LLM trying to interpret raw cohort data.
 */
export function buildRegimeNarrative(view: CohortRegimeView): string {
  const parts: string[] = [];

  // Sentence 1 — supply level + 30d trajectory
  parts.push(
    `As of ${view.asOfDate} (block ${view.blockHeight}), Bitcoin long-term holders ` +
      `(UTXOs >= ${view.cohortBoundaryDays} days old) hold ` +
      `${formatBtc(view.lthSupplyBtc)} BTC ` +
      `(${formatPct(view.lthSupplyPctOfCirculating, 1)} of circulating supply); ` +
      `short-term holders hold ${formatBtc(view.sthSupplyBtc)} BTC ` +
      `(${formatPct(view.sthSupplyPctOfCirculating, 1)}).`,
  );

  // Sentence 2 — 30d delta and trend
  parts.push(
    `Over the trailing 30 days, LTH supply has ${describeDirection(view.lthSupplyDelta30dBtc)} ` +
      `by ${formatBtc(Math.abs(view.lthSupplyDelta30dBtc))} BTC ` +
      `(${formatSignedPct(view.lthSupplyDelta30dPct)}); the cross-window trend is ${formatTrend(view.trend)}.`,
  );

  // Sentence 3 — LTH-SOPR
  if (view.lthSopr !== null) {
    parts.push(
      `LTH-SOPR is ${view.lthSopr.toFixed(3)} ` +
        `(30d avg ${view.lthSopr30dAvg !== null ? view.lthSopr30dAvg.toFixed(3) : "n/a"}), ` +
        `state: ${view.lthSoprState.replace(/_/g, " ")}.`,
    );
  } else {
    parts.push(
      `LTH-SOPR is unavailable for this date (no cohort spends recorded); state: ${view.lthSoprState.replace(/_/g, " ")}.`,
    );
  }

  // Sentence 4 — HODL waves dominant band + 30d shift
  const dominantPct = view.hodlWaves.pctOfSupply[view.dominantBand] ?? 0;
  const top3 = topNBands(view.hodlWavesDelta30d, 3);
  const movers = top3
    .map(({ band, delta }) => `${prettyBand(band)} ${formatSignedPct(delta, 2)}`)
    .join(", ");
  parts.push(
    `Dominant HODL waves band: ${prettyBand(view.dominantBand)} ` +
      `(${formatPct(dominantPct, 1)} of supply). ` +
      `Largest 30d band shifts: ${movers}.`,
  );

  // Sentence 5 — final regime call
  parts.push(`Regime classifier: ${view.regimeClassifier}.`);

  return parts.join(" ");
}

/**
 * Pick the 2-3 metrics with the largest absolute deviation from their
 * baseline. We use 30d deltas here because that's the same window the
 * regime classifier uses, so the "key drivers" line up with the regime
 * call itself.
 */
export function buildKeyDrivers(view: CohortRegimeView): string[] {
  const candidates: Array<{ label: string; magnitude: number }> = [];

  candidates.push({
    label:
      view.lthSupplyDelta30dPct >= 0
        ? `LTH supply +${formatBtc(view.lthSupplyDelta30dBtc)} BTC over 30d (${formatSignedPct(view.lthSupplyDelta30dPct)})`
        : `LTH supply ${formatBtc(view.lthSupplyDelta30dBtc)} BTC over 30d (${formatSignedPct(view.lthSupplyDelta30dPct)})`,
    magnitude: Math.abs(view.lthSupplyDelta30dPct),
  });

  if (view.lthSopr !== null) {
    candidates.push({
      label: `LTH-SOPR ${view.lthSopr.toFixed(3)} (${view.lthSoprState.replace(/_/g, " ")})`,
      magnitude: Math.abs(view.lthSopr - 1),
    });
  }

  // Pick the largest 30d band shift (in absolute pp)
  const top = topNBands(view.hodlWavesDelta30d, 1)[0];
  if (top) {
    candidates.push({
      label: `${prettyBand(top.band)} share ${formatSignedPct(top.delta, 2)} over 30d`,
      magnitude: Math.abs(top.delta),
    });
  }

  candidates.sort((a, b) => b.magnitude - a.magnitude);
  return candidates.slice(0, 3).map((c) => c.label);
}

// ---------- formatting helpers (pure) ----------

function formatBtc(btc: number): string {
  if (Math.abs(btc) >= 1_000_000) return `${(btc / 1_000_000).toFixed(2)}M`;
  if (Math.abs(btc) >= 1_000) return `${(btc / 1_000).toFixed(2)}k`;
  return btc.toFixed(2);
}

function formatPct(fraction: number, digits = 2): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

function formatSignedPct(fraction: number, digits = 2): string {
  const sign = fraction >= 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(digits)}%`;
}

function describeDirection(signed: number): string {
  if (signed > 0) return "increased";
  if (signed < 0) return "decreased";
  return "remained flat";
}

function formatTrend(trend: string): string {
  return trend.replace(/_/g, " ");
}

function topNBands(
  delta: Record<HodlAgeBand, number>,
  n: number,
): Array<{ band: HodlAgeBand; delta: number }> {
  return [...HODL_AGE_BANDS]
    .map((band) => ({ band, delta: delta[band] ?? 0 }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, n);
}

function prettyBand(band: HodlAgeBand): string {
  switch (band) {
    case "under_1m":
      return "<1m";
    case "1m_3m":
      return "1m–3m";
    case "3m_6m":
      return "3m–6m";
    case "6m_12m":
      return "6m–12m";
    case "1y_2y":
      return "1y–2y";
    case "2y_3y":
      return "2y–3y";
    case "3y_5y":
      return "3y–5y";
    case "5y_7y":
      return "5y–7y";
    case "7y_10y":
      return "7y–10y";
    case "over_10y":
      return ">10y";
  }
}
