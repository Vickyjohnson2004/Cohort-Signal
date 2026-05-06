import type { Pool } from "pg";
import {
  HODL_AGE_BANDS,
  type CohortSnapshot,
  type HodlAgeBand,
  type HodlWavesDistribution,
} from "../schemas/index.js";
import { finalizeHodlWaves } from "../cohort/bands.js";

/**
 * Optional fields written by the rebuild job. Stored in dedicated columns
 * added in migration 0002. We accept them as an intersection-extension of
 * CohortSnapshot so the canonical shared type doesn't need to know about
 * write-time concerns.
 */
export interface SnapshotExtras {
  lthNetPositionChangeBtc7d?: number | null;
  lthNetPositionChangeBtc30d?: number | null;
  lthNetPositionChangeBtc90d?: number | null;
  lthSopr30dMean?: number | null;
  regime?: "accumulation" | "equilibrium" | "distribution" | null;
}

/**
 * Upsert a single snapshot. Idempotent on (snapshot_date, cohort_boundary_days).
 */
export async function upsertSnapshot(
  pool: Pool | import("pg").PoolClient,
  snap: CohortSnapshot,
  extras: SnapshotExtras = {},
): Promise<void> {
  const cols = [
    "snapshot_date",
    "cohort_boundary_days",
    "block_height",
    "lth_supply_btc",
    "sth_supply_btc",
    "circulating_supply_btc",
    "lth_supply_pct_of_circulating",
    "sth_supply_pct_of_circulating",
    ...HODL_AGE_BANDS.map((b) => `hodl_waves_btc_${b}`),
    ...HODL_AGE_BANDS.map((b) => `hodl_waves_pct_${b}`),
    "lth_sopr",
    "lth_net_position_change_btc_1d",
    "lth_net_position_change_btc_7d",
    "lth_net_position_change_btc_30d",
    "lth_net_position_change_btc_90d",
    "lth_sopr_30d_mean",
    "regime",
    "provisional",
    "methodology_version",
    "computed_at",
  ];

  const values: unknown[] = [
    snap.date,
    snap.cohortBoundaryDays,
    snap.blockHeight,
    snap.lthSupplyBtc,
    snap.sthSupplyBtc,
    snap.circulatingSupplyBtc,
    snap.lthSupplyPctOfCirculating,
    snap.sthSupplyPctOfCirculating,
    ...HODL_AGE_BANDS.map((b) => snap.hodlWaves.btc[b] ?? 0),
    ...HODL_AGE_BANDS.map((b) => snap.hodlWaves.pctOfSupply[b] ?? 0),
    snap.lthSopr,
    snap.lthNetPositionChangeBtc1d,
    extras.lthNetPositionChangeBtc7d ?? null,
    extras.lthNetPositionChangeBtc30d ?? null,
    extras.lthNetPositionChangeBtc90d ?? null,
    extras.lthSopr30dMean ?? null,
    extras.regime ?? null,
    snap.provisional,
    snap.methodologyVersion,
    snap.computedAt,
  ];

  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const updates = cols
    .filter((c) => c !== "snapshot_date" && c !== "cohort_boundary_days")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  await pool.query(
    `INSERT INTO cohort_snapshots (${cols.join(", ")}) VALUES (${placeholders})
     ON CONFLICT (snapshot_date, cohort_boundary_days) DO UPDATE SET ${updates};`,
    values,
  );
}

/**
 * Bulk-upsert many snapshots in one multi-row INSERT statement per chunk.
 *
 * Each row contributes ~28 parameters; we chunk at 1000 rows = ~28k params,
 * which stays under Postgres' 32k-parameter ceiling. A 3000-row rebuild
 * therefore makes 3 round-trips, instead of 3000 with the old serial
 * variant — ~1000x faster against a remote Neon instance.
 */
