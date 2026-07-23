import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";

import { computeContentHash, loadLinkIndex, saveLinkIndex, buildPriorityQueue } from "./link-index.js";
import { parseFrontmatter } from "./frontmatter.js";
import { resolveReviewPath } from "./safe-paths.js";
import { safeAgentId } from "../sql-safety.js";
import { distanceToScore } from "../score.js";
import { mutationAllowed } from "../obsidian-mutation-policy.js";

const GENERATED_RECORD_TYPES = new Set([
  "duplicate_candidate",
  "impact_analysis",
  "provenance",
  "source",
]);

const INVALID_SEMANTIC_STATUSES = new Set(["archived", "deleted"]);

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
  const canWrite = options.confirm === true
    && mutationAllowed(options.mutationPolicy, "semantic_index_write")
    && mutationAllowed(options.mutationPolicy, "vault_write");

  const vaultPath = rawConfig.vaultPath;
  const resolvedCfg = resolveDiscoveryConfig(rawConfig);
  const { threshold, maxLinksPerRecord } = resolvedCfg;
  const maxPerRun = options.maxPerRun ?? resolvedCfg.maxPerRun;
  const topN = options.topN ?? rawConfig?.discovery?.topN ?? 15;
  const minScore = options.minScore ?? rawConfig?.discovery?.minScore ?? threshold;

  if (!records.length) return { processed: 0, skipped: 0, unchanged: 0, errors: 0, indexUpdated: false };

  const existingIndex = loadLinkIndex(vaultPath);
  const queue = buildPriorityQueue(records, existingIndex).slice(0, maxPerRun);

  const runWithDb = async (db) => {
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
          if (dirty && canWrite) saveLinkIndex(vaultPath, existingIndex, { mutationPolicy: options.mutationPolicy });
          return {
            processed,
            skipped,
            unchanged,
            errors,
            indexUpdated: dirty && canWrite,
            batchAborted: true,
            ...(dirty && !canWrite ? { blocked: true, reason: "bound_confirmation_required" } : {}),
          };
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

    if (dirty && canWrite) saveLinkIndex(vaultPath, existingIndex, { mutationPolicy: options.mutationPolicy });
    return {
      processed,
      skipped,
      unchanged,
      errors,
      indexUpdated: dirty && canWrite,
      ...(dirty && !canWrite ? { blocked: true, reason: "bound_confirmation_required" } : {}),
    };
  };

  if (options.db) return await runWithDb(options.db);
  if (typeof pool.withDb === "function") return await pool.withDb(defaultAgentId, runWithDb);
  return await runWithDb(pool.getDb(defaultAgentId));
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

function parseSemanticSearchScore(candidate) {
  if (candidate == null) return NaN;
  if (typeof candidate.score === "number" && Number.isFinite(candidate.score)) return candidate.score;
  if (typeof candidate._distance === "number" && Number.isFinite(candidate._distance)) return distanceToScore(candidate._distance);
  if (typeof candidate.distance === "number" && Number.isFinite(candidate.distance)) return distanceToScore(candidate.distance);
  return NaN;
}

function readSemanticCandidateId(candidate) {
  return firstNonEmpty(
    candidate?.memory_id,
    candidate?.id,
    candidate?.entry?.id,
    candidate?.memoryId,
    candidate?.recordId,
    candidate?.entry?.memory_id,
  );
}

function isScopeMismatch(candidate, scope) {
  return hasScopeMismatch(
    {
      agent_id: firstNonEmpty(candidate?.agent_id, candidate?.agentId, candidate?.agent,
        candidate?.storedBy, candidate?.entry?.agent_id, candidate?.entry?.agentId, candidate?.entry?.storedBy),
      workspace_id: firstNonEmpty(candidate?.workspace_id, candidate?.workspaceId, candidate?.workspaceKey,
        candidate?.entry?.workspace_id, candidate?.entry?.workspaceId, candidate?.entry?.workspaceKey),
    },
    scope,
  );
}

