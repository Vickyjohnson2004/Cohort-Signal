/**
 * Minimal CoinGecko free-tier client for daily BTC OHLC. The free public
 * API allows daily-granularity historical OHLC for any coin without an
 * API key, with rate limits of ~10-30 req/min. We use it to seed the
 * btc_price_daily table for the LTH-SOPR computation.
 */

const DEFAULT_BASE = "https://api.coingecko.com/api/v3";

export interface CoinGeckoOptions {
  baseUrl?: string;
  /** Optional CoinGecko Demo API key (ups the rate limit). */
  demoApiKey?: string;
  /** Default request timeout in ms. */
  timeoutMs?: number;
}

export interface DailyOhlc {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export class CoinGeckoClient {
  private readonly baseUrl: string;
  private readonly demoKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: CoinGeckoOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.demoKey = opts.demoApiKey || process.env.COINGECKO_DEMO_API_KEY || undefined;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /**
   * Daily BTC/USD OHLC over the last `days` days. CoinGecko's free
   * `coins/{id}/ohlc` returns 4-hour candles for short windows and daily
   * for >=90 days; we always pass days >= 90 and downsample if needed.
   */
  async fetchBtcDailyOhlc(days: number): Promise<DailyOhlc[]> {
    const url = new URL(`${this.baseUrl}/coins/bitcoin/ohlc`);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("days", String(Math.max(days, 90)));
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) throw new Error(`coingecko ohlc HTTP ${res.status}`);
    const rows = (await res.json()) as Array<[number, number, number, number, number]>;
    return downsampleToDaily(rows);
  }

  /**
   * Range history (close-only). Used for backfilling pre-90d history if
   * needed, since /ohlc has odd granularity for very long windows.
   */
  async fetchBtcMarketChartRange(fromUnix: number, toUnix: number): Promise<Array<{ date: string; close: number }>> {
    const url = new URL(`${this.baseUrl}/coins/bitcoin/market_chart/range`);
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("from", String(fromUnix));
    url.searchParams.set("to", String(toUnix));
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) throw new Error(`coingecko market_chart HTTP ${res.status}`);
    const json = (await res.json()) as { prices: Array<[number, number]> };
    const byDate = new Map<string, number>();
    for (const [ts, close] of json.prices) {
      const date = new Date(ts).toISOString().slice(0, 10);
      byDate.set(date, close); // last write per day = end-of-day close
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, close]) => ({ date, close }));
  }

  private async fetchWithTimeout(url: URL): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.demoKey) headers["x-cg-demo-api-key"] = this.demoKey;
      return await fetch(url, { signal: ctrl.signal, headers });
    } finally {
      clearTimeout(timer);
    }
  }
}

function downsampleToDaily(
  rows: Array<[number, number, number, number, number]>,
): DailyOhlc[] {
  const byDate = new Map<string, { date: string; open: number; high: number; low: number; close: number }>();
  for (const [ts, open, high, low, close] of rows) {
    const date = new Date(ts).toISOString().slice(0, 10);
    const cur = byDate.get(date);
    if (!cur) {
      byDate.set(date, { date, open, high, low, close });
    } else {
      cur.high = Math.max(cur.high, high);
      cur.low = Math.min(cur.low, low);
      cur.close = close; // last sample of the day = close
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
