import {
  HODL_AGE_BANDS,
  HODL_AGE_BAND_RANGES,
  type HodlAgeBand,
  type HodlWavesDistribution,
} from "../schemas/index.js";

/**
 * Map a UTXO age (in days) to its canonical HODL age band.
 * Pure function — fully deterministic.
 */
export function bandForAgeDays(ageDays: number): HodlAgeBand {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    throw new RangeError(`bandForAgeDays: invalid ageDays=${ageDays}`);
  }
  for (const band of HODL_AGE_BANDS) {
    const range = HODL_AGE_BAND_RANGES[band];
    if (ageDays >= range.minDays && ageDays < range.maxDays) {
      return band;
    }
  }
  return "over_10y";
}

/**
 * Build an empty HODL waves distribution. Useful as the accumulator seed
 * when binning a fresh UTXO set.
 */
export function emptyHodlWaves(): HodlWavesDistribution {
  const btc = {} as Record<HodlAgeBand, number>;
  const pct = {} as Record<HodlAgeBand, number>;
  for (const band of HODL_AGE_BANDS) {
    btc[band] = 0;
    pct[band] = 0;
  }
  return { btc, pctOfSupply: pct };
}

/**
 * Given the BTC totals per age band, produce the percent distribution.
 * Total supply is computed as the sum of band totals; if zero we return
 * a uniform-zero distribution.
 */
export function finalizeHodlWaves(btcByBand: Record<HodlAgeBand, number>): HodlWavesDistribution {
  const total = HODL_AGE_BANDS.reduce((acc, band) => acc + (btcByBand[band] ?? 0), 0);
  const pct = {} as Record<HodlAgeBand, number>;
  for (const band of HODL_AGE_BANDS) {
    pct[band] = total > 0 ? (btcByBand[band] ?? 0) / total : 0;
  }
  const btcCopy = {} as Record<HodlAgeBand, number>;
  for (const band of HODL_AGE_BANDS) btcCopy[band] = btcByBand[band] ?? 0;
  return { btc: btcCopy, pctOfSupply: pct };
}

/**
 * Sum BTC across bands at or above the cohort boundary. The boundary is
 * expressed in days so we convert it to the equivalent band cutoff.
 *
 * For the standard 155-day cutoff, "long-term" supply is everything in
 * bands whose minDays >= 155 OR straddles 155 (we then compute the
 * straddled band's contribution proportionally during binning, not here).
 *
 * This helper is intentionally _exclusive_ of the straddling band — the
 * binning logic in the indexer handles the boundary at the UTXO level for
 * exactness. Use this only for cross-checks.
 */
export function sumBandsAboveDays(
  btcByBand: Record<HodlAgeBand, number>,
  thresholdDays: number,
): number {
  let acc = 0;
  for (const band of HODL_AGE_BANDS) {
    const range = HODL_AGE_BAND_RANGES[band];
    if (range.minDays >= thresholdDays) {
      acc += btcByBand[band] ?? 0;
    }
  }
  return acc;
}

/**
 * Pick the dominant age band — the one with the largest percent share.
 * Ties broken by older band wins (HODL waves convention).
 */
export function dominantBand(waves: HodlWavesDistribution): HodlAgeBand {
  let best: HodlAgeBand = "under_1m";
  let bestPct = -1;
  for (const band of HODL_AGE_BANDS) {
    const v = waves.pctOfSupply[band] ?? 0;
    if (v > bestPct) {
      best = band;
      bestPct = v;
    }
  }
  return best;
}
