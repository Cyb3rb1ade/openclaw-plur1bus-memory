import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import { collectTier1Links } from "./graph-link-writer.js";
import { buildManagedBlock, replaceManagedBlock } from "./managed-blocks.js";
import { buildRecordIndex, readMemoryNotes } from "./record-index.js";
import { atomicWriteText, resolveVaultPath } from "./safe-paths.js";

function sha256(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function bodyOf(text) {
  const content = String(text || "");
  if (!content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---\n", 4);
  return end < 0 ? content : content.slice(end + 5);
}

function resolveKnowledgePath(rawConfig = {}) {
  const vaultPath = resolveVaultPath(rawConfig);
  if (!vaultPath) throw new Error("obsidianBridge.vaultPath is not configured");
  return { vaultPath, knowledgePath: resolve(vaultPath, "memory", "KNOWLEDGE.md") };
}

function graphBlock(links, blockId = "graph-links") {
  return {
    id: blockId,
    version: "4.2.18",
    body: `## 🔗 Verwandte Einträge\n\n${links.join("\n")}`,
    attrs: { tiers: "explicit" },
  };
}

function sourceMemoriesFrom(content) {
  const parsed = parseFrontmatter(content);
  const ids = Array.isArray(parsed.frontmatter.source_memories)
    ? parsed.frontmatter.source_memories.map(String).filter(Boolean)
    : [];
  return { parsed, ids };
}

/**
 * Plan the managed graph block for memory/KNOWLEDGE.md without writing.
 *
 * @param {Object} rawConfig - Bridge config with vaultPath and reviewRoot
 * @param {Object} options
 * @param {number} [options.maxPerNote=5] - Maximum graph links
 * @returns {Object} Dry-run plan
 */
export function planKnowledgeHubGraphLinks(rawConfig = {}, options = {}) {
  const maxPerNote = options.maxPerNote ?? rawConfig.graphLinks?.maxPerNote ?? 5;
  const blockId = options.blockId || rawConfig.graphLinks?.blockId || "graph-links";
  const reviewRoot = rawConfig.reviewRoot || "plur1bus";
  const { vaultPath, knowledgePath } = resolveKnowledgePath(rawConfig);
  if (!existsSync(knowledgePath)) {
    return { ok: false, missingKnowledge: true, sourceMemoriesTotal: 0, resolvable: 0, missing: 0, links: [], wouldWrite: false };
  }

  const before = readFileSync(knowledgePath, "utf8");
  const { ids } = sourceMemoriesFrom(before);
  const memories = readMemoryNotes(rawConfig);
  const index = buildRecordIndex(rawConfig, { records: memories, readExistingRecords: false });
  const links = collectTier1Links({ source_memories: ids }, index, reviewRoot, maxPerNote);
  const resolvableIds = ids.filter((id) => index.byMemoryId[id]);
  const missingIds = ids.filter((id) => !index.byMemoryId[id]);
  const wouldWrite = links.length > 0;
  const next = wouldWrite ? replaceManagedBlock(before, graphBlock(links, blockId)) : { changed: false, content: before, conflict: null };

  return {
    ok: true,
    vaultPath,
    path: knowledgePath,
    rel: relative(vaultPath, knowledgePath).replace(/\\/g, "/"),
    sourceMemoriesTotal: ids.length,
    resolvable: resolvableIds.length,
    missing: missingIds.length,
    missingIds,
    links,
    wouldWrite,
    changed: next.changed,
    conflict: next.conflict || null,
    preview: next.content,
    beforeHash: sha256(before),
    beforeBodyHash: sha256(bodyOf(before)),
    afterHash: next.changed ? sha256(next.content) : sha256(before),
    afterBodyHash: next.changed ? sha256(bodyOf(next.content)) : sha256(bodyOf(before)),
  };
}

function writeManifest(rawConfig, plan, options = {}) {
  const manifestDir = options.manifestDir || join(plan.vaultPath, ".plur1bus", "apply-manifests");
  mkdirSync(manifestDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = join(manifestDir, `${stamp}-knowledge-hub-graph.json`);
  const manifest = {
    kind: "knowledge-hub-graph",
    path: plan.path,
    rel: plan.rel,
    sourceMemoriesTotal: plan.sourceMemoriesTotal,
    resolvable: plan.resolvable,
    missing: plan.missing,
    missingIds: plan.missingIds,
    links: plan.links,
    beforeHash: plan.beforeHash,
    beforeBodyHash: plan.beforeBodyHash,
    afterHash: plan.afterHash,
    afterBodyHash: plan.afterBodyHash,
    workspaceId: rawConfig.workspaceKey || rawConfig.workspaceId || rawConfig.workspace_id || null,
    agentId: rawConfig.agentId || rawConfig.agent_id || null,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

/**
 * Apply a managed graph block to memory/KNOWLEDGE.md behind an explicit gate.
 *
 * @param {Object} rawConfig - Bridge config with vaultPath and reviewRoot
 * @param {Object} options
 * @param {boolean} [options.confirm=false] - Must be true to write
 * @returns {Object} Apply result
 */
export function applyKnowledgeHubGraphLinks(rawConfig = {}, options = {}) {
  const plan = planKnowledgeHubGraphLinks(rawConfig, options);
  if (!options.confirm) {
    return { ok: false, blocked: true, reason: "confirm_required", updated: 0, unchanged: 0, skipped: 0, plan };
  }
  if (!plan.ok || !plan.wouldWrite || plan.links.length < 1) {
    return { ok: true, updated: 0, unchanged: 0, skipped: 1, conflicts: plan.conflict ? [plan.rel] : [], plan };
  }
  if (plan.conflict) {
    return { ok: false, updated: 0, unchanged: 0, skipped: 0, conflicts: [plan.rel], plan };
  }
  if (!plan.changed) {
    return { ok: true, updated: 0, unchanged: 1, skipped: 0, conflicts: [], plan };
  }

  const manifestPath = writeManifest(rawConfig, plan, options);
  mkdirSync(dirname(plan.path), { recursive: true });
  atomicWriteText(plan.path, plan.preview);
  return { ok: true, updated: 1, unchanged: 0, skipped: 0, conflicts: [], manifestPath, plan };
}
