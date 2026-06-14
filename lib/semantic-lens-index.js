import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SEMANTIC_LENS_CONFIG = Object.freeze({
  enabled: false,
  maxLensMemories: 3,
  maxBridgeMemories: 2,
  maxFadedMemories: 1,
  maxCommunities: 2,
  timeoutMs: 50,
  cacheTtlMs: 30_000,
});

const indexCache = new Map();

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function memoryIdOf(memory) {
  return String(
    memory?.entry?.memory_id ??
    memory?.entry?.memoryId ??
    memory?.entry?.id ??
    memory?.memory_id ??
    memory?.memoryId ??
    memory?.id ??
    "",
  ).trim();
}

function normalizeIndex(raw) {
  if (!raw || raw.version !== 1) return null;
  if (!raw.memoryToCommunity || typeof raw.memoryToCommunity !== "object") return null;
  if (!raw.communities || typeof raw.communities !== "object") return null;
  return raw;
}

function resolveIndexPath({ workspaceDir, indexPath } = {}) {
  if (indexPath) return indexPath;
  if (!workspaceDir) return null;
  return join(workspaceDir, ".plur1bus", "semantic-lens-index.json");
}

export function clearSemanticLensIndexCache() {
  indexCache.clear();
}

export function resolveSemanticLensConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    maxLensMemories: toPositiveInt(config.maxLensMemories, DEFAULT_SEMANTIC_LENS_CONFIG.maxLensMemories),
    maxBridgeMemories: toPositiveInt(config.maxBridgeMemories, DEFAULT_SEMANTIC_LENS_CONFIG.maxBridgeMemories),
    maxFadedMemories: toPositiveInt(config.maxFadedMemories, DEFAULT_SEMANTIC_LENS_CONFIG.maxFadedMemories),
    maxCommunities: toPositiveInt(config.maxCommunities, DEFAULT_SEMANTIC_LENS_CONFIG.maxCommunities),
    timeoutMs: toPositiveInt(config.timeoutMs, DEFAULT_SEMANTIC_LENS_CONFIG.timeoutMs),
    cacheTtlMs: toPositiveInt(config.cacheTtlMs, DEFAULT_SEMANTIC_LENS_CONFIG.cacheTtlMs),
  };
}

/**
 * Load a precomputed semantic-lens index with mtime/TTL cache.
 *
 * @param {{workspaceDir?: string, indexPath?: string, cacheTtlMs?: number, nowMs?: number}} options
 * @returns {{index: object, path: string, mtimeMs: number}|null}
 */
export function loadSemanticLensIndex(options = {}) {
  const path = resolveIndexPath(options);
  if (!path || !existsSync(path)) return null;
  try {
    const stat = statSync(path);
    const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const cacheTtlMs = toPositiveInt(options.cacheTtlMs, DEFAULT_SEMANTIC_LENS_CONFIG.cacheTtlMs);
    const cached = indexCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && nowMs - cached.loadedAtMs <= cacheTtlMs) {
      return cached.record;
    }
    const parsed = normalizeIndex(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed) return null;
    const record = { index: parsed, path, mtimeMs: stat.mtimeMs };
    indexCache.set(path, { mtimeMs: stat.mtimeMs, loadedAtMs: nowMs, record });
    return record;
  } catch (_err) {
    return null;
  }
}

function distinctCommunities(baseMemories, index, limit) {
  const out = [];
  const seen = new Set();
  for (const memory of baseMemories || []) {
    const id = memoryIdOf(memory);
    if (!id) continue;
    const communityId = index.memoryToCommunity?.[id];
    if (!communityId || seen.has(communityId) || !index.communities?.[communityId]) continue;
    seen.add(communityId);
    out.push(communityId);
    if (out.length >= limit) break;
  }
  return out;
}

