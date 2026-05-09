#!/usr/bin/env bash
#
# daily-update.sh — once-per-day incremental update for cohort_snapshots.
#
# Run by the Railway "cohortsignal-cron" service on a daily schedule (06:00
# UTC by default). The job has three phases:
#
#   1. bq-bootstrap --from <yesterday> --to <today>
#        Pulls the last day's UTXO creations + spends from BigQuery into
#        the flow tables. ~150 MB scan, well within free tier. Idempotent.
#
#   2. prices --from <7d-ago>
#        Backfills the last week of BTC daily prices from CryptoCompare.
#        Tiny (~50 KB). Idempotent, overwrites by date.
#
#   3. rebuild --from <60d-ago>
#        Replays the deterministic snapshot rebuilder over a rolling
#        60-day window. We don't need to redo all of 2018-2026 daily —
#        only the trailing window that affects 30d/90d-avg statistics
#        for today's snapshot. 60 days gives 90d-avg a clean buffer.
#        ~30 seconds, no external network calls.
#
# Total runtime: ~1-2 minutes. Total BigQuery cost: free-tier-safe.
#
# Exit codes:
#   0  on success of all three phases
#   1  if any phase exits non-zero (Railway will mark the run as failed)

set -euo pipefail

YESTERDAY=$(date -u -d 'yesterday' +%Y-%m-%d)
TODAY=$(date -u +%Y-%m-%d)
SEVEN_DAYS_AGO=$(date -u -d '7 days ago' +%Y-%m-%d)
SIXTY_DAYS_AGO=$(date -u -d '60 days ago' +%Y-%m-%d)

ENTRY=/app/apps/indexer/dist/main.js

echo "[cron] daily-update.sh starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[cron] yesterday=$YESTERDAY today=$TODAY 7d-ago=$SEVEN_DAYS_AGO 60d-ago=$SIXTY_DAYS_AGO"

echo "[cron] phase 1/3: bq-bootstrap --from $YESTERDAY --to $TODAY"
node "$ENTRY" bq-bootstrap --from "$YESTERDAY" --to "$TODAY"

echo "[cron] phase 2/3: prices --from $SEVEN_DAYS_AGO"
node "$ENTRY" prices --from "$SEVEN_DAYS_AGO"

echo "[cron] phase 3/3: rebuild --from $SIXTY_DAYS_AGO"
node "$ENTRY" rebuild --from "$SIXTY_DAYS_AGO"

echo "[cron] daily-update.sh complete at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
