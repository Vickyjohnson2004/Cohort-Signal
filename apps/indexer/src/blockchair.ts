/**
 * Stream Blockchair daily dumps line-by-line. We never store the dump
 * locally — `https://gz.blockchair.com/...` -> gunzip -> readline -> handler.
 *
 * Throughput is critical: a single day's outputs dump can have ~3M rows
 * and the bootstrap walks 9 years × 365 days. We optimize three ways:
 *   1) The header is parsed once per dump; column indexes for the fields
 *      we care about are bound into a tight typed accessor object that
 *      stays alive for the whole stream.
 *   2) Per-row handlers receive a positional accessor — no per-row Map
 *      lookups, no allocation of intermediate objects unless needed.
 *   3) We never await sync handlers: `streamDump` only awaits if the
 *      handler returns a thenable.
 */

import { createGunzip } from "node:zlib";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { Readable } from "node:stream";

const BLOCKCHAIR_BASE = "https://gz.blockchair.com/bitcoin";

export type DumpKind = "blocks" | "outputs" | "inputs";

/**
 * Column-index lookup, derived once from the header row.
 */
export interface ColumnIndex {
  /** Returns the index of a column, or -1 if missing. */
  idx(name: string): number;
  /** Total column count. */
  count: number;
}

export function dumpDateKey(d: Date | string): string {
  const date = typeof d === "string" ? new Date(`${d}T00:00:00Z`) : d;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export function dumpUrl(kind: DumpKind, isoDate: string): string {
  return `${BLOCKCHAIR_BASE}/${kind}/blockchair_bitcoin_${kind}_${dumpDateKey(isoDate)}.tsv.gz`;
}

interface FetchAndParseOptions {
  retries?: number;
  timeoutMs?: number;
  okOn404?: boolean;
}

/**
 * Stream a Blockchair dump with positional row access.
 *
 * onHeader is invoked exactly once with the column-index lookup; whatever
 * it returns is the positional accessor passed to every onRow call.
 */
export async function streamDump<TParsed>(
  kind: DumpKind,
  isoDate: string,
  onHeader: (cols: ColumnIndex) => TParsed,
  onRow: (parser: TParsed, fields: string[]) => void,
  opts: FetchAndParseOptions = {},
): Promise<void> {
  const url = dumpUrl(kind, isoDate);
  const retries = Math.max(1, opts.retries ?? 3);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) {
        if (opts.okOn404) return;
        throw new Error(`dump 404: ${url}`);
      }
      if (!res.ok) throw new Error(`dump HTTP ${res.status}: ${url}`);
      if (!res.body) throw new Error(`dump body empty: ${url}`);

      const nodeStream = Readable.fromWeb(res.body as unknown as never);
      const gunzip = createGunzip();
      nodeStream.pipe(gunzip);
      const rl: ReadlineInterface = createInterface({
        input: gunzip,
        crlfDelay: Infinity,
      });

      let parser: TParsed | null = null;
      for await (const line of rl) {
        if (!line) continue;
        if (parser === null) {
          // Header row.
          const headerNames = line.split("\t");
          const colMap = new Map<string, number>();
          for (let i = 0; i < headerNames.length; i++) {
            const n = headerNames[i];
            if (n !== undefined) colMap.set(n, i);
          }
          const cols: ColumnIndex = {
            idx: (n: string) => colMap.get(n) ?? -1,
            count: headerNames.length,
          };
          parser = onHeader(cols);
          continue;
        }
        const fields = line.split("\t");
        onRow(parser, fields);
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[blockchair] attempt ${attempt}/${retries} failed for ${url}: ${(err as Error).message ?? String(err)}`,
      );
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastErr ?? new Error("streamDump exhausted retries");
}

// ----- typed parsers (one per dump kind) -----

export interface BlockParser {
  idIdx: number;
  timeIdx: number;
}
export function blocksHeader(cols: ColumnIndex): BlockParser {
  return {
    idIdx: cols.idx("id") !== -1 ? cols.idx("id") : cols.idx("block_id"),
    timeIdx: cols.idx("time"),
  };
}
export function readBlock(p: BlockParser, fields: string[]): { height: number; date: string } | null {
  if (p.idIdx < 0 || p.timeIdx < 0) return null;
  const heightStr = fields[p.idIdx];
  const timeStr = fields[p.timeIdx];
  if (heightStr === undefined || timeStr === undefined) return null;
  const height = Number(heightStr);
  if (!Number.isFinite(height)) return null;
  // timeStr looks like "2024-01-02 00:18:14" — slice the date portion only;
  // we don't need full Date parsing for the bootstrap.
  const date = timeStr.length >= 10 ? timeStr.slice(0, 10) : "";
  if (!date) return null;
  return { height, date };
}

export interface OutputParser {
  blockIdIdx: number;
  valueIdx: number;
  usdIdx: number;
  spendIdx: number;
}
export function outputsHeader(cols: ColumnIndex): OutputParser {
  return {
    blockIdIdx: cols.idx("block_id"),
    valueIdx: cols.idx("value"),
    usdIdx: cols.idx("value_usd"),
    spendIdx: cols.idx("is_spendable"),
  };
}
export interface OutputData {
  blockId: number;
  valueSat: number;
  valueUsdAtCreation: number;
  isSpendable: boolean;
}
export function readOutput(p: OutputParser, fields: string[], out: OutputData): boolean {
  if (p.blockIdIdx < 0 || p.valueIdx < 0) return false;
  const blockIdStr = fields[p.blockIdIdx];
  const valueStr = fields[p.valueIdx];
  if (blockIdStr === undefined || valueStr === undefined) return false;
  const blockId = +blockIdStr;
  const valueSat = +valueStr;
  if (!isFinite(blockId) || !isFinite(valueSat)) return false;
  out.blockId = blockId;
  out.valueSat = valueSat;
  out.valueUsdAtCreation =
    p.usdIdx >= 0 ? +(fields[p.usdIdx] ?? "0") : 0;
  // is_spendable: -1 = spendable, 0 = unspendable (OP_RETURN)
  out.isSpendable = p.spendIdx < 0 || fields[p.spendIdx] !== "0";
  return true;
}

export interface InputParser {
  creationBlockIdIdx: number;
  spendBlockIdIdx: number;
  spendTimeIdx: number;
  valueIdx: number;
  usdIdx: number;
  spendUsdIdx: number;
  lifespanIdx: number;
}
export function inputsHeader(cols: ColumnIndex): InputParser {
  return {
    creationBlockIdIdx: cols.idx("block_id"),
    spendBlockIdIdx: cols.idx("spending_block_id"),
    spendTimeIdx: cols.idx("spending_time"),
    valueIdx: cols.idx("value"),
    usdIdx: cols.idx("value_usd"),
    spendUsdIdx: cols.idx("spending_value_usd"),
    lifespanIdx: cols.idx("lifespan"),
  };
}
export interface InputData {
  creationBlockId: number;
  spendBlockId: number;
  spendDate: string;
  valueSat: number;
  valueUsdAtCreation: number;
  valueUsdAtSpend: number;
  lifespanSeconds: number;
}
export function readInput(p: InputParser, fields: string[], out: InputData): boolean {
  if (p.creationBlockIdIdx < 0 || p.spendBlockIdIdx < 0 || p.spendTimeIdx < 0) return false;
  const cb = fields[p.creationBlockIdIdx];
  const sb = fields[p.spendBlockIdIdx];
  const st = fields[p.spendTimeIdx];
  if (cb === undefined || sb === undefined || st === undefined) return false;
  const creationBlockId = +cb;
  const spendBlockId = +sb;
  if (!isFinite(creationBlockId) || !isFinite(spendBlockId)) return false;
  out.creationBlockId = creationBlockId;
  out.spendBlockId = spendBlockId;
  out.spendDate = st.length >= 10 ? st.slice(0, 10) : "";
  out.valueSat = p.valueIdx >= 0 ? +(fields[p.valueIdx] ?? "0") : 0;
  out.valueUsdAtCreation = p.usdIdx >= 0 ? +(fields[p.usdIdx] ?? "0") : 0;
  out.valueUsdAtSpend = p.spendUsdIdx >= 0 ? +(fields[p.spendUsdIdx] ?? "0") : 0;
  out.lifespanSeconds = p.lifespanIdx >= 0 ? +(fields[p.lifespanIdx] ?? "0") : 0;
  return out.spendDate !== "";
}

export function* iterateDateRange(startIsoDate: string, endIsoDate: string): Generator<string> {
  const start = new Date(`${startIsoDate}T00:00:00Z`);
  const end = new Date(`${endIsoDate}T00:00:00Z`);
  const cur = new Date(start);
  while (cur.getTime() <= end.getTime()) {
    yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}