async function hydrateMemory(id, options) {
  if (options.memoryById instanceof Map && options.memoryById.has(id)) return options.memoryById.get(id);
  if (options.memoryById && typeof options.memoryById === "object" && options.memoryById[id]) return options.memoryById[id];
  if (typeof options.getMemoryById === "function") return await options.getMemoryById(id);
  return null;
}

async function selectLensMemories(baseMemories, options, config) {
  if (options.lookupDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, options.lookupDelayMs));
  }
  const index = options.indexRecord?.index || options.index;
  if (!index) return { lensMemories: [], communities: [], reason: "missing_index" };
  const baseIds = new Set((baseMemories || []).map(memoryIdOf).filter(Boolean));
  const communities = distinctCommunities(baseMemories, index, config.maxCommunities);
  if (communities.length === 0) return { lensMemories: [], communities, reason: "no_community_match" };

  const picked = [];
  const pickedIds = new Set(baseIds);
  let bridgeCount = 0;
  let fadedCount = 0;

  const tryPick = async (id, role, communityId) => {
    if (!id || pickedIds.has(id) || picked.length >= config.maxLensMemories) return;
    if (role === "bridge" && bridgeCount >= config.maxBridgeMemories) return;
    if (role === "faded" && fadedCount >= config.maxFadedMemories) return;
    const entry = await hydrateMemory(id, options);
    if (!entry) return;
    pickedIds.add(id);
    if (role === "bridge") bridgeCount++;
    if (role === "faded") fadedCount++;
    picked.push({
      entry: { ...entry, id: memoryIdOf(entry) || id },
      score: 0,
      source: "semantic_lens",
      semanticLens: { role, communityId },
    });
  };

  for (const communityId of communities) {
    const community = index.communities[communityId] || {};
    for (const id of community.bridgeMemoryIds || []) await tryPick(id, "bridge", communityId);
    for (const id of community.representativeMemoryIds || []) await tryPick(id, "representative", communityId);
    for (const id of community.fadedCandidateMemoryIds || []) await tryPick(id, "faded", communityId);
    if (picked.length >= config.maxLensMemories) break;
  }

  return { lensMemories: picked, communities, reason: picked.length ? "applied" : "no_hydrated_candidates" };
}

/**
 * Append a few associative memories from a precomputed Semantic Lens index.
 * Normal recall remains primary; timeout/error returns base memories unchanged.
 *
 * @param {Array} baseMemories Recall results shaped like {entry, score}
 * @param {object} options semanticLens config, index, and small ID hydration callback/map
 * @returns {Promise<{memories:Array,lensMemories:Array,communities:Array,timedOut:boolean,reason:string}>}
 */
export async function applySemanticLensToRecall(baseMemories = [], options = {}) {
  const config = resolveSemanticLensConfig(options.semanticLens || options.config || {});
  if (!config.enabled) {
    return { memories: baseMemories, lensMemories: [], communities: [], timedOut: false, reason: "disabled" };
  }
  const indexRecord = options.indexRecord || (
    options.index ? { index: options.index } : loadSemanticLensIndex({
      workspaceDir: options.workspaceDir,
      indexPath: options.indexPath,
      cacheTtlMs: config.cacheTtlMs,
    })
  );
  if (!indexRecord?.index) {
    return { memories: baseMemories, lensMemories: [], communities: [], timedOut: false, reason: "missing_index" };
  }

  const work = selectLensMemories(baseMemories, { ...options, indexRecord }, config);
  try {
    const result = await Promise.race([
      work,
      new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), config.timeoutMs)),
    ]);
    if (result?.timedOut) {
      return { memories: baseMemories, lensMemories: [], communities: [], timedOut: true, reason: "timeout" };
    }
    return {
      memories: [...baseMemories, ...(result.lensMemories || [])],
      lensMemories: result.lensMemories || [],
      communities: result.communities || [],
      timedOut: false,
      reason: result.reason || "applied",
    };
  } catch (_err) {
    return { memories: baseMemories, lensMemories: [], communities: [], timedOut: false, reason: "error" };
  }
}
