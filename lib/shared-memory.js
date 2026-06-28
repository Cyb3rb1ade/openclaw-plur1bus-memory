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
const DEFAULT_MAX_CONFLICT_CANDIDATES = 500;
const DEFAULT_MAX_CONFLICTS = 100;
const SENSITIVE_SHARE_IMPORTANCE = 0.9;
const SENSITIVE_SHARE_CATEGORIES = new Set([
  "access/password",
  "account",
  "birthday",
  "credential",
  "health",
  "money",
  "money/account",
  "password",
  "person",
  "relationship",
  "secret",
]);

function sensitiveSharedMemoryReason(metadata = {}) {
  const category = String(metadata.category || metadata.type || metadata.memoryType || "").toLowerCase();
  const criticalType = String(metadata.criticalType || metadata.criticalPushType || "").toLowerCase();
  const importance = Number(metadata.importance);
  const importanceBand = String(metadata.importanceBand || metadata.factQuality?.importanceBand || "").toLowerCase();

  if (metadata.memoryClass === "core") return "core memory";
  if (metadata.neverForget === true || metadata.neverForget === 1 || metadata.neverForget === "1") return "neverForget memory";
  if (SENSITIVE_SHARE_CATEGORIES.has(category)) return `sensitive category: ${category}`;
  if (SENSITIVE_SHARE_CATEGORIES.has(criticalType)) return `critical type: ${criticalType}`;
  if (importanceBand === "critical") return "critical importance band";
  if (Number.isFinite(importance) && importance >= SENSITIVE_SHARE_IMPORTANCE) return `high importance: ${importance}`;
  return null;
}

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

  const reason = sensitiveSharedMemoryReason(metadata);
  if (reason && metadata.allowSensitiveShare !== true) {
    throw new Error(`sensitive shared memory requires explicit approval: ${reason}`);
  }

  const db = dbPool.getDb(agentId);
  const { allowSensitiveShare: _allowSensitiveShare, ...safeMetadata } = metadata;
  const entry = {
    ...safeMetadata,
    id: safeMetadata.id || randomUUID(),
    text: text.trim(),
    scope: "workspace_shared",
    createdAt: safeMetadata.createdAt || Date.now(),
    status: safeMetadata.status || "active",
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

const DEFAULT_CONFLICT_MAX_CANDIDATES = 500;
const DEFAULT_CONFLICT_MAX_CONFLICTS = 100;

/**
 * Detects potential conflicts among shared memories.
 *
 * The comparison is O(n²); to avoid blocking on large inputs a hard
 * `maxCandidates` limit prunes older entries and `maxConflicts` stops the
 * inner loop early. Small inputs (< limit) keep exact semantics; large
 * inputs trade completeness for bounded runtime and deterministically
 * prefer the most recent candidates.
 *
 * @param {Array<object>} sharedMemories
 * @param {object} [opts]
 * @param {number} [opts.maxCandidates=500]
 * @param {number} [opts.maxConflicts=100]
 * @returns {Array<{entries: Array<object>, similarity: number, type: string}>}
 */
export function detectConflicts(sharedMemories, opts = {}) {
  if (!sharedMemories || sharedMemories.length < 2) return [];

  const maxCandidates = Number.isFinite(opts.maxCandidates)
    ? Math.max(2, opts.maxCandidates)
    : DEFAULT_CONFLICT_MAX_CANDIDATES;
  const maxConflicts = Number.isFinite(opts.maxConflicts)
    ? Math.max(1, opts.maxConflicts)
    : DEFAULT_CONFLICT_MAX_CONFLICTS;

  let candidates = sharedMemories;
  if (sharedMemories.length > maxCandidates) {
    candidates = [...sharedMemories]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, maxCandidates);
  }

  const conflicts = [];
  const seenPairs = new Set();

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
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
        if (conflicts.length >= maxConflicts) return conflicts;
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
