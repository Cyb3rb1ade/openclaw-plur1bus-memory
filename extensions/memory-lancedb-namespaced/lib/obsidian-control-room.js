/**
 * PLUR1BUS Obsidian Bridge control-room layer.
 *
 * This module writes review, dashboard, curation, and project-management
 * artifacts into an Obsidian vault. PLUR1BUS stays authoritative: Obsidian text
 * is treated as untrusted input and apply never mutates memory without explicit
 * approval plus immediate revalidation.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { generateBases } from "./obsidian/bases-generator.js";
import { generateDashboards } from "./obsidian/dashboard-generator.js";
import { generateTaskSuggestions } from "./obsidian/tasks-generator.js";
import { generateConflictReport as generateLivingConflictReport } from "./obsidian/conflict-report.js";
import { buildProjectHub } from "./obsidian/project-hub-builder.js";
import { buildWeeklySynthesis } from "./obsidian/weekly-synthesis.js";
import { runMaintenanceDeep as runLivingMaintenanceDeep } from "./obsidian/maintenance-deep.js";
import { runAdversarialDeep } from "./obsidian/adversarial-deep.js";
import { buildSemanticConflictGraph } from "./obsidian/semantic-conflict-graph.js";
import { scanSemanticDuplicates } from "./obsidian/semantic-duplicate-scan.js";
import { buildProvenanceGraph } from "./obsidian/provenance-graph.js";
import { analyzeImpact } from "./obsidian/impact-analysis.js";
import { buildMemoryExplanation } from "./obsidian/memory-explain-builder.js";
import { generateLinkSuggestions } from "./obsidian/link-suggestions.js";
import { writeRecords } from "./obsidian/record-writer.js";
import { buildRecordIndex } from "./obsidian/record-index.js";
import { patchSoulMd } from "./install/soul-patcher.js";
import { discoverObsidianWorkspaces, initWorkspace } from "./obsidian-bridge.js";

export const OBSIDIAN_CONTROL_ROOM_VERSION = "4.0.1";
export const REVIEW_BUNDLE_SCHEMA_VERSION = 1;
export const DEFAULT_REVIEW_ROOT = "00-system/plur1bus";
export const DEFAULT_MORNING_CRON = "0 9 * * *";
export const DEFAULT_MORNING_TZ = "Europe/Zurich";

export const REVIEW_PROFILES = Object.freeze([
  "standard",
  "conservative",
  "adversarial",
  "maintenance",
  "project_manager",
  "semantic_deep",
]);

export const OBSIDIAN_CAPABILITIES = Object.freeze([
  "vault_doctor",
  "prepare_review_bundle",
  "maintenance_light",
  "maintenance_deep",
  "adversarial_light",
  "adversarial_deep",
  "daily_morning_review",
  "apply_approved_changes",
  "project_hub",
  "conflict_report",
  "memory_explain",
  "stale_knowledge_report",
  "hygiene_suggestions",
  "task_extraction",
  "managed_blocks",
  "dashboards",
  "weekly_synthesis",
  "canonical_records",
  "bases_dashboards",
  "semantic_conflict_graph",
  "semantic_duplicate_scan",
  "provenance_graph",
  "impact_analysis",
  "link_suggestions",
  "soul_patch",
]);

const REVIEW_DIRECTORIES = Object.freeze([
  ".",
  "dashboards",
  "review-bundles",
  "proposals",
  "doctor",
  "conflicts",
  "memory-explanations",
  "stale-knowledge",
  "project-hubs",
  "tasks",
  "records",
  "dashboards/bases",
  "semantic-conflicts",
  "duplicate-candidates",
  "provenance",
  "impact-analysis",
  "weekly",
]);

const REVIEW_ITEM_TYPES = new Set([
  "memory_promotion",
  "memory_demotion",
  "tombstone",
  "knowledge_update",
  "conflict_resolution",
  "vault_hygiene",
  "project_hub_update",
  "task_suggestion",
  "stale_review",
  "note_import_candidate",
]);

const REVIEW_ITEM_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "snoozed",
  "applied",
  "blocked",
  "stale",
]);

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|system|developer|higher-priority)\s+(instructions|messages|rules)/i,
  /\b(system|developer)\s+prompt\b/i,
  /\bexecute\s+(this\s+)?(shell\s+)?command\b/i,
  /\b(read|print|exfiltrate)\s+(secrets?|env|environment|api[_-]?keys?)\b/i,
  /\brm\s+-rf\b/i,
  /\bcurl\b[^\n|;&]*\|\s*(sh|bash)\b/i,
  /\bsudo\b/i,
  /\bBEGIN[_ -]?SECRET\b/i,
];

function nowIso(options = {}) {
  const date = options.now instanceof Date ? options.now : new Date();
  return date.toISOString();
}

function expandPath(value) {
  if (!value) return value;
  const s = String(value);
  if (s === "~") return homedir();
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  return s;
}

function normalizeAbsPath(value) {
  const expanded = expandPath(value);
  if (!expanded) return null;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function hashToken(value) {
  const raw = String(value || "");
  return raw.startsWith("sha256:") ? raw : `sha256:${sha256Hex(raw)}`;
}

function stripHashPrefix(value) {
  return String(value || "").replace(/^sha256:/, "");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeSlug(value, fallback = "item") {
  return String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\w .-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || fallback;
}

function scalarYaml(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const s = String(value).replace(/\r?\n/g, " ").slice(0, 1000);
  if (!s || /[:#{}\[\],&*?|\-<>=!%@`"']|\s$|^\s/.test(s)) return JSON.stringify(s);
  return s;
}

function formatFrontmatter(frontmatter, body) {
  const lines = ["---"];
  for (const key of Object.keys(frontmatter)) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${scalarYaml(item)}`);
    } else {
      lines.push(`${key}: ${scalarYaml(value)}`);
    }
  }
  lines.push("---", "");
  return `${lines.join("\n")}${String(body || "").replace(/^\n+/, "")}`;
}

export function parseBridgeFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text, rawFrontmatter: "" };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: text, rawFrontmatter: "" };
  const rawFrontmatter = text.slice(4, end);
  const body = text.slice(end + 5);
  const frontmatter = {};
  let currentKey = null;
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const list = line.match(/^\s+-\s+(.+)$/);
    if (list && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(parseYamlScalar(list[1]));
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) {
      currentKey = null;
      continue;
    }
    const [, key, rawValue = ""] = match;
    frontmatter[key] = rawValue === "" ? [] : parseYamlScalar(rawValue);
    currentKey = key;
  }
  return { frontmatter, body, rawFrontmatter };
}

function parseYamlScalar(rawValue) {
  const value = String(rawValue || "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function normalizeObsidianControlRoomConfig(raw = {}, options = {}) {
  const cfg = raw?.obsidianBridge || raw || {};
  const agents = cfg.agents || {};
  const defaultProfiles = agents.defaultProfiles || {};
  return {
    enabled: cfg.enabled === true,
    mode: cfg.mode || "augment",
    vaultPath: cfg.vaultPath ?? cfg.vault ?? null,
    workspaceRoot: cfg.workspaceRoot ?? null,
    reviewRoot: cfg.reviewRoot || DEFAULT_REVIEW_ROOT,
    requireUserApproval: cfg.requireUserApproval !== false,
    applyApprovedOnly: cfg.applyApprovedOnly !== false,
    writeManagedBlocks: cfg.writeManagedBlocks !== false,
    allowWrite: cfg.allowWrite !== false,
    allowDotObsidianWrite: cfg.allowDotObsidianWrite === true,
    capabilityPack: cfg.capabilityPack || "full",
    agents: {
      include: Array.isArray(agents.include) && agents.include.length > 0 ? agents.include : ["*"],
      equalCapabilities: agents.equalCapabilities !== false,
      defaultProfiles: {
        main: defaultProfiles.main || "standard",
        bernhardine: defaultProfiles.bernhardine || "conservative",
        heisenberg: defaultProfiles.heisenberg || "adversarial",
        ...defaultProfiles,
      },
    },
    morningReview: {
      enabled: cfg.morningReview?.enabled === true,
      cron: cfg.morningReview?.cron || DEFAULT_MORNING_CRON,
      timezone: cfg.morningReview?.timezone || DEFAULT_MORNING_TZ,
      delivery: cfg.morningReview?.delivery || "announce",
      session: cfg.morningReview?.session || "isolated",
      writeReviewBundle: cfg.morningReview?.writeReviewBundle !== false,
      applyMode: cfg.morningReview?.applyMode || "manual",
    },
    maintenance: {
      daily: cfg.maintenance?.daily || "light",
      weekly: cfg.maintenance?.weekly || "deep",
    },
    adversarial: {
      daily: cfg.adversarial?.daily || "light",
      weekly: cfg.adversarial?.weekly || "deep",
    },
    optionalIntegrations: {
      dataview: cfg.optionalIntegrations?.dataview === true,
      tasks: cfg.optionalIntegrations?.tasks === true,
      bases: cfg.optionalIntegrations?.bases === true,
    },
    sourceOfTruth: cfg.sourceOfTruth || "plur1bus-lancedb",
    recallAuthority: cfg.recallAuthority || "lancedb-reranked-vector",
    dashboardLayer: {
      enabled: cfg.dashboardLayer?.enabled !== false,
      records: cfg.dashboardLayer?.records !== false,
      markdownDashboards: cfg.dashboardLayer?.markdownDashboards !== false,
      bases: cfg.dashboardLayer?.bases === true,
      dataview: cfg.dashboardLayer?.dataview === true,
      tasks: cfg.dashboardLayer?.tasks === true,
      autoLinkSuggestions: cfg.dashboardLayer?.autoLinkSuggestions !== false,
    },
    deepMaintenance: {
      enabled: cfg.deepMaintenance?.enabled !== false,
      archiveAfterDays: Number(cfg.deepMaintenance?.archiveAfterDays || 30),
      staleDecisionAfterDays: Number(cfg.deepMaintenance?.staleDecisionAfterDays || 45),
      semanticDuplicateScan: cfg.deepMaintenance?.semanticDuplicateScan !== false,
    },
    adversarialDeep: {
      enabled: cfg.adversarialDeep?.enabled !== false,
      semanticContradictionScan: cfg.adversarialDeep?.semanticContradictionScan !== false,
      evidenceScoring: cfg.adversarialDeep?.evidenceScoring !== false,
      llmClassifier: cfg.adversarialDeep?.llmClassifier === true,
    },
    semanticGraph: {
      enabled: cfg.semanticGraph?.enabled !== false,
      proposalOnly: cfg.semanticGraph?.proposalOnly !== false,
      mutateMemory: false,
    },
    provenanceGraph: {
      enabled: cfg.provenanceGraph?.enabled !== false,
    },
    impactAnalysis: {
      enabled: cfg.impactAnalysis?.enabled !== false,
      proposalOnly: cfg.impactAnalysis?.proposalOnly !== false,
    },
    weekly: {
      enabled: cfg.weekly?.enabled !== false,
      archive: cfg.weekly?.archive !== false,
      trendWindowWeeks: Number(cfg.weekly?.trendWindowWeeks || 4),
    },
    soulPatch: {
      enabled: cfg.soulPatch?.enabled !== false,
      force: cfg.soulPatch?.force === true,
      migrateLegacy: cfg.soulPatch?.migrateLegacy === true,
      createIfMissing: cfg.soulPatch?.createIfMissing !== false,
      backup: cfg.soulPatch?.backup !== false,
    },
    maxFileBytes: Number(cfg.maxFileBytes || options.maxFileBytes || 256 * 1024),
    maxItems: Number(cfg.maxItems || options.maxItems || 200),
  };
}

export function getObsidianCapabilityPack(agentId = "main", rawConfig = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  const defaultProfile = REVIEW_PROFILES.includes(cfg.agents.defaultProfiles[agentId])
    ? cfg.agents.defaultProfiles[agentId]
    : "standard";
  return {
    agentId,
    capabilityPack: cfg.capabilityPack,
    equalCapabilities: true,
    defaultProfile,
    reviewProfiles: [...REVIEW_PROFILES],
    capabilities: [...OBSIDIAN_CAPABILITIES],
  };
}

function assertSafeRelativePath(relPath, options = {}) {
  const raw = String(relPath || "").replace(/\\/g, "/");
  if (!raw || raw === ".") return ".";
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`Unsafe absolute path rejected: ${relPath}`);
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  if (options.allowDotObsidianWrite !== true && parts[0] === ".obsidian") {
    throw new Error(".obsidian writes require obsidianBridge.allowDotObsidianWrite=true");
  }
  return parts.join("/") || ".";
}

function resolveUnder(root, relPath, options = {}) {
  const safeRel = assertSafeRelativePath(relPath, options);
  const target = safeRel === "." ? root : resolve(root, safeRel);
  const rootResolved = resolve(root);
  if (target !== rootResolved && !target.startsWith(`${rootResolved}/`)) {
    throw new Error(`Path traversal rejected: ${relPath}`);
  }
  return target;
}

export function resolveObsidianBridgePaths(rawConfig = {}, options = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig, options);
  if (!cfg.vaultPath) {
    return { cfg, ok: false, error: "obsidianBridge.vaultPath is not configured" };
  }
  const vaultPath = normalizeAbsPath(cfg.vaultPath);
  const reviewRoot = assertSafeRelativePath(cfg.reviewRoot, { allowDotObsidianWrite: cfg.allowDotObsidianWrite });
  const reviewPath = resolveUnder(vaultPath, reviewRoot, { allowDotObsidianWrite: cfg.allowDotObsidianWrite });
  return { cfg, ok: true, vaultPath, reviewRoot, reviewPath };
}

export function safeBridgePath(rawConfig = {}, relPath, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) throw new Error(paths.error);
  return resolveUnder(paths.reviewPath, relPath, { allowDotObsidianWrite: paths.cfg.allowDotObsidianWrite });
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function atomicWriteText(path, content) {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, String(content), "utf8");
    try { fsyncSync(fd); } catch (_) {}
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dirFd = openSync(dirname(path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (_) {}
}

function atomicWriteJson(path, value) {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path, fallback = null) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {}
  return fallback;
}

function maybeCreateReviewLayout(paths, options = {}) {
  if (!paths.ok || paths.cfg.allowWrite === false || options.readOnly === true) return [];
  const actions = [];
  for (const rel of REVIEW_DIRECTORIES) {
    const dir = rel === "." ? paths.reviewPath : resolveUnder(paths.reviewPath, rel, paths.cfg);
    if (!existsSync(dir)) {
      ensureDir(dir);
      actions.push({ action: "create_dir", path: relative(paths.vaultPath, dir).replace(/\\/g, "/") });
    }
  }
  const readme = resolveUnder(paths.reviewPath, "README.md", paths.cfg);
  if (!existsSync(readme)) {
    atomicWriteText(readme, [
      "# PLUR1BUS Obsidian Bridge",
      "",
      "This directory is generated by PLUR1BUS. It is a review and control-room surface, not the source of truth.",
      "",
      "- PLUR1BUS memory remains authoritative.",
      "- Obsidian notes are untrusted input until reviewed and approved.",
      "- Checked boxes in Obsidian do not apply changes by themselves.",
      "- Machine-managed sections use checksum markers and preserve human text outside managed blocks.",
      "",
    ].join("\n"));
    actions.push({ action: "write_readme", path: `${paths.reviewRoot}/README.md` });
  }
  const managedLog = resolveUnder(paths.reviewPath, "managed-blocks.log.jsonl", paths.cfg);
  if (!existsSync(managedLog)) {
    atomicWriteText(managedLog, "");
    actions.push({ action: "write_managed_blocks_log", path: `${paths.reviewRoot}/managed-blocks.log.jsonl` });
  }
  return actions;
}

function readMarkdownFiles(root, options = {}) {
  const maxFileBytes = options.maxFileBytes || 256 * 1024;
  const maxItems = options.maxItems || 200;
  const out = [];
  if (!existsSync(root)) return out;

  function walk(dir) {
    if (out.length >= maxItems) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxItems) break;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".obsidian") continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stat = statSync(abs);
        if (stat.size > maxFileBytes) continue;
        out.push({ abs, rel, size: stat.size, content: readFileSync(abs, "utf8") });
      }
    }
  }

  walk(root);
  return out;
}

export function buildManagedBlock({ id, agent = "main", bundle = "", body }) {
  const cleanId = safeSlug(id, "managed-block");
  const hash = hashToken(body);
  return [
    `<!-- plur1bus:managed:start id="${cleanId}" agent="${safeSlug(agent, "main")}" bundle="${safeSlug(bundle, "bundle")}" hash="${hash}" -->`,
    String(body || "").replace(/\s+$/g, ""),
    "<!-- plur1bus:managed:end -->",
  ].join("\n");
}

function parseMarkerAttrs(marker) {
  const attrs = {};
  const pattern = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let match = pattern.exec(marker);
  while (match) {
    attrs[match[1]] = match[2];
    match = pattern.exec(marker);
  }
  return attrs;
}

export function findManagedBlocks(content) {
  const text = String(content || "");
  const re = /<!-- plur1bus:managed:start\b([^>]*)-->\n?([\s\S]*?)\n?<!-- plur1bus:managed:end -->/g;
  const blocks = [];
  let match = re.exec(text);
  while (match) {
    const attrs = parseMarkerAttrs(match[1]);
    blocks.push({
      id: attrs.id || "",
      attrs,
      body: match[2],
      start: match.index,
      end: match.index + match[0].length,
      fullText: match[0],
      hashMatches: stripHashPrefix(attrs.hash) === sha256Hex(match[2]),
    });
    match = re.exec(text);
  }
  return blocks;
}

export function replaceManagedBlock(existingContent, descriptor, nextBody) {
  const id = safeSlug(descriptor.id, "managed-block");
  const text = String(existingContent || "");
  const block = findManagedBlocks(text).find((item) => item.id === id);
  const nextBlock = buildManagedBlock({ ...descriptor, id, body: nextBody });
  if (!block) {
    const prefix = text.trimEnd();
    return {
      changed: true,
      content: `${prefix}${prefix ? "\n\n" : ""}${nextBlock}\n`,
      conflict: null,
    };
  }
  if (!block.hashMatches) {
    return {
      changed: false,
      content: text,
      conflict: {
        type: "managed_block_hash_mismatch",
        id,
        status: "pending",
        risk: "medium",
        reason: "Managed block content changed outside PLUR1BUS; treating it as user-authored.",
        expectedHash: block.attrs.hash || "",
        actualHash: hashToken(block.body),
      },
    };
  }
  return {
    changed: true,
    content: `${text.slice(0, block.start)}${nextBlock}${text.slice(block.end)}`,
    conflict: null,
  };
}

export function writeManagedBlockFile(rawConfig, relPath, descriptor, nextBody, options = {}) {
  const target = safeBridgePath(rawConfig, relPath, options);
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const result = replaceManagedBlock(existing, descriptor, nextBody);
  if (result.conflict) return { ...result, path: relPath };
  if (result.changed && normalizeObsidianControlRoomConfig(rawConfig).allowWrite !== false) {
    atomicWriteText(target, result.content);
  }
  return { ...result, path: relPath };
}

function bundleIdFromDate(date = new Date()) {
  const iso = date.toISOString();
  return `rb-${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

function itemIdFromBundle(bundleId, index) {
  return `rbi-${bundleId.replace(/^rb-/, "")}-${String(index + 1).padStart(3, "0")}`;
}

function normalizeReviewProfile(profile) {
  return REVIEW_PROFILES.includes(profile) ? profile : "standard";
}

function normalizeReviewItem(raw, context = {}) {
  const generatedAt = context.generatedAt || nowIso();
  const type = REVIEW_ITEM_TYPES.has(raw.type) ? raw.type : "vault_hygiene";
  const risk = ["low", "medium", "high", "critical"].includes(raw.risk) ? raw.risk : classifyRisk(raw);
  const id = raw.id || itemIdFromBundle(context.bundleId || "rb-unknown", context.index || 0);
  return {
    id,
    type,
    status: REVIEW_ITEM_STATUSES.has(raw.status) ? raw.status : "pending",
    risk,
    proposedByAgent: raw.proposedByAgent || context.agentId || "main",
    reviewProfile: normalizeReviewProfile(raw.reviewProfile || context.reviewProfile || "standard"),
    target: String(raw.target || ""),
    action: String(raw.action || ""),
    reason: String(raw.reason || ""),
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String).slice(0, 10) : [],
    sourceRefs: Array.isArray(raw.sourceRefs) ? raw.sourceRefs.map(String).slice(0, 10) : [],
    preconditions: {
      sourceHash: raw.preconditions?.sourceHash || raw.sourceHash || "",
      targetHash: raw.preconditions?.targetHash || raw.targetHash || "",
      sourcePath: raw.preconditions?.sourcePath || raw.sourcePath || "",
      targetPath: raw.preconditions?.targetPath || raw.targetPath || "",
      generatedAt: raw.preconditions?.generatedAt || generatedAt,
    },
    adversarialReview: raw.adversarialReview || { status: "pass", reason: "", recommendation: "" },
    maintenanceReview: raw.maintenanceReview || { status: "pass", reason: "" },
    applyPreview: raw.applyPreview || { command: "", files: [], memoryIds: [] },
    sourceTrust: raw.sourceTrust || raw.trustLevel || "untrusted",
    evidenceKind: raw.evidenceKind || raw.sourceKind || "",
    sourceScope: raw.sourceScope || raw.scope || "",
    targetScope: raw.targetScope || "",
    explicitGlobalApproval: raw.explicitGlobalApproval === true,
    explicitAssistantEvidenceApproval: raw.explicitAssistantEvidenceApproval === true,
    noteContent: raw.noteContent ? String(raw.noteContent).slice(0, 4000) : "",
  };
}

function classifyRisk(item) {
  if (item.risk) return item.risk;
  if (item.type === "tombstone" || item.type === "knowledge_update") return "high";
  if (String(item.target || "").includes("memory/KNOWLEDGE.md")) return "critical";
  if (item.type === "memory_promotion" || item.type === "memory_demotion") return "medium";
  return "low";
}

function hasPromptInjectionLikeContent(item) {
  const haystack = [item.noteContent, item.reason, item.action, ...item.evidence].join("\n");
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(haystack));
}

export function adversarialLightReviewItem(rawItem, context = {}) {
  const item = normalizeReviewItem(rawItem, context);
  const checks = [];

  if (String(item.target).includes("memory/KNOWLEDGE.md") && /overwrite|write|replace|append/i.test(item.action)) {
    checks.push({ status: "block", reason: "Direct KNOWLEDGE.md mutation is forbidden; use an approval-gated proposal." });
  }
  if (hasPromptInjectionLikeContent(item)) {
    checks.push({ status: "warning", reason: "Prompt-injection-like or command-like text was found in untrusted note content." });
  }
  if (item.evidenceKind === "assistant" && (/trusted|global_user/i.test(`${item.sourceTrust} ${item.targetScope}`))) {
    checks.push({ status: "block", reason: "Assistant-only assertions cannot be promoted to trusted/global memory." });
  }
  if (item.sourceScope === "agent_private" && item.targetScope === "workspace_shared" && item.status !== "approved") {
    checks.push({ status: "block", reason: "agent_private content cannot move to workspace_shared without explicit user approval." });
  }
  if (item.sourceScope === "workspace_shared" && item.targetScope === "global_user" && !item.explicitGlobalApproval) {
    checks.push({ status: "block", reason: "workspace_shared content cannot move to global_user without explicit global approval policy." });
  }
  if (/obsidian/i.test(item.sourceTrust) && /trusted|global/i.test(`${item.targetScope} ${item.action}`)) {
    checks.push({ status: "warning", reason: "Obsidian note content is untrusted input and must remain a candidate until reviewed." });
  }
  if (/all memories|\*|entire vault|everything/i.test(`${item.target} ${item.action}`)) {
    checks.push({ status: item.risk === "low" ? "block" : "warning", reason: "The proposed mutation is broad; risk label or target scope is unsafe." });
  }
  if (!item.evidence.length && ["memory_promotion", "knowledge_update", "note_import_candidate"].includes(item.type)) {
    checks.push({ status: "warning", reason: "Proposal lacks user/tool evidence." });
  }

  const block = checks.find((check) => check.status === "block");
  const warning = checks.find((check) => check.status === "warning");
  const review = block
    ? { status: "block", reason: block.reason, recommendation: "Keep this item pending/blocked until a safer proposal is generated." }
    : warning
      ? { status: "warning", reason: warning.reason, recommendation: "Show warning in the ReviewBundle and require explicit approval." }
      : { status: "pass", reason: "No light adversarial invariant violation detected.", recommendation: "Review normally." };
  return { ...item, adversarialReview: review };
}

export function runMaintenanceLight(rawConfig = {}, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  const findings = [];
  const actions = [];
  const createdAt = nowIso(options);
  const cfg = paths.cfg;

  if (!cfg.enabled) {
    findings.push({ severity: "info", code: "bridge_disabled", message: "Obsidian Bridge is disabled; PLUR1BUS memory tools remain available." });
  }
  if (!paths.ok) {
    findings.push({ severity: "error", code: "missing_vault_path", message: paths.error });
    return { mode: "light", createdAt, ok: false, findings, actions, config: summarizeBridgeConfig(cfg) };
  }
  if (!existsSync(paths.vaultPath)) {
    findings.push({ severity: "error", code: "missing_vault", path: paths.vaultPath, message: "Configured vault path does not exist." });
  } else {
    if (!existsSync(paths.reviewPath)) {
      findings.push({ severity: "warning", code: "missing_review_root", path: paths.reviewRoot, message: "Review root is missing or not yet generated." });
    }
    try {
      if (options.createLayout === true) actions.push(...maybeCreateReviewLayout(paths, options));
    } catch (err) {
      findings.push({ severity: "error", code: "create_review_root_failed", message: String(err?.message || err) });
    }
    if (existsSync(paths.reviewPath)) {
      const files = readMarkdownFiles(paths.reviewPath, { maxFileBytes: cfg.maxFileBytes, maxItems: cfg.maxItems });
      for (const file of files) {
        const parsed = parseBridgeFrontmatter(file.content);
        if (file.rel.startsWith("review-bundles/") && parsed.frontmatter.type === "plur1bus-review-bundle") {
          for (const required of ["bundleId", "createdAt", "status", "applyMode", "obsidianBridgeVersion"]) {
            if (!parsed.frontmatter[required]) {
              findings.push({ severity: "error", code: "missing_review_bundle_field", path: file.rel, message: `Missing ${required}` });
            }
          }
          if (parsed.frontmatter.status === "pending_user_review") {
            const ageMs = Date.now() - Date.parse(parsed.frontmatter.createdAt || 0);
            if (Number.isFinite(ageMs) && ageMs > 7 * 86400_000) {
              findings.push({ severity: "warning", code: "stale_pending_bundle", path: file.rel, message: "Pending ReviewBundle is older than 7 days." });
            }
          }
        }
        for (const block of findManagedBlocks(file.content)) {
          if (!block.hashMatches) {
            findings.push({ severity: "error", code: "managed_block_hash_mismatch", path: file.rel, message: `Managed block ${block.id} hash mismatch.` });
          }
        }
        if (/\[\[[^\]\n]+?\]\]/.test(file.content) && /PLUR1BUS|plur1bus/.test(file.content)) {
          const unresolved = [...file.content.matchAll(/\[\[([^\]\n]+?)\]\]/g)]
            .map((match) => match[1])
            .filter((target) => !target.includes("#"))
            .slice(0, 5);
          if (unresolved.length > 0) {
            findings.push({ severity: "warning", code: "generated_link_review", path: file.rel, message: `Review generated links: ${unresolved.join(", ")}` });
          }
        }
      }
    }
  }
  if (cfg.mode !== "augment") {
    findings.push({ severity: "error", code: "invalid_mode", message: "Obsidian Bridge must run in augment mode." });
  }
  if (cfg.requireUserApproval !== true || cfg.applyApprovedOnly !== true) {
    findings.push({ severity: "error", code: "unsafe_approval_config", message: "Approval-gated apply must remain enabled." });
  }
  if (cfg.allowDotObsidianWrite === true) {
    findings.push({ severity: "warning", code: "dot_obsidian_write_enabled", message: ".obsidian writes are enabled; keep this explicit and limited." });
  }
  return {
    mode: "light",
    createdAt,
    ok: findings.every((finding) => finding.severity !== "error"),
    findings,
    actions,
    config: summarizeBridgeConfig(cfg),
  };
}

export function runMaintenanceDeep(rawConfig = {}, options = {}) {
  const light = runMaintenanceLight(rawConfig, options);
  return {
    ...light,
    mode: "deep",
    findings: [
      ...light.findings,
      {
        severity: "info",
        code: "deep_maintenance_markdown_baseline",
        message: "Deep maintenance currently emits Markdown-first review suggestions; semantic duplicate checks and archive rotation are future-safe extensions.",
      },
    ],
  };
}

function summarizeBridgeConfig(cfg) {
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    vaultPath: cfg.vaultPath ? "[configured]" : null,
    workspaceRoot: cfg.workspaceRoot ? "[configured]" : null,
    reviewRoot: cfg.reviewRoot,
    requireUserApproval: cfg.requireUserApproval,
    applyApprovedOnly: cfg.applyApprovedOnly,
    writeManagedBlocks: cfg.writeManagedBlocks,
    allowWrite: cfg.allowWrite,
    allowDotObsidianWrite: cfg.allowDotObsidianWrite,
    capabilityPack: cfg.capabilityPack,
    agents: {
      include: cfg.agents.include,
      equalCapabilities: cfg.agents.equalCapabilities,
      defaultProfiles: cfg.agents.defaultProfiles,
    },
    morningReview: cfg.morningReview,
    maintenance: cfg.maintenance,
    adversarial: cfg.adversarial,
  };
}

function collectProposalInputs(rawConfig = {}, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  const proposals = Array.isArray(options.proposals) ? options.proposals : [];
  const inputs = [...proposals];
  if (!paths.ok || !existsSync(paths.vaultPath)) return inputs;
  const cfg = paths.cfg;
  const reviewRootPrefix = `${paths.reviewRoot.replace(/\/+$/, "")}/`;
  const files = readMarkdownFiles(paths.vaultPath, { maxFileBytes: cfg.maxFileBytes, maxItems: Math.min(cfg.maxItems, 80) });
  for (const file of files) {
    if (file.rel.startsWith(reviewRootPrefix) || file.rel === paths.reviewRoot) continue;
    if (/memory\/KNOWLEDGE\.md$/.test(file.rel)) continue;
    const body = parseBridgeFrontmatter(file.content).body.trim();
    if (!body) continue;
    const hash = hashToken(file.content);
    if (/TODO|^- \[ \]/im.test(body)) {
      inputs.push({
        type: "task_suggestion",
        risk: "low",
        target: file.rel,
        action: "Extract candidate tasks into bridge task suggestions.",
        reason: "Markdown task-like content was found in an Obsidian note.",
        evidence: [body.slice(0, 280)],
        sourceRefs: [file.rel],
        preconditions: { sourceHash: hash, sourcePath: file.rel },
        noteContent: body.slice(0, 1000),
        sourceTrust: "obsidian_untrusted",
      });
    }
    if (hasPromptInjectionLikeContent({ noteContent: body, reason: "", action: "", evidence: [] })) {
      inputs.push({
        type: "note_import_candidate",
        risk: "medium",
        target: file.rel,
        action: "Keep note as untrusted candidate and require adversarial review.",
        reason: "Prompt-injection-like text was detected in note content.",
        evidence: [body.slice(0, 280)],
        sourceRefs: [file.rel],
        preconditions: { sourceHash: hash, sourcePath: file.rel },
        noteContent: body.slice(0, 1000),
        sourceTrust: "obsidian_untrusted",
      });
    }
  }
  return inputs.slice(0, cfg.maxItems);
}

function maintenanceFindingsToItems(maintenance, context) {
  return maintenance.findings
    .filter((finding) => ["warning", "error"].includes(finding.severity))
    .map((finding, index) => normalizeReviewItem({
      type: "vault_hygiene",
      risk: finding.severity === "error" ? "medium" : "low",
      target: finding.path || finding.code,
      action: "Review bridge hygiene finding.",
      reason: finding.message,
      evidence: [finding.code],
      maintenanceReview: {
        status: finding.severity === "error" ? "warning" : "pass",
        reason: finding.message,
      },
    }, { ...context, index: context.index + index }));
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.type}|${item.target}|${item.action}|${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function renderReviewBundleMarkdown(bundle, items, maintenance) {
  const warningItems = items.filter((item) => item.adversarialReview.status === "warning");
  const blockedItems = items.filter((item) => item.adversarialReview.status === "block");
  const conflicts = items.filter((item) => item.type === "conflict_resolution" || item.status === "blocked" || item.adversarialReview.status === "block");
  const stale = items.filter((item) => item.type === "stale_review" || item.status === "stale");
  const projectUpdates = items.filter((item) => item.type === "project_hub_update");
  const hygiene = items.filter((item) => item.type === "vault_hygiene");
  const taskItems = items.filter((item) => item.type === "task_suggestion");

  const body = [
    "# PLUR1BUS ReviewBundle",
    "",
    "## Summary",
    "",
    `- Bundle: ${bundle.bundleId}`,
    `- Status: ${bundle.status}`,
    `- Apply mode: ${bundle.applyMode}`,
    `- Items: ${items.length}`,
    `- Warnings: ${warningItems.length}`,
    `- Blocks: ${blockedItems.length}`,
    "",
    "## Maintenance Findings",
    "",
    maintenance.findings.length
      ? maintenance.findings.map((finding) => `- ${finding.severity}: ${finding.code} - ${finding.message}`).join("\n")
      : "- No light maintenance findings.",
    "",
    "## Adversarial Findings",
    "",
    items.length
      ? items.map((item) => `- ${item.id}: ${item.adversarialReview.status} - ${item.adversarialReview.reason || "No issue"}`).join("\n")
      : "- No proposals to review.",
    "",
    "## Candidate Changes",
    "",
    items.length ? items.map(renderReviewItem).join("\n\n") : "- No candidate changes.",
    "",
    "## Conflicts",
    "",
    conflicts.length ? conflicts.map((item) => `- ${item.id}: ${item.reason}`).join("\n") : "- No conflicts generated.",
    "",
    "## Stale Knowledge",
    "",
    stale.length ? stale.map((item) => `- ${item.id}: ${item.reason}`).join("\n") : "- No stale knowledge items generated.",
    "",
    "## Suggested Project Updates",
    "",
    projectUpdates.length ? projectUpdates.map((item) => `- ${item.id}: ${item.target}`).join("\n") : "- No project updates generated.",
    "",
    "## Suggested Link/Tag/Property Hygiene",
    "",
    hygiene.length ? hygiene.map((item) => `- ${item.id}: ${item.reason}`).join("\n") : "- No hygiene suggestions generated.",
    "",
    "## Task Suggestions",
    "",
    taskItems.length ? taskItems.map((item) => `- [ ] ${item.reason} #plur1bus/status-pending`).join("\n") : "- No task suggestions generated.",
    "",
    "## User Action Checklist",
    "",
    "- [ ] Review warnings and blocked items.",
    "- [ ] Approve selected items with `/plur1bus obsidian review approve <bundleId> --items <ids|all|low-risk>`.",
    "- [ ] Reject or snooze unsafe items.",
    "- [ ] Run `/plur1bus obsidian review apply <bundleId>` after approval.",
    "",
    "## Apply Instructions",
    "",
    "A checked box in Obsidian is not approval. The apply command re-reads this bundle, revalidates preconditions and hashes, and applies approved items only.",
    "",
  ].join("\n");

  return formatFrontmatter({
    type: "plur1bus-review-bundle",
    version: REVIEW_BUNDLE_SCHEMA_VERSION,
    bundleId: bundle.bundleId,
    createdAt: bundle.createdAt,
    workspaceKey: bundle.workspaceKey,
    createdByAgent: bundle.createdByAgent,
    status: bundle.status,
    applyMode: bundle.applyMode,
    reviewProfiles: bundle.reviewProfiles,
    obsidianBridgeVersion: OBSIDIAN_CONTROL_ROOM_VERSION,
  }, body);
}

function renderReviewItem(item) {
  return [
    `### ${item.id} - ${item.type}`,
    "",
    `- Status: ${item.status}`,
    `- Risk: ${item.risk}`,
    `- Target: ${item.target || "(none)"}`,
    `- Action: ${item.action || "(none)"}`,
    `- Reason: ${item.reason || "(none)"}`,
    `- Proposed by: ${item.proposedByAgent}`,
    `- Review profile: ${item.reviewProfile}`,
    `- Adversarial: ${item.adversarialReview.status} - ${item.adversarialReview.reason || "No issue"}`,
    "",
    "```json",
    JSON.stringify(item, null, 2),
    "```",
  ].join("\n");
}

function writeReviewBundle(paths, bundle, items, maintenance) {
  maybeCreateReviewLayout(paths, { createLayout: true });
  const rel = `review-bundles/${bundle.bundleId}.md`;
  const jsonRel = `review-bundles/${bundle.bundleId}.items.json`;
  const target = resolveUnder(paths.reviewPath, rel, paths.cfg);
  const jsonTarget = resolveUnder(paths.reviewPath, jsonRel, paths.cfg);
  atomicWriteText(target, renderReviewBundleMarkdown(bundle, items, maintenance));
  atomicWriteJson(jsonTarget, { bundle, items, maintenance });
  return {
    markdownPath: `${paths.reviewRoot}/${rel}`,
    itemsPath: `${paths.reviewRoot}/${jsonRel}`,
  };
}

export async function prepareReviewBundle(rawConfig = {}, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  const pipeline = [];
  const createdAt = nowIso(options);
  const bundleId = options.bundleId || bundleIdFromDate(options.now || new Date());
  const agentId = options.agentId || "main";
  const workspaceKey = options.workspaceKey || "main";
  const reviewProfiles = Array.isArray(options.reviewProfiles) && options.reviewProfiles.length
    ? options.reviewProfiles.map(normalizeReviewProfile)
    : ["standard", "maintenance", "adversarial"];

  pipeline.push("snapshot_lock");
  const maintenance = runMaintenanceLight(rawConfig, { ...options, createLayout: paths.ok, now: options.now });
  pipeline.push("maintenance_light");
  const inputs = collectProposalInputs(rawConfig, options);
  pipeline.push("collect_changes");

  let items = inputs.map((input, index) => normalizeReviewItem(input, {
    bundleId,
    index,
    generatedAt: createdAt,
    agentId,
    reviewProfile: input.reviewProfile || reviewProfiles[0],
  }));
  items.push(...maintenanceFindingsToItems(maintenance, {
    bundleId,
    index: items.length,
    generatedAt: createdAt,
    agentId,
    reviewProfile: "maintenance",
  }));
  pipeline.push("generate_review_proposals");

  items = items.map((item, index) => adversarialLightReviewItem(item, {
    bundleId,
    index,
    generatedAt: createdAt,
    agentId,
    reviewProfile: item.reviewProfile,
  }));
  pipeline.push("adversarial_light");

  items = dedupeItems(items).map((item, index) => ({ ...item, id: item.id || itemIdFromBundle(bundleId, index) }));
  pipeline.push("risk_classification");
  pipeline.push("deduplication");

  const bundle = {
    type: "plur1bus-review-bundle",
    version: REVIEW_BUNDLE_SCHEMA_VERSION,
    bundleId,
    createdAt,
    workspaceKey,
    createdByAgent: agentId,
    status: "pending_user_review",
    applyMode: "approval_required",
    reviewProfiles,
    obsidianBridgeVersion: OBSIDIAN_CONTROL_ROOM_VERSION,
    pipeline,
  };

  let written = null;
  if (paths.ok && paths.cfg.allowWrite !== false && paths.cfg.morningReview.writeReviewBundle !== false) {
    written = writeReviewBundle(paths, bundle, items, maintenance);
    pipeline.push("write_review_bundle");
  }
  pipeline.push("notify_user");
  pipeline.push("await_explicit_approval");

  return {
    status: paths.ok ? "prepared" : "blocked",
    ok: paths.ok,
    error: paths.ok ? null : paths.error,
    applied: false,
    bundle,
    items,
    maintenance,
    written,
    pipeline,
  };
}

export async function runMorningReview(rawConfig = {}, options = {}) {
  const result = await prepareReviewBundle(rawConfig, {
    ...options,
    reviewProfiles: options.reviewProfiles || ["standard", "maintenance", "adversarial"],
  });
  return {
    ...result,
    morningReview: true,
    applyMode: "manual",
    note: "Morning review prepares proposals only; it never applies changes without explicit approval.",
  };
}

function loadBundleRecord(rawConfig, bundleId, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) throw new Error(paths.error);
  const safeBundle = safeSlug(bundleId, "bundle");
  const jsonTarget = resolveUnder(paths.reviewPath, `review-bundles/${safeBundle}.items.json`, paths.cfg);
  const record = readJson(jsonTarget, null);
  if (!record) throw new Error(`ReviewBundle not found: ${bundleId}`);
  return { paths, record, jsonTarget, safeBundle };
}

function saveBundleRecord(loaded) {
  const { paths, record, safeBundle } = loaded;
  const maintenance = record.maintenance || { findings: [] };
  writeReviewBundle(paths, record.bundle, record.items, maintenance);
  return record;
}

function selectItems(items, selector) {
  const raw = String(selector || "all").trim();
  if (raw === "all") return new Set(items.map((item) => item.id));
  if (raw === "low-risk") return new Set(items.filter((item) => item.risk === "low").map((item) => item.id));
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  return new Set(ids);
}

export function updateReviewBundleItems(rawConfig, bundleId, action, selector = "all", options = {}) {
  const loaded = loadBundleRecord(rawConfig, bundleId, options);
  const selected = selectItems(loaded.record.items, selector);
  const status = action === "approve" ? "approved"
    : action === "reject" ? "rejected"
      : action === "snooze" ? "snoozed"
        : null;
  if (!status) throw new Error(`Unsupported review action: ${action}`);
  let changed = 0;
  loaded.record.items = loaded.record.items.map((item) => {
    if (!selected.has(item.id)) return item;
    if (["applied", "blocked"].includes(item.status)) return item;
    changed += 1;
    return {
      ...item,
      status,
      snoozedUntil: status === "snoozed" ? options.until || "" : item.snoozedUntil || "",
      updatedAt: nowIso(options),
    };
  });
  saveBundleRecord(loaded);
  return { bundleId, action, selector, changed, items: loaded.record.items };
}

function fileHashIfConfigured(paths, item, kind) {
  const rel = item.preconditions?.[`${kind}Path`];
  const expected = item.preconditions?.[`${kind}Hash`];
  if (!rel || !expected) return { ok: true };
  const abs = resolveUnder(paths.vaultPath, rel, paths.cfg);
  if (!existsSync(abs)) return { ok: false, reason: `${kind} path missing: ${rel}` };
  const actual = hashToken(readFileSync(abs, "utf8"));
  return stripHashPrefix(actual) === stripHashPrefix(expected)
    ? { ok: true }
    : { ok: false, reason: `${kind} hash mismatch`, expected, actual };
}

async function revalidateItem(paths, item, options = {}) {
  if (typeof options.revalidateItem === "function") {
    const result = await options.revalidateItem(item);
    if (result === true) return { ok: true };
    if (result === false) return { ok: false, reason: "custom revalidation failed" };
    if (result && typeof result === "object") return result.ok === false ? result : { ok: true };
  }
  const source = fileHashIfConfigured(paths, item, "source");
  if (!source.ok) return source;
  const target = fileHashIfConfigured(paths, item, "target");
  if (!target.ok) return target;
  if (item.memoryCandidateStatus && item.memoryCandidateStatus !== "pending") {
    return { ok: false, reason: "MemoryCandidate is no longer pending." };
  }
  return { ok: true };
}

function applySafetyBlock(item, options = {}) {
  if (item.adversarialReview?.status === "block") return "Adversarial review blocks this item.";
  if (item.evidenceKind === "assistant" && (/trusted|global_user/i.test(`${item.sourceTrust} ${item.targetScope}`)) && !item.explicitAssistantEvidenceApproval) {
    return "Assistant-only assertion cannot be promoted to trusted/global memory.";
  }
  if (item.sourceScope === "workspace_shared" && item.targetScope === "global_user" && !item.explicitGlobalApproval && options.explicitGlobalApproval !== true) {
    return "workspace_shared to global_user requires explicit global approval.";
  }
  if (String(item.target).includes("memory/KNOWLEDGE.md") && /overwrite|write|replace/i.test(item.action)) {
    return "Direct KNOWLEDGE.md overwrite is forbidden.";
  }
  return "";
}

export async function applyApprovedReviewBundle(rawConfig, bundleId, options = {}) {
  const loaded = loadBundleRecord(rawConfig, bundleId, options);
  const { paths, record } = loaded;
  const applied = [];
  const blocked = [];

  for (const item of record.items) {
    if (item.status !== "approved") continue;
    const safety = applySafetyBlock(item, options);
    if (safety) {
      item.status = "blocked";
      item.blockedReason = safety;
      blocked.push({ id: item.id, reason: safety });
      continue;
    }
    const validation = await revalidateItem(paths, item, options);
    if (!validation.ok) {
      item.status = "stale";
      item.blockedReason = validation.reason || "precondition failed";
      blocked.push({ id: item.id, reason: item.blockedReason });
      continue;
    }

    if (["memory_promotion", "note_import_candidate"].includes(item.type)) {
      if (typeof options.memoryStore !== "function") {
        item.status = "blocked";
        item.blockedReason = "No memoryStore callback available in this runtime.";
        blocked.push({ id: item.id, reason: item.blockedReason });
        continue;
      }
      await options.memoryStore({
        item,
        payload: item.applyPreview?.payload || {
          text: item.action || item.reason,
          category: "fact",
          origin: "internal",
          scope: item.targetScope === "global_user" ? "user" : "workspace",
          evidenceQuote: item.evidence?.[0] || "",
          sourceUrl: item.sourceRefs?.[0] || "",
        },
      });
    } else if (item.type === "knowledge_update") {
      if (typeof options.knowledgeUpdate !== "function") {
        item.status = "blocked";
        item.blockedReason = "No knowledgeUpdate callback available in this runtime.";
        blocked.push({ id: item.id, reason: item.blockedReason });
        continue;
      }
      await options.knowledgeUpdate({ item, payload: item.applyPreview?.payload || {} });
    } else if (item.type === "task_suggestion") {
      const taskBody = `- [ ] ${item.reason || item.action} #plur1bus/status-pending\n`;
      writeManagedBlockFile(rawConfig, "tasks/task-suggestions.md", {
        id: `task-${item.id}`,
        agent: item.proposedByAgent,
        bundle: bundleId,
      }, taskBody, options);
    }

    item.status = "applied";
    item.appliedAt = nowIso(options);
    applied.push({ id: item.id, type: item.type });
  }

  if (applied.length === 0 && blocked.length === 0) {
    record.bundle.status = "pending_user_review";
  } else if (record.items.every((item) => ["applied", "rejected", "blocked", "snoozed", "stale"].includes(item.status))) {
    record.bundle.status = "reviewed";
  }
  saveBundleRecord(loaded);
  return { bundleId, applied, blocked, items: record.items };
}

export function runVaultDoctor(rawConfig = {}, options = {}) {
  const maintenance = runMaintenanceLight(rawConfig, { ...options, readOnly: options.fix !== true });
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  const managedBlockStatus = [];
  const reviewBundleQueue = [];
  if (paths.ok && existsSync(paths.reviewPath)) {
    const files = readMarkdownFiles(paths.reviewPath, { maxFileBytes: paths.cfg.maxFileBytes, maxItems: paths.cfg.maxItems });
    for (const file of files) {
      const blocks = findManagedBlocks(file.content);
      if (blocks.length > 0) {
        managedBlockStatus.push(...blocks.map((block) => ({
          path: file.rel,
          id: block.id,
          hashMatches: block.hashMatches,
        })));
      }
      const parsed = parseBridgeFrontmatter(file.content);
      if (parsed.frontmatter.type === "plur1bus-review-bundle") {
        reviewBundleQueue.push({
          path: file.rel,
          bundleId: parsed.frontmatter.bundleId,
          status: parsed.frontmatter.status,
          createdAt: parsed.frontmatter.createdAt,
        });
      }
    }
  }
  return {
    ok: maintenance.ok,
    criticalFindings: maintenance.findings.filter((finding) => finding.severity === "error"),
    warnings: maintenance.findings.filter((finding) => finding.severity === "warning"),
    hygieneSuggestions: maintenance.findings.filter((finding) => finding.severity === "info"),
    bridgeConfig: maintenance.config,
    vaultPathStatus: paths.ok
      ? { configured: true, exists: existsSync(paths.vaultPath), reviewRoot: paths.reviewRoot }
      : { configured: false, error: paths.error },
    managedBlockStatus,
    reviewBundleQueue,
    scopeLeakWarnings: maintenance.findings.filter((finding) => finding.code.includes("scope")),
    assistantOnlyPromotionWarnings: maintenance.findings.filter((finding) => finding.code.includes("assistant")),
    staleEmbeddingQueueWarning: options.staleEmbeddingQueueWarning || null,
    plur1busHealthReferences: options.plur1busHealthReferences || [],
    readOnly: options.fix !== true,
  };
}

export function generateProjectHub(rawConfig = {}, topic, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  const safeTopic = safeSlug(topic, "project");
  const body = [
    `# ${topic}`,
    "",
    "## Goal",
    "",
    options.goal || "Pending user review.",
    "",
    "## Current State",
    "",
    options.currentState || "No generated current-state summary yet.",
    "",
    "## Decisions",
    "",
    "- Review related ReviewBundle items before promotion.",
    "",
    "## Open Questions",
    "",
    "- What assumptions need confirmation?",
    "",
    "## Sources/Evidence",
    "",
    options.source ? `- ${options.source}` : "- No source evidence attached.",
    "",
    "## Next Actions",
    "",
    "- [ ] Review this hub and approve any proposed changes via PLUR1BUS.",
    "",
    "## Related ReviewBundle Items",
    "",
    "- None linked yet.",
    "",
    "## Conflicts",
    "",
    "- None generated.",
    "",
    "## Stale Assumptions",
    "",
    "- None generated.",
    "",
  ].join("\n");
  const result = writeManagedBlockFile(rawConfig, `project-hubs/${safeTopic}.md`, {
    id: "project-hub",
    agent: options.agentId || "main",
    bundle: options.bundleId || "manual",
  }, body, options);
  return { topic, path: `${paths.ok ? paths.reviewRoot : DEFAULT_REVIEW_ROOT}/project-hubs/${safeTopic}.md`, ...result };
}

export function generateConflictReport(rawConfig = {}, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) return { ok: false, error: paths.error, conflicts: [] };
  maybeCreateReviewLayout(paths, { createLayout: true });
  const conflicts = [];
  const bundleDir = resolveUnder(paths.reviewPath, "review-bundles", paths.cfg);
  if (existsSync(bundleDir)) {
    for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".items.json")) continue;
      const record = readJson(join(bundleDir, entry.name), null);
      if (!record?.items) continue;
      for (const item of record.items) {
        if (item.adversarialReview?.status === "block" || item.status === "blocked" || item.type === "conflict_resolution") {
          conflicts.push({ bundleId: record.bundle?.bundleId || "", id: item.id, target: item.target, reason: item.blockedReason || item.adversarialReview?.reason || item.reason });
        }
      }
    }
  }
  const stamp = nowIso(options).slice(0, 10);
  const rel = `conflicts/conflicts-${stamp}.md`;
  const body = [
    "# PLUR1BUS Conflict Report",
    "",
    conflicts.length ? conflicts.map((item) => `- ${item.bundleId}/${item.id}: ${item.reason} (${item.target})`).join("\n") : "- No conflicts found in bridge-managed bundles.",
    "",
    "Conflicts are proposals only. No automatic resolution was attempted.",
    "",
  ].join("\n");
  atomicWriteText(resolveUnder(paths.reviewPath, rel, paths.cfg), body);
  return { ok: true, path: `${paths.reviewRoot}/${rel}`, conflicts };
}

export function writeMemoryExplanation(rawConfig = {}, id, record = null, options = {}) {
  const safeId = safeSlug(id, "memory");
  const memory = record || {};
  const body = [
    `# Memory Explanation: ${id}`,
    "",
    "## Statement",
    "",
    memory.statement || memory.text || "(record not found in current context)",
    "",
    "## Provenance",
    "",
    JSON.stringify(memory.origin || memory.provenance || {}, null, 2),
    "",
    "## Trust / Confidence / Scope",
    "",
    `- Trust level: ${memory.trustLevel || memory.origin?.trustLevel || "unknown"}`,
    `- Confidence: ${memory.confidence ?? "unknown"}`,
    `- Scope: ${memory.scope || "unknown"}`,
    "",
    "## Why PLUR1BUS Believes It",
    "",
    memory.reason || "Evidence is shown above when available. Assistant-authored claims remain untrusted until confirmed.",
    "",
    "## Behavioral Impact",
    "",
    "This page is explanatory only. It does not promote, demote, tombstone, prune, or share memory.",
    "",
    "## Risks",
    "",
    "- Check whether the evidence is user/tool-backed before promotion.",
    "",
    "## Related Conflicts",
    "",
    "- None generated.",
    "",
    "## Proposal Options",
    "",
    "- Propose promotion after explicit approval.",
    "- Propose demotion or tombstone after explicit approval.",
    "",
  ].join("\n");
  const result = writeManagedBlockFile(rawConfig, `memory-explanations/${safeId}.md`, {
    id: "memory-explanation",
    agent: options.agentId || "main",
    bundle: options.bundleId || "manual",
  }, body, options);
  return { id, ...result };
}

export function writeTaskSuggestions(rawConfig = {}, tasks = [], options = {}) {
  const lines = tasks.length
    ? tasks.map((task) => `- [ ] ${String(task).replace(/\r?\n/g, " ")} #plur1bus/status-pending`).join("\n")
    : "- [ ] Review PLUR1BUS Obsidian Bridge Morning Review cron registration #plur1bus/status-pending";
  return writeManagedBlockFile(rawConfig, "tasks/task-suggestions.md", {
    id: "task-suggestions",
    agent: options.agentId || "main",
    bundle: options.bundleId || "manual",
  }, `${lines}\n`, options);
}

export function printMorningReviewCronCommand(rawConfig = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  return [
    "openclaw cron add \\",
    "  --name \"PLUR1BUS Morning Review\" \\",
    `  --cron "${cfg.morningReview.cron}" \\`,
    `  --tz "${cfg.morningReview.timezone}" \\`,
    `  --session ${cfg.morningReview.session} \\`,
    "  --message \"Run /plur1bus obsidian morning-review. Prepare proposals only. Run maintenance_light before proposal generation and adversarial_light before user presentation. Do not apply changes without explicit user approval. Write the ReviewBundle to Obsidian and return a concise approval summary.\" \\",
    "  --announce",
  ].join("\n");
}

function parseCommandOption(tokens, name, fallback = "") {
  const index = tokens.indexOf(name);
  if (index < 0) return fallback;
  return tokens[index + 1] || fallback;
}

function commandResult(value) {
  return { text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function defaultLivingDashboardRecords(agentId, workspaceKey) {
  const now = nowIso();
  return [{
    type: "source",
    id: `authority-${workspaceKey}`,
    status: "current",
    risk: "low",
    scope: "dashboard_only",
    trustLevel: "system_declared",
    origin: "plur1bus",
    agentId,
    summary: "PLUR1BUS/LanceDB remains authoritative memory; Obsidian is dashboard, review, visualization, and proposal output only.",
    createdAt: now,
    updatedAt: now,
  }];
}

export async function handleObsidianBridgeCommand(tokens = [], context = {}) {
  const rawConfig = context.config || {};
  const command = tokens[0] || "doctor";
  const sub = tokens[1] || "";
  const agentId = context.commandCtx?.agentId || context.agentId || "main";
  const workspaceKey = context.commandCtx?.workspaceKey || context.workspaceKey || "main";

  try {
    if (command === "doctor") return commandResult(runVaultDoctor(rawConfig, { agentId, workspaceKey }));
    if (command === "init" && sub === "workspaces") {
      const dryRun = tokens.includes("--dry-run");
      const verbose = tokens.includes("--verbose");
      const workspaces = discoverObsidianWorkspaces(rawConfig);
      const results = workspaces.map((workspace) => {
        const init = initWorkspace(workspace, { dryRun, allowDotObsidianWrite: rawConfig.allowDotObsidianWrite === true });
        return {
          workspaceId: workspace.workspaceId,
          agentId: workspace.agentId,
          label: workspace.label,
          path: workspace.path,
          actions: init.actions,
        };
      });
      return commandResult({
        ok: true,
        dryRun,
        verbose,
        workspaces: results.length,
        results: verbose ? results : results.map((result) => ({
          workspaceId: result.workspaceId,
          path: result.path,
          actions: result.actions.length,
        })),
      });
    }
    if (command === "morning-review") return commandResult(await runMorningReview(rawConfig, { agentId, workspaceKey }));
    if (command === "records" && sub === "rebuild") {
      const records = context.records || defaultLivingDashboardRecords(agentId, workspaceKey);
      return commandResult({ ok: true, written: writeRecords(rawConfig, records, { agentId, workspaceKey }) });
    }
    if (command === "dashboards" && sub === "build") return commandResult(generateDashboards(rawConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
    if (command === "bases" && sub === "build") return commandResult(generateBases(rawConfig, { agentId, workspaceKey }));
    if (command === "dataview" && sub === "build") return commandResult(generateDashboards({ ...rawConfig, optionalIntegrations: { ...(rawConfig.optionalIntegrations || {}), dataview: true } }, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
    if (command === "tasks" && sub === "build") return commandResult(generateTaskSuggestions(rawConfig, context.tasks || [], { agentId, workspaceKey }));
    if (command === "weekly") {
      if (sub === "build") return commandResult(buildWeeklySynthesis(rawConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
      return commandResult(await prepareReviewBundle(rawConfig, { agentId, workspaceKey, reviewProfiles: ["maintenance", "adversarial", "project_manager"] }));
    }
    if (command === "conflicts") {
      if (sub === "build") return commandResult(generateLivingConflictReport(rawConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
      return commandResult(generateConflictReport(rawConfig, { agentId, workspaceKey }));
    }
    if (command === "project-hub") {
      const topic = tokens.filter((token) => token !== "--refresh").slice(1).join(" ").trim();
      if (!topic) return commandResult("Usage: /plur1bus obsidian project-hub <topic>");
      if (tokens.includes("--refresh")) return commandResult(buildProjectHub(rawConfig, topic, { agentId, workspaceKey, records: context.records || [] }));
      return commandResult(generateProjectHub(rawConfig, topic, { agentId, workspaceKey }));
    }
    if (command === "memory" && sub === "explain") {
      const id = tokens[2] || "";
      if (!id) return commandResult("Usage: /plur1bus obsidian memory explain <id>");
      const record = typeof context.findRecord === "function" ? context.findRecord(id) : null;
      if (tokens.includes("--deep")) return commandResult(buildMemoryExplanation(rawConfig, id, { agentId, workspaceKey, findRecord: context.findRecord, records: context.records || [] }));
      return commandResult(writeMemoryExplanation(rawConfig, id, record, { agentId, workspaceKey }));
    }
    if (command === "maintenance" && sub === "deep") return commandResult(runLivingMaintenanceDeep(rawConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
    if (command === "adversarial" && sub === "deep") return commandResult(runAdversarialDeep(context.items || [], { agentId, workspaceKey }));
    if (command === "semantic-conflicts" && sub === "build") return commandResult(buildSemanticConflictGraph(rawConfig, { agentId, workspaceKey, records: context.records || [] }));
    if (command === "duplicates" && sub === "scan") return commandResult(scanSemanticDuplicates(rawConfig, { agentId, workspaceKey, records: context.records || [] }));
    if (command === "provenance" && sub === "build") return commandResult(buildProvenanceGraph(rawConfig, { agentId, workspaceKey, records: context.records || [] }));
    if (command === "impact" && sub === "analyze") return commandResult(analyzeImpact(rawConfig, tokens[2] || "all", { agentId, workspaceKey, records: context.records || [] }));
    if (command === "links" && sub === "suggest") return commandResult(generateLinkSuggestions(rawConfig, { agentId, workspaceKey, records: buildRecordIndex(rawConfig, { records: context.records || [] }).records }));
    if (command === "soul" && sub === "patch") {
      const soulPath = context.soulPath || (context.workspaceDir ? join(context.workspaceDir, "SOUL.MD") : "");
      if (!soulPath) return commandResult({ ok: false, error: "SOUL.MD path unavailable" });
      return commandResult(patchSoulMd(soulPath, {
        version: OBSIDIAN_CONTROL_ROOM_VERSION,
        force: tokens.includes("--force-soul") || rawConfig.soulPatch?.force === true,
        migrateLegacy: tokens.includes("--migrate-soul-memory-rules") || rawConfig.soulPatch?.migrateLegacy === true,
        dryRun: tokens.includes("--dry-run"),
        createIfMissing: rawConfig.soulPatch?.createIfMissing !== false,
        backup: rawConfig.soulPatch?.backup !== false,
      }));
    }
    if (command === "cron") {
      if (sub === "print-morning-review") return commandResult({ command: printMorningReviewCronCommand(rawConfig) });
      if (sub === "install-morning-review") {
        const cronCommand = printMorningReviewCronCommand(rawConfig);
        if (!tokens.includes("--force")) {
          return commandResult({
            installed: false,
            reason: "Refusing to install without --force. Review the OpenClaw cron command first.",
            command: cronCommand,
          });
        }
        if (typeof context.openclawCronAdd !== "function") {
          return commandResult({
            installed: false,
            reason: "No OpenClaw cron API is available in this runtime; run the printed command manually.",
            command: cronCommand,
          });
        }
        return commandResult(await context.openclawCronAdd({ command: cronCommand }));
      }
    }
    if (command === "review") {
      const bundleId = tokens[2] || "";
      if (sub === "prepare") return commandResult(await prepareReviewBundle(rawConfig, { agentId, workspaceKey }));
      if (sub === "show") {
        if (!bundleId) return commandResult("Usage: /plur1bus obsidian review show <bundleId>");
        return commandResult(loadBundleRecord(rawConfig, bundleId).record);
      }
      if (["approve", "reject", "snooze"].includes(sub)) {
        if (!bundleId) return commandResult(`Usage: /plur1bus obsidian review ${sub} <bundleId> --items <ids|all|low-risk>`);
        return commandResult(updateReviewBundleItems(rawConfig, bundleId, sub, parseCommandOption(tokens, "--items", "all"), {
          until: parseCommandOption(tokens, "--until", ""),
        }));
      }
      if (sub === "apply") {
        if (!bundleId) return commandResult("Usage: /plur1bus obsidian review apply <bundleId>");
        return commandResult(await applyApprovedReviewBundle(rawConfig, bundleId, {
          memoryStore: context.memoryStore,
          knowledgeUpdate: context.knowledgeUpdate,
        }));
      }
    }
    return commandResult("Usage: /plur1bus obsidian doctor|init workspaces [--dry-run] [--verbose]|records rebuild|dashboards build|bases build|dataview build|tasks build|review <prepare|show|approve|reject|snooze|apply>|morning-review|conflicts [build]|project-hub <topic> [--refresh]|memory explain <id> [--deep]|weekly [build]|maintenance deep|adversarial deep|semantic-conflicts build|duplicates scan|provenance build|impact analyze <id|all>|links suggest|soul patch|cron <print-morning-review|install-morning-review>");
  } catch (err) {
    return commandResult({ ok: false, error: String(err?.message || err) });
  }
}

export function cleanupTempFile(path) {
  try {
    if (path && existsSync(path)) unlinkSync(path);
  } catch (_) {}
}
