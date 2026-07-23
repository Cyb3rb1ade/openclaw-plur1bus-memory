/**
 * lib/shared-memory.js — Kollaboratives Memory (verkleinert)
 *
 * Scope: workspace_shared only.
 * Merge-Strategie: latest-wins.
 */

import { jaccardSimilarity } from "./text-utils.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { safeAgentId, sqlString } from "./sql-safety.js";
import { trySafeWarn } from "./safe-logging.js";

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

async function withDbLease(dbPool, agentId, fn) {
  if (typeof dbPool?.withDb === "function") return dbPool.withDb(agentId, fn);
  return fn(dbPool.getDb(agentId));
}

const sharedSchemaMigrations = new WeakMap();
const sharedStoreQueues = new Map();
const SHARE_ACTIONS = new Set(["explicit_share", "legacy_workspace_shared_migration"]);

async function withOptionalAccessLease(lease, descriptor, sources, fn, logger) {
  if (typeof lease !== "function") return fn(sources);
  let callbackEntered = false;
  try {
    return await lease((db) => {
      callbackEntered = true;
      if (!db) return fn(sources);
      return fn([...sources, { ...descriptor, db, optional: true }]);
    });
  } catch (error) {
    if (callbackEntered) throw error;
    trySafeWarn(logger, `shared-memory.${descriptor.namespace}-acquisition`, error);
    return fn(sources);
  }
}

/**
 * Leases required same-agent namespaces plus each authorized optional shared pool.
 * @param {object} privatePool Private namespace pool.
 * @param {object} sharedPool Shared workspace/user pool.
 * @param {string} agentId Requesting agent.
 * @param {object} ctx Canonical request memory context.
 * @param {Function} fn Lease-bound reader callback.
 * @returns {Promise<*>} Callback result.
 */
export async function withAccessReadDbs(privatePool, sharedPool, agentId, ctx, fn) {
  return privatePool.withReadDbs(agentId, async (privateDbs) => {
    const required = privateDbs.map((item) => ({
      ...item,
      optional: false,
      sourceKind: "private",
    }));
    return withOptionalAccessLease(
      ctx?.workspaceIdentity
        ? (callback) => sharedPool.withWorkspaceReadDb(ctx, callback)
        : null,
      { namespace: "shared-workspace", sourceKind: "workspace" },
      required,
      (withWorkspace) => withOptionalAccessLease(
        ctx?.userPrincipal
          ? (callback) => sharedPool.withUserReadDb(ctx, callback)
          : null,
        { namespace: "shared-user", sourceKind: "user" },
        withWorkspace,
        fn,
        ctx?.logger,
      ),
      ctx?.logger,
    );
  });
}

function hash(value) { return createHash("sha256").update(String(value)).digest("hex"); }
function fieldsOf(schema) { return Array.isArray(schema?.fields) ? schema.fields : []; }
function liveExpiry(value, now) {
  return value == null || value === 0 || (typeof value === "number" && Number.isFinite(value) && value > now);
}
function isFiniteVector(vector, dim) {
  return Array.isArray(vector) && vector.length === dim && vector.every(Number.isFinite);
}
function vectorDimensionFromType(type) {
  for (const key of ["listSize", "dimension", "length", "size"]) {
    if (Number.isInteger(type?.[key])) return type[key];
  }
  return null;
}
function runKeyed(key, operation) {
  const previous = sharedStoreQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  sharedStoreQueues.set(key, next);
  return next.finally(() => { if (sharedStoreQueues.get(key) === next) sharedStoreQueues.delete(key); });
}

/** Ensures share provenance columns exist using the table's own text type. */
export async function ensureSharedMemoryColumns(db, { runDbOperation = null } = {}) {
  if (!db || typeof db.init !== "function" || !db.table) throw new Error("shared target database is unavailable");
  const run = typeof runDbOperation === "function"
    ? runDbOperation
    : (_label, operation) => operation();
  const previous = sharedSchemaMigrations.get(db);
  if (previous) return run("shared-schema-existing", () => previous);
  const task = (async () => {
    await run("shared-schema-init", () => db.init());
    let schema = await run("shared-schema-read", () => db.table.schema());
    let fields = fieldsOf(schema);
    const textField = fields.find((field) => field.name === "text");
    if (!textField?.type) throw new Error("shared target schema is missing text type");
    for (const required of ["agentId", "workspaceId"]) {
      if (!fields.some((field) => field.name === required)) throw new Error(`shared target schema is missing ${required}`);
    }
    const defaults = { sourceMemoryId: "''", sourceAgentId: "''", shareIdempotencyKey: "''", shareProvenance: "'{}'" };
    const missing = Object.keys(defaults).filter((name) => !fields.some((field) => field.name === name));
    if (missing.length) {
      try {
        await run("shared-schema-add-columns", () =>
          db.table.addColumns(missing.map((name) => ({
            name,
            type: textField.type,
            valueSql: defaults[name],
          }))));
      }
      catch (error) {
        schema = await run("shared-schema-race-read", () => db.table.schema());
        fields = fieldsOf(schema);
        if (!missing.every((name) => fields.some((field) => field.name === name))) throw error;
      }
      if (typeof db.refreshSchemaFields === "function") {
        await run("shared-schema-refresh", () => db.refreshSchemaFields());
      }
    }
    return true;
  })();
  sharedSchemaMigrations.set(db, task);
  try { return await task; } catch (error) { sharedSchemaMigrations.delete(db); throw error; }
}

