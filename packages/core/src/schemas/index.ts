/**
 * Shared types and constants for CohortSignal.
 *
 * These types are the canonical wire format consumed by both the indexer
 * (which writes them to Postgres) and the MCP server (which reads them
 * back and serves them to Context). Keeping them in one place is what
 * lets us guarantee schema accuracy across the dispute-resolution boundary.
 */

export type RegimeClassifier = "accumulation" | "equilibrium" | "distribution";

export type RegimeTrend =
  | "accelerating_up"
  | "decelerating_up"
  | "flat"
  | "accelerating_down"
  | "decelerating_down";

export type LthSoprStatus = "above_one" | "below_one" | "neutral";

export type LthSoprState =
  | "capitulation"
  | "profit_taking"
  | "neutral_spending"
  | "hodl_dominant";

/**
 * The canonical age bands used for HODL waves. These mirror Glassnode's
 * dashboard layout so cross-referencing remains trivial.
 */
export const HODL_AGE_BANDS = [
  "under_1m",
  "1m_3m",
  "3m_6m",
  "6m_12m",
  "1y_2y",
  "2y_3y",
  "3y_5y",
  "5y_7y",
  "7y_10y",
  "over_10y",
] as const;

export type HodlAgeBand = (typeof HODL_AGE_BANDS)[number];

/**
 * Each band has an inclusive lower bound (in days) and an exclusive upper
 * bound. A UTXO of age N days lives in band B iff lower <= N < upper.
 * The final band ("over_10y") has Infinity as its upper bound.
 */
export const HODL_AGE_BAND_RANGES: Record<HodlAgeBand, { minDays: number; maxDays: number }> = {
  under_1m: { minDays: 0, maxDays: 30 },
  "1m_3m": { minDays: 30, maxDays: 90 },
  "3m_6m": { minDays: 90, maxDays: 180 },
  "6m_12m": { minDays: 180, maxDays: 365 },
  "1y_2y": { minDays: 365, maxDays: 730 },
  "2y_3y": { minDays: 730, maxDays: 1095 },
  "3y_5y": { minDays: 1095, maxDays: 1825 },
  "5y_7y": { minDays: 1825, maxDays: 2555 },
  "7y_10y": { minDays: 2555, maxDays: 3650 },
  over_10y: { minDays: 3650, maxDays: Number.POSITIVE_INFINITY },
};

export interface HodlWavesDistribution {
  /**
   * Each band's share of total circulating supply, expressed as a fraction
   * in [0, 1]. The sum across all bands equals 1 within rounding tolerance.
   */
  pctOfSupply: Record<HodlAgeBand, number>;
  /**
   * Each band's BTC supply at this snapshot date.
   */
  btc: Record<HodlAgeBand, number>;
}

export interface CohortSnapshot {
  /** ISO date (UTC) for which this snapshot is computed (end of day). */
  date: string;
  /** Bitcoin block height the snapshot is computed at (last block of day). */
  blockHeight: number;
  /** Cohort boundary used (default: 155 days = Glassnode standard). */
  cohortBoundaryDays: number;

  /** Total LTH supply in BTC. */
  lthSupplyBtc: number;
  /** Total STH supply in BTC. */
  sthSupplyBtc: number;
  /** Total circulating supply at this date. */
  circulatingSupplyBtc: number;
  /** LTH supply / circulating supply, in [0, 1]. */
  lthSupplyPctOfCirculating: number;
  /** STH supply / circulating supply, in [0, 1]. */
  sthSupplyPctOfCirculating: number;

  /** HODL waves distribution at this date. */
  hodlWaves: HodlWavesDistribution;

  /**
   * LTH-SOPR for this date — daily-weighted ratio of spent USD value to
   * created USD value across UTXOs that were >= cohortBoundaryDays old at
   * the time of spend. Null if no LTH spends occurred on this date.
   */
  lthSopr: number | null;

  /**
   * Net change in LTH supply over the trailing 24h window
   * (BTC, signed; positive = LTH cohort grew).
   */
  lthNetPositionChangeBtc1d: number;

  /**
   * Whether this snapshot is still considered provisional because the
   * underlying chain tip has fewer than the configured finality
   * confirmations.
   */
  provisional: boolean;

  /** ISO timestamp when this snapshot was computed. */
  computedAt: string;
  /** Methodology version — bumped whenever the algorithm changes. */
  methodologyVersion: string;
}

/**
 * The fully enriched view returned by Query / Execute methods. Built by
 * combining a base snapshot with rolling 7d/30d/90d statistics, a regime
 * classifier output, and freshness metadata.
 */
export interface CohortRegimeView {
  asOf: string;
  asOfDate: string;
  blockHeight: number;
  cohortBoundaryDays: number;
  methodology: string;
  methodologyVersion: string;
  indexerVersion: string;

  // Freshness
  dataFreshnessSeconds: number;
  freshnessWarning: boolean;
  provisional: boolean;

  // Supply
  lthSupplyBtc: number;
  sthSupplyBtc: number;
  circulatingSupplyBtc: number;
  lthSupplyPctOfCirculating: number;
  sthSupplyPctOfCirculating: number;

  // Deltas
  lthSupplyDelta7dBtc: number;
  lthSupplyDelta30dBtc: number;
  lthSupplyDelta90dBtc: number;
  lthSupplyDelta7dPct: number;
  lthSupplyDelta30dPct: number;
  lthSupplyDelta90dPct: number;

  // Net position change averages
  lthNetPositionChangeBtc7dAvg: number;
  lthNetPositionChangeBtc30dAvg: number;
  lthNetPositionChangeBtc90dAvg: number;

  // SOPR
  lthSopr: number | null;
  lthSopr30dAvg: number | null;
  lthSoprStatus: LthSoprStatus;
  lthSoprState: LthSoprState;

  // HODL waves
  hodlWaves: HodlWavesDistribution;
  hodlWavesDelta30d: Record<HodlAgeBand, number>;
  hodlWavesDelta90d: Record<HodlAgeBand, number>;
  dominantBand: HodlAgeBand;

  // Regime
  regimeClassifier: RegimeClassifier;
  regimeNarrative: string;
  keyDrivers: string[];
  trend: RegimeTrend;

  // Public proof
  evidenceURL: string;
}

export interface IndexerStatus {
  lastBlockProcessed: number;
  lastBlockProcessedAt: string;
  chainTipHeight: number | null;
  lagSeconds: number;
  freshnessWarning: boolean;
  methodologyVersion: string;
  indexerVersion: string;
}

export interface RegimeChangeEvent {
  date: string;
  blockHeight: number;
  fromRegime: RegimeClassifier;
  toRegime: RegimeClassifier;
  cohortBoundaryDays: number;
}
