/**
 * lib/shared-memory.js — Kollaboratives Memory (verkleinert)
 *
 * Scope: workspace_shared only.
 * Merge-Strategie: latest-wins.
 */

import { jaccardSimilarity } from "./text-utils.js";
import { randomUUID } from "node:crypto";

const DEFAULT_VECTOR_DIM = 384;
const CONFLICT_THRESHOLD = 0.8;

/**
 * Stores a memory with scope "workspace_shared".
 *
 * @param {object} dbPool — AgentDbPool with getDb(agentId) → MemoryDB
 * @param {string} agentId
 * @param {string} text
 * @param {object} [metadata]
 * @returns {Promise<{ok: boolean, id: string}>}
 */
export async function storeSharedMemory(dbPool, agentId, text, metadata = {}) {
  if (!agentId || typeof agentId !== "string") {
    throw new Error("agentId is required and must be a string");
  }
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw new Error("text is required and must be non-empty");
  }

  const db = dbPool.getDb(agentId);
  const entry = {
    ...metadata,
    id: metadata.id || randomUUID(),
    text: text.trim(),
    scope: "workspace_shared",
    createdAt: metadata.createdAt || Date.now(),
    status: metadata.status || "active",
  };

  if (!entry.vector || !Array.isArray(entry.vector)) {
    entry.vector = new Float32Array(DEFAULT_VECTOR_DIM).fill(0);
  }

  await db.store(entry);
  return { ok: true, id: entry.id };
}

/**
 * Queries shared memories across the workspace.
 *
 * @param {object} dbPool
 * @param {string} agentId
 * @param {string} query
 * @param {Function|null} embeddings — async (text) → vector | null
 * @param {number} [limit=10]
 * @returns {Promise<Array<object>>}
 */
export async function querySharedMemories(
  dbPool,
  agentId,
  query,
  embeddings,
  limit = 10
) {
  if (!agentId) return [];
  const db = dbPool.getDb(agentId);

  // Vector search path
  if (typeof embeddings === "function") {
    try {
      const vector = await embeddings(query);
      if (vector && (vector.length > 0 || vector.byteLength > 0)) {
        const results = await db.search(vector, limit * 2, 0);
        return results
          .filter((r) => r.scope === "workspace_shared")
          .slice(0, limit);
      }
    } catch (_err) {
      // Fall through to text fallback
    }
  }

  // Text fallback
  const rows = await db.scanActive();
  const needle = query.toLowerCase();
  return rows
    .filter((r) => r.scope === "workspace_shared")
    .filter(
      (r) =>
        (r.text || "").toLowerCase().includes(needle) ||
        (r.summary || "").toLowerCase().includes(needle)
    )
    .slice(0, limit)
    .map((r) => ({ ...r, score: 0.5 }));
}

/**
 * Detects potential conflicts among shared memories.
 *
 * @param {Array<object>} sharedMemories
 * @returns {Array<{entries: Array<object>, similarity: number, type: string}>}
 */
export function detectConflicts(sharedMemories) {
  if (!sharedMemories || sharedMemories.length < 2) return [];

  const conflicts = [];
  const seenPairs = new Set();

  for (let i = 0; i < sharedMemories.length; i++) {
    for (let j = i + 1; j < sharedMemories.length; j++) {
      const a = sharedMemories[i];
      const b = sharedMemories[j];
      const pairKey = [a.id, b.id].sort().join("-");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const sim = jaccardSimilarity(a.text || "", b.text || "");
      if (sim >= CONFLICT_THRESHOLD) {
        // Identical entries in all relevant fields are not conflicts
        if (
          a.text === b.text &&
          a.summary === b.summary &&
          a.category === b.category
        ) {
          continue;
        }
        conflicts.push({
          entries: [a, b],
          similarity: sim,
          type: "similar_text_different_content",
        });
      }
    }
  }

  return conflicts;
}

/**
 * Resolves a conflict using the given strategy.
 *
 * @param {object} conflict
 * @param {string} [strategy="latest-wins"]
 * @returns {{winner: object|null, loser: object|null, strategy: string}}
 */
export function resolveConflict(conflict, strategy = "latest-wins") {
  if (!conflict || !Array.isArray(conflict.entries) || conflict.entries.length === 0) {
    return { winner: null, loser: null, strategy };
  }

  if (strategy === "latest-wins") {
    const sorted = [...conflict.entries].sort(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
    );
    return {
      winner: sorted[0],
      loser: sorted[1] || null,
      strategy,
    };
  }

  return { winner: null, loser: null, strategy };
}
