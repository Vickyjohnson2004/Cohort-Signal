/**
 * Versioning and methodology constants. Kept in their own module so that
 * the cohort-math layer can import them without creating a cycle through
 * the package barrel.
 */
export const CORE_VERSION = "1.0.0";
export const METHODOLOGY_VERSION = "cohortsignal-v1.0";

/**
 * The standard Glassnode LTH/STH cohort boundary in days. UTXOs with age
 * >= 155 days are classified as Long-Term-Held; younger ones are
 * Short-Term-Held.
 *
 * Provenance: empirical study by Glassnode of UTXO age distribution
 * showing 155 days is the inflection point between high-velocity and
 * dormancy-dominated cohorts. We adopt it for compatibility with
 * existing on-chain reporting.
 */
export const DEFAULT_COHORT_BOUNDARY_DAYS = 155;
