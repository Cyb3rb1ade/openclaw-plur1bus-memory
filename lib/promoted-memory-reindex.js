import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative } from "node:path";
import { INPUT_LIMITS, validateInput } from "./input-limits.js";
import { resolveInside, safeAgentId } from "./sql-safety.js";

const PROMOTION_MARKER_RE = /<!--\s*openclaw-memory-promotion:([^>]+)\s*-->/;

function requireValidInput(value, options) {
  const result = validateInput(value, options);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function configuredPathInside(baseDir, configuredPath) {
  const pathPart = isAbsolute(configuredPath)
    ? relative(baseDir, configuredPath)
    : configuredPath;
  return resolveInside(baseDir, pathPart);
}

/**
 * Parses curated dreaming-promotion marker/list-item pairs from MEMORY.md.
 *
 * @param {string} content
 * @returns {Array<{marker: string, text: string}>}
 */
export function parsePromotionMarkers(content) {
  requireValidInput(content, {
    maxLength: 10 * INPUT_LIMITS.MEMORY_TEXT,
    name: "MEMORY.md content",
    required: true,
  });
  const promotions = [];
  let pendingMarker = null;
  for (const line of content.split(/\r?\n/)) {
    const markerMatch = line.match(PROMOTION_MARKER_RE);
    if (markerMatch) {
      pendingMarker = requireValidInput(markerMatch[1].trim(), {
        maxLength: 512,
        name: "promotion marker",
        required: true,
      });
      continue;
    }
    if (!pendingMarker) continue;
    if (!line.startsWith("- ")) {
      pendingMarker = null;
      continue;
    }
    const text = line
      .slice(2)
      .replace(/\s+\[score=[^\]]*\]\s*$/, "")
      .trim();
    const validated = requireValidInput(text, {
      maxLength: INPUT_LIMITS.MEMORY_TEXT,
      name: "promotion text",
      required: true,
    });
    promotions.push({ marker: pendingMarker, text: validated });
    pendingMarker = null;
  }
  return promotions;
}

/**
 * Discovers one safe owning agent and MEMORY.md source per workspace.
 *
 * @param {object} config
 * @param {string} openclawHome
 * @param {{agents?: string[]}} [options]
 * @returns {Array<{agentId: string, workspaceDir: string, memoryPath: string, workspaceKey: string}>}
 */
