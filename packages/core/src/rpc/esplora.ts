/**
 * Esplora (Blockstream) — public Bitcoin REST API. Used as a no-auth
 * fallback and to mint the public evidenceURL we attach to every response.
 *
 * Docs: https://github.com/Blockstream/esplora/blob/master/API.md
 */

const DEFAULT_BASE = "https://blockstream.info/api";

export interface EsploraBlockTip {
  height: number;
  hash: string;
  timestamp: number;
}

export class EsploraClient {
  constructor(private readonly baseUrl: string = DEFAULT_BASE) {}

  /**
   * The current chain-tip height as seen by Blockstream — used as a
   * sanity-check baseline for our indexer's lag computation, in case the
   * primary RPC provider is itself behind.
   */
  async getTipHeight(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/blocks/tip/height`);
    if (!res.ok) throw new Error(`esplora tip-height HTTP ${res.status}`);
    return Number(await res.text());
  }

  async getBlockHashAt(height: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/block-height/${height}`);
    if (!res.ok) throw new Error(`esplora block-hash HTTP ${res.status}`);
    return (await res.text()).trim();
  }

  /**
   * Public-evidence URL pointing reviewers/buyers at a block-explorer page
   * for a given block height. We attach this to every cohort response.
   */
  evidenceUrlForBlock(height: number): string {
    return `${this.baseUrl.replace(/\/api$/, "")}/block-height/${height}`;
  }

  /**
   * Public-evidence URL pointing reviewers at a block-explorer query
   * for a given snapshot date. Useful in regimeChangeEvents.
   */
  evidenceUrlForDate(isoDate: string, blockHeight: number): string {
    return `${this.baseUrl.replace(/\/api$/, "")}/block-height/${blockHeight}?date=${isoDate}`;
  }
}
