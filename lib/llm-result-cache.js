/**
 * Exact, purpose-allowlisted LLM result cache with absolute TTL and LRU
 * eviction. Persistent storage is optional and added lazily per agent scope.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { safeDebug, safeWarn } from "./safe-logging.js";
import { resolveInside, safeAgentId } from "./sql-safety.js";

/** Default absolute result-cache lifetime: 24 hours. */
export const DEFAULT_LLM_RESULT_CACHE_TTL_MS = 86_400_000;

/** Explicitly cacheable PLUR1BUS-internal LLM transformations. */
export const LLM_RESULT_CACHE_PURPOSES = Object.freeze({
  CAPTURE_SUMMARY: "capture-summary",
  RECALL_QUERY_SUMMARY: "recall-query-summary",
  MERGE_DECISION: "merge-decision",
  CONFLICT_RESOLUTION: "conflict-resolution",
  EMOTION_CLASSIFICATION: "emotion-classification",
  EPISODE_ANALYSIS: "episode-analysis",
  CONVERSATION_INSIGHTS: "conversation-insights",
  SKILL_EXTRACTION: "skill-extraction",
  REM_PATTERN_ANALYSIS: "rem-pattern-analysis",
  KNOWLEDGE_UPDATE: "knowledge-update",
});

const ALLOWED_PURPOSES = new Set(Object.values(LLM_RESULT_CACHE_PURPOSES));
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 7 * 86_400_000;
const CACHE_VERSION = "llm-result-cache-v1";
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 67_108_864;
const MAX_MAX_ENTRIES = 10_000;
const MAX_MAX_BYTES = 1_073_741_824;
const PERSIST_METADATA_BYTES = 256;
const SOFT_LIMIT_RATIO = 0.9;
const SQLITE_CLEANUP_BATCH_SIZE = 8;
const SQLITE_CLEANUP_MAX_ROWS = 256;
const SQLITE_SWEEP_MAX_BATCHES = 16;

/**
 * Clamp a cache TTL to the supported finite range.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeLlmResultCacheTtlMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_RESULT_CACHE_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(parsed)));
}

/**
 * Clamp the memory entry cap to the supported range (0 disables the layer).
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeLlmResultCacheMaxEntries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_ENTRIES;
  return Math.min(MAX_MAX_ENTRIES, Math.max(0, Math.floor(parsed)));
}

/**
 * Clamp the persistent byte cap to the supported range (0 skips all writes).
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeLlmResultCacheMaxBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_BYTES;
  return Math.min(MAX_MAX_BYTES, Math.max(0, Math.floor(parsed)));
}

/**
 * Add an explicit cache scope and allowlisted purpose to an LLM config.
 * @param {Object} llmCfg
 * @param {string} scopeId
 * @param {string} purpose
 * @returns {Object}
 */
export function withLlmResultCacheContext(llmCfg, scopeId, purpose) {
  return { ...llmCfg, resultCacheContext: { scopeId, purpose } };
}

/**
 * Serialize JSON-like values deterministically without normalizing strings.
 * @param {unknown} value
 * @returns {string}
 */
function stableSerialize(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Number.POSITIVE_INFINITY) return "number:Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "number:-Infinity";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${String(value)}`;
  }
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "bigint") return `bigint:${String(value)}`;
  if (Array.isArray(value)) {
    return `array:[${value.map(stableSerialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`);
    return `object:{${entries.join(",")}}`;
  }
  return `${typeof value}:${String(value)}`;
}

/**
 * Create a SHA-256 hexadecimal digest.
 * @param {string} value
 * @returns {string}
 */
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Build the sole cache key without retaining prompt, credential, or headers.
 * @param {Object} request
 * @returns {string}
 */
function buildCacheKey(request) {
  const credentialHash = sha256(stableSerialize(request.credential));
  const headersHash = sha256(stableSerialize(request.headers));
  return sha256(stableSerialize({
    cacheVersion: CACHE_VERSION,
    purpose: request.purpose,
    scopeId: request.scopeId,
    endpoint: request.endpoint,
    credentialHash,
    model: request.model,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    jsonMode: request.jsonMode,
    disableThinking: request.disableThinking,
    headersHash,
  }));
}

