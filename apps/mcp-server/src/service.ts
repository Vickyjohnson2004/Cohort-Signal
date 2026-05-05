/**
 * Service layer — turns the Postgres-backed cohort_snapshots table into
 * the fully enriched CohortRegimeView the MCP tools serve. All business
 * logic lives in @cohortsignal/core; this file only orchestrates DB
 * reads and metadata stitching.
 */

import {
  DEFAULT_COHORT_BOUNDARY_DAYS,
  METHODOLOGY_VERSION,
  CORE_VERSION,
} from "@cohortsignal/core";
import {
  type CohortRegimeView,
  type CohortSnapshot,
  type IndexerStatus,
  type RegimeChangeEvent,
  HODL_AGE_BANDS,
  type HodlAgeBand,
} from "@cohortsignal/core/schemas";
import { dominantBand } from "@cohortsignal/core/cohort";
import {
  classifyRegime,
  REGIME_METHODOLOGY,
  findRegimeChangeEvents,
  type RegimeInputs,
} from "@cohortsignal/core/cohort";
import {
  deltaBtc,
  deltaPct,
  hodlWavesDelta,
  lthSoprStateFor,
  lthSoprStatusFor,
  meanLthSopr,
  meanNetPositionChange,
  priorSnapshotDaysAgo,
  trendFor,
} from "@cohortsignal/core/cohort";
import {
  buildKeyDrivers,
  buildRegimeNarrative,
} from "@cohortsignal/core/cohort";
import { EsploraClient } from "@cohortsignal/core/rpc";
import {
  cacheJson,
  CohortToolError,
  diffDays,
  shiftDateByDaysUtc,
} from "@cohortsignal/core/util";
import {
  getEarliestSnapshotDate,
  getIndexerState,
  getLastLthSoprBelowOneCrossover,
  getLatestSnapshot,
  getLthSupplyExtremes,
  getSnapshotAtOrBefore,
  getSnapshotRange,
  getTrailingWindow,
} from "@cohortsignal/core/db";
import type { Pool } from "pg";

const FRESHNESS_WARNING_SECONDS = Number(
  process.env.INDEXER_FRESHNESS_WARNING_SECONDS ?? 14_400,
);

const SERVER_VERSION = "1.0.0";
const INDEXER_VERSION = `cohortsignal-indexer-${CORE_VERSION}`;

export interface BuildViewOptions {
  asOfDate?: string;
  cohortBoundaryDays?: number;
  /** ISO timestamp used for "now" math; useful for tests. */
  nowIso?: string;
}

export interface CohortService {
  getRegimeView(opts: BuildViewOptions): Promise<CohortRegimeView>;
  getIndexerStatus(): Promise<IndexerStatus>;
  getEarliestDate(cohortBoundaryDays: number): Promise<string | null>;
  getRegimeChangeEvents(opts: {
    fromDate: string;
    toDate: string;
    cohortBoundaryDays: number;
  }): Promise<RegimeChangeEvent[]>;
  getHistoricalContext(opts: {
    asOfDate?: string;
    cohortBoundaryDays?: number;
  }): Promise<HistoricalContext>;
  getLthSoprContext(opts: {
    asOfDate?: string;
    cohortBoundaryDays?: number;
  }): Promise<LthSoprContext>;
  getCohortTimeseries(opts: {
    startDate: string;
    endDate: string;
    metric: TimeseriesMetric;
    granularity: "daily" | "weekly";
    cohortBoundaryDays: number;
  }): Promise<CohortTimeseries>;
}

export type TimeseriesMetric =
  | "lth_supply"
  | "sth_supply"
  | "lth_sopr"
  | "lth_net_position_change"
  | "hodl_waves";

export interface HistoricalContext {
  asOf: string;
  asOfDate: string;
  blockHeight: number;
  cohortBoundaryDays: number;
  methodology: string;
  methodologyVersion: string;
  indexerVersion: string;
  dataFreshnessSeconds: number;
  freshnessWarning: boolean;
  provisional: boolean;
  lthSupplyCurrent: number;
  lthSupply6moMin: number | null;
  lthSupply6moMax: number | null;
  lthSupply12moMin: number | null;
  lthSupply12moMax: number | null;
  percentilePosition6mo: number | null;
  percentilePosition12mo: number | null;
  regimeChangeEvents: RegimeChangeEvent[];
  evidenceURL: string;
}

