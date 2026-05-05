import type { Pool } from "pg";
import type { IndexerStatus } from "../schemas/index.js";

/**
 * Read the singleton indexer state row. Returns null before the indexer
 * has run for the first time.
 */
export async function getIndexerState(pool: Pool): Promise<IndexerStatus | null> {
  const res = await pool.query(
    `SELECT
       last_block_processed,
       last_block_processed_at,
       chain_tip_height,
       methodology_version,
       indexer_version
     FROM indexer_state WHERE id = 1`,
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];
  const lastAt = row.last_block_processed_at instanceof Date
    ? (row.last_block_processed_at as Date).toISOString()
    : String(row.last_block_processed_at);
  const lagSeconds = Math.max(0, Math.floor((Date.now() - new Date(lastAt).getTime()) / 1000));
  const freshnessThreshold = Number(process.env.INDEXER_FRESHNESS_WARNING_SECONDS ?? 14_400);
  return {
    lastBlockProcessed: Number(row.last_block_processed),
    lastBlockProcessedAt: lastAt,
    chainTipHeight: row.chain_tip_height === null ? null : Number(row.chain_tip_height),
    lagSeconds,
    freshnessWarning: lagSeconds > freshnessThreshold,
    methodologyVersion: String(row.methodology_version),
    indexerVersion: String(row.indexer_version),
  };
}

/**
 * Upsert the singleton indexer state row.
 */
export async function setIndexerState(
  pool: Pool,
  partial: Partial<{
    lastBlockProcessed: number;
    lastBlockProcessedAt: string;
    chainTipHeight: number | null;
    chainTipSeenAt: string | null;
    methodologyVersion: string;
    indexerVersion: string;
    bootstrapCompletedAt: string | null;
    bootstrapSource: string | null;
    notes: string | null;
  }>,
): Promise<void> {
  // Field-by-field UPSERT so we can do partial writes.
  const existing = await pool.query(`SELECT 1 FROM indexer_state WHERE id = 1`);
  if (existing.rowCount === 0) {
    await pool.query(
      `INSERT INTO indexer_state (
         id, last_block_processed, last_block_processed_at,
         chain_tip_height, chain_tip_seen_at,
         methodology_version, indexer_version,
         bootstrap_completed_at, bootstrap_source, notes
       ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        partial.lastBlockProcessed ?? 0,
        partial.lastBlockProcessedAt ?? new Date().toISOString(),
        partial.chainTipHeight ?? null,
        partial.chainTipSeenAt ?? null,
        partial.methodologyVersion ?? "cohortsignal-v1.0",
        partial.indexerVersion ?? "0.1.0",
        partial.bootstrapCompletedAt ?? null,
        partial.bootstrapSource ?? null,
        partial.notes ?? null,
      ],
    );
    return;
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    vals.push(val);
  };
  if (partial.lastBlockProcessed !== undefined) push("last_block_processed", partial.lastBlockProcessed);
  if (partial.lastBlockProcessedAt !== undefined) push("last_block_processed_at", partial.lastBlockProcessedAt);
  if (partial.chainTipHeight !== undefined) push("chain_tip_height", partial.chainTipHeight);
  if (partial.chainTipSeenAt !== undefined) push("chain_tip_seen_at", partial.chainTipSeenAt);
  if (partial.methodologyVersion !== undefined) push("methodology_version", partial.methodologyVersion);
  if (partial.indexerVersion !== undefined) push("indexer_version", partial.indexerVersion);
  if (partial.bootstrapCompletedAt !== undefined) push("bootstrap_completed_at", partial.bootstrapCompletedAt);
  if (partial.bootstrapSource !== undefined) push("bootstrap_source", partial.bootstrapSource);
  if (partial.notes !== undefined) push("notes", partial.notes);
  if (sets.length === 0) return;
  push("updated_at", new Date().toISOString());

  await pool.query(`UPDATE indexer_state SET ${sets.join(", ")} WHERE id = 1`, vals);
}