function emptyCounters() {
  return {
    requests: 0,
    memoryHits: 0,
    persistHits: 0,
    misses: 0,
    coalesced: 0,
    upstreamCalls: 0,
    persistWrites: 0,
    persistWriteSkipped: 0,
    avoidedInputTokens: 0,
    avoidedOutputTokens: 0,
    upstreamProviderCachedInputTokens: 0,
    hitsMissingUsage: 0,
  };
}

/**
 * Create an exact LLM result cache.
 * @param {Object} [options]
 * @param {boolean} [options.enabled=true]
 * @param {number} [options.ttlMs=86400000]
 * @param {number} [options.maxEntries=256]
 * @param {boolean} [options.persist=false]
 * @param {string} [options.baseDbPath]
 * @param {number} [options.maxBytes=67108864]
 * @param {boolean} [options.metrics=true]
 * @param {() => number} [options.now]
 * @param {(path: string, mode: number) => void} [options.chmodFile]
 * @param {() => Promise<Object>} [options.loadSqlite]
 * @param {Object} [options.logger]
 * @returns {{getOrCompute: Function, getMetrics: Function, close: Function}}
 */
export function createLlmResultCache({
  enabled = true,
  ttlMs,
  maxEntries = DEFAULT_MAX_ENTRIES,
  persist = false,
  baseDbPath,
  maxBytes = DEFAULT_MAX_BYTES,
  metrics = true,
  now = Date.now,
  chmodFile = chmodSync,
  loadSqlite = () => import("node:sqlite"),
  logger,
} = {}) {
  const normalizedTtlMs = normalizeLlmResultCacheTtlMs(ttlMs);
  const normalizedMaxEntries = normalizeLlmResultCacheMaxEntries(maxEntries);
  if (Number.isFinite(Number(maxEntries)) && Math.floor(Number(maxEntries)) > MAX_MAX_ENTRIES) {
    safeWarn(logger, "llm-result-cache",
      `llmResultCacheMaxEntries ${Math.floor(Number(maxEntries))} exceeds the maximum of ${MAX_MAX_ENTRIES}; clamped`,
      { phase: "config" });
  }
  const normalizedMaxBytes = normalizeLlmResultCacheMaxBytes(maxBytes);
  if (Number.isFinite(Number(maxBytes)) && Math.floor(Number(maxBytes)) > MAX_MAX_BYTES) {
    safeWarn(logger, "llm-result-cache",
      `llmResultCacheMaxBytes ${Math.floor(Number(maxBytes))} exceeds the maximum of ${MAX_MAX_BYTES}; clamped`,
      { phase: "config" });
  }

  /** @type {Map<string, {value: Object, expiresAt: number}>} */
  const memory = new Map();
  /** @type {Map<string, Promise<Object>>} */
  const inFlight = new Map();
  /** @type {Map<string, ReturnType<typeof emptyCounters>>} */
  const metricsByScope = new Map();
  /** @type {Map<string, {database: import("node:sqlite").DatabaseSync, dbPath: string, scopeId: string}>} */
  const dbByPath = new Map();
  /** @type {Map<string, string>} */
  const dbPathByScope = new Map();
  /** @type {Map<string, Promise<Object|null>>} */
  const dbOpenByScope = new Map();
  const failedDbPaths = new Set();
  const failedScopes = new Set();
  let sqliteModule;
  let closed = false;
  let closePromise;

  function countersFor(scopeId) {
    let counters = metricsByScope.get(scopeId);
    if (!counters) {
      counters = emptyCounters();
      metricsByScope.set(scopeId, counters);
    }
    return counters;
  }

  function increment(scopeId, key, amount = 1) {
    if (!metrics) return;
    countersFor(scopeId)[key] += amount;
  }

  function recordHitUsage(scopeId, value) {
    const inputTokens = value?.usage?.inputTokens;
    const outputTokens = value?.usage?.outputTokens;
    if (Number.isFinite(inputTokens)) increment(scopeId, "avoidedInputTokens", inputTokens);
    if (Number.isFinite(outputTokens)) increment(scopeId, "avoidedOutputTokens", outputTokens);
    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
      increment(scopeId, "hitsMissingUsage");
    }
  }

  function isCacheableResult(request, value) {
    const text = value?.text;
    if (typeof text !== "string" || text.trim().length === 0) return false;
    if (request.jsonMode !== true) return true;
    try {
      JSON.parse(text);
      return true;
    } catch {
      safeDebug(logger, "llm-result-cache", "invalid_json_result", {
        phase: "validate-result",
        scopeId: request.scopeId,
        purpose: request.purpose,
      });
      return false;
    }
  }

  function getMemory(keyHash, timestamp) {
    const entry = memory.get(keyHash);
    if (!entry) return undefined;
    if (entry.expiresAt <= timestamp) {
      memory.delete(keyHash);
      return undefined;
    }
    memory.delete(keyHash);
    memory.set(keyHash, entry);
    return entry.value;
  }

  function setMemory(keyHash, value, expiresAt) {
    if (normalizedMaxEntries === 0) return;
    memory.delete(keyHash);
    memory.set(keyHash, { value, expiresAt });
    while (memory.size > normalizedMaxEntries) {
      const oldestKey = memory.keys().next().value;
      if (oldestKey === undefined) break;
      memory.delete(oldestKey);
    }
  }

  function closeHandle(handle, phase) {
    if (!handle) return;
    try {
      handle.database.close();
    } catch (error) {
      safeDebug(logger, "llm-result-cache", error, {
        phase,
        scopeId: handle.scopeId,
        dbPath: handle.dbPath,
      });
    }
  }

  function disablePersistence(scopeId, dbPath, database, error, phase) {
    failedScopes.add(scopeId);
    if (dbPath) {
      failedDbPaths.add(dbPath);
      dbByPath.delete(dbPath);
    }
    dbPathByScope.delete(scopeId);
    if (database) closeHandle({ database, dbPath, scopeId }, `${phase}-close`);
    safeWarn(logger, "llm-result-cache", error, {
      phase,
      scopeId,
      ...(dbPath ? { dbPath } : {}),
    });
  }

  async function openDb(scopeId) {
    let database;
    let dbPath;
    try {
      mkdirSync(baseDbPath, { recursive: true, mode: 0o700 });
      const resolvedBaseDbPath = resolveInside(baseDbPath);
      if (!statSync(resolvedBaseDbPath).isDirectory()) {
        throw new Error("LLM result cache base path is not a directory");
      }
      const agentId = safeAgentId(scopeId);
      dbPath = resolveInside(resolvedBaseDbPath, CACHE_VERSION, `${agentId}.db`);
      if (failedDbPaths.has(dbPath)) return null;
      const existing = dbByPath.get(dbPath);
      if (existing) return existing;

      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      if (!sqliteModule) sqliteModule = await loadSqlite();
      database = new sqliteModule.DatabaseSync(dbPath);
      chmodFile(dbPath, 0o600);
      database.exec("PRAGMA busy_timeout=5000;");
      const schemaRow = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get();
      if (Number(schemaRow?.count ?? 0) === 0) {
        database.exec("PRAGMA auto_vacuum=INCREMENTAL;");
        database.exec("VACUUM;");
      }
      database.exec("PRAGMA journal_mode=WAL;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS llm_results (
          key_hash TEXT PRIMARY KEY,
          purpose TEXT NOT NULL,
          model TEXT NOT NULL,
          response_text TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          provider_cached_input_tokens INTEGER,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          byte_size INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_results_expires ON llm_results(expires_at);
        CREATE INDEX IF NOT EXISTS idx_llm_results_accessed ON llm_results(accessed_at);
      `);
      sweepExpired(database, now());
      const handle = { database, dbPath, scopeId };
      dbByPath.set(dbPath, handle);
      dbPathByScope.set(scopeId, dbPath);
      return handle;
    } catch (error) {
      disablePersistence(scopeId, dbPath, database, error, "open");
      return null;
    }
  }

  async function ensureDb(scopeId) {
    if (!persist || !baseDbPath || failedScopes.has(scopeId)) return null;
    const knownPath = dbPathByScope.get(scopeId);
    if (knownPath) {
      const handle = dbByPath.get(knownPath);
      if (handle) return handle;
    }
    const existingOpen = dbOpenByScope.get(scopeId);
    if (existingOpen) return existingOpen;
    if (closed) return null;

    const pendingOpen = openDb(scopeId);
    dbOpenByScope.set(scopeId, pendingOpen);
    try {
      return await pendingOpen;
    } finally {
      dbOpenByScope.delete(scopeId);
    }
  }

  function databaseSize(dbPath) {
    let total = 0;
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) total += statSync(path).size;
    }
    return total;
  }

  function deleteExpired(database, timestamp) {
    const deletion = database.prepare(`
      DELETE FROM llm_results
      WHERE key_hash IN (
        SELECT key_hash
        FROM llm_results
        WHERE expires_at <= ?
        ORDER BY expires_at ASC, accessed_at ASC, created_at ASC
        LIMIT ?
      )
    `).run(timestamp, SQLITE_CLEANUP_MAX_ROWS);
    return Number(deletion.changes ?? 0);
  }

  function sweepExpired(database, timestamp) {
    for (let batch = 0; batch < SQLITE_SWEEP_MAX_BATCHES; batch += 1) {
      if (deleteExpired(database, timestamp) < SQLITE_CLEANUP_MAX_ROWS) break;
    }
  }

  function compactAndMeasure(handle) {
    const { database, dbPath } = handle;
    database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    database.exec("PRAGMA incremental_vacuum;");
    database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return databaseSize(dbPath);
  }

  function trimToSize(handle, targetBytes, initialRemovedRows = 0) {
    const { database } = handle;
    let currentBytes = compactAndMeasure(handle);
    let removedRows = initialRemovedRows;
    while (currentBytes > targetBytes && removedRows < SQLITE_CLEANUP_MAX_ROWS) {
      const batchSize = Math.min(
        SQLITE_CLEANUP_BATCH_SIZE,
        SQLITE_CLEANUP_MAX_ROWS - removedRows,
      );
      const deletion = database.prepare(`
        DELETE FROM llm_results
        WHERE key_hash IN (
          SELECT key_hash
          FROM llm_results
          ORDER BY accessed_at ASC, created_at ASC
          LIMIT ?
        )
      `).run(batchSize);
      const changedRows = Number(deletion.changes ?? 0);
      if (changedRows <= 0) break;
      removedRows += changedRows;
      currentBytes = compactAndMeasure(handle);
    }
    return { currentBytes, removedRows };
  }

  async function getPersistent(keyHash, scopeId, timestamp) {
    const handle = await ensureDb(scopeId);
    if (!handle) return undefined;
    const { database, dbPath } = handle;
    try {
      const row = database.prepare(`
        SELECT response_text, input_tokens, output_tokens,
          provider_cached_input_tokens, expires_at
        FROM llm_results
        WHERE key_hash = ?
      `).get(keyHash);
      if (!row) return undefined;
      if (row.expires_at <= timestamp) {
        database.prepare("DELETE FROM llm_results WHERE key_hash = ?").run(keyHash);
        return undefined;
      }
      database.prepare("UPDATE llm_results SET accessed_at = ? WHERE key_hash = ?")
        .run(timestamp, keyHash);
      return {
        value: {
          text: row.response_text,
          usage: {
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            providerCachedInputTokens: row.provider_cached_input_tokens,
          },
        },
        expiresAt: row.expires_at,
      };
    } catch (error) {
      disablePersistence(scopeId, dbPath, database, error, "read");
      return undefined;
    }
  }

  async function setPersistent(keyHash, request, value, createdAt, expiresAt) {
    const { scopeId } = request;
    const handle = await ensureDb(scopeId);
    if (!handle) return;
    const { database, dbPath } = handle;
    try {
      let removedRows = deleteExpired(database, createdAt);
      const softTarget = Math.floor(normalizedMaxBytes * SOFT_LIMIT_RATIO);
      let currentBytes = databaseSize(dbPath);
      if (currentBytes >= normalizedMaxBytes) {
        const trimmed = trimToSize(handle, softTarget, removedRows);
        currentBytes = trimmed.currentBytes;
        removedRows = trimmed.removedRows;
      }
      if (currentBytes >= normalizedMaxBytes) {
        increment(scopeId, "persistWriteSkipped");
        return;
      }

      const responseBytes = value?.text === null
        ? 0
        : Buffer.byteLength(String(value?.text ?? ""), "utf8");
      database.prepare(`
        INSERT INTO llm_results
          (key_hash, purpose, model, response_text, input_tokens, output_tokens,
           provider_cached_input_tokens, created_at, accessed_at, expires_at, byte_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_hash) DO UPDATE SET
          purpose=excluded.purpose,
          model=excluded.model,
          response_text=excluded.response_text,
          input_tokens=excluded.input_tokens,
          output_tokens=excluded.output_tokens,
          provider_cached_input_tokens=excluded.provider_cached_input_tokens,
          created_at=excluded.created_at,
          accessed_at=excluded.accessed_at,
          expires_at=excluded.expires_at,
          byte_size=excluded.byte_size
      `).run(
        keyHash,
        request.purpose,
        String(request.model ?? ""),
        value?.text ?? null,
        value?.usage?.inputTokens ?? null,
        value?.usage?.outputTokens ?? null,
        value?.usage?.providerCachedInputTokens ?? null,
        createdAt,
        createdAt,
        expiresAt,
        responseBytes + PERSIST_METADATA_BYTES,
      );
      increment(scopeId, "persistWrites");

      if (databaseSize(dbPath) > softTarget) {
        trimToSize(handle, softTarget, removedRows);
      }
    } catch (error) {
      disablePersistence(scopeId, dbPath, database, error, "write");
    }
  }

  async function computeAndStore(keyHash, request, compute) {
    const { scopeId } = request;
    increment(scopeId, "upstreamCalls");
    const value = await compute();
    const providerCachedInputTokens = value?.usage?.providerCachedInputTokens;
    if (Number.isFinite(providerCachedInputTokens)) {
      increment(scopeId, "upstreamProviderCachedInputTokens", providerCachedInputTokens);
    }

    if (!isCacheableResult(request, value)) return value;

    const createdAt = now();
    const expiresAt = createdAt + normalizedTtlMs;
    setMemory(keyHash, value, expiresAt);
    if (persist) await setPersistent(keyHash, request, value, createdAt, expiresAt);
    return value;
  }

  async function resolveMiss(keyHash, request, compute) {
    const { scopeId } = request;
    if (persist) {
      const stored = await getPersistent(keyHash, scopeId, now());
      if (stored !== undefined) {
        setMemory(keyHash, stored.value, stored.expiresAt);
        increment(scopeId, "persistHits");
        recordHitUsage(scopeId, stored.value);
        return stored.value;
      }
    }
    increment(scopeId, "misses");
    return computeAndStore(keyHash, request, compute);
  }

  async function getOrCompute(request, compute) {
    const scopeId = request?.scopeId;
    if (!enabled || typeof scopeId !== "string" || scopeId.length === 0
      || !ALLOWED_PURPOSES.has(request?.purpose)) {
      return compute();
    }

    increment(scopeId, "requests");
    const keyHash = buildCacheKey(request);
    const memoryValue = getMemory(keyHash, now());
    if (memoryValue !== undefined) {
      increment(scopeId, "memoryHits");
      recordHitUsage(scopeId, memoryValue);
      return memoryValue;
    }

    const existing = inFlight.get(keyHash);
    if (existing) {
      increment(scopeId, "coalesced");
      const value = await existing;
      recordHitUsage(scopeId, value);
      return value;
    }

    const pending = resolveMiss(keyHash, request, compute);
    inFlight.set(keyHash, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(keyHash);
    }
  }

  function getMetrics(scopeId) {
    const counters = metricsByScope.get(scopeId) || emptyCounters();
    const hits = counters.memoryHits + counters.persistHits;
    return {
      ...counters,
      hits,
      hitRate: counters.requests > 0 ? hits / counters.requests : 0,
      enabled,
      persistConfigured: persist,
      persistActive: dbPathByScope.has(scopeId),
    };
  }

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      await Promise.allSettled([...inFlight.values()]);
      await Promise.allSettled([...dbOpenByScope.values()]);
      for (const handle of dbByPath.values()) {
        try {
          sweepExpired(handle.database, now());
        } catch (error) {
          safeDebug(logger, "llm-result-cache", error, {
            phase: "close-sweep",
            scopeId: handle.scopeId,
            dbPath: handle.dbPath,
          });
        }
        closeHandle(handle, "close");
      }
      dbByPath.clear();
      dbPathByScope.clear();
    })();
    return closePromise;
  }

  return { getOrCompute, getMetrics, close };
}