export interface LthSoprContext {
  asOf: string;
  asOfDate: string;
  blockHeight: number;
  cohortBoundaryDays: number;
  methodology: string;
  methodologyVersion: string;
  indexerVersion: string;
  dataFreshnessSeconds: number;
  freshnessWarning: boolean;
  provisional: boolean;
  lthSoprCurrent: number | null;
  lthSopr30dAvg: number | null;
  lthSoprState: CohortRegimeView["lthSoprState"];
  lthSoprStatus: CohortRegimeView["lthSoprStatus"];
  lastBelowOneCrossover: { date: string; daysAgo: number } | null;
  /** A simple historical-context object built from prior similar SOPR readings. */
  similarHistoricalReadings: {
    threshold: number;
    direction: "below" | "above";
    countLast365d: number;
  };
  evidenceURL: string;
}

export interface CohortTimeseries {
  metric: TimeseriesMetric;
  granularity: "daily" | "weekly";
  startDate: string;
  endDate: string;
  cohortBoundaryDays: number;
  methodology: string;
  methodologyVersion: string;
  indexerVersion: string;
  evidenceURL: string;
  dataPoints: Array<{
    date: string;
    blockHeight: number;
    value: number | null;
    provisional: boolean;
    bandBreakdown?: Record<HodlAgeBand, number>;
  }>;
  regimeChangeEvents: RegimeChangeEvent[];
}

export class PostgresCohortService implements CohortService {
  private readonly pool: Pool;
  private readonly esplora: EsploraClient;

  constructor(pool: Pool, esplora?: EsploraClient) {
    this.pool = pool;
    this.esplora = esplora ?? new EsploraClient(process.env.ESPLORA_API_URL);
  }

  async getIndexerStatus(): Promise<IndexerStatus> {
    const state = await getIndexerState(this.pool);
    if (!state) {
      throw new CohortToolError(
        "indexer_not_ready",
        "The indexer has not yet recorded a state row. The historical bootstrap may still be in progress.",
      );
    }
    return state;
  }

  async getEarliestDate(cohortBoundaryDays: number): Promise<string | null> {
    return getEarliestSnapshotDate(this.pool, cohortBoundaryDays);
  }

  async getRegimeView(opts: BuildViewOptions): Promise<CohortRegimeView> {
    const cohortBoundaryDays = opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;
    const cacheKey = `csv:1:${cohortBoundaryDays}:${opts.asOfDate ?? "now"}`;
    return cacheJson(cacheKey, opts.asOfDate ? 3600 : 60, () =>
      this.buildRegimeView({ ...opts, cohortBoundaryDays }),
    );
  }

