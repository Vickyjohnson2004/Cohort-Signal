/**
 * CLI entry point for the CohortSignal indexer.
 *
 * Usage:
 *   indexer bq-bootstrap [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--creations-only] [--spends-only]
 *      Run the BigQuery extracts that populate utxo_daily_creations and
 *      utxo_daily_spends_by_creation. Idempotent. The full historical run
 *      bills ~613 GB; subsequent runs only bill the incremental window.
 *
 *   indexer rebuild [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--cohort 155]
 *      Replay the deterministic snapshot rebuilder over the flow tables
 *      and write the resulting cohort_snapshots + regime_change_events.
 *      Idempotent. Run after bq-bootstrap and after prices.
 *
 *   indexer prices [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *      Backfill BTC daily prices from CoinGecko into btc_price_daily.
 *      Required for LTH-SOPR computation in `rebuild`.
 *
 *   indexer live [--cohort 155]
 *      Run the live-edge loop: every 5 minutes, project today's
 *      provisional snapshot from yesterday's authoritative state plus the
 *      current chain-tip's coinbase issuance.
 */

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
  resolve(process.cwd(), "../../../.env"),
]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, override: false });
    break;
  }
}

import { bigQueryBootstrap } from "./bigquery.js";
import { rebuildAllSnapshots } from "./rebuildSnapshots.js";
import { runLiveLoop } from "./live.js";
import { backfillPrices } from "./prices.js";

interface Args {
  cmd: string;
  from?: string;
  to?: string;
  cohort?: number;
  creationsOnly?: boolean;
  spendsOnly?: boolean;
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? "live";
  const args: Args = { cmd };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--from" && next) {
      args.from = next;
      i++;
    } else if (a === "--to" && next) {
      args.to = next;
      i++;
    } else if (a === "--cohort" && next) {
      args.cohort = Number(next);
      i++;
    } else if (a === "--creations-only") {
      args.creationsOnly = true;
    } else if (a === "--spends-only") {
      args.spendsOnly = true;
    }
  }
  return args;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  switch (args.cmd) {
    case "bq-bootstrap": {
      const fromDate = args.from ?? "2018-01-01";
      const toDate = args.to ?? todayUtc();
      console.log(
        `[indexer] bq-bootstrap ${fromDate}..${toDate} ` +
          `creationsOnly=${Boolean(args.creationsOnly)} spendsOnly=${Boolean(args.spendsOnly)}`,
      );
      const t0 = Date.now();
      const result = await bigQueryBootstrap({
        fromDate,
        toDate,
        creationsOnly: args.creationsOnly,
        spendsOnly: args.spendsOnly,
        onProgress: (info) => {
          console.log(
            `[bq] phase=${info.phase} rowsSeen=${info.rowsSeen} rowsWritten=${info.rowsWritten} pageBytes=${(info.pageBytes / 1e9).toFixed(2)}GB`,
          );
        },
      });
      console.log(
        `[indexer] bq-bootstrap done in ${Math.floor((Date.now() - t0) / 1000)}s ` +
          `creations=${result.creationsRows} spends=${result.spendsRows} ` +
          `bytesBilled=${(result.bytesBilled / 1e9).toFixed(1)}GB`,
      );
      process.exit(0);
      return;
    }
    case "rebuild": {
      const cohortBoundaryDays = args.cohort ?? 155;
      console.log(`[indexer] rebuild from=${args.from ?? "<earliest>"} to=${args.to ?? "<today>"} cohort=${cohortBoundaryDays}`);
      const t0 = Date.now();
      const result = await rebuildAllSnapshots({
        cohortBoundaryDays,
        fromDate: args.from,
        toDate: args.to,
        onProgress: (info) => {
          console.log(
            `[rebuild] ${info.date} LTH=${info.lthBtc.toFixed(0)} STH=${info.sthBtc.toFixed(0)} days=${info.daysWritten}`,
          );
        },
      });
      console.log(
        `[indexer] rebuild done in ${Math.floor((Date.now() - t0) / 1000)}s ` +
          `daysWritten=${result.daysWritten} regimeChanges=${result.regimeChanges}`,
      );
      process.exit(0);
      return;
    }
    case "live": {
      const cohortBoundaryDays = args.cohort ?? 155;
      console.log(`[indexer] live mode cohortBoundaryDays=${cohortBoundaryDays}`);
      await runLiveLoop({ cohortBoundaryDays });
      return;
    }
    case "prices": {
      await backfillPrices({ fromDate: args.from, toDate: args.to });
      process.exit(0);
      return;
    }
    default:
      console.error(`[indexer] unknown command: ${args.cmd}`);
      console.error(
        "Usage: indexer {bq-bootstrap|rebuild|prices|live} [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--cohort 155] [--creations-only|--spends-only]",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[indexer] fatal", err);
  process.exit(1);
});
