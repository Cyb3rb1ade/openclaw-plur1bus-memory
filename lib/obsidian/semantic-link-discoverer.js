import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { computeContentHash, loadLinkIndex, saveLinkIndex, buildPriorityQueue } from "./link-index.js";
import { parseFrontmatter } from "./frontmatter.js";
import { resolveReviewPath } from "./safe-paths.js";

const GENERATED_RECORD_TYPES = new Set([
  "duplicate_candidate",
  "impact_analysis",
  "provenance",
  "source",
]);

function resolveDiscoveryConfig(rawConfig) {
  const g = rawConfig.graphLinks?.semanticDiscovery || {};
  return {
    maxPerRun: g.maxPerRun ?? 500,
    threshold: g.threshold ?? rawConfig.graphLinks?.semanticThreshold ?? 0.78,
    maxLinksPerRecord: g.maxLinksPerRecord ?? 5,
  };
}

export async function discoverSemanticLinks(rawConfig, records, options = {}) {
  const { pool, logger } = options;
  const defaultAgentId = options.defaultAgentId ?? rawConfig.defaultAgentId ?? "main";
  if (!pool) throw new Error("discoverSemanticLinks: options.pool is required");

  const vaultPath = rawConfig.vaultPath;
  const resolvedCfg = resolveDiscoveryConfig(rawConfig);
  const { maxPerRun, threshold, maxLinksPerRecord } = resolvedCfg;
  const topN = options.topN ?? rawConfig?.discovery?.topN ?? 15;
  const minScore = options.minScore ?? rawConfig?.discovery?.minScore ?? threshold;

  if (!records.length) return { processed: 0, skipped: 0, unchanged: 0, errors: 0, indexUpdated: false };

  const existingIndex = loadLinkIndex(vaultPath);
  const queue = buildPriorityQueue(records, existingIndex).slice(0, maxPerRun);

  const db = pool.getDb(defaultAgentId);

  let processed = 0, skipped = 0, unchanged = 0, errors = 0;
  let dirty = false;

  for (const record of queue) {
    if (!record.vector || !record.vector.length) { skipped++; continue; }

    const currentHash = computeContentHash(record);
    const existing = existingIndex.entries[record.id];
    if (existing && existing.contentHash === currentHash) {
      unchanged++;
      continue;
    }

    let searchResults;
    try {
      searchResults = await db.search(record.vector, topN, minScore);
    } catch (err) {
      const status = err?.status || err?.statusCode || (err?.message?.includes("429") ? 429 : 0);
      if (status === 429) {
        logger?.warn?.("plur1bus-semantic: 429 — aborting batch early");
        if (dirty) saveLinkIndex(vaultPath, existingIndex);
        return { processed, skipped, unchanged, errors, indexUpdated: dirty, batchAborted: true };
      }
      logger?.warn?.(`plur1bus-semantic: search failed for ${record.id}: ${err?.message}`);
      errors++;
      continue;
    }

    const selfId = record.id;
    const similar = (searchResults || [])
      .map((r) => r.entry?.id || null)
      .filter((id) => id && id !== selfId)
      .slice(0, maxLinksPerRecord);

    const now = new Date().toISOString();
    existingIndex.entries[selfId] = {
      similar,
      contentHash: currentHash,
      firstDiscoveredAt: existing?.firstDiscoveredAt || now,
      lastCheckedAt: now,
    };

    dirty = true;
    processed++;
  }

  if (dirty) saveLinkIndex(vaultPath, existingIndex);
  return { processed, skipped, unchanged, errors, indexUpdated: dirty };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function resolveExpectedScope(rawConfig = {}, options = {}) {
  return {
    agentId: firstNonEmpty(options.agentId, options.agent_id, rawConfig.agentId, rawConfig.agent_id),
    workspaceId: firstNonEmpty(
      options.workspaceId,
      options.workspace_id,
      options.workspaceKey,
      rawConfig.workspaceId,
      rawConfig.workspace_id,
      rawConfig.workspaceKey,
    ),
  };
}

function titleFromBody(body) {
  return String(body || "").match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
}

function scopeValue(record, keys) {
  for (const key of keys) {
    const value = firstNonEmpty(record?.[key]);
    if (value) return value;
  }
  return "";
}

function hasScopeMismatch(record, { agentId, workspaceId } = {}) {
  const recordAgent = scopeValue(record, ["agent_id", "agentId"]);
  const recordWorkspace = scopeValue(record, ["workspace_id", "workspaceId", "workspaceKey"]);
  return Boolean(
    (agentId && recordAgent && recordAgent !== agentId)
    || (workspaceId && recordWorkspace && recordWorkspace !== workspaceId)
  );
}

function normalizeVector(vector) {
  if (Array.isArray(vector)) return vector;
  if (ArrayBuffer.isView(vector)) return Array.from(vector);
  if (vector && typeof vector.toArray === "function") return Array.from(vector.toArray());
  return vector;
}

function validVector(rawVector) {
  const vector = normalizeVector(rawVector);
  return Array.isArray(vector)
    && vector.length > 0
    && vector.every((value) => typeof value === "number" && Number.isFinite(value));
}

function cosineSimilarity(a, b) {
  a = normalizeVector(a);
  b = normalizeVector(b);
  if (!validVector(a) || !validVector(b) || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA <= 0 || normB <= 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Read materialized memory mirror notes as semantic-link candidates.
 *
 * @param {Object} rawConfig - Bridge config with vaultPath/reviewRoot and scope
 * @param {Object} options - Optional scope overrides
 * @returns {{ records: Array<Object>, total: number, skipped: Object }}
 */
export function readMemoryMirrorRecords(rawConfig = {}, options = {}) {
  const { reviewPath } = resolveReviewPath(rawConfig, ".");
  const memoriesDir = join(reviewPath, "memories");
  const scope = resolveExpectedScope(rawConfig, options);
  const result = {
    records: [],
    total: 0,
    skipped: {
      generated: 0,
      missingId: 0,
      missingText: 0,
      notMemory: 0,
      scopeMismatch: 0,
    },
  };
  if (!existsSync(memoriesDir)) return result;

  const entries = readdirSync(memoriesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  result.total = entries.length;

  for (const name of entries) {
    const file = join(memoriesDir, name);
    const content = readFileSync(file, "utf8");
    const parsed = parseFrontmatter(content);
    const fm = parsed.frontmatter || {};
    const type = String(fm.plur1bus_type || fm.type || "").trim();
    if (GENERATED_RECORD_TYPES.has(type)) {
      result.skipped.generated++;
      continue;
    }
    if (type !== "memory") {
      result.skipped.notMemory++;
      continue;
    }
    if (hasScopeMismatch(fm, scope)) {
      result.skipped.scopeMismatch++;
      continue;
    }
    const id = firstNonEmpty(fm.memory_id, fm.id);
    if (!id) {
      result.skipped.missingId++;
      continue;
    }
    const body = String(parsed.body || "").trim();
    if (!body) {
      result.skipped.missingText++;
      continue;
    }
    const title = titleFromBody(body);
    result.records.push({
      id,
      memory_id: id,
      path: relative(reviewPath, file).replace(/\\/g, "/"),
      title,
      summary: title,
      text: body,
      body,
      content_hash: fm.content_hash || "",
      agent_id: firstNonEmpty(fm.agent_id, fm.agentId),
      workspace_id: firstNonEmpty(fm.workspace_id, fm.workspaceId, fm.workspaceKey),
      plur1bus_type: "memory",
      category: fm.category,
      importance: fm.importance,
      scope: fm.scope,
    });
  }

  return result;
}

/**
 * Attach LanceDB vectors to mirror records by memory id without crossing scope.
 *
 * @param {Array<Object>} mirrorRecords
 * @param {Array<Object>} sidecarRecords
 * @param {Object} options
 * @returns {{ records: Array<Object>, vectorMatches: number, skippedWithoutVector: number, skippedScopeMismatch: number }}
 */
export function joinMemoryMirrorVectorSidecar(mirrorRecords = [], sidecarRecords = [], options = {}) {
  const expectedScope = resolveExpectedScope({}, options);
  const sidecarById = new Map();
  let skippedScopeMismatch = 0;

  for (const sidecar of [...(Array.isArray(sidecarRecords) ? sidecarRecords : [])].sort((a, b) => {
    const aId = firstNonEmpty(a?.memory_id, a?.id);
    const bId = firstNonEmpty(b?.memory_id, b?.id);
    return aId.localeCompare(bId);
  })) {
    const id = firstNonEmpty(sidecar?.memory_id, sidecar?.id);
    if (!id) continue;
    if (hasScopeMismatch(sidecar, expectedScope)) {
      skippedScopeMismatch++;
      continue;
    }
    if (!sidecarById.has(id)) sidecarById.set(id, sidecar);
  }

  const records = [];
  let skippedWithoutVector = 0;
  for (const mirror of [...(Array.isArray(mirrorRecords) ? mirrorRecords : [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (hasScopeMismatch(mirror, expectedScope)) {
      skippedScopeMismatch++;
      continue;
    }
    const id = firstNonEmpty(mirror.memory_id, mirror.id);
    const sidecar = sidecarById.get(id);
    const vector = normalizeVector(sidecar?.vector);
    if (!sidecar || !validVector(vector)) {
      skippedWithoutVector++;
      continue;
    }
    records.push({ ...mirror, id, memory_id: id, vector });
  }

  return {
    records,
    vectorMatches: records.length,
    skippedWithoutVector,
    skippedScopeMismatch,
  };
}

function estimateIndexBytes(entries) {
  return Buffer.byteLength(JSON.stringify({ version: "1", entries }, null, 2), "utf8");
}

/**
 * Build an in-memory semantic link index plan from memory mirrors plus vectors.
 *
 * This function never writes .plur1bus/link-index.json.
 *
 * @param {Object} rawConfig - Bridge config with vaultPath/reviewRoot and scope
 * @param {Object} options
 * @returns {Object} Dry-run plan
 */
export function planSemanticLinkIndexDryRun(rawConfig = {}, options = {}) {
  const mirrorResult = options.mirrorRecords
    ? { records: options.mirrorRecords, total: options.mirrorRecords.length, skipped: {} }
    : readMemoryMirrorRecords(rawConfig, options);
  const joined = joinMemoryMirrorVectorSidecar(mirrorResult.records, options.sidecarRecords || [], options);
  const maxSimilar = options.maxSimilar ?? rawConfig.graphLinks?.semanticDiscovery?.maxLinksPerRecord ?? 5;
  const threshold = options.threshold ?? rawConfig.graphLinks?.semanticDiscovery?.threshold ?? rawConfig.graphLinks?.semanticThreshold ?? 0.78;
  const records = [...joined.records].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const entries = {};

  for (const record of records) {
    const links = [];
    for (const candidate of records) {
      if (candidate.id === record.id) continue;
      const score = cosineSimilarity(record.vector, candidate.vector);
      if (score == null || score < threshold) continue;
      links.push({
        id: candidate.id,
        memory_id: candidate.memory_id,
        path: candidate.path,
        title: candidate.title || candidate.summary || candidate.id,
        score: Number(score.toFixed(6)),
      });
    }
    links.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));
    const selected = links.slice(0, maxSimilar);
    entries[record.id] = {
      similar: selected.map((link) => link.id),
      links: selected,
      contentHash: record.content_hash || computeContentHash(record),
      sourcePath: record.path,
    };
  }

  return {
    ok: true,
    dryRun: true,
    wouldWrite: false,
    mirrorFilesTotal: mirrorResult.total,
    mirrorUsableText: mirrorResult.records.length,
    mirrorSkipped: mirrorResult.skipped,
    vectorMatches: joined.vectorMatches,
    indexableRecords: records.length,
    skippedWithoutVector: joined.skippedWithoutVector,
    skippedScopeMismatch: (mirrorResult.skipped?.scopeMismatch || 0) + joined.skippedScopeMismatch,
    threshold,
    maxSimilar,
    expectedIndexBytes: estimateIndexBytes(entries),
    entries,
  };
}
