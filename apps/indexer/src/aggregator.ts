/**
 * CohortAggregator — the deterministic in-memory engine that produces
 * daily cohort_snapshots from a stream of (output_created, output_spent)
 * events.
 *
 * Design constraint: O(blocks_ever_created) memory, not O(utxos_ever_created).
 * We aggregate by *creation_block_id* rather than (txhash, vout). At any
 * point in time, two pieces of state are tracked per creation block:
 *
 *   - survivedBtc[blockId]            : sum of BTC value of UTXOs created
 *                                       at this block that are STILL UNSPENT
 *                                       at the current cursor day
 *   - survivedUsdAtCreation[blockId] : sum of value_usd_at_creation for
 *                                       those UTXOs (used by SOPR; not
 *                                       strictly needed for cohort sums)
 *
 * The HODL waves snapshot for day D is then a simple O(blocks_ever) sweep:
 *
 *   for each blockId B with survivedBtc[B] > 0:
 *       creationDate = blockDateFor(B)
 *       ageDays      = D - creationDate
 *       band         = bandForAgeDays(ageDays)
 *       hodlWaves[band].btc += survivedBtc[B]
 *
 * Memory: ~9M blocks × 3 numbers × 8 bytes ≈ 216 MB peak (but really
 * much less since a typed Float64Array indexed by blockId reduces overhead
 * dramatically). We use Float64Arrays sized to the max known block height
 * for cache-friendliness.
 *
 * LTH-SOPR: separate from the HODL waves walk. As we stream each *spent*
 * input, if its `lifespan_days >= cohortBoundaryDays`, we accumulate
 * (spend_value_usd, create_value_usd) into a per-day SOPR aggregator.
 * The daily LTH-SOPR is sum(spend_usd) / sum(create_usd).
 */

import {
  HODL_AGE_BANDS,
  type CohortSnapshot,
  type HodlAgeBand,
  type HodlWavesDistribution,
  METHODOLOGY_VERSION,
  DEFAULT_COHORT_BOUNDARY_DAYS,
} from "@cohortsignal/core";
import { bandForAgeDays, finalizeHodlWaves } from "@cohortsignal/core/cohort";
import { circulatingSupplyBtcAt } from "@cohortsignal/core/util";

const SAT_PER_BTC = 100_000_000;

export interface BlockMeta {
  height: number;
  /** UTC date string (YYYY-MM-DD) of the block timestamp. */
  date: string;
}

export interface OutputCreatedEvent {
  /** Block height the output was created at. */
  blockId: number;
  /** Output value in satoshis (integer). */
  valueSat: number;
  /** USD value at creation time (output dump column 'value_usd'). */
  valueUsdAtCreation: number;
  /** Whether the output is spendable (rows where is_spendable = 0 are ignored). */
  isSpendable: boolean;
}

export interface InputSpentEvent {
  /** Block height the spent output was originally created at. */
  creationBlockId: number;
  /** Block height the spend happened at. */
  spendBlockId: number;
  /** Spent value in satoshis (integer; same as creation value). */
  valueSat: number;
  /** USD value at creation time. */
  valueUsdAtCreation: number;
  /** USD value at spend time (input dump column 'spending_value_usd'). */
  valueUsdAtSpend: number;
  /** Pre-computed lifespan in seconds (column 'lifespan'). */
  lifespanSeconds: number;
}

/**
 * Per-day LTH-SOPR aggregator — one running pair (spendUsd, createUsd) per
 * spend day. We only count spends whose lifespan in days >= cohort boundary.
 */
interface SoprDayBucket {
  spendUsdSum: number;
  createUsdSum: number;
}

interface DailySnapshotBuilderOptions {
  cohortBoundaryDays: number;
  startBlockHeight?: number;
  /** Initial supply (BTC) at startBlockHeight. Used during partial bootstraps. */
  startCirculatingSupplyBtc?: number;
}

export class CohortAggregator {
  /**
   * survivedSat[blockId] = sum of unspent satoshis created at blockId.
   * We use a sparse Map rather than a Float64Array so we don't need to
   * know the max block height ahead of time.
   */
  private readonly survivedSat = new Map<number, number>();

  /** Block metadata (height -> date). Filled by ingestBlock(). */
  private readonly blockDateById = new Map<number, string>();

  /** Maximum block height observed. Used for snapshot block_height. */
  private maxBlockId = 0;

  /** Per-spend-day SOPR bucket for LTH spends only. */
  private readonly soprByDay = new Map<string, SoprDayBucket>();

  /**
   * Cohort boundary in days. Currently captured per snapshot; the
   * aggregator state itself is boundary-agnostic (we always store full
   * UTXO age info). The boundary is applied at snapshot computation time.
   */
  constructor(private readonly opts: DailySnapshotBuilderOptions) {}

  ingestBlock(meta: BlockMeta): void {
    this.blockDateById.set(meta.height, meta.date);
    if (meta.height > this.maxBlockId) this.maxBlockId = meta.height;
  }

  ingestOutputCreated(ev: OutputCreatedEvent): void {
    if (!ev.isSpendable) return;
    if (ev.valueSat <= 0) return;
    const cur = this.survivedSat.get(ev.blockId) ?? 0;
    this.survivedSat.set(ev.blockId, cur + ev.valueSat);
    if (ev.blockId > this.maxBlockId) this.maxBlockId = ev.blockId;
  }

