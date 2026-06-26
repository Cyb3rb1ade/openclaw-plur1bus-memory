import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveInside } from "../sql-safety.js";
import {
  DEFAULT_LOCAL_E5_DIMENSIONS,
  DEFAULT_LOCAL_E5_MODEL,
  DEFAULT_LOCAL_MODEL_CACHE,
  DEFAULT_LOCAL_RERANKER_MODEL,
} from "./dimensions.js";

const MEMORY_TABLE_DIR = "memories.lance";
const MEMORY_TABLE_DATA_DIR = "data";
const MEMORY_TABLE_TX_DIR = "_transactions";
const DEFAULT_MAX_SCAN_DEPTH = 4;
const SCHEMA_SEED_ID = "__schema__";
const SCHEMA_DELETE_MARKER = 'id = "__schema__"';
const MAX_MARKER_SCAN_BYTES = 1024 * 1024;

function clone(value) {
  return value == null || typeof value !== "object" ? value : JSON.parse(JSON.stringify(value));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hasCredentialRef(cfg = {}) {
  return nonEmptyString(cfg.apiKeyEnv) ||
    nonEmptyString(cfg.apiKey) ||
    (cfg.apiKey && typeof cfg.apiKey === "object");
}

function shouldUseLocalEmbedding(embedding = {}) {
  const provider = embedding?.provider;
  if (provider === "local-transformers") return false;
  if (!provider) return true;
  if (provider === "openai" || provider === "openai-compatible") {
    return !hasCredentialRef(embedding);
  }
  return false;
}

function shouldUseLocalReranker(reranker = {}) {
  const provider = reranker?.provider;
  if (provider === "local-transformers") return false;
  if (provider === "cohere") return !hasCredentialRef(reranker);
  if (!provider || provider === "disabled" || reranker?.enabled === false) return true;
  return false;
}

function childPathInside(root, dir, name) {
  const relDir = relative(root, dir);
  return resolveInside(root, ...(relDir ? [relDir, name] : [name]));
}

function listDirEntries(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries;
}

function listLanceDataFiles(tableDir) {
  const dataDir = resolveInside(tableDir, MEMORY_TABLE_DATA_DIR);
  return listDirEntries(dataDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lance"))
    .map((entry) => resolveInside(dataDir, entry.name));
}

function fileContainsAscii(path, marker) {
  let stat;
  try {
    stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_MARKER_SCAN_BYTES) return false;
    return readFileSync(path).includes(Buffer.from(marker));
  } catch {
    return false;
  }
}

function hasSchemaSeedDeleteMarker(tableDir) {
  const txDir = resolveInside(tableDir, MEMORY_TABLE_TX_DIR);
  return listDirEntries(txDir)
    .filter((entry) => entry.isFile())
    .some((entry) => fileContainsAscii(resolveInside(txDir, entry.name), SCHEMA_DELETE_MARKER));
}

function isSchemaSeedOnlyTable(tableDir, dataFiles) {
  return dataFiles.length === 1 &&
    fileContainsAscii(dataFiles[0], SCHEMA_SEED_ID) &&
    hasSchemaSeedDeleteMarker(tableDir);
}

function hasLanceMemoryData(tableDir) {
  const dataFiles = listLanceDataFiles(tableDir);
  if (dataFiles.length === 0) return false;
  if (dataFiles.length > 1) return true;
  return !isSchemaSeedOnlyTable(tableDir, dataFiles);
}

function scanForMemoryTable(root, dir, depth, opts = {}) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    let child;
    try {
      child = childPathInside(root, dir, entry.name);
    } catch {
      continue;
    }
    let stat;
    try {
      stat = lstatSync(child);
    } catch {
      continue;
    }
    if (entry.name === MEMORY_TABLE_DIR && stat.isDirectory()) {
      if (!opts.requireDataFiles) return true;
      if (hasLanceMemoryData(child)) return true;
    }
    if (depth > 0 && stat.isDirectory() && scanForMemoryTable(root, child, depth - 1, opts)) return true;
  }
  return false;
}

