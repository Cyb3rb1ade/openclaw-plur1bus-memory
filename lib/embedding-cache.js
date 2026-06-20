/**
 * lib/embedding-cache.js
 *
 * v2 embedding cache: in-memory LRU+TTL plus optional persistent SQLite backend,
 * request coalescing, hit-rate metrics, and byte-size limits with TTL/LRU eviction.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { safeAgentId, resolveInside } from "./sql-safety.js";
import { safeDebug, safeWarn } from "./safe-logging.js";

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_TTL_MS = 300_000;
const CACHE_VERSION = "v2";
const DEFAULT_MAX_BYTES_AGENT = 1 * 1024 * 1024 * 1024;
const DEFAULT_MAX_BYTES_SHARED = 5 * 1024 * 1024 * 1024;
const SOFT_LIMIT_RATIO = 0.9;

/**
 * Normalisiert einen Eingabetext für Cache-Keys.
 * @param {unknown} text
 * @returns {string}
 */
function normalizeText(text) {
  return String(text ?? "").trim().toLowerCase();
}

/**
 * SHA-256 Hex-Hash eines Strings.
 * @param {string} value
 * @returns {string}
 */
function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Baue den persistierten/volatile Cache-Key und seinen Hash.
 * @param {Object} parts
 * @param {string} parts.provider
 * @param {string} parts.model
 * @param {number} parts.dimensions
 * @param {string} parts.scopeId
 * @param {string} parts.cacheVersion
 * @param {string} parts.textHash
 * @returns {{ key: string, keyHash: string }}
 */
function buildKey({ provider, model, dimensions, scopeId, cacheVersion, textHash }) {
  const key = `${provider}\x00${model}\x00${dimensions}\x00${scopeId}\x00${cacheVersion}\x00${textHash}`;
  return { key, keyHash: sha256Hex(key) };
}

/**
 * Sichere Verzeichnis-/Dateinamen für eine Scope-ID.
 * @param {string} scopeId
 * @returns {string}
 */
function sanitizeScopeDir(scopeId) {
  try {
    return safeAgentId(scopeId);
  } catch {
    return `scope-${sha256Hex(scopeId).slice(0, 24)}`;
  }
}

/**
 * Erzeugt eine neue Embedding-Cache-Instanz.
 *
 * @param {Object} [options]
 * @param {number} [options.maxEntries=128]
 * @param {number} [options.ttlMs=300000]
 * @param {boolean} [options.enabled=true]
 * @param {boolean} [options.coalesce=true]
 * @param {boolean} [options.persist=false]
 * @param {boolean} [options.persistDebug=false]
 * @param {boolean} [options.metrics=false]
 * @param {"agent"|"shared"} [options.scope="agent"]
 * @param {number} [options.maxBytes]
 * @param {string} [options.cacheBasePath]
 * @param {string} [options.provider]
 * @param {string} [options.model]
 * @param {number} [options.dimensions]
 * @param {Object} [options.logger]
 * @returns {Object}
 */
