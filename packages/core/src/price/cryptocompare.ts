/**
 * Minimal CryptoCompare free-tier client for daily BTC OHLC.
 *
 * We use this in place of CoinGecko's free tier because CoinGecko's
 * `/market_chart/range` endpoint now caps Public API users at 365 days of
 * history (their pricing change in late 2024). CohortSignal's LTH-SOPR
 * computation needs the full 2018→today history, so we depend on
 * CryptoCompare's still-free histoday endpoint.
 *
 * Endpoint: GET https://min-api.cryptocompare.com/data/v2/histoday
 *   ?fsym=BTC&tsym=USD&limit=N&toTs=<unix>
 *
 * Returns up to 2000 daily candles at a time. Free public usage:
 * approximately 50 calls / second / IP, ~250k calls/month. We only need
 * ~2-3 calls for the full backfill; well within the free tier forever.
 *
 * Cross-check: CryptoCompare aggregates from multiple exchanges, so
 * absolute USD numbers may differ from any single venue (Coinbase,
 * Bitstamp). For LTH-SOPR the absolute level doesn't matter, only the
 * RATIO between price-at-creation and price-at-spend, both pulled from
 * the same series. This means our SOPR is internally consistent.
 */

const DEFAULT_BASE = "https://min-api.cryptocompare.com/data/v2";

export interface CryptoCompareOptions {
  baseUrl?: string;
  /** Optional API key (anonymous usage is allowed but rate-limited). */
  apiKey?: string;
  timeoutMs?: number;
}

export interface DailyOhlc {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class CryptoCompareClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: CryptoCompareOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.apiKey = opts.apiKey || process.env.CRYPTOCOMPARE_API_KEY || undefined;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Fetch BTC/USD daily OHLC over the inclusive range [fromUnix, toUnix].
   * Pages internally to handle the 2000-row cap.
   */
  async fetchBtcDailyOhlcRange(fromUnix: number, toUnix: number): Promise<DailyOhlc[]> {
    const all: DailyOhlc[] = [];
    let cursor = toUnix;
    while (cursor > fromUnix) {
      const limit = 2000; // max
      const url = new URL(`${this.baseUrl}/histoday`);
      url.searchParams.set("fsym", "BTC");
      url.searchParams.set("tsym", "USD");
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("toTs", String(cursor));
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) throw new Error(`CryptoCompare HTTP ${res.status}`);
      const json = (await res.json()) as {
        Response: string;
        Message?: string;
        Data?: {
          TimeFrom?: number;
          TimeTo?: number;
          Data: Array<{ time: number; high: number; low: number; open: number; close: number }>;
        };
      };
      if (json.Response !== "Success" || !json.Data) {
        throw new Error(`CryptoCompare: ${json.Message ?? "no data"}`);
      }
      const rows = json.Data.Data;
      // Rows come oldest-first; convert to our DailyOhlc shape.
      for (const r of rows) {
        if (r.time < fromUnix) continue;
        if (r.time > toUnix) continue;
        // Skip leading zero rows (CryptoCompare returns zeroes before its
        // earliest data on the requested instrument).
        if (r.open === 0 && r.high === 0 && r.low === 0 && r.close === 0) continue;
        const date = new Date(r.time * 1000).toISOString().slice(0, 10);
        all.push({ date, open: r.open, high: r.high, low: r.low, close: r.close });
      }
      // Page back: next call should fetch up to (TimeFrom - 86400).
      const earliest = json.Data.TimeFrom ?? rows[0]?.time;
      if (!earliest || earliest <= fromUnix) break;
      cursor = earliest - 86400;
      if (rows.length === 0) break;
    }
    // Dedupe + sort ascending.
    const byDate = new Map<string, DailyOhlc>();
    for (const r of all) byDate.set(r.date, r);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  private async fetchWithTimeout(url: URL): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.apiKey) headers.authorization = `Apikey ${this.apiKey}`;
      return await fetch(url, { signal: ctrl.signal, headers });
    } finally {
      clearTimeout(timer);
    }
  }
}