function localEmbeddingConfig(existing = {}) {
  return {
    provider: "local-transformers",
    model: DEFAULT_LOCAL_E5_MODEL,
    dimensions: DEFAULT_LOCAL_E5_DIMENSIONS,
    local: {
      model: DEFAULT_LOCAL_E5_MODEL,
      dimensions: DEFAULT_LOCAL_E5_DIMENSIONS,
      queryPrefix: "query: ",
      passagePrefix: "passage: ",
      cacheDir: existing.local?.cacheDir || existing.cacheDir || DEFAULT_LOCAL_MODEL_CACHE,
    },
    embeddingCacheEnabled: existing.embeddingCacheEnabled,
    embeddingCacheMaxEntries: existing.embeddingCacheMaxEntries,
    embeddingCacheTtlMs: existing.embeddingCacheTtlMs,
    embeddingCachePersist: existing.embeddingCachePersist,
    embeddingCachePersistDebug: existing.embeddingCachePersistDebug,
    embeddingCacheCoalesce: existing.embeddingCacheCoalesce,
    embeddingCacheMetrics: existing.embeddingCacheMetrics,
    embeddingCacheScope: existing.embeddingCacheScope,
    embeddingCacheMaxBytes: existing.embeddingCacheMaxBytes,
  };
}

function localRerankerConfig(existing = {}) {
  return {
    provider: "local-transformers",
    enabled: true,
    model: DEFAULT_LOCAL_RERANKER_MODEL,
    candidates: existing.candidates ?? 20,
    timeoutMs: existing.timeoutMs ?? 5000,
    fallbackOnError: existing.fallbackOnError !== false,
    local: {
      model: DEFAULT_LOCAL_RERANKER_MODEL,
      cacheDir: existing.local?.cacheDir || DEFAULT_LOCAL_MODEL_CACHE,
    },
  };
}

/**
 * Detects whether any LanceDB memory table already exists below a DB root.
 *
 * @param {string} baseDbPath - Resolved PLUR1BUS LanceDB root.
 * @param {object} [opts]
 * @param {number} [opts.maxDepth] - Maximum directory depth to scan.
 * @returns {boolean} True when a memories.lance table directory exists.
 */
export function hasExistingLanceMemoryTables(baseDbPath, opts = {}) {
  if (!nonEmptyString(baseDbPath) || !existsSync(baseDbPath)) return false;
  let root;
  try {
    root = realpathSync(baseDbPath);
    if (!lstatSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  return scanForMemoryTable(root, root, opts.maxDepth ?? DEFAULT_MAX_SCAN_DEPTH);
}

/**
 * Detects whether any LanceDB memory table has persisted data fragments.
 *
 * @param {string} baseDbPath - Resolved PLUR1BUS LanceDB root.
 * @param {object} [opts]
 * @param {number} [opts.maxDepth] - Maximum directory depth to scan.
 * @returns {boolean} True when a memories.lance table contains data files.
 */
export function hasExistingLanceMemoryData(baseDbPath, opts = {}) {
  if (!nonEmptyString(baseDbPath) || !existsSync(baseDbPath)) return false;
  let root;
  try {
    root = realpathSync(baseDbPath);
    if (!lstatSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  return scanForMemoryTable(root, root, opts.maxDepth ?? DEFAULT_MAX_SCAN_DEPTH, { requireDataFiles: true });
}

/**
 * Applies local provider defaults for legacy configs only while no memory data exists.
 *
 * @param {object} config - Plugin config after feature policy defaults.
 * @param {object} opts
 * @param {string} opts.baseDbPath - Resolved PLUR1BUS LanceDB root.
 * @returns {{config: object, changed: boolean, migrations: string[], reason: string}}
 */
export function applyLegacyProviderDefaults(config = {}, opts = {}) {
  const next = clone(config || {});
  if (hasExistingLanceMemoryData(opts.baseDbPath)) {
    return { config: next, changed: false, migrations: [], reason: "existing-memory-data" };
  }

  const migrations = [];
  if (shouldUseLocalEmbedding(next.embedding || {})) {
    next.embedding = localEmbeddingConfig(next.embedding || {});
    migrations.push("embedding");
  }
  if (shouldUseLocalReranker(next.reranker || {})) {
    next.reranker = localRerankerConfig(next.reranker || {});
    migrations.push("reranker");
  }

  return {
    config: next,
    changed: migrations.length > 0,
    migrations,
    reason: migrations.length > 0 ? "no-existing-memory-data" : "explicit-provider-config",
  };
}