  private async buildRegimeView(opts: BuildViewOptions): Promise<CohortRegimeView> {
    const cohortBoundaryDays = opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;
    const now = opts.nowIso ? new Date(opts.nowIso) : new Date();

    let snap: CohortSnapshot | null;
    if (opts.asOfDate) {
      snap = await getSnapshotAtOrBefore(this.pool, opts.asOfDate, cohortBoundaryDays);
      if (!snap) {
        const earliest = await this.getEarliestDate(cohortBoundaryDays);
        throw new CohortToolError(
          "indexer_coverage_gap",
          `No cohort snapshot exists at or before ${opts.asOfDate} for cohortBoundaryDays=${cohortBoundaryDays}. ` +
            (earliest
              ? `The earliest available date is ${earliest}.`
              : "No snapshots have been indexed yet."),
          { earliestAvailable: earliest },
        );
      }
    } else {
      snap = await getLatestSnapshot(this.pool, cohortBoundaryDays, true);
      if (!snap) {
        throw new CohortToolError(
          "indexer_not_ready",
          "No cohort snapshots are available yet. The indexer is still bootstrapping.",
        );
      }
    }

    const window = await getTrailingWindow(this.pool, snap.date, 91, cohortBoundaryDays);
    const series = window;

    const prior7 = priorSnapshotDaysAgo(series, snap, 7);
    const prior30 = priorSnapshotDaysAgo(series, snap, 30);
    const prior90 = priorSnapshotDaysAgo(series, snap, 90);

    const delta7Btc = deltaBtc(snap, prior7);
    const delta30Btc = deltaBtc(snap, prior30);
    const delta90Btc = deltaBtc(snap, prior90);
    const delta7Pct = deltaPct(snap, prior7);
    const delta30Pct = deltaPct(snap, prior30);
    const delta90Pct = deltaPct(snap, prior90);

    const npc7 = meanNetPositionChange(series, snap, 7);
    const npc30 = meanNetPositionChange(series, snap, 30);
    const npc90 = meanNetPositionChange(series, snap, 90);

    const sopr30 = meanLthSopr(series, snap, 30);
    const soprStatus = lthSoprStatusFor(snap.lthSopr);
    const soprState = lthSoprStateFor(snap.lthSopr, sopr30, npc30, snap.lthSupplyBtc);

    const wavesDelta30 = hodlWavesDelta(series, snap, 30);
    const wavesDelta90 = hodlWavesDelta(series, snap, 90);
    const dominant = dominantBand(snap.hodlWaves);

    const under1m = snap.hodlWaves.pctOfSupply.under_1m ?? 0;
    const under1mPrior30 = prior30?.hodlWaves.pctOfSupply.under_1m ?? under1m;

    const regimeInputs: RegimeInputs = {
      lthSupplyBtc: snap.lthSupplyBtc,
      lthSupplyDelta30dPct: delta30Pct,
      lthSupplyDelta7dPct: delta7Pct,
      lthNetPositionChange30dAvgBtc: npc30,
      lthSopr: snap.lthSopr,
      lthSopr30dAvg: sopr30,
      under1mPct: under1m,
      under1mPct30dAgo: under1mPrior30,
    };
    const regime = classifyRegime(regimeInputs);
    const trend = trendFor(delta7Pct, delta30Pct, delta90Pct);

    const indexerStatus = await this.getIndexerStatus();
    const ageSeconds = Math.max(
      0,
      Math.floor((now.getTime() - new Date(`${snap.date}T23:59:59Z`).getTime()) / 1000),
    );

    const view: CohortRegimeView = {
      asOf: now.toISOString(),
      asOfDate: snap.date,
      blockHeight: snap.blockHeight,
      cohortBoundaryDays: snap.cohortBoundaryDays,
      methodology: REGIME_METHODOLOGY,
      methodologyVersion: snap.methodologyVersion,
      indexerVersion: INDEXER_VERSION,

      dataFreshnessSeconds: indexerStatus.lagSeconds + ageSeconds,
      freshnessWarning: indexerStatus.lagSeconds > FRESHNESS_WARNING_SECONDS,
      provisional: snap.provisional,

      lthSupplyBtc: snap.lthSupplyBtc,
      sthSupplyBtc: snap.sthSupplyBtc,
      circulatingSupplyBtc: snap.circulatingSupplyBtc,
      lthSupplyPctOfCirculating: snap.lthSupplyPctOfCirculating,
      sthSupplyPctOfCirculating: snap.sthSupplyPctOfCirculating,

      lthSupplyDelta7dBtc: delta7Btc,
      lthSupplyDelta30dBtc: delta30Btc,
      lthSupplyDelta90dBtc: delta90Btc,
      lthSupplyDelta7dPct: delta7Pct,
      lthSupplyDelta30dPct: delta30Pct,
      lthSupplyDelta90dPct: delta90Pct,

      lthNetPositionChangeBtc7dAvg: npc7,
      lthNetPositionChangeBtc30dAvg: npc30,
      lthNetPositionChangeBtc90dAvg: npc90,

      lthSopr: snap.lthSopr,
      lthSopr30dAvg: sopr30,
      lthSoprStatus: soprStatus,
      lthSoprState: soprState,

      hodlWaves: snap.hodlWaves,
      hodlWavesDelta30d: wavesDelta30,
      hodlWavesDelta90d: wavesDelta90,
      dominantBand: dominant,

      regimeClassifier: regime,
      regimeNarrative: "", // filled below
      keyDrivers: [],
      trend,

      evidenceURL: this.esplora.evidenceUrlForBlock(snap.blockHeight),
    };
    view.regimeNarrative = buildRegimeNarrative(view);
    view.keyDrivers = buildKeyDrivers(view);
    return view;
  }