export function discoverPromotionTargets(config, openclawHome, options = {}) {
  const legacyList = config?.agents?.list;
  const currentEntries = config?.agents?.entries;
  const agents = Array.isArray(legacyList)
    ? legacyList
    : Array.isArray(currentEntries)
      ? currentEntries
      : currentEntries && typeof currentEntries === "object"
        ? Object.entries(currentEntries).map(([id, entry]) => ({
          ...(entry && typeof entry === "object" ? entry : {}),
          id,
        }))
        : [];
  const requested = new Set((options.agents || []).map(safeAgentId));
  const defaultWorkspace = config?.agents?.defaults?.workspace || "workspace";
  const byWorkspace = new Map();

  for (const entry of agents) {
    const agentId = safeAgentId(entry?.id);
    if (requested.size > 0 && !requested.has(agentId)) continue;
    const workspaceDir = configuredPathInside(openclawHome, entry.workspace || defaultWorkspace);
    const existing = byWorkspace.get(workspaceDir);
    if (!existing) {
      byWorkspace.set(workspaceDir, { agentId, workspaceDir });
      continue;
    }
    const hyphens = (value) => (value.match(/-/g) || []).length;
    if (
      hyphens(agentId) < hyphens(existing.agentId)
      || (hyphens(agentId) === hyphens(existing.agentId) && agentId.length < existing.agentId.length)
    ) {
      byWorkspace.set(workspaceDir, { agentId, workspaceDir });
    }
  }

  const targets = [];
  for (const target of byWorkspace.values()) {
    const candidates = [
      resolveInside(target.workspaceDir, "MEMORY.md"),
      resolveInside(target.workspaceDir, "sys", "MEMORY.md"),
      resolveInside(target.workspaceDir, "memory", "MEMORY.md"),
    ];
    const memoryPath = candidates.find((candidate) => existsSync(candidate));
    if (!memoryPath) continue;
    targets.push({
      ...target,
      memoryPath,
      workspaceKey: basename(target.workspaceDir),
    });
  }
  return targets.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Builds a deterministic UUIDv5-shaped ID from agent ownership and marker.
 *
 * @param {string} agentId
 * @param {string} marker
 * @returns {string}
 */
export function stablePromotionId(agentId, marker) {
  const safeAgent = safeAgentId(agentId);
  const safeMarker = requireValidInput(marker, {
    maxLength: 512,
    name: "promotion marker",
    required: true,
  });
  const bytes = createHash("sha256").update(`${safeAgent}\0${safeMarker}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Builds an internal reindex plan. Text remains internal and is never emitted
 * by applyPromotionReindex's public result.
 *
 * @param {{targets: Array<object>, openclawHome: string, readFile?: Function}} options
 * @returns {{targets: Array<object>}}
 */
export function planPromotionReindex({ targets, openclawHome, readFile = readFileSync }) {
  const plannedTargets = [];
  for (const target of targets || []) {
    const agentId = safeAgentId(target.agentId);
    const content = readFile(target.memoryPath, "utf8");
    const seen = new Set();
    const promotions = [];
    for (const promotion of parsePromotionMarkers(content)) {
      const id = stablePromotionId(agentId, promotion.marker);
      if (seen.has(id)) continue;
      seen.add(id);
      promotions.push({
        id,
        markerHash: createHash("sha256").update(promotion.marker).digest("hex"),
        text: promotion.text,
      });
    }
    plannedTargets.push({
      agentId,
      workspaceKey: target.workspaceKey,
      workspaceDir: target.workspaceDir,
      dbPath: resolveInside(openclawHome, "memory", "lancedb-namespaced", agentId),
      promotions,
    });
  }
  return { targets: plannedTargets };
}

function emptyCounts(planned = 0) {
  return { planned, inserted: 0, skipped: 0, failed: 0 };
}

/**
 * Applies or safely summarizes a promoted-memory reindex plan.
 *
 * @param {{targets?: Array<object>}} plan
 * @param {{apply?: boolean, createEmbedder?: Function, createMemoryDb?: Function, now?: Function}} dependencies
 * @returns {Promise<object>}
 */
export async function applyPromotionReindex(plan, dependencies = {}) {
  const targets = Array.isArray(plan?.targets) ? plan.targets : [];
  const planned = targets.reduce((sum, target) => sum + (target.promotions?.length || 0), 0);
  const result = {
    ok: true,
    mode: dependencies.apply === true ? "apply" : "dry-run",
    counts: emptyCounts(planned),
    agents: [],
    failures: [],
  };
  if (dependencies.apply !== true || planned === 0) {
    result.agents = targets.map((target) => ({
      agentId: target.agentId,
      counts: emptyCounts(target.promotions?.length || 0),
    }));
    return result;
  }
  if (typeof dependencies.createEmbedder !== "function" || typeof dependencies.createMemoryDb !== "function") {
    throw new Error("applyPromotionReindex requires provider and database factories in apply mode");
  }

  const embedder = await dependencies.createEmbedder();
  if (!Number.isInteger(embedder?.dimensions) || embedder.dimensions <= 0 || typeof embedder.embed !== "function") {
    throw new Error("embedding provider returned an invalid dimension or embed function");
  }
  const now = typeof dependencies.now === "function" ? dependencies.now : Date.now;

  for (const target of targets) {
    const agentCounts = emptyCounts(target.promotions?.length || 0);
    let db;
    try {
      db = dependencies.createMemoryDb({
        agentId: target.agentId,
        dbPath: target.dbPath,
        vectorDim: embedder.dimensions,
      });
      for (const promotion of target.promotions || []) {
        try {
          if (await db.getById(promotion.id)) {
            result.counts.skipped += 1;
            agentCounts.skipped += 1;
            continue;
          }
          const timestamp = now();
          const vector = await embedder.embed(promotion.text, { agentId: target.agentId });
          await db.store({
            id: promotion.id,
            text: promotion.text,
            summary: promotion.text.slice(0, 200),
            origin: "dreaming-promotion",
            vector,
            importance: 0.9,
            category: "curated",
            createdAt: timestamp,
            agentId: target.agentId,
            storedBy: target.agentId,
            sourceMessageRole: "internal",
            sourceTimestamp: timestamp,
            evidenceQuote: promotion.text.slice(0, 200),
            scope: "agent-private",
            workspaceId: target.workspaceKey || "",
            workspaceKey: target.workspaceKey || "",
          });
          result.counts.inserted += 1;
          agentCounts.inserted += 1;
        } catch {
          result.ok = false;
          result.counts.failed += 1;
          agentCounts.failed += 1;
          result.failures.push({ agentId: target.agentId, promotionId: promotion.id, code: "promotion-apply-failed" });
        }
      }
    } finally {
      if (db && typeof db.shutdown === "function") {
        try {
          await db.shutdown();
        } catch {
          result.ok = false;
          result.failures.push({ agentId: target.agentId, code: "database-shutdown-failed" });
        }
      }
    }
    result.agents.push({ agentId: target.agentId, counts: agentCounts });
  }
  return result;
}
