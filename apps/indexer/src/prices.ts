/**
 * BTC daily-price ingestion job.
 *
 * The indexer's LTH-SOPR computation uses USD values that come pre-attached
 * to Blockchair input dumps (`value_usd` and `spending_value_usd`). We
 * therefore don't strictly need to maintain our own price series for
 * cohort math. We do maintain it for two reasons:
 *
 *   1) Provisional / live-edge LTH-SOPR will eventually need a today
 *      reference price when we resolve spends via Esplora rather than
 *      Blockchair.
 *   2) Future enhancements (e.g. realized-cap series) want a clean,
 *      auditable price source.
 *
 * We use CoinGecko's free `coins/bitcoin/market_chart/range` endpoint,
 * which returns daily USD closes back to BTC's earliest history without
 * an API key.
 */

import { CoinGeckoClient } from "@cohortsignal/core/price";
import { getPoolAsync, upsertDailyPrice } from "@cohortsignal/core/db";

export async function backfillPrices(opts: {
  fromDate?: string;
  toDate?: string;
}): Promise<void> {
  const pool = await getPoolAsync();
  const cg = new CoinGeckoClient({
    baseUrl: process.env.COINGECKO_API_URL,
    demoApiKey: process.env.COINGECKO_DEMO_API_KEY,
  });

  const from = opts.fromDate ?? "2018-01-01";
  const to = opts.toDate ?? new Date().toISOString().slice(0, 10);
  const fromUnix = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
  const toUnix = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000);

  console.log(`[prices] fetching ${from}..${to} from CoinGecko`);
  const series = await cg.fetchBtcMarketChartRange(fromUnix, toUnix);
  console.log(`[prices] got ${series.length} daily samples`);

  for (const row of series) {
    await upsertDailyPrice(pool, {
      date: row.date,
      open: row.close,
      high: row.close,
      low: row.close,
      close: row.close,
      source: "coingecko-public",
    });
  }
  console.log("[prices] backfill complete");
}