  async getRegimeChangeEvents(opts: {
    fromDate: string;
    toDate: string;
    cohortBoundaryDays: number;
  }): Promise<RegimeChangeEvent[]> {
    const series = await getSnapshotRange(
      this.pool,
      opts.fromDate,
      opts.toDate,
      opts.cohortBoundaryDays,
    );
    if (series.length < 2) return [];

    const enriched = await Promise.all(
      series.map(async (snapshot) => {
        const window = await getTrailingWindow(this.pool, snapshot.date, 31, opts.cohortBoundaryDays);
        const prior30 = priorSnapshotDaysAgo(window, snapshot, 30);
        const npc30 = meanNetPositionChange(window, snapshot, 30);
        const sopr30 = meanLthSopr(window, snapshot, 30);
        const inputs: RegimeInputs = {
          lthSupplyBtc: snapshot.lthSupplyBtc,
          lthSupplyDelta30dPct: deltaPct(snapshot, prior30),
          lthSupplyDelta7dPct: deltaPct(snapshot, priorSnapshotDaysAgo(window, snapshot, 7)),
          lthNetPositionChange30dAvgBtc: npc30,
          lthSopr: snapshot.lthSopr,
          lthSopr30dAvg: sopr30,
          under1mPct: snapshot.hodlWaves.pctOfSupply.under_1m ?? 0,
          under1mPct30dAgo: prior30?.hodlWaves.pctOfSupply.under_1m ?? snapshot.hodlWaves.pctOfSupply.under_1m ?? 0,
        };
        return { snapshot, inputs };
      }),
    );

    const flips = findRegimeChangeEvents(enriched);
    return flips.map((f) => ({ ...f, cohortBoundaryDays: opts.cohortBoundaryDays }));
  }

  async getHistoricalContext(opts: {
    asOfDate?: string;
    cohortBoundaryDays?: number;
  }): Promise<HistoricalContext> {
    const cohortBoundaryDays = opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;
    const view = await this.getRegimeView({ asOfDate: opts.asOfDate, cohortBoundaryDays });

    const asOfDate = view.asOfDate;
    const sixMo = await getLthSupplyExtremes(this.pool, asOfDate, 183, cohortBoundaryDays);
    const twelveMo = await getLthSupplyExtremes(this.pool, asOfDate, 366, cohortBoundaryDays);

    const fromDate = shiftDateByDaysUtc(asOfDate, -366);
    const events = await this.getRegimeChangeEvents({
      fromDate,
      toDate: asOfDate,
      cohortBoundaryDays,
    });

    const pct6 = sixMo
      ? percentile(view.lthSupplyBtc, sixMo.min, sixMo.max)
      : null;
    const pct12 = twelveMo
      ? percentile(view.lthSupplyBtc, twelveMo.min, twelveMo.max)
      : null;

    return {
      asOf: view.asOf,
      asOfDate: view.asOfDate,
      blockHeight: view.blockHeight,
      cohortBoundaryDays: view.cohortBoundaryDays,
      methodology: view.methodology,
      methodologyVersion: view.methodologyVersion,
      indexerVersion: view.indexerVersion,
      dataFreshnessSeconds: view.dataFreshnessSeconds,
      freshnessWarning: view.freshnessWarning,
      provisional: view.provisional,
      lthSupplyCurrent: view.lthSupplyBtc,
      lthSupply6moMin: sixMo?.min ?? null,
      lthSupply6moMax: sixMo?.max ?? null,
      lthSupply12moMin: twelveMo?.min ?? null,
      lthSupply12moMax: twelveMo?.max ?? null,
      percentilePosition6mo: pct6,
      percentilePosition12mo: pct12,
      regimeChangeEvents: events,
      evidenceURL: view.evidenceURL,
    };
  }