export async function bulkUpsertSnapshots(
  pool: Pool | import("pg").PoolClient,
  rows: Array<{ snap: CohortSnapshot; extras?: SnapshotExtras }>,
): Promise<void> {
  if (rows.length === 0) return;
  const cols = [
    "snapshot_date",
    "cohort_boundary_days",
    "block_height",
    "lth_supply_btc",
    "sth_supply_btc",
    "circulating_supply_btc",
    "lth_supply_pct_of_circulating",
    "sth_supply_pct_of_circulating",
    ...HODL_AGE_BANDS.map((b) => `hodl_waves_btc_${b}`),
    ...HODL_AGE_BANDS.map((b) => `hodl_waves_pct_${b}`),
    "lth_sopr",
    "lth_net_position_change_btc_1d",
    "lth_net_position_change_btc_7d",
    "lth_net_position_change_btc_30d",
    "lth_net_position_change_btc_90d",
    "lth_sopr_30d_mean",
    "regime",
    "provisional",
    "methodology_version",
    "computed_at",
  ];
  const rowParamsPerRow = cols.length;
  const CHUNK = Math.max(1, Math.floor(30_000 / rowParamsPerRow));

  const updates = cols
    .filter((c) => c !== "snapshot_date" && c !== "cohort_boundary_days")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const placeholderRows: string[] = [];
    let p = 1;
    for (const { snap, extras } of slice) {
      const ex = extras ?? {};
      const values: unknown[] = [
        snap.date,
        snap.cohortBoundaryDays,
        snap.blockHeight,
        snap.lthSupplyBtc,
        snap.sthSupplyBtc,
        snap.circulatingSupplyBtc,
        snap.lthSupplyPctOfCirculating,
        snap.sthSupplyPctOfCirculating,
        ...HODL_AGE_BANDS.map((b) => snap.hodlWaves.btc[b] ?? 0),
        ...HODL_AGE_BANDS.map((b) => snap.hodlWaves.pctOfSupply[b] ?? 0),
        snap.lthSopr,
        snap.lthNetPositionChangeBtc1d,
        ex.lthNetPositionChangeBtc7d ?? null,
        ex.lthNetPositionChangeBtc30d ?? null,
        ex.lthNetPositionChangeBtc90d ?? null,
        ex.lthSopr30dMean ?? null,
        ex.regime ?? null,
        snap.provisional,
        snap.methodologyVersion,
        snap.computedAt,
      ];
      const placeholders: string[] = [];
      for (const v of values) {
        placeholders.push(`$${p++}`);
        params.push(v);
      }
      placeholderRows.push(`(${placeholders.join(", ")})`);
    }
    const sql = `
      INSERT INTO cohort_snapshots (${cols.join(", ")})
      VALUES ${placeholderRows.join(", ")}
      ON CONFLICT (snapshot_date, cohort_boundary_days) DO UPDATE SET ${updates};
    `;
    await pool.query(sql, params);
  }
}

/**
 * Read the most recent snapshot for the given cohort boundary, optionally
 * including provisional rows.
 */
export async function getLatestSnapshot(
  pool: Pool,
  cohortBoundaryDays: number,
  includeProvisional = true,
): Promise<CohortSnapshot | null> {
  const where = includeProvisional
    ? "WHERE cohort_boundary_days = $1"
    : "WHERE cohort_boundary_days = $1 AND provisional = false";
  const res = await pool.query(
    `SELECT * FROM cohort_snapshots ${where}
     ORDER BY snapshot_date DESC LIMIT 1`,
    [cohortBoundaryDays],
  );
  if (res.rowCount === 0) return null;
  return rowToSnapshot(res.rows[0]);
}

/**
 * Read the snapshot at or just before the given date. If no snapshot exists
 * on or before that date, returns null.
 */
export async function getSnapshotAtOrBefore(
  pool: Pool,
  date: string,
  cohortBoundaryDays: number,
): Promise<CohortSnapshot | null> {
  const res = await pool.query(
    `SELECT * FROM cohort_snapshots
     WHERE cohort_boundary_days = $1 AND snapshot_date <= $2
     ORDER BY snapshot_date DESC LIMIT 1`,
    [cohortBoundaryDays, date],
  );
  if (res.rowCount === 0) return null;
  return rowToSnapshot(res.rows[0]);
}

/**
 * Read the contiguous series of snapshots in [startDate, endDate],
 * inclusive, ascending by date.
 */
export async function getSnapshotRange(
  pool: Pool,
  startDate: string,
  endDate: string,
  cohortBoundaryDays: number,
): Promise<CohortSnapshot[]> {
  const res = await pool.query(
    `SELECT * FROM cohort_snapshots
     WHERE cohort_boundary_days = $1
       AND snapshot_date BETWEEN $2 AND $3
     ORDER BY snapshot_date ASC`,
    [cohortBoundaryDays, startDate, endDate],
  );
  return res.rows.map(rowToSnapshot);
}

/**
 * Range of snapshots up to and including `endDate`, going back N days.
 */
export async function getTrailingWindow(
  pool: Pool,
  endDate: string,
  windowDays: number,
  cohortBoundaryDays: number,
): Promise<CohortSnapshot[]> {
  const res = await pool.query(
    `SELECT * FROM cohort_snapshots
     WHERE cohort_boundary_days = $1
       AND snapshot_date <= $2
       AND snapshot_date >= ($2::date - ($3 - 1) * INTERVAL '1 day')
     ORDER BY snapshot_date ASC`,
    [cohortBoundaryDays, endDate, windowDays],
  );
  return res.rows.map(rowToSnapshot);
}

/**
 * Min/max LTH supply over a trailing window.
 */
