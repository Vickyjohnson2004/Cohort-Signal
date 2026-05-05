-- =============================================================================
-- CohortSignal — initial schema
-- =============================================================================
-- One row per (date, cohort_boundary_days) is the canonical unit of truth.
-- The default cohort_boundary_days is 155 (Glassnode standard); we allow
-- alternative boundaries because the Execute methods accept a
-- cohortBoundaryDays parameter and we want to be able to serve them
-- pre-computed (or at least cache them) without recomputing on every call.

CREATE TABLE IF NOT EXISTS cohort_snapshots (
    id                                bigserial PRIMARY KEY,
    snapshot_date                     date           NOT NULL,
    cohort_boundary_days              integer        NOT NULL DEFAULT 155,
    block_height                      integer        NOT NULL,

    lth_supply_btc                    numeric(20, 8) NOT NULL,
    sth_supply_btc                    numeric(20, 8) NOT NULL,
    circulating_supply_btc            numeric(20, 8) NOT NULL,
    lth_supply_pct_of_circulating     numeric(10, 8) NOT NULL,
    sth_supply_pct_of_circulating     numeric(10, 8) NOT NULL,

    -- HODL waves: one column per canonical age band, BTC and pct.
    hodl_waves_btc_under_1m           numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_1m_3m              numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_3m_6m              numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_6m_12m             numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_1y_2y              numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_2y_3y              numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_3y_5y              numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_5y_7y              numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_7y_10y             numeric(20, 8) NOT NULL DEFAULT 0,
    hodl_waves_btc_over_10y           numeric(20, 8) NOT NULL DEFAULT 0,

    hodl_waves_pct_under_1m           numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_1m_3m              numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_3m_6m              numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_6m_12m             numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_1y_2y              numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_2y_3y              numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_3y_5y              numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_5y_7y              numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_7y_10y             numeric(10, 8) NOT NULL DEFAULT 0,
    hodl_waves_pct_over_10y           numeric(10, 8) NOT NULL DEFAULT 0,

    -- LTH-SOPR for the day; null if no LTH spends were observed.
    lth_sopr                          numeric(12, 8),

    -- Daily change in LTH supply (BTC, signed).
    lth_net_position_change_btc_1d    numeric(20, 8) NOT NULL DEFAULT 0,

    -- Provisional flag for the latest few snapshots until they reach the
    -- finality threshold (default 6 confirmations).
    provisional                       boolean        NOT NULL DEFAULT false,

    methodology_version               text           NOT NULL,
    computed_at                       timestamptz    NOT NULL DEFAULT now(),

    UNIQUE (snapshot_date, cohort_boundary_days)
);

CREATE INDEX IF NOT EXISTS cohort_snapshots_date_idx
    ON cohort_snapshots (snapshot_date DESC);

CREATE INDEX IF NOT EXISTS cohort_snapshots_date_boundary_idx
    ON cohort_snapshots (cohort_boundary_days, snapshot_date DESC);

-- =============================================================================
-- Indexer state — singleton row tracking how far the live indexer has caught
-- up to the chain tip. Used to compute dataFreshnessSeconds and to decide
-- when to set freshnessWarning.
-- =============================================================================

CREATE TABLE IF NOT EXISTS indexer_state (
    id                       integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_block_processed     integer     NOT NULL,
    last_block_processed_at  timestamptz NOT NULL,
    chain_tip_height         integer,
    chain_tip_seen_at        timestamptz,
    methodology_version      text        NOT NULL,
    indexer_version          text        NOT NULL,
    bootstrap_completed_at   timestamptz,
    bootstrap_source         text,
    notes                    text,
    updated_at               timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- BTC daily prices — used for LTH-SOPR computation.
-- One row per UTC date, OHLC + a single "reference" close used in SOPR.
-- =============================================================================

CREATE TABLE IF NOT EXISTS btc_price_daily (
    price_date    date           PRIMARY KEY,
    open_usd      numeric(20, 8) NOT NULL,
    high_usd      numeric(20, 8) NOT NULL,
    low_usd       numeric(20, 8) NOT NULL,
    close_usd     numeric(20, 8) NOT NULL,
    source        text           NOT NULL,
    fetched_at    timestamptz    NOT NULL DEFAULT now()
);

-- =============================================================================
-- Regime change events — pre-computed at indexer time so Query/Execute
-- methods don't have to rescan the entire series.
-- =============================================================================

CREATE TABLE IF NOT EXISTS regime_change_events (
    id                     bigserial PRIMARY KEY,
    event_date             date    NOT NULL,
    block_height           integer NOT NULL,
    cohort_boundary_days   integer NOT NULL,
    from_regime            text    NOT NULL CHECK (from_regime IN ('accumulation','equilibrium','distribution')),
    to_regime              text    NOT NULL CHECK (to_regime IN ('accumulation','equilibrium','distribution')),
    methodology_version    text    NOT NULL,
    computed_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_date, cohort_boundary_days)
);

CREATE INDEX IF NOT EXISTS regime_change_events_boundary_date_idx
    ON regime_change_events (cohort_boundary_days, event_date DESC);