function isGeneratedOrInvalid(candidate) {
  const type = firstNonEmpty(candidate?.type, candidate?.plur1bus_type, candidate?.memoryKind, candidate?.entry?.type, candidate?.entry?.plur1bus_type, candidate?.entry?.memoryKind);
  const memoryKind = firstNonEmpty(candidate?.memoryKind, candidate?.entry?.memoryKind);
  const status = firstNonEmpty(candidate?.status, candidate?.entry?.status, candidate?.plur1bus_status);
  if (type && GENERATED_RECORD_TYPES.has(type)) return true;
  if (memoryKind && memoryKind !== "memory") return true;
  if (status && INVALID_SEMANTIC_STATUSES.has(status)) return true;
  return false;
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

async function buildAnnLinksForRecord(record, options = {}, allRecords = [], searchSimilar) {
  if (!searchSimilar || !record || !Array.isArray(allRecords) || !allRecords.length) return [];
  const { threshold = 0.78, maxSimilar = 5, topK = 20 } = options;

  const sourceVector = normalizeVector(record.vector);
  if (!validVector(sourceVector)) return [];

  const targetScope = {
    agentId: record.agent_id,
    workspaceId: record.workspace_id,
  };

  let searchRows;
  try {
    searchRows = await searchSimilar(record, {
      vector: sourceVector,
      threshold,
      maxLinksPerRecord: maxSimilar,
      topK,
      record,
      workspace_id: targetScope.workspaceId,
      agent_id: targetScope.agentId,
    });
  } catch (err) {
    return [];
  }

  const recordById = new Map();
  for (const candidate of allRecords) {
    const id = firstNonEmpty(candidate?.memory_id, candidate?.id);
    if (id) recordById.set(id, candidate);
  }

  const candidates = [];
  for (const row of Array.isArray(searchRows) ? searchRows : []) {
    const candidateId = readSemanticCandidateId(row);
    if (!candidateId || candidateId === record.id) continue;
    if (isScopeMismatch(row, targetScope)) continue;
    if (isGeneratedOrInvalid(row)) continue;
    const score = parseSemanticSearchScore(row);
    if (!Number.isFinite(score) || score < threshold) continue;
    const candidateRecord = recordById.get(candidateId);
    if (!candidateRecord) continue;
    candidates.push({
      id: candidateId,
      memory_id: candidateRecord.memory_id,
      path: candidateRecord.path,
      title: candidateRecord.title || candidateRecord.summary || candidateId,
      score: Number(score.toFixed(6)),
    });
  }

  candidates.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));
  return candidates.slice(0, maxSimilar);
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
  const topK = options.topK ?? rawConfig.graphLinks?.semanticDiscovery?.topK ?? 20;
  const searchSimilar = options.searchSimilar;
  const useAnn = typeof searchSimilar === "function";
  const searchOptions = { maxSimilar, threshold, topK };
  const searchMeta = { calls: 0 };
  const records = [...joined.records].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const entries = {};

  for (const record of records) {
    let links;
    if (useAnn) {
      links = await buildAnnLinksForRecord(record, searchOptions, records, async (queryRecord, queryOptions = {}) => {
        searchMeta.calls += 1;
        return searchSimilar(queryRecord, {
          ...queryOptions,
          vector: queryRecord.vector,
          agent_id: record.agent_id,
          workspace_id: record.workspace_id,
        });
      });
    } else {
      links = [];
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
      links = links.slice(0, maxSimilar);
    }
    entries[record.id] = {
      similar: links.map((link) => link.id),
      links,
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
    searchCalls: searchMeta.calls,
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
  const canWrite = options.confirm === true
    && mutationAllowed(options.mutationPolicy, "semantic_index_write")
    && mutationAllowed(options.mutationPolicy, "vault_write");
  if (!canWrite) {
    return { ok: false, blocked: true, reason: "bound_confirmation_required", updated: 0, unchanged: 0, skipped: 0, conflicts: [], plan };
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
  saveLinkIndex(plan.vaultPath, indexPayload, { mutationPolicy: options.mutationPolicy });
  return { ok: true, updated: 1, unchanged: 0, skipped: 0, conflicts: [], manifestPath, plan };
}

function defaultCheckpointPath(vaultPath) {
  return join(vaultPath, ".plur1bus", "tmp", "semantic-link-index-checkpoint.json");
}

function readSemanticCheckpoint(checkpointPath) {
  if (!checkpointPath || !existsSync(checkpointPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      version: "1",
      entries: normalizeIndexEntries(parsed.entries || {}),
      nextOffset: Number.isInteger(parsed.nextOffset) ? parsed.nextOffset : 0,
      total: Number.isInteger(parsed.total) ? parsed.total : 0,
      complete: parsed.complete === true,
    };
  } catch {
    return null;
  }
}

function writeSemanticCheckpoint(checkpointPath, payload = {}) {
  if (!checkpointPath) return;
  mkdirSync(dirname(checkpointPath), { recursive: true });
  writeFileSync(checkpointPath, `${JSON.stringify({
    version: "1",
    ...payload,
    entries: normalizeIndexEntries(payload.entries || {}),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
}

function semanticBatchLinks(record, options, records, searchSimilar) {
  if (typeof searchSimilar === "function") {
    return buildAnnLinksForRecord(record, options, records, searchSimilar);
  }
  const links = [];
  for (const candidate of records) {
    if (candidate.id === record.id) continue;
    const score = cosineSimilarity(record.vector, candidate.vector);
    if (score == null || score < options.threshold) continue;
    links.push({
      id: candidate.id,
      memory_id: candidate.memory_id,
      path: candidate.path,
      title: candidate.title || candidate.summary || candidate.id,
      score: Number(score.toFixed(6)),
    });
  }
  links.sort((a, b) => (b.score - a.score) || String(a.id).localeCompare(String(b.id)));
  return links.slice(0, options.maxSimilar);
}

/**
 * Process a bounded, checkpointed semantic-link-index batch.
 *
 * This is intended for large workspaces where a full per-record ANN pass may
 * exceed one runtime window. Dry-runs write only a checkpoint/preview; the final
 * `.plur1bus/link-index.json` is written only with `confirm: true` after all
 * records have been processed.
 *
 * @param {Object} rawConfig
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function runSemanticLinkIndexBatch(rawConfig = {}, options = {}) {
  const canWrite = options.confirm === true
    && mutationAllowed(options.mutationPolicy, "semantic_index_write")
    && mutationAllowed(options.mutationPolicy, "vault_write");
  const { vaultPath } = resolveReviewPath(rawConfig, ".");
  const checkpointPath = options.checkpointPath || defaultCheckpointPath(vaultPath);
  const existingCheckpoint = readSemanticCheckpoint(checkpointPath);
  const mirrorResult = options.mirrorRecords
    ? { records: options.mirrorRecords, total: options.mirrorRecords.length, skipped: {} }
    : readMemoryMirrorRecords(rawConfig, options);
  const sidecar = options.sidecarRecords
    ? { records: options.sidecarRecords, total: options.sidecarRecords.length, skipped: {} }
    : await loadLanceDbVectorSidecar(rawConfig, options);
  const joined = joinMemoryMirrorVectorSidecar(mirrorResult.records, sidecar.records || [], options);
  const records = [...joined.records].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const maxSimilar = options.maxSimilar ?? rawConfig.graphLinks?.semanticDiscovery?.maxLinksPerRecord ?? 5;
  const threshold = options.threshold ?? rawConfig.graphLinks?.semanticDiscovery?.threshold ?? rawConfig.graphLinks?.semanticThreshold ?? 0.78;
  const topK = options.topK ?? rawConfig.graphLinks?.semanticDiscovery?.topK ?? 20;
  const batchSize = Math.max(1, Number.parseInt(options.batchSize ?? 100, 10));
  const concurrency = Math.max(1, Number.parseInt(options.concurrency ?? 1, 10));
  const maxRuntimeMs = Number.isFinite(options.maxRuntimeSeconds) ? Math.max(0, options.maxRuntimeSeconds * 1000) : Infinity;
  const startedAt = Date.now();
  const offset = existingCheckpoint ? existingCheckpoint.nextOffset : Math.max(0, Number.parseInt(options.offset ?? 0, 10));
  const limit = options.limit == null ? records.length - offset : Math.max(0, Number.parseInt(options.limit, 10));
  const end = Math.min(records.length, offset + limit);
  const entries = normalizeIndexEntries(existingCheckpoint?.entries || {});
  const searchOptions = { maxSimilar, threshold, topK };
  let processed = 0;
  let linksFound = 0;
  let errors = 0;
  const progress = [];

  let cursor = offset;
  while (cursor < end) {
    if (processed > 0 && Date.now() - startedAt >= maxRuntimeMs) break;
    const chunkStart = cursor;
    const chunkEnd = Math.min(end, cursor + batchSize);
    const chunk = records.slice(chunkStart, chunkEnd).map((record, index) => ({ record, index: chunkStart + index }));
    const chunkResults = [];
    let nextChunkIndex = 0;
    const workers = Array.from({ length: Math.min(concurrency, chunk.length) }, async () => {
      while (nextChunkIndex < chunk.length) {
        const item = chunk[nextChunkIndex++];
        try {
          const links = await semanticBatchLinks(item.record, searchOptions, records, async (queryRecord, queryOptions = {}) => {
            if (typeof options.searchSimilar !== "function") return [];
            return options.searchSimilar(queryRecord, {
              ...queryOptions,
              vector: queryRecord.vector,
              agent_id: item.record.agent_id,
              workspace_id: item.record.workspace_id,
            });
          });
          chunkResults.push({ index: item.index, record: item.record, links, error: null });
        } catch (err) {
          chunkResults.push({ index: item.index, record: item.record, links: [], error: err });
        }
      }
    });
    await Promise.all(workers);

    for (const item of chunkResults.sort((a, b) => a.index - b.index)) {
      if (item.error) {
        errors++;
      } else {
        linksFound += item.links.length;
        entries[item.record.id] = {
          similar: item.links.map((link) => link.id),
          links: item.links,
          contentHash: item.record.content_hash || computeContentHash(item.record),
          sourcePath: item.record.path,
        };
      }
      processed++;
    }

    cursor = chunkEnd;
    const elapsedMs = Date.now() - startedAt;
    const rate = processed > 0 ? processed / Math.max(elapsedMs / 1000, 0.001) : 0;
    const remaining = Math.max(0, records.length - cursor);
    progress.push({
      processed: cursor,
      total: records.length,
      linksFound,
      elapsedMs,
      estimatedRemainingSeconds: rate > 0 ? Math.round(remaining / rate) : null,
    });
    if (canWrite) {
      writeSemanticCheckpoint(checkpointPath, {
        total: records.length,
        nextOffset: cursor,
        complete: cursor >= records.length,
        entries,
        progress,
      });
    }
    options.logger?.info?.(`semantic-link-index: processed ${cursor}/${records.length}, links=${linksFound}`);
  }

  const nextOffset = Math.min(records.length, cursor);
  const complete = nextOffset >= records.length;
  if (canWrite) {
    writeSemanticCheckpoint(checkpointPath, {
      total: records.length,
      nextOffset,
      complete,
      entries,
      progress,
    });
  }

  const normalizedEntries = normalizeIndexEntries(entries);
  const plan = {
    ok: true,
    dryRun: !canWrite,
    vaultPath,
    path: join(vaultPath, ".plur1bus", "link-index.json"),
    rel: ".plur1bus/link-index.json",
    mirrorFilesTotal: mirrorResult.total,
    mirrorUsableText: mirrorResult.records.length,
    sidecarRowsTotal: sidecar.total,
    sidecarUsable: sidecar.records.length,
    vectorMatches: joined.vectorMatches,
    indexableRecords: records.length,
    skippedWithoutVector: joined.skippedWithoutVector,
    skippedScopeMismatch: (mirrorResult.skipped?.scopeMismatch || 0) + joined.skippedScopeMismatch,
    threshold,
    maxSimilar,
    entries: normalizedEntries,
  };

  const current = readExistingIndex(plan);
  const changed = isIndexChanged({ entries: normalizedEntries }, current);
  const result = {
    ok: true,
    dryRun: !canWrite,
    checkpointPath,
    offset,
    limit,
    batchSize,
    concurrency,
    processed,
    total: records.length,
    nextOffset,
    complete,
    linksFound,
    errors,
    progress,
    entries: normalizedEntries,
    entriesCount: Object.keys(normalizedEntries).length,
    expectedIndexBytes: estimateIndexBytes(normalizedEntries),
    wouldWrite: Boolean(canWrite && complete && changed && records.length > 0),
    updated: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: [],
    plan,
  };

  if (!canWrite) return { ...result, blocked: true, reason: "bound_confirmation_required" };
  if (!complete) {
    return { ...result, reason: "checkpoint_incomplete" };
  }
  if (records.length === 0) {
    return { ...result, ok: false, unchanged: 1, reason: "no_vector_matches" };
  }
  if (!changed) {
    return { ...result, unchanged: 1 };
  }

  const manifestPath = writeSemanticLinkIndexManifest(rawConfig, plan, options);
  saveLinkIndex(vaultPath, { version: "1", entries: normalizedEntries }, { mutationPolicy: options.mutationPolicy });
  return { ...result, updated: 1, manifestPath };
}
