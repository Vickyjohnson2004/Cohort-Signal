/**
 * BTC daily-price ingestion job.
 *
 * In the BigQuery + rebuild architecture, the LTH-SOPR computation reads
 * USD prices directly from this table. Each daily snapshot's LTH-SOPR is:
 *
 *   sopr[d] = sum_{c <= d-155}(spends[d,c].btc * price[d])
 *           / sum_{c <= d-155}(spends[d,c].btc * price[c])
 *
 * So the price table MUST cover at minimum [first creation date, today].
 * If it doesn't, days with missing prices contribute null to LTH-SOPR
 * (the rebuilder's defensive default).
 *
 * We use CoinGecko's free `coins/bitcoin/market_chart/range` endpoint,
 * which returns daily USD closes back to BTC's earliest history without
 * an API key. Rate-limit: ~10-30 calls/min on the free tier; one
 * range-call can fetch up to ~3000 daily samples in one shot, so the
 * full 2018→today fetch is a single call.
 */

import { CryptoCompareClient } from "@cohortsignal/core/price";
import { bulkUpsertDailyPrices, getPoolAsync } from "@cohortsignal/core/db";

export async function backfillPrices(opts: {
  fromDate?: string;
  toDate?: string;
}): Promise<void> {
  const pool = await getPoolAsync();
  const cc = new CryptoCompareClient({
    apiKey: process.env.CRYPTOCOMPARE_API_KEY,
  });

  const from = opts.fromDate ?? "2018-01-01";
  const to = opts.toDate ?? new Date().toISOString().slice(0, 10);
  const fromUnix = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
  const toUnix = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000);

  console.log(`[prices] fetching ${from}..${to} from CryptoCompare`);
  const series = await cc.fetchBtcDailyOhlcRange(fromUnix, toUnix);
  console.log(`[prices] got ${series.length} daily samples`);

  await bulkUpsertDailyPrices(
    pool,
    series.map((row) => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      source: "cryptocompare-public",
    })),
  );
  console.log(`[prices] backfill complete: ${series.length} rows written`);
}
