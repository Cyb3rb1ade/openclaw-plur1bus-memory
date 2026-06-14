import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";

import { computeContentHash, loadLinkIndex, saveLinkIndex, buildPriorityQueue } from "./link-index.js";
import { parseFrontmatter } from "./frontmatter.js";
import { resolveReviewPath } from "./safe-paths.js";
import { safeAgentId } from "../sql-safety.js";

const GENERATED_RECORD_TYPES = new Set([
  "duplicate_candidate",
  "impact_analysis",
  "provenance",
  "source",
]);

const DEFAULT_LANCE_DB_BASE_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");

/**
 * Load LanceDB rows as semantic sidecar records.
 *
 * @param {string} basePath
 * @param {string} agentId
 * @param {Object} options
 * @returns {Promise<Array<Object>>}
 */
async function loadLanceDbRows(basePath, agentId, options = {}) {
  if (typeof options.loadLanceDbRows === "function") {
    const rows = await options.loadLanceDbRows();
    return Array.isArray(rows) ? rows : [];
  }
  const dbDir = join(basePath, safeAgentId(agentId));
  const { connect } = await import("@lancedb/lancedb");
  const db = await connect(dbDir);
  const names = await db.tableNames();
  if (!names.includes("memories")) return [];
  const table = await db.openTable("memories");
  return await table.query().toArray();
}

function normalizeLanceDbRow(row) {
  if (!row) return null;
  const type = firstNonEmpty(row.type, row.plur1bus_type, row.memoryKind);
  if (!type || GENERATED_RECORD_TYPES.has(type)) return null;
  const id = firstNonEmpty(row.memory_id, row.id);
  if (!id) return null;
  return {
    id,
    memory_id: id,
    vector: normalizeVector(row.vector),
    agent_id: firstNonEmpty(row.agent_id, row.agentId),
    workspace_id: firstNonEmpty(row.workspace_id, row.workspaceId, row.workspaceKey),
    plur1bus_type: type,
    scope: row.scope || "agent-private",
    text: row.text || "",
    summary: row.summary || "",
  };
}

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

/**
 * Load vectors for semantic linking directly from LanceDB.
 *
 * The dedicated loader is used for Dry-Run only and keeps the existing
 * MemoryDB.scanActive() path untouched.
 *
 * @param {Object} rawConfig
 * @param {Object} options
 * @returns {Promise<{ records: Array<Object>, total: number, skipped: Object }>} sidecar load result
 */
