/**
 * Bitcoin circulating supply at a given block height.
 *
 * Bitcoin's coinbase issuance schedule is fully deterministic: 50 BTC per
 * block until block 209,999, then halves every 210,000 blocks. We compute
 * the cumulative subsidy at any height in closed form.
 *
 * Note: this is the _issued_ supply, not "in-circulation" (which would
 * exclude provably-burned coins). For LTH/STH cohort math, issued supply
 * is the right denominator because all issued UTXOs are accounted for in
 * the cohort sums.
 */

const HALVING_INTERVAL = 210_000;
const INITIAL_SUBSIDY_SAT = 50n * 100_000_000n; // 50 BTC in satoshis

export function circulatingSupplyBtcAt(blockHeight: number): number {
  if (blockHeight < 0) return 0;
  let totalSat = 0n;
  let processed = 0;
  let halving = 0;
  while (processed <= blockHeight) {
    const subsidy = INITIAL_SUBSIDY_SAT >> BigInt(halving);
    if (subsidy === 0n) break; // subsidy hit zero — stop adding
    const startOfEra = halving * HALVING_INTERVAL;
    const endOfEra = startOfEra + HALVING_INTERVAL - 1;
    const lastBlockInThisEra = Math.min(endOfEra, blockHeight);
    const blocksInThisEra = BigInt(lastBlockInThisEra - startOfEra + 1);
    totalSat += subsidy * blocksInThisEra;
    processed = lastBlockInThisEra + 1;
    halving += 1;
  }
  return Number(totalSat) / 100_000_000;
}
