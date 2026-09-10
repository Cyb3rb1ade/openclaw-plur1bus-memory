/**
 * Stale-entry detection for the KNOWLEDGE.md promotion queue
 * (`.adaptive-learning/knowledge-pending.json`).
 *
 * `knowledge_update` fetches the queued memories, drops the invalidated ones
 * so they can never reach canonical KNOWLEDGE.md, and afterwards removes only
 * the keys it actually integrated. Entries whose memory can never become
 * promotable — invalidated (a soft delete sets `status="deleted"` **and**
 * `epistemicStatus="invalidated"`, see lib/db-adapter.js) or gone from the
 * table entirely — were therefore never removed. They stayed queued forever,
 * inflating `pendingCount` and with it the "N insights are waiting for
 * KNOWLEDGE.md" maintenance nudge.
 *
 * Pruning is deliberately conservative: a key is only reported when its id was
 * actually part of the query that produced `rows`. Ids beyond the query cap,
 * or a failed fetch, must leave the queue untouched rather than silently drop
 * work that is still pending.
 */
import { normalizeEpistemicStatus } from "./epistemic-status.js";

/**
 * @param {{pending?: Array<{key?: string, memoryId?: string}>, rows?: Array<{id?: string, epistemicStatus?: string}>, queriedIds?: string[]}} params
 *   `pending` the agent's queue entries, `rows` the rows the DB returned,
 *   `queriedIds` exactly the ids that were asked for.
 * @returns {string[]} queue keys that can never be promoted, in queue order,
 *   each at most once.
 */
export function selectStalePendingKeys({ pending, rows, queriedIds } = {}) {
  const entries = Array.isArray(pending) ? pending : [];
  const asked = new Set(Array.isArray(queriedIds) ? queriedIds.filter((id) => typeof id === "string" && id) : []);
  if (asked.size === 0) return [];
  const rowById = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row && typeof row.id === "string" && row.id) rowById.set(row.id, row);
  }
  const stale = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = entry?.key;
    const memoryId = entry?.memoryId;
    if (typeof key !== "string" || !key || seen.has(key)) continue;
    if (typeof memoryId !== "string" || !asked.has(memoryId)) continue;
    const row = rowById.get(memoryId);
    const unpromotable = row === undefined
      || normalizeEpistemicStatus(row.epistemicStatus) === "invalidated";
    if (!unpromotable) continue;
    seen.add(key);
    stale.push(key);
  }
  return stale;
}
