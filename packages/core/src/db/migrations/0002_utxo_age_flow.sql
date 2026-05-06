-- =============================================================================
-- CohortSignal — UTXO age-flow tables
-- =============================================================================
-- These tables hold the canonical "what BTC was created on day X and what
-- of it has been spent on day Y" rollup that we extract from the public
-- bigquery-public-data.crypto_bitcoin dataset (or, for live updates, from
-- a Bitcoin Core RPC node we already control via GetBlock).
--
-- Together they let us deterministically reconstruct cohort_snapshots
-- for any UTC day in range without having to scan the chain again, and
-- they are the source-of-truth that our `rebuild-snapshots` job replays
-- into cohort_snapshots and regime_change_events.
--
-- Methodology cross-check: the sum of (creation_total_btc) over all dates
-- minus the sum of (spend_total_btc joined back to creations) at any
-- as-of date must equal the total UTXO supply at that date, which in turn
-- must equal Bitcoin's circulating supply (within the well-known rounding/
-- burn drift of ~30 BTC). This invariant is asserted by the rebuild job.

-- Daily creations: one row per UTC date.
CREATE TABLE IF NOT EXISTS utxo_daily_creations (
    creation_date     date           PRIMARY KEY,
    total_btc         numeric(20, 8) NOT NULL,
    /* `source` documents where the row came from for audit. Values:
       'bigquery:crypto_bitcoin' for historical rows
       'rpc:getblock'           for live-edge rows
    */
    source            text           NOT NULL,
    fetched_at        timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS utxo_daily_creations_source_idx
    ON utxo_daily_creations (source);

-- Spends rolled up by (spend_date, creation_date).
-- Cardinality from a 2018-01-01 -> 2026-05-05 BigQuery run: ~6.79M rows.
CREATE TABLE IF NOT EXISTS utxo_daily_spends_by_creation (
    spend_date        date           NOT NULL,
    creation_date     date           NOT NULL,
    total_btc         numeric(20, 8) NOT NULL,
    source            text           NOT NULL,
    fetched_at        timestamptz    NOT NULL DEFAULT now(),
    PRIMARY KEY (spend_date, creation_date)
);

CREATE INDEX IF NOT EXISTS utxo_daily_spends_spend_idx
    ON utxo_daily_spends_by_creation (spend_date);
CREATE INDEX IF NOT EXISTS utxo_daily_spends_creation_idx
    ON utxo_daily_spends_by_creation (creation_date);

-- =============================================================================
-- bootstrap_runs — audit log of every BigQuery / RPC bootstrap we ran
-- =============================================================================
CREATE TABLE IF NOT EXISTS bootstrap_runs (
    id                bigserial PRIMARY KEY,
    started_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz,
    /* 'bigquery-creations', 'bigquery-spends', 'rpc-day' */
    job_kind          text NOT NULL,
    /* Date range processed, inclusive. */
    range_start       date,
    range_end         date,
    rows_written      bigint,
    bytes_billed      bigint,
    success           boolean,
    error             text,
    notes             text
);

-- =============================================================================
-- Add 7d/30d/90d net position change columns to cohort_snapshots
-- =============================================================================
-- We previously only stored the 1-day delta. Computing 7/30/90-day deltas
-- on the fly works but doubles the SQL surface; cache them at write-time.
ALTER TABLE cohort_snapshots
    ADD COLUMN IF NOT EXISTS lth_net_position_change_btc_7d  numeric(20, 8),
    ADD COLUMN IF NOT EXISTS lth_net_position_change_btc_30d numeric(20, 8),
    ADD COLUMN IF NOT EXISTS lth_net_position_change_btc_90d numeric(20, 8),
    /* Mean LTH-SOPR over a trailing 30d window, used by the regime classifier. */
    ADD COLUMN IF NOT EXISTS lth_sopr_30d_mean               numeric(12, 8),
    /* Cached regime label, written by the rebuild job. NULL on rows where
       the trailing window isn't full yet (first ~90 days of history). */
    ADD COLUMN IF NOT EXISTS regime                          text
        CHECK (regime IS NULL OR regime IN ('accumulation','equilibrium','distribution'));

CREATE INDEX IF NOT EXISTS cohort_snapshots_regime_idx
    ON cohort_snapshots (cohort_boundary_days, regime, snapshot_date DESC);
