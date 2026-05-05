/**
 * Minimal Bitcoin Core JSON-RPC client. We only need a handful of methods
 * for the live-edge indexer (the historical seed comes from Blockchair
 * dumps, not RPC).
 */

export interface BitcoinRpcOptions {
  url: string;
  /** Optional bearer token, only used for providers that prefer headers over URL. */
  authHeader?: string;
  /** Default request timeout in ms. */
  timeoutMs?: number;
}

export interface BitcoinBlock {
  hash: string;
  height: number;
  time: number; // unix seconds
  confirmations: number;
  tx: string[]; // verbosity 1: tx hashes only
  previousblockhash?: string;
}

export interface BitcoinBlockVerbose2 {
  hash: string;
  height: number;
  time: number;
  confirmations: number;
  tx: BitcoinTxVerbose[];
  previousblockhash?: string;
}

export interface BitcoinTxVerbose {
  txid: string;
  hash: string;
  vin: Array<{
    txid?: string;
    vout?: number;
    coinbase?: string;
    sequence?: number;
  }>;
  vout: Array<{
    value: number; // BTC, decimal
    n: number;
    scriptPubKey: { type: string; address?: string };
  }>;
}

export class BitcoinRpcError extends Error {
  override readonly name = "BitcoinRpcError";
  constructor(
    message: string,
    public readonly method: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class BitcoinRpcClient {
  constructor(private readonly opts: BitcoinRpcOptions) {}

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.authHeader) headers.authorization = this.opts.authHeader;
      const res = await fetch(this.opts.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "1.0", id: "cohortsignal", method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new BitcoinRpcError(
          `HTTP ${res.status} from ${method}: ${text.slice(0, 200)}`,
          method,
          res.status,
        );
      }
      const json = (await res.json()) as { result: T; error: unknown };
      if (json.error) {
        throw new BitcoinRpcError(
          `RPC error from ${method}: ${JSON.stringify(json.error).slice(0, 200)}`,
          method,
        );
      }
      return json.result;
    } catch (err) {
      if (err instanceof BitcoinRpcError) throw err;
      throw new BitcoinRpcError(
        `network error in ${method}: ${(err as Error).message ?? String(err)}`,
        method,
        undefined,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async getBlockCount(): Promise<number> {
    return this.call<number>("getblockcount");
  }

  async getBlockHash(height: number): Promise<string> {
    return this.call<string>("getblockhash", [height]);
  }

  /** verbosity=1 returns block header + tx ids. */
  async getBlock(hash: string): Promise<BitcoinBlock> {
    return this.call<BitcoinBlock>("getblock", [hash, 1]);
  }

  /** verbosity=2 returns full transaction objects (large payload). */
  async getBlockVerbose2(hash: string): Promise<BitcoinBlockVerbose2> {
    return this.call<BitcoinBlockVerbose2>("getblock", [hash, 2]);
  }

  /** Required for resolving inputs whose previous output we haven't cached. */
  async getRawTransaction(txid: string, blockhash?: string): Promise<BitcoinTxVerbose> {
    if (blockhash) return this.call<BitcoinTxVerbose>("getrawtransaction", [txid, true, blockhash]);
    return this.call<BitcoinTxVerbose>("getrawtransaction", [txid, true]);
  }
}
