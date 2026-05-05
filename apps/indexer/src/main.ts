/**
 * CLI entry point for the CohortSignal indexer.
 *
 * Usage:
 *   indexer bootstrap [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--cohort 155] [--resume]
 *   indexer live      [--cohort 155]
 *   indexer prices    [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 */

// Load env from monorepo root.
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

import { runBootstrap, type BootstrapProgressInfo } from "./bootstrap.js";
import { runLiveLoop } from "./live.js";
import { backfillPrices } from "./prices.js";

interface Args {
  cmd: string;
  from?: string;
  to?: string;
  cohort?: number;
  resume?: boolean;
  forceRestart?: boolean;
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
    } else if (a === "--resume") {
      args.resume = true;
    } else if (a === "--force-restart") {
      args.forceRestart = true;
    }
  }
  return args;
}

function defaultEndDate(): string {
  // Yesterday in UTC. Today's Blockchair dump is typically not yet published.
  const d = new Date(Date.now() - 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  switch (args.cmd) {
    case "bootstrap": {
      const startDate = args.from ?? "2018-01-01";
      const endDate = args.to ?? defaultEndDate();
      const cohortBoundaryDays = args.cohort ?? 155;
      const resume = !args.forceRestart && Boolean(args.resume);
      console.log(
        `[indexer] bootstrap ${startDate}..${endDate} cohortBoundaryDays=${cohortBoundaryDays} resume=${resume}`,
      );
      const startTs = Date.now();
      await runBootstrap({
        startDate,
        endDate,
        cohortBoundaryDays,
        resume,
        onProgress: (info: BootstrapProgressInfo) => {
          const elapsedTotal = Math.floor((Date.now() - startTs) / 1000);
          const eta =
            info.daysRemaining > 0 && info.elapsedMs > 0
              ? Math.floor((info.elapsedMs / 1000) * info.daysRemaining)
              : 0;
          console.log(
            `[bootstrap] ${info.date} blk=${info.blockHeight} ` +
              `LTH=${info.lthSupplyBtc.toFixed(0)} STH=${info.sthSupplyBtc.toFixed(0)} ` +
              `unspent=${info.totalUnspentBtc.toFixed(0)} BTC tracked=${info.trackedBlocks} ` +
              `dt=${(info.elapsedMs / 1000).toFixed(1)}s remaining=${info.daysRemaining}d ` +
              `total=${elapsedTotal}s eta=${eta}s`,
          );
        },
      });
      console.log(`[indexer] bootstrap done in ${Math.floor((Date.now() - startTs) / 1000)}s`);
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
      console.error("Usage: indexer {bootstrap|live|prices} [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--cohort 155]");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[indexer] fatal", err);
  process.exit(1);
});
