#!/usr/bin/env bash
#
# daily-update.sh — once-per-day incremental update for cohort_snapshots.
#
# Run by the Railway "cohortsignal-cron" service on a daily schedule (06:00
# UTC by default). The job has three phases:
#
#   1. bq-bootstrap --from <yesterday> --to <today>
#        Pulls the last day's UTXO creations + spends from BigQuery into
#        the flow tables. Tiny scan, well within free tier. Idempotent.
#
#   2. prices --from <7d-ago>
#        Backfills the last week of BTC daily prices from CryptoCompare.
#        Tiny (~50 KB). Idempotent, overwrites by date.
#
#   3. rebuild  (NO --from FLAG)
#        Replays the deterministic snapshot rebuilder over the FULL 2018-
#        today range. ~11 minutes, no external network calls. This is
#        non-negotiable for correctness: rebuildSnapshotsStreaming starts
#        its UTXO age tracking from `inputs.creations[0].creationDate`,
#        so passing only the trailing 60 days of creations causes every
#        snapshot to think the chain has zero history and emit LTH=0
#        across the rebuilt window. The 2026-05-09 cron run did exactly
#        that and corrupted the trailing 61 days of cohort_snapshots
#        before we caught it. The full rebuild is idempotent and
#        deterministic; re-running it produces byte-identical output to
#        the canonical historical state. Cost is just Postgres I/O.
#
# Total runtime: ~12 minutes. Total BigQuery cost: free-tier-safe.
#
# Exit codes:
#   0  on success of all three phases
#   1  if any phase exits non-zero (Railway will mark the run as failed)

set -euo pipefail

YESTERDAY=$(date -u -d 'yesterday' +%Y-%m-%d)
TODAY=$(date -u +%Y-%m-%d)
SEVEN_DAYS_AGO=$(date -u -d '7 days ago' +%Y-%m-%d)

ENTRY=/app/apps/indexer/dist/main.js

echo "[cron] daily-update.sh starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[cron] yesterday=$YESTERDAY today=$TODAY 7d-ago=$SEVEN_DAYS_AGO"

echo "[cron] phase 1/3: bq-bootstrap --from $YESTERDAY --to $TODAY"
node "$ENTRY" bq-bootstrap --from "$YESTERDAY" --to "$TODAY"

echo "[cron] phase 2/3: prices --from $SEVEN_DAYS_AGO"
node "$ENTRY" prices --from "$SEVEN_DAYS_AGO"

echo "[cron] phase 3/3: rebuild (full 2018-today replay; ~11 min)"
node "$ENTRY" rebuild

echo "[cron] daily-update.sh complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