function sensitiveSharedMemoryReason(metadata = {}) {
  const category = String(metadata.category || "").toLowerCase();
  const type = String(metadata.type || metadata.memoryType || "").toLowerCase();
  const criticalType = String(metadata.criticalType || metadata.criticalPushType || "").toLowerCase();
  const importance = Number(metadata.importance);
  const importanceBand = String(metadata.importanceBand || metadata.factQuality?.importanceBand || "").toLowerCase();

  if (metadata.memoryClass === "core") return "core memory";
  if (metadata.neverForget === true || metadata.neverForget === 1 || metadata.neverForget === "1") return "neverForget memory";
  if (SENSITIVE_SHARE_CATEGORIES.has(category)) return `sensitive category: ${category}`;
  if (SENSITIVE_SHARE_CATEGORIES.has(type)) return `sensitive type: ${type}`;
  if (SENSITIVE_SHARE_CATEGORIES.has(criticalType)) return `critical type: ${criticalType}`;
  if (importanceBand === "critical") return "critical importance band";
  if (Number.isFinite(importance) && importance >= SENSITIVE_SHARE_IMPORTANCE) return `high importance: ${importance}`;
  return null;
}

/**
 * Stores a memory with scope "workspace_shared".
 *
 * @param {object} dbPool — AgentDbPool with withDb(agentId, fn) and getDb compatibility.
 * @param {string} agentId
 * @param {string} text
 * @param {object} [metadata]
 * @returns {Promise<{ok: boolean, id: string}>}
 */
export async function storeSharedMemory(targetDb, source, ctx, {
  targetScope,
  vector,
  sourceAgentId,
  action = "explicit_share",
  allowSensitiveShare = false,
  logger = null,
  runDbOperation = null,
} = {}) {
  if (!targetDb || !source || !["workspace", "user"].includes(targetScope) || !SHARE_ACTIONS.has(action)) throw new Error("invalid shared memory request");
  const run = typeof runDbOperation === "function"
    ? runDbOperation
    : (_label, operation) => operation();
  const principal = targetScope === "workspace" ? ctx?.workspaceIdentity : ctx?.userPrincipal;
  if (!principal) throw new Error("shared target principal is required");
  const reason = sensitiveSharedMemoryReason(source);
  if (reason && !allowSensitiveShare) throw new Error(`sensitive shared memory requires explicit approval: ${reason}`);
  await ensureSharedMemoryColumns(targetDb, { runDbOperation: run });
  if (!isFiniteVector(vector, targetDb.vectorDim)) throw new Error("shared vector does not match target dimension");
  const schema = await run("shared-store-schema", () => targetDb.table.schema());
  const vectorField = fieldsOf(schema).find((field) => field.name === "vector");
  if (!vectorField?.type) throw new Error("shared target schema is missing vector type");
  const schemaVectorDim = vectorDimensionFromType(vectorField.type);
  if (schemaVectorDim != null && schemaVectorDim !== targetDb.vectorDim) throw new Error("shared target vector schema dimension mismatch");
  const authoritativeSourceAgent = safeAgentId(sourceAgentId);
  if (!source.id) throw new Error("shared source provenance is incomplete");
  for (const alias of [source.agentId, source.storedBy]) {
    if (alias != null && alias !== "" && alias !== authoritativeSourceAgent) throw new Error("shared source ownership conflicts with leased agent");
  }
  const idempotencyKey = hash([action, targetScope, principal, authoritativeSourceAgent, source.id, hash(source.text || source.summary || "")].join("\0"));
  return runKeyed(idempotencyKey, async () => {
    const rows = await run("shared-store-idempotency-read", () =>
      targetDb.table.query()
        .where(`shareIdempotencyKey = ${sqlString(idempotencyKey)} AND status = 'active'`)
        .limit(2)
        .toArray());
    if (rows.length > 1) throw new Error("shared idempotency conflict");
    if (rows.length === 1) return { ok: true, id: rows[0].id, shareIdempotencyKey: idempotencyKey };
    const now = Date.now();
    const copy = {
      ...source, id: randomUUID(), vector: [...vector], scope: targetScope, status: "active", storedBy: authoritativeSourceAgent, agentId: authoritativeSourceAgent,
      workspaceId: targetScope === "workspace" ? principal : "", workspaceKey: targetScope === "workspace" ? principal : "", ownerUserId: targetScope === "user" ? principal : "",
      sourceMemoryId: source.id, sourceAgentId: authoritativeSourceAgent, shareIdempotencyKey: idempotencyKey,
      shareProvenance: JSON.stringify({ schemaVersion: 1, action, targetScope, targetPrincipalHash: hash(principal), sourceMemoryId: source.id, sourceAgentId: authoritativeSourceAgent, sharedAt: now }),
      supersededBy: "", previousVersion: "",
    };
    await run("shared-store-copy", () => targetDb.store(copy));
    const readbackRows = await run("shared-store-readback", () =>
      targetDb.table.query().where(`id = ${sqlString(copy.id)}`).limit(2).toArray());
    if (readbackRows.length !== 1 || readbackRows[0].id !== copy.id || readbackRows[0].shareIdempotencyKey !== idempotencyKey) throw new Error("shared memory readback verification failed");
    return { ok: true, id: copy.id, shareIdempotencyKey: idempotencyKey };
  });
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
  return withDbLease(dbPool, agentId, async (db) => {
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
        // Fall through to text fallback.
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
  });
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