  async getLthSoprContext(opts: {
    asOfDate?: string;
    cohortBoundaryDays?: number;
  }): Promise<LthSoprContext> {
    const cohortBoundaryDays = opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;
    const view = await this.getRegimeView({ asOfDate: opts.asOfDate, cohortBoundaryDays });
    const lastBelowOne = await getLastLthSoprBelowOneCrossover(
      this.pool,
      cohortBoundaryDays,
      view.asOfDate,
    );
    // historical context: how many days in the trailing 365d had SOPR
    // below 1 (or above 1.05, depending on current state)
    const yearStart = shiftDateByDaysUtc(view.asOfDate, -365);
    const series = await getSnapshotRange(
      this.pool,
      yearStart,
      view.asOfDate,
      cohortBoundaryDays,
    );
    const direction: "below" | "above" =
      view.lthSopr !== null && view.lthSopr < 1.0 ? "below" : "above";
    const threshold = direction === "below" ? 1.0 : 1.05;
    const count =
      direction === "below"
        ? series.filter((s) => s.lthSopr !== null && s.lthSopr < threshold).length
        : series.filter((s) => s.lthSopr !== null && s.lthSopr > threshold).length;

    return {
      asOf: view.asOf,
      asOfDate: view.asOfDate,
      blockHeight: view.blockHeight,
      cohortBoundaryDays,
      methodology: view.methodology,
      methodologyVersion: view.methodologyVersion,
      indexerVersion: view.indexerVersion,
      dataFreshnessSeconds: view.dataFreshnessSeconds,
      freshnessWarning: view.freshnessWarning,
      provisional: view.provisional,
      lthSoprCurrent: view.lthSopr,
      lthSopr30dAvg: view.lthSopr30dAvg,
      lthSoprState: view.lthSoprState,
      lthSoprStatus: view.lthSoprStatus,
      lastBelowOneCrossover: lastBelowOne,
      similarHistoricalReadings: {
        threshold,
        direction,
        countLast365d: count,
      },
      evidenceURL: view.evidenceURL,
    };
  }

  async getCohortTimeseries(opts: {
    startDate: string;
    endDate: string;
    metric: TimeseriesMetric;
    granularity: "daily" | "weekly";
    cohortBoundaryDays: number;
  }): Promise<CohortTimeseries> {
    const series = await getSnapshotRange(
      this.pool,
      opts.startDate,
      opts.endDate,
      opts.cohortBoundaryDays,
    );
    if (series.length === 0) {
      const earliest = await this.getEarliestDate(opts.cohortBoundaryDays);
      throw new CohortToolError(
        "indexer_coverage_gap",
        `No snapshots in [${opts.startDate}, ${opts.endDate}] for cohortBoundaryDays=${opts.cohortBoundaryDays}.` +
          (earliest ? ` The earliest available date is ${earliest}.` : ""),
        { earliestAvailable: earliest },
      );
    }

    const sampled = opts.granularity === "weekly"
      ? series.filter((s) => new Date(`${s.date}T00:00:00Z`).getUTCDay() === 0)
      : series;

    const dataPoints = sampled.map((s) => {
      const value = pickMetricValue(s, opts.metric);
      const point: CohortTimeseries["dataPoints"][number] = {
        date: s.date,
        blockHeight: s.blockHeight,
        value,
        provisional: s.provisional,
      };
      if (opts.metric === "hodl_waves") {
        const breakdown = {} as Record<HodlAgeBand, number>;
        for (const b of HODL_AGE_BANDS) breakdown[b] = s.hodlWaves.pctOfSupply[b] ?? 0;
        point.bandBreakdown = breakdown;
      }
      return point;
    });

    const events = await this.getRegimeChangeEvents({
      fromDate: opts.startDate,
      toDate: opts.endDate,
      cohortBoundaryDays: opts.cohortBoundaryDays,
    });

    const lastBlock = sampled[sampled.length - 1]?.blockHeight ?? series[series.length - 1]?.blockHeight ?? 0;

    return {
      metric: opts.metric,
      granularity: opts.granularity,
      startDate: opts.startDate,
      endDate: opts.endDate,
      cohortBoundaryDays: opts.cohortBoundaryDays,
      methodology: REGIME_METHODOLOGY,
      methodologyVersion: METHODOLOGY_VERSION,
      indexerVersion: INDEXER_VERSION,
      evidenceURL: this.esplora.evidenceUrlForBlock(lastBlock),
      dataPoints,
      regimeChangeEvents: events,
    };
  }
}

function pickMetricValue(s: CohortSnapshot, metric: TimeseriesMetric): number | null {
  switch (metric) {
    case "lth_supply":
      return s.lthSupplyBtc;
    case "sth_supply":
      return s.sthSupplyBtc;
    case "lth_sopr":
      return s.lthSopr;
    case "lth_net_position_change":
      return s.lthNetPositionChangeBtc1d;
    case "hodl_waves":
      return null; // value lives in bandBreakdown
  }
}

function percentile(value: number, min: number, max: number): number | null {
  if (max <= min) return null;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export const SERVER_INFO = {
  name: "cohortsignal",
  version: SERVER_VERSION,
  indexerVersion: INDEXER_VERSION,
  methodologyVersion: METHODOLOGY_VERSION,
} as const;

export {
  diffDays as _diffDays,
  shiftDateByDaysUtc as _shiftDateByDaysUtc,
};