export async function getLthSupplyExtremes(
  pool: Pool,
  endDate: string,
  windowDays: number,
  cohortBoundaryDays: number,
): Promise<{ min: number; max: number; minDate: string; maxDate: string } | null> {
  const res = await pool.query(
    `SELECT
       MIN(lth_supply_btc)::float8 AS min,
       MAX(lth_supply_btc)::float8 AS max,
       (SELECT snapshot_date FROM cohort_snapshots
          WHERE cohort_boundary_days = $1
            AND snapshot_date <= $2
            AND snapshot_date >= ($2::date - ($3 - 1) * INTERVAL '1 day')
          ORDER BY lth_supply_btc ASC LIMIT 1) AS min_date,
       (SELECT snapshot_date FROM cohort_snapshots
          WHERE cohort_boundary_days = $1
            AND snapshot_date <= $2
            AND snapshot_date >= ($2::date - ($3 - 1) * INTERVAL '1 day')
          ORDER BY lth_supply_btc DESC LIMIT 1) AS max_date
     FROM cohort_snapshots
     WHERE cohort_boundary_days = $1
       AND snapshot_date <= $2
       AND snapshot_date >= ($2::date - ($3 - 1) * INTERVAL '1 day')`,
    [cohortBoundaryDays, endDate, windowDays],
  );
  if (res.rowCount === 0 || res.rows[0].min === null) return null;
  return {
    min: Number(res.rows[0].min),
    max: Number(res.rows[0].max),
    minDate: toIsoDate(res.rows[0].min_date),
    maxDate: toIsoDate(res.rows[0].max_date),
  };
}

/**
 * Last LTH-SOPR crossover below 1.0 — the most recent date where SOPR
 * went from >=1 to <1.
 */
export async function getLastLthSoprBelowOneCrossover(
  pool: Pool,
  cohortBoundaryDays: number,
  asOfDate: string,
): Promise<{ date: string; daysAgo: number } | null> {
  const res = await pool.query(
    `WITH series AS (
       SELECT snapshot_date,
              lth_sopr,
              LAG(lth_sopr) OVER (ORDER BY snapshot_date) AS prev_sopr
       FROM cohort_snapshots
       WHERE cohort_boundary_days = $1
         AND snapshot_date <= $2
         AND lth_sopr IS NOT NULL
     )
     SELECT snapshot_date FROM series
     WHERE lth_sopr < 1.0 AND prev_sopr >= 1.0
     ORDER BY snapshot_date DESC LIMIT 1`,
    [cohortBoundaryDays, asOfDate],
  );
  if (res.rowCount === 0) return null;
  const date = toIsoDate(res.rows[0].snapshot_date);
  const daysAgo = Math.floor(
    (new Date(`${asOfDate}T00:00:00Z`).getTime() - new Date(`${date}T00:00:00Z`).getTime()) /
      (1000 * 60 * 60 * 24),
  );
  return { date, daysAgo };
}

/**
 * Earliest indexed snapshot date (for indexerCoverageGap error messages).
 */
export async function getEarliestSnapshotDate(
  pool: Pool,
  cohortBoundaryDays: number,
): Promise<string | null> {
  const res = await pool.query(
    `SELECT snapshot_date FROM cohort_snapshots
     WHERE cohort_boundary_days = $1
     ORDER BY snapshot_date ASC LIMIT 1`,
    [cohortBoundaryDays],
  );
  if (res.rowCount === 0) return null;
  return toIsoDate(res.rows[0].snapshot_date);
}

// ---------- helpers ----------

function rowToSnapshot(row: Record<string, unknown>): CohortSnapshot {
  const btc = {} as Record<HodlAgeBand, number>;
  for (const b of HODL_AGE_BANDS) btc[b] = Number(row[`hodl_waves_btc_${b}`] ?? 0);
  const finalized = finalizeHodlWaves(btc);
  // Prefer stored pct (already normalized) over recomputing from BTC, in
  // case BTC has rounding drift.
  const pct = {} as Record<HodlAgeBand, number>;
  for (const b of HODL_AGE_BANDS) {
    const stored = row[`hodl_waves_pct_${b}`];
    pct[b] = stored != null ? Number(stored) : finalized.pctOfSupply[b];
  }
  const waves: HodlWavesDistribution = { btc: finalized.btc, pctOfSupply: pct };

  return {
    date: toIsoDate(row.snapshot_date),
    blockHeight: Number(row.block_height),
    cohortBoundaryDays: Number(row.cohort_boundary_days),
    lthSupplyBtc: Number(row.lth_supply_btc),
    sthSupplyBtc: Number(row.sth_supply_btc),
    circulatingSupplyBtc: Number(row.circulating_supply_btc),
    lthSupplyPctOfCirculating: Number(row.lth_supply_pct_of_circulating),
    sthSupplyPctOfCirculating: Number(row.sth_supply_pct_of_circulating),
    hodlWaves: waves,
    lthSopr: row.lth_sopr === null || row.lth_sopr === undefined ? null : Number(row.lth_sopr),
    lthNetPositionChangeBtc1d: Number(row.lth_net_position_change_btc_1d ?? 0),
    provisional: Boolean(row.provisional),
    methodologyVersion: String(row.methodology_version),
    computedAt:
      row.computed_at instanceof Date
        ? (row.computed_at as Date).toISOString()
        : String(row.computed_at),
  };
}

function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  throw new Error(`toIsoDate: unexpected ${typeof value} ${String(value)}`);
}