export function createEmbeddingCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  ttlMs = DEFAULT_TTL_MS,
  enabled = true,
  coalesce = true,
  persist = false,
  persistDebug = false,
  metrics = false,
  scope = "agent",
  maxBytes,
  cacheBasePath,
  provider: defaultProvider = "legacy",
  model: defaultModel = "legacy",
  dimensions: defaultDimensions = 0,
  logger,
} = {}) {
  /** @type {Map<string, { vector: number[], expiryTime: number }>} */
  const map = new Map();
  /** @type {Map<string, number>} */
  const expiryMap = new Map();
  /** @type {Map<string, Promise<Map<string, number[]>>>} */
  const inflight = new Map();

  const metricsState = {
    requests: 0,
    hits: 0,
    memoryHits: 0,
    persistHits: 0,
    misses: 0,
    coalesced: 0,
    persistWrites: 0,
    persistWriteSkipped: 0,
    errors: 0,
  };

  let db = null;
  let dbPath = null;
  let dbFailed = false;
  let sqliteModule = null;

  function sweepExpired() {
    const now = Date.now();
    for (const [key, expiryTime] of expiryMap) {
      if (expiryTime <= now) {
        map.delete(key);
        expiryMap.delete(key);
      }
    }
  }

  function _resolveScopeId(options = {}) {
    if (options.scopeId) return options.scopeId;
    if (scope === "shared") return "shared";
    return options.agentId || "default";
  }

  function _resolveMaxBytes(options = {}) {
    if (options.maxBytes !== undefined) return options.maxBytes;
    if (maxBytes !== undefined) return maxBytes;
    if (scope === "shared") return DEFAULT_MAX_BYTES_SHARED;
    return DEFAULT_MAX_BYTES_AGENT;
  }

  function _resolveDbPath(options = {}) {
    if (!cacheBasePath) return null;
    const scopeId = _resolveScopeId(options);
    const dirName = sanitizeScopeDir(scopeId);
    try {
      return resolveInside(cacheBasePath, "embedding-cache-v2", `${dirName}.db`);
    } catch (err) {
      safeWarn(logger, "embedding-cache", err, { scope: "resolveDbPath" });
      return null;
    }
  }

  function _dbSize() {
    if (!dbPath || !existsSync(dbPath)) return 0;
    try {
      return statSync(dbPath).size;
    } catch {
      return 0;
    }
  }

  async function _ensureDb(options = {}) {
    if (!persist || dbFailed) return null;
    if (db) return db;
    const targetDbPath = _resolveDbPath(options);
    if (!targetDbPath) {
      dbFailed = true;
      return null;
    }
    dbPath = targetDbPath;

    try {
      if (!sqliteModule) {
        sqliteModule = await import("node:sqlite");
      }
      mkdirSync(dirname(dbPath), { recursive: true });
      db = new sqliteModule.DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL;");
      db.exec("PRAGMA busy_timeout=5000;");
      db.exec("PRAGMA auto_vacuum=INCREMENTAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          key_hash TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          scope_id TEXT NOT NULL,
          cache_version TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          vector BLOB NOT NULL,
          debug_text TEXT,
          created_at INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_embeddings_expires ON embeddings(expires_at);
        CREATE INDEX IF NOT EXISTS idx_embeddings_accessed ON embeddings(accessed_at);
      `);
      return db;
    } catch (err) {
      dbFailed = true;
      safeWarn(logger, "embedding-cache", err, { scope: "ensureDb", dbPath });
      db = null;
      return null;
    }
  }

  function _getMemory(keyHash, now) {
    const entry = map.get(keyHash);
    if (!entry) return undefined;
    if (entry.expiryTime <= now) {
      map.delete(keyHash);
      expiryMap.delete(keyHash);
      return undefined;
    }
    map.delete(keyHash);
    map.set(keyHash, entry);
    return entry.vector;
  }

  function _setMemory(keyHash, vector, expiryTime) {
    map.set(keyHash, { vector, expiryTime });
    expiryMap.set(keyHash, expiryTime);
    while (map.size > maxEntries) {
      const first = map.keys().next().value;
      if (first === undefined) break;
      map.delete(first);
      expiryMap.delete(first);
    }
  }

  async function _getDb(keyHash, now, options = {}) {
    const database = await _ensureDb(options);
    if (!database) return undefined;
    try {
      const row = database.prepare("SELECT vector, expires_at FROM embeddings WHERE key_hash = ?").get(keyHash);
      if (!row) return undefined;
      if (row.expires_at <= now) {
        database.prepare("DELETE FROM embeddings WHERE key_hash = ?").run(keyHash);
        return undefined;
      }
      database.prepare("UPDATE embeddings SET accessed_at = ? WHERE key_hash = ?").run(now, keyHash);
      return JSON.parse(Buffer.from(row.vector).toString("utf8"));
    } catch (err) {
      safeWarn(logger, "embedding-cache", err, { scope: "getDb", keyHash: keyHash.slice(0, 16) });
      return undefined;
    }
  }

  function _cleanupDb(targetBytes = 0) {
    if (!db) return;
    const now = Date.now();
    try {
      db.prepare("DELETE FROM embeddings WHERE expires_at <= ?").run(now);
      if (targetBytes > 0) {
        while (_dbSize() > targetBytes) {
          const oldest = db.prepare("SELECT key_hash FROM embeddings ORDER BY accessed_at ASC, created_at ASC LIMIT 1").get();
          if (!oldest) break;
          db.prepare("DELETE FROM embeddings WHERE key_hash = ?").run(oldest.key_hash);
        }
      }
    } catch (err) {
      safeWarn(logger, "embedding-cache", err, { scope: "cleanupDb" });
    }
  }

  async function _persistSet(rows, options = {}) {
    const database = await _ensureDb(options);
    if (!database || rows.length === 0) return;

    const limit = _resolveMaxBytes(options);
    _cleanupDb();
    if (_dbSize() >= limit) {
      metricsState.persistWriteSkipped += rows.length;
      safeWarn(logger, "embedding-cache", "persist_write_skipped_size_limit", {
        dbSize: _dbSize(),
        maxBytes: limit,
        skippedRows: rows.length,
      });
      return;
    }

    const now = Date.now();
    const expiry = now + ttlMs;
    const scopeId = _resolveScopeId(options);
    const provider = options.provider || defaultProvider;
    const model = options.model || defaultModel;
    const dimensions = options.dimensions ?? defaultDimensions;
    const storeDebug = options.persistDebug ?? persistDebug;

    try {
      const insert = database.prepare(`
        INSERT INTO embeddings
          (key_hash, provider, model, dimensions, scope_id, cache_version, text_hash, vector, debug_text, created_at, accessed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key_hash) DO UPDATE SET
          vector=excluded.vector,
          text_hash=excluded.text_hash,
          debug_text=excluded.debug_text,
          accessed_at=excluded.accessed_at,
          expires_at=excluded.expires_at
      `);
      for (const row of rows) {
        const debugText = storeDebug && row.normalized ? row.normalized : null;
        insert.run(
          row.keyHash,
          provider,
          model,
          dimensions,
          scopeId,
          CACHE_VERSION,
          row.textHash,
          Buffer.from(JSON.stringify(row.vector)),
          debugText,
          now,
          now,
          expiry
        );
      }
      metricsState.persistWrites += rows.length;

      const softTarget = Math.floor(limit * SOFT_LIMIT_RATIO);
      if (_dbSize() > softTarget) {
        _cleanupDb(softTarget);
      }
    } catch (err) {
      safeWarn(logger, "embedding-cache", err, { scope: "persistSet", rowCount: rows.length });
    }
  }

  async function _computeBatch(batch, options, computeMissing) {
    const texts = batch.map((m) => m.text);
    let vectors;
    try {
      vectors = await computeMissing(texts);
    } catch (err) {
      metricsState.errors++;
      throw err;
    }

    const now = Date.now();
    const expiry = now + ttlMs;
    const resultMap = new Map();
    const toPersist = [];

    for (let i = 0; i < batch.length; i++) {
      const vector = vectors[i];
      const item = batch[i];
      resultMap.set(item.keyHash, vector);
      if (vector !== undefined) {
        _setMemory(item.keyHash, vector, expiry);
        toPersist.push({
          keyHash: item.keyHash,
          textHash: item.textHash,
          normalized: item.normalized,
          vector,
        });
      }
    }

    if (toPersist.length > 0) {
      await _persistSet(toPersist, options);
    }
    return resultMap;
  }

  function _keyPartsFor(options = {}) {
    return {
      provider: options.provider || defaultProvider,
      model: options.model || defaultModel,
      dimensions: options.dimensions ?? defaultDimensions,
      scopeId: _resolveScopeId(options),
      cacheVersion: CACHE_VERSION,
    };
  }

  /**
   * Lädt einen Batch von Embeddings. Berechnet fehlende Einträge via
   * `computeMissing`, sofern angegeben, und füllt Cache + Persistenz.
   *
   * @param {string[]} texts
   * @param {Object} [options]
   * @param {string} [options.provider]
   * @param {string} [options.model]
   * @param {number} [options.dimensions]
   * @param {string} [options.agentId]
   * @param {string} [options.scopeId]
   * @param {Function} [computeMissing]
   * @returns {Promise<number[][]>}
   */
  async function getMany(texts, options = {}, computeMissing) {
    if (!enabled) {
      if (!computeMissing) return new Array(texts.length).fill(undefined);
      return computeMissing(texts);
    }

    const now = Date.now();
    const keyParts = _keyPartsFor(options);
    const normalized = texts.map(normalizeText);
    const keyHashes = normalized.map((n) => buildKey({ ...keyParts, textHash: sha256Hex(n) }).keyHash);
    const results = new Array(texts.length);
    const missing = [];

    for (let i = 0; i < texts.length; i++) {
      metricsState.requests++;
      const memVector = _getMemory(keyHashes[i], now);
      if (memVector !== undefined) {
        results[i] = memVector;
        metricsState.hits++;
        metricsState.memoryHits++;
        continue;
      }
      if (persist) {
        const dbVector = await _getDb(keyHashes[i], now, options);
        if (dbVector !== undefined) {
          results[i] = dbVector;
          _setMemory(keyHashes[i], dbVector, now + ttlMs);
          metricsState.hits++;
          metricsState.persistHits++;
          continue;
        }
      }
      metricsState.misses++;
      missing.push({
        index: i,
        keyHash: keyHashes[i],
        textHash: sha256Hex(normalized[i]),
        normalized: normalized[i],
        text: texts[i],
      });
    }

    if (missing.length === 0 || !computeMissing) {
      _maybeLogMetrics();
      return results;
    }

    if (coalesce) {
      const toCompute = [];
      const keyPromises = new Map();
      for (const m of missing) {
        const existing = inflight.get(m.keyHash);
        if (existing) {
          keyPromises.set(m.keyHash, existing);
          metricsState.coalesced++;
        } else if (!keyPromises.has(m.keyHash)) {
          toCompute.push(m);
        }
      }

      if (toCompute.length > 0) {
        let resolveBatch;
        let rejectBatch;
        const batchPromise = new Promise((res, rej) => {
          resolveBatch = res;
          rejectBatch = rej;
        });
        for (const m of toCompute) {
          inflight.set(m.keyHash, batchPromise);
          keyPromises.set(m.keyHash, batchPromise);
        }
        _computeBatch(toCompute, options, computeMissing)
          .then(resolveBatch, rejectBatch)
          .finally(() => {
            for (const m of toCompute) {
              inflight.delete(m.keyHash);
            }
          });
      }

      await Promise.all(
        missing.map((m) =>
          keyPromises
            .get(m.keyHash)
            .then((vecMap) => {
              const vec = vecMap.get(m.keyHash);
              if (vec !== undefined) {
                results[m.index] = vec;
              }
            })
            .catch((err) => {
              metricsState.errors++;
              throw err;
            })
        )
      );
    } else {
      const computed = await computeMissing(missing.map((m) => m.text));
      const now2 = Date.now();
      const expiry = now2 + ttlMs;
      const toPersist = [];
      for (let i = 0; i < missing.length; i++) {
        const vec = computed[i];
        const m = missing[i];
        results[m.index] = vec;
        if (vec !== undefined) {
          _setMemory(m.keyHash, vec, expiry);
          toPersist.push({ keyHash: m.keyHash, textHash: m.textHash, normalized: m.normalized, vector: vec });
        }
      }
      if (toPersist.length > 0) await _persistSet(toPersist, options);
    }

    _maybeLogMetrics();
    return results;
  }

  /**
   * Schreibt mehrere Einträge in den Cache.
   *
   * @param {Array<{text: string, vector: number[], key?: string}>} entries
   * @param {Object} [options]
   */
  async function setMany(entries, options = {}) {
    if (!enabled || entries.length === 0) return;
    const now = Date.now();
    const expiry = now + ttlMs;
    const keyParts = _keyPartsFor(options);
    const toPersist = [];

    for (const entry of entries) {
      const normalized = normalizeText(entry.text);
      const textHash = sha256Hex(normalized);
      const keyHash = entry.key || buildKey({ ...keyParts, textHash }).keyHash;
      _setMemory(keyHash, entry.vector, expiry);
      toPersist.push({
        keyHash,
        textHash,
        normalized,
        vector: entry.vector,
      });
    }
    await _persistSet(toPersist, options);
  }

  /**
   * Legacy-Getter für einzelne Einträge.
   * @param {string} agentId
   * @param {string} normalizedQuery
   * @param {string} modelVersion
   * @returns {{ vector: number[] } | undefined}
   */
  function get(agentId, normalizedQuery, modelVersion) {
    const normalized = normalizeText(normalizedQuery);
    const textHash = sha256Hex(normalized);
    const { keyHash } = buildKey({
      provider: defaultProvider,
      model: modelVersion,
      dimensions: defaultDimensions,
      scopeId: agentId,
      cacheVersion: CACHE_VERSION,
      textHash,
    });
    const now = Date.now();
    const mem = _getMemory(keyHash, now);
    if (mem !== undefined) return { vector: mem };
    return undefined;
  }

  /**
   * Legacy-Setter für einzelne Einträge.
   * @param {string} agentId
   * @param {string} normalizedQuery
   * @param {string} modelVersion
   * @param {number[]} vector
   */
  function set(agentId, normalizedQuery, modelVersion, vector) {
    const normalized = normalizeText(normalizedQuery);
    const textHash = sha256Hex(normalized);
    const { keyHash } = buildKey({
      provider: defaultProvider,
      model: modelVersion,
      dimensions: defaultDimensions,
      scopeId: agentId,
      cacheVersion: CACHE_VERSION,
      textHash,
    });
    _setMemory(keyHash, vector, Date.now() + ttlMs);
    _persistSet([{ keyHash, textHash, normalized, vector }], { agentId }).catch((err) =>
      safeDebug(logger, "embedding-cache", err, { scope: "legacy-set" })
    );
  }

  function clear() {
    map.clear();
    expiryMap.clear();
  }

  function getMetrics() {
    return { ...metricsState, hitRate: metricsState.requests ? metricsState.hits / metricsState.requests : 0 };
  }

  function _maybeLogMetrics() {
    if (!metrics || !logger || typeof logger.debug !== "function") return;
    const m = getMetrics();
    logger.debug(`[embedding-cache] metrics: requests=${m.requests} hits=${m.hits}(${m.hitRate.toFixed(2)}) memory=${m.memoryHits} persist=${m.persistHits} misses=${m.misses} coalesced=${m.coalesced}`);
  }

  return {
    get,
    set,
    getMany,
    setMany,
    clear,
    getMetrics,
    get size() {
      sweepExpired();
      return map.size;
    },
  };
}