export async function loadLanceDbVectorSidecar(rawConfig = {}, options = {}) {
  const scope = resolveExpectedScope(rawConfig, options);
  const basePath = firstNonEmpty(options.lanceDbBasePath, rawConfig.baseDbPath, rawConfig.lanceDbBasePath, DEFAULT_LANCE_DB_BASE_PATH);
  const workspaceId = firstNonEmpty(scope.workspaceId, scope.agentId, "main");
  const agentId = firstNonEmpty(options.agentId, options.agent_id, rawConfig.agentId, rawConfig.agent_id, workspaceId);
  const result = {
    records: [],
    total: 0,
    skipped: {
      generated: 0,
      missingId: 0,
      missingText: 0,
      notMemory: 0,
      scopeMismatch: 0,
      withoutVector: 0,
    },
  };

  let rows;
  try {
    rows = await loadLanceDbRows(basePath, agentId, options);
  } catch (err) {
    return result;
  }

  result.total = Array.isArray(rows) ? rows.length : 0;
  const seen = new Set();

  for (const row of rows) {
    const mapped = normalizeLanceDbRow(row);
    if (!mapped) {
      if (!row || !(row.type || row.memoryKind || row.plur1bus_type)) result.skipped.missingId++;
      else result.skipped.generated++;
      continue;
    }

    if (hasScopeMismatch(mapped, scope)) {
      result.skipped.scopeMismatch++;
      continue;
    }

    const vector = normalizeVector(mapped.vector);
    if (!validVector(vector)) {
      result.skipped.withoutVector++;
      continue;
    }

    if (!seen.has(mapped.id)) {
      seen.add(mapped.id);
      result.records.push({ ...mapped, vector });
    }
  }

  return result;
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
export async function planSemanticLinkIndexDryRun(rawConfig = {}, options = {}) {
  const { vaultPath } = resolveReviewPath(rawConfig, ".");
  const mirrorResult = options.mirrorRecords
    ? { records: options.mirrorRecords, total: options.mirrorRecords.length, skipped: {} }
    : readMemoryMirrorRecords(rawConfig, options);

  const sidecar = options.sidecarRecords
    ? { records: options.sidecarRecords, total: options.sidecarRecords.length, skipped: {} }
    : await loadLanceDbVectorSidecar(rawConfig, options);

  const joined = joinMemoryMirrorVectorSidecar(mirrorResult.records, sidecar.records || [], options);
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

  const normalizedEntries = normalizeIndexEntries(entries);
  const existingIndex = readIndexPayload(vaultPath);
  const beforeHash = hashText(JSON.stringify(existingIndex, null, 0));
  const afterHash = hashText(JSON.stringify({ version: "1", entries: normalizedEntries }, null, 0));

  return {
    ok: true,
    dryRun: true,
    vaultPath,
    path: join(vaultPath, ".plur1bus", "link-index.json"),
    rel: ".plur1bus/link-index.json",
    wouldWrite: joined.vectorMatches > 0,
    mirrorFilesTotal: mirrorResult.total,
    mirrorUsableText: mirrorResult.records.length,
    sidecarRowsTotal: sidecar.total,
    sidecarUsable: sidecar.records.length,
    sidecarWithVector: joined.vectorMatches + joined.skippedWithoutVector,
    mirrorSkipped: mirrorResult.skipped,
    vectorMatches: joined.vectorMatches,
    indexableRecords: records.length,
    skippedWithoutVector: joined.skippedWithoutVector,
    skippedScopeMismatch: (mirrorResult.skipped?.scopeMismatch || 0) + joined.skippedScopeMismatch,
    reason: joined.vectorMatches === 0 ? "no_vector_matches" : "",
    threshold,
    maxSimilar,
    expectedIndexBytes: estimateIndexBytes(entries),
    beforeHash,
    afterHash,
    entries,
  };
}

function hashText(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function normalizeIndexEntries(entries = {}) {
  const ordered = Object.fromEntries(
    Object.entries(entries || {})
      .filter(([, value]) => value)
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([id, entry]) => [
        String(id),
        {
          similar: Array.isArray(entry?.similar) ? [...entry.similar] : [],
          contentHash: String(entry?.contentHash || ""),
          sourcePath: entry?.sourcePath || "",
          links: Array.isArray(entry?.links) ? [...entry.links] : [],
        },
      ]),
  );
  return ordered;
}

function buildIndexPayloadFromPlan(plan = {}) {
  const entries = normalizeIndexEntries(plan.entries || {});
  return { version: "1", entries };
}

function readIndexPayload(vaultPath) {
  const existing = loadLinkIndex(vaultPath);
  return { version: "1", entries: normalizeIndexEntries(existing?.entries || {}) };
}

function writeSemanticLinkIndexManifest(rawConfig, plan, options = {}) {
  const manifestDir = options.manifestDir || join(plan.vaultPath, ".plur1bus", "apply-manifests");
  mkdirSync(manifestDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = join(manifestDir, `${stamp}-semantic-link-index.json`);
  const manifest = {
    kind: "semantic-link-index",
    path: plan.path,
    rel: plan.rel,
    mirrorFilesTotal: plan.mirrorFilesTotal,
    mirrorUsableText: plan.mirrorUsableText,
    vectorMatches: plan.vectorMatches,
    indexableRecords: plan.indexableRecords,
    skippedWithoutVector: plan.skippedWithoutVector,
    skippedScopeMismatch: plan.skippedScopeMismatch,
    entriesTotal: Object.keys(plan.entries || {}).length,
    threshold: plan.threshold,
    maxSimilar: plan.maxSimilar,
    beforeHash: plan.beforeHash,
    afterHash: plan.afterHash,
    workspaceId: rawConfig.workspaceKey || rawConfig.workspaceId || rawConfig.workspace_id || null,
    agentId: rawConfig.agentId || rawConfig.agent_id || null,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function readExistingIndex(plan = {}) {
  const existing = loadLinkIndex(plan.vaultPath);
  return normalizeIndexEntries(existing?.entries || {});
}

function isIndexChanged(plan = {}, current = {}) {
  const before = current || {};
  const after = normalizeIndexEntries(plan.entries || {});
  return JSON.stringify(before) !== JSON.stringify(after);
}

/**
 * Apply semantic-link index generation behind an explicit confirmation gate.
 *
 * @param {Object} rawConfig - Bridge config with vaultPath and reviewRoot
 * @param {Object} options
 * @param {boolean} [options.confirm=false] - Must be true to write index
 * @param {Array<Object>} [options.sidecarRecords] - Optional vector sidecar records
 * @param {Array<Object>} [options.mirrorRecords] - Optional pre-read mirror records
 * @returns {Object} Apply result
 */
export async function applySemanticLinkIndex(rawConfig = {}, options = {}) {
  const plan = await planSemanticLinkIndexDryRun(rawConfig, options);
  if (!options.confirm) {
    return { ok: false, blocked: true, reason: "confirm_required", updated: 0, unchanged: 0, skipped: 0, conflicts: [], plan };
  }
  if (!plan.ok || !plan.wouldWrite) {
    const noVectors = plan.vectorMatches === 0;
    if (noVectors) {
      return { ok: false, updated: 0, unchanged: 1, skipped: 0, conflicts: [], reason: "no_vector_matches", plan };
    }
    return { ok: true, updated: 0, unchanged: 1, skipped: 0, conflicts: [], plan };
  }

  if (!plan.vaultPath) {
    return { ok: false, updated: 0, unchanged: 0, skipped: 0, conflicts: [".plur1bus/link-index.json"], reason: "missing_vault_path", plan };
  }

  const beforeIndex = readExistingIndex(plan);
  if (!isIndexChanged(plan, beforeIndex)) {
    return { ok: true, updated: 0, unchanged: 1, skipped: 0, conflicts: [], plan };
  }

  const manifestPath = writeSemanticLinkIndexManifest(rawConfig, plan, options);
  const indexPayload = buildIndexPayloadFromPlan(plan);
  saveLinkIndex(plan.vaultPath, indexPayload);
  return { ok: true, updated: 1, unchanged: 0, skipped: 0, conflicts: [], manifestPath, plan };
}