  ingestInputSpent(ev: InputSpentEvent, spendDate: string): void {
    if (ev.valueSat <= 0) return;
    const cur = this.survivedSat.get(ev.creationBlockId) ?? 0;
    const next = cur - ev.valueSat;
    if (next <= 0) {
      this.survivedSat.delete(ev.creationBlockId);
    } else {
      this.survivedSat.set(ev.creationBlockId, next);
    }
    if (ev.spendBlockId > this.maxBlockId) this.maxBlockId = ev.spendBlockId;

    // LTH-SOPR contribution if the spend was of a long-term-held UTXO.
    const ageDays = ev.lifespanSeconds / 86_400;
    if (ageDays >= this.opts.cohortBoundaryDays) {
      const bucket =
        this.soprByDay.get(spendDate) ?? { spendUsdSum: 0, createUsdSum: 0 };
      // Skip rows with non-finite USD (early Blockchair entries before
      // pricing was reliable can be NaN/0; we filter zeros out — the
      // contribution is undefined and including 0/0 would skew SOPR).
      if (
        Number.isFinite(ev.valueUsdAtSpend) &&
        Number.isFinite(ev.valueUsdAtCreation) &&
        ev.valueUsdAtSpend > 0 &&
        ev.valueUsdAtCreation > 0
      ) {
        bucket.spendUsdSum += ev.valueUsdAtSpend;
        bucket.createUsdSum += ev.valueUsdAtCreation;
      }
      this.soprByDay.set(spendDate, bucket);
    }
  }

  /**
   * Return the LTH-SOPR for a specific UTC date, or null if no qualifying
   * spends were observed.
   */
  lthSoprFor(date: string): number | null {
    const b = this.soprByDay.get(date);
    if (!b || b.createUsdSum === 0) return null;
    return b.spendUsdSum / b.createUsdSum;
  }

  /**
   * Drop the LTH-SOPR bucket for a date once we've persisted that day's
   * snapshot. Keeps memory bounded across a multi-year bootstrap.
   */
  forgetSoprFor(date: string): void {
    this.soprByDay.delete(date);
  }

  /**
   * Build a CohortSnapshot for the given snapshot date.
   *
   * @param snapshotDate     UTC date string (YYYY-MM-DD).
   * @param snapshotBlockId  The last block height of that day.
   * @param prevLthBtc       LTH supply BTC from the previous-day snapshot,
   *                          for net-position-change. Pass 0 for the very
   *                          first day.
   */
  buildSnapshot(args: {
    snapshotDate: string;
    snapshotBlockId: number;
    prevLthBtc: number;
    provisional?: boolean;
  }): CohortSnapshot {
    const cohortBoundaryDays =
      this.opts.cohortBoundaryDays ?? DEFAULT_COHORT_BOUNDARY_DAYS;

    const today = new Date(`${args.snapshotDate}T00:00:00Z`).getTime();
    const oneDay = 86_400_000;

    let lthSat = 0;
    let sthSat = 0;
    const btcByBand = {} as Record<HodlAgeBand, number>;
    for (const b of HODL_AGE_BANDS) btcByBand[b] = 0;

    for (const [blockId, sat] of this.survivedSat) {
      const creationDate = this.blockDateById.get(blockId);
      if (!creationDate) continue; // shouldn't happen if blocks ingested

      const ageDays = Math.floor(
        (today - new Date(`${creationDate}T00:00:00Z`).getTime()) / oneDay,
      );
      if (ageDays < 0) continue; // future-dated block (impossible for valid input)

      const valueBtc = sat / SAT_PER_BTC;
      const band = bandForAgeDays(ageDays);
      btcByBand[band] += valueBtc;
      if (ageDays >= cohortBoundaryDays) {
        lthSat += sat;
      } else {
        sthSat += sat;
      }
    }

    const lthBtc = lthSat / SAT_PER_BTC;
    const sthBtc = sthSat / SAT_PER_BTC;

    const issuedBtcAtTip = circulatingSupplyBtcAt(args.snapshotBlockId);
    // The aggregated UTXO sum can drift from issuance by a few thousand BTC
    // due to provably-burned coins (e.g. 50 BTC genesis output, OP_RETURN
    // burns) and rounding; use it as the denominator for cohort percentages
    // because that's the supply we actually accounted for in the cohort sums.
    const accountedBtc = lthBtc + sthBtc;
    const denomBtc = accountedBtc > 0 ? accountedBtc : issuedBtcAtTip;

    const hodlWaves: HodlWavesDistribution = finalizeHodlWaves(btcByBand);

    return {
      date: args.snapshotDate,
      blockHeight: args.snapshotBlockId,
      cohortBoundaryDays,
      lthSupplyBtc: lthBtc,
      sthSupplyBtc: sthBtc,
      circulatingSupplyBtc: denomBtc,
      lthSupplyPctOfCirculating: denomBtc > 0 ? lthBtc / denomBtc : 0,
      sthSupplyPctOfCirculating: denomBtc > 0 ? sthBtc / denomBtc : 0,
      hodlWaves,
      lthSopr: this.lthSoprFor(args.snapshotDate),
      lthNetPositionChangeBtc1d: lthBtc - args.prevLthBtc,
      provisional: Boolean(args.provisional),
      methodologyVersion: METHODOLOGY_VERSION,
      computedAt: new Date().toISOString(),
    };
  }

  /** Number of distinct creation-blocks currently tracked. */
  trackedBlockCount(): number {
    return this.survivedSat.size;
  }

  /** Sum of all unspent satoshis currently tracked. */
  totalUnspentSat(): number {
    let s = 0;
    for (const v of this.survivedSat.values()) s += v;
    return s;
  }

  maxObservedBlockId(): number {
    return this.maxBlockId;
  }
}
