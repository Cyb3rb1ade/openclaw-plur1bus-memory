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
import { buildRecordIndex, DEEP_ANALYSIS_RECORD_COLLECTIONS } from "./obsidian/record-index.js";
import { patchSoulMd } from "./install/soul-patcher.js";
import {
  discoverLocalObsidianWorkspaceCandidates,
  discoverObsidianWorkspaces,
  initWorkspace,
  writeDiscoveredObsidianWorkspaces,
} from "./obsidian-bridge.js";

export const OBSIDIAN_CONTROL_ROOM_VERSION = "4.2.10";
export const REVIEW_BUNDLE_SCHEMA_VERSION = 1;
export const DEFAULT_REVIEW_ROOT = "plur1bus";
export const DEFAULT_MORNING_CRON = "0 9 * * *";
export const DEFAULT_EVENING_CRON = "0 18 * * *";
export const DEFAULT_MORNING_TZ = "Europe/Berlin";
export const OPENCLAW_COMMAND_SURFACE_NOTICE = "Use the OpenClaw plugin command surface only. /plur1bus is a registered slash/plugin command, not a shell binary; do not search PATH, do not run a plur1bus executable, and do not run openclaw plur1bus.";

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
  "invalid",
]);

const DEFAULT_OBSIDIAN_SOURCE_DIR_EXCLUDES = new Set([
  ".adaptive-learning",
  ".agents",
  ".claude",
  ".clawhub",
  ".git",
  ".obsidian",
  ".openclaw",
  ".outcome",
  ".pi",
  ".proactive",
  ".secrets",
  ".state",
  ".stfolder",
  ".stversions",
  "__pycache__",
  "node_modules",
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

function payloadHash(payload) {
  return `sha256:${sha256Hex(stableJson(payload || {}))}`;
}

function firstSourceQuote(body) {
  const normalized = String(body || "").replace(/\r\n/g, "\n");
  const line = normalized
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#") && !item.startsWith("---"));
  return (line || normalized.trim()).slice(0, 200);
}

function summarizeSourceForMemory(body, target) {
  const text = String(body || "").trim();
  const title = text.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || basename(String(target || "Obsidian note"), ".md");
  const quote = firstSourceQuote(text);
  if (hasPromptInjectionLikeText(text)) {
    return `Obsidian note "${title}" contains untrusted prompt-like text and needs review before any memory promotion.`;
  }
  return quote ? `${title}: ${quote}` : `Obsidian note "${title}" needs review before memory promotion.`;
}

function buildSemanticPayload(raw, context = {}) {
  const sourceHash = raw.preconditions?.sourceHash || raw.sourceHash || raw.content_hash || "";
  const sourceRef = Array.isArray(raw.sourceRefs) && raw.sourceRefs[0] ? String(raw.sourceRefs[0]) : String(raw.sourcePath || raw.target || "");
  const noteContent = String(raw.noteContent || raw.reason || raw.action || "");
  const evidenceQuote = raw.evidenceQuote || (Array.isArray(raw.evidence) && raw.evidence[0]) || firstSourceQuote(noteContent);
  return {
    text: String(raw.text || raw.summary || summarizeSourceForMemory(noteContent, raw.target)).trim(),
    category: raw.category || (raw.type === "knowledge_update" ? "decision" : "fact"),
    scope: raw.scope === "global_user" || raw.targetScope === "global_user" ? "user" : raw.scope || raw.targetScope || "workspace",
    origin: raw.origin || "internal",
    sourceUrl: raw.sourceUrl || (sourceRef ? `obsidian://${context.workspaceKey || "main"}/${sourceRef}` : ""),
    sourceRef,
    evidenceQuote: String(evidenceQuote || "").slice(0, 200),
    sourceHash,
    content_hash: sourceHash,
    sourceTrustLevel: raw.sourceTrustLevel || raw.sourceTrust || raw.trustLevel || "untrusted_obsidian",
  };
}

function normalizeApplyPreview(raw, context = {}) {
  const existing = raw.applyPreview && typeof raw.applyPreview === "object" ? raw.applyPreview : {};
  const payload = existing.payload && typeof existing.payload === "object"
    ? existing.payload
    : buildSemanticPayload(raw, context);
  return {
    ...existing,
    schemaVersion: existing.schemaVersion || 1,
    payload,
    payloadHash: existing.payloadHash || payloadHash(payload),
    immutableFields: existing.immutableFields || ["text", "category", "scope", "origin", "sourceUrl", "sourceRef", "evidenceQuote", "sourceHash", "content_hash", "sourceTrustLevel"],
  };
}

function hasPromptInjectionLikeText(text) {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(String(text || "")));
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

function workspaceEntryPath(entry = {}) {
  return entry.path || entry.workspace || entry.workspaceDir || entry.workspacePath || entry.dir || null;
}

function workspaceEntryId(entry = {}, fallback = "") {
  return entry.workspace_id || entry.workspaceId || entry.id || entry.name || fallback || "";
}

function workspaceEntryAgent(entry = {}, fallback = "") {
  return entry.agent_id || entry.agentId || entry.agent || fallback || "";
}

function normalizePathForMatch(value) {
  if (!value) return "";
  try {
    return normalizeAbsPath(value);
  } catch (_) {
    return resolve(expandHome(String(value)));
  }
}

function workspaceMatchesContext(entry = {}, index = 0, options = {}) {
  const rawPath = workspaceEntryPath(entry);
  const workspaceId = workspaceEntryId(entry, rawPath ? basename(rawPath) : `workspace-${index}`);
  const agentId = workspaceEntryAgent(entry, workspaceId);
  const labels = [
    workspaceId,
    agentId,
    entry.label,
    entry.alias,
    ...(Array.isArray(entry.aliases) ? entry.aliases : []),
  ].filter(Boolean).map(String);
  const requested = [
    options.workspaceKey,
    options.workspaceId,
    options.agentId,
    options.commandCtx?.workspaceKey,
    options.commandCtx?.agentId,
  ].filter(Boolean).map(String);
  if (requested.some((value) => labels.includes(value))) return true;

  const contextPath = options.workspaceDir || options.commandCtx?.workspaceDir;
  if (rawPath && contextPath) {
    return normalizePathForMatch(rawPath) === normalizePathForMatch(contextPath);
  }
  return false;
}

function selectWorkspaceVaultPath(rawConfig = {}, cfg = normalizeObsidianControlRoomConfig(rawConfig), options = {}) {
  if (cfg.vaultPath) return { vaultPath: cfg.vaultPath, source: "vaultPath" };

  const contextPath = options.workspaceDir || options.commandCtx?.workspaceDir;
  const workspaces = Array.isArray(cfg.workspaces) ? cfg.workspaces : [];
  const matchingWorkspace = workspaces.find((workspace, index) => workspaceMatchesContext(workspace, index, options));
  const matchingPath = workspaceEntryPath(matchingWorkspace);
  if (matchingPath) return { vaultPath: matchingPath, source: "workspaces" };

  if (contextPath) return { vaultPath: contextPath, source: "workspaceDir" };

  if (workspaces.length === 1) {
    const onlyPath = workspaceEntryPath(workspaces[0]);
    if (onlyPath) return { vaultPath: onlyPath, source: "singleWorkspace" };
  }

  return null;
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
    workspaces: Array.isArray(cfg.workspaces) ? cfg.workspaces : [],
    agents: {
      include: Array.isArray(agents.include) && agents.include.length > 0 ? agents.include : ["*"],
      equalCapabilities: agents.equalCapabilities !== false,
      defaultProfiles: {
        default: defaultProfiles.default || "standard",
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
    eveningReview: {
      enabled: cfg.eveningReview?.enabled === true,
      cron: cfg.eveningReview?.cron || DEFAULT_EVENING_CRON,
      timezone: cfg.eveningReview?.timezone || cfg.morningReview?.timezone || DEFAULT_MORNING_TZ,
      delivery: cfg.eveningReview?.delivery || cfg.morningReview?.delivery || "announce",
      session: cfg.eveningReview?.session || cfg.morningReview?.session || "isolated",
      applyMode: cfg.eveningReview?.applyMode || "manual",
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
    : (REVIEW_PROFILES.includes(cfg.agents.defaultProfiles.default) ? cfg.agents.defaultProfiles.default : "standard");
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
  const selected = selectWorkspaceVaultPath(rawConfig, cfg, options);
  if (!selected?.vaultPath) {
    return { cfg, ok: false, error: "obsidianBridge.vaultPath is not configured and no matching obsidianBridge.workspaces[] entry was found" };
  }
  cfg.vaultPath = selected.vaultPath;
  const vaultPath = normalizeAbsPath(selected.vaultPath);
  const reviewRoot = assertSafeRelativePath(cfg.reviewRoot, { allowDotObsidianWrite: cfg.allowDotObsidianWrite });
  const reviewPath = resolveUnder(vaultPath, reviewRoot, { allowDotObsidianWrite: cfg.allowDotObsidianWrite });
  return { cfg, ok: true, vaultPath, reviewRoot, reviewPath, vaultSource: selected.source };
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
  const excludedDirs = options.excludedDirs || DEFAULT_OBSIDIAN_SOURCE_DIR_EXCLUDES;
  const candidates = [];
  if (!existsSync(root)) return [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (excludedDirs.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const stat = statSync(abs);
        if (stat.size > maxFileBytes) continue;
        candidates.push({ abs, rel, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }

  walk(root);
  return candidates
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.rel.localeCompare(b.rel))
    .slice(0, maxItems)
    .map((file) => ({ ...file, content: readFileSync(file.abs, "utf8") }));
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
  const applyPreview = normalizeApplyPreview({ ...raw, type }, context);
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
    applyPreview,
    payloadHash: applyPreview.payloadHash,
    sourceTrustLevel: applyPreview.payload.sourceTrustLevel || raw.sourceTrustLevel || "untrusted_obsidian",
    approvedPayloadHash: raw.approvedPayloadHash || "",
    approvalMetadata: raw.approvalMetadata || null,
    appliedMemoryId: raw.appliedMemoryId || "",
    idempotencyKey: raw.idempotencyKey || `${id}:${applyPreview.payloadHash}`,
    sourceTrust: raw.sourceTrust || raw.trustLevel || applyPreview.payload.sourceTrustLevel || "untrusted",
    evidenceKind: raw.evidenceKind || raw.sourceKind || "",
    sourceScope: raw.sourceScope || raw.scope || "",
    targetScope: raw.targetScope || raw.scope || "",
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
  return hasPromptInjectionLikeText(haystack);
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
  const files = readMarkdownFiles(paths.vaultPath, {
    maxFileBytes: cfg.maxFileBytes,
    maxItems: Math.min(cfg.maxItems, 80),
    excludedDirs: DEFAULT_OBSIDIAN_SOURCE_DIR_EXCLUDES,
  });
  for (const file of files) {
    if (file.rel.startsWith(reviewRootPrefix) || file.rel === paths.reviewRoot) continue;
    if (/memory\/KNOWLEDGE\.md$/.test(file.rel)) continue;
    if (file.rel.startsWith("memory/cards/") || file.rel.startsWith("decisions/")) continue;
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
    const promptLike = hasPromptInjectionLikeContent({ noteContent: body, reason: "", action: "", evidence: [] });
    const evidenceQuote = firstSourceQuote(body);
    inputs.push({
      type: "note_import_candidate",
      risk: promptLike ? "medium" : "low",
      target: file.rel,
      action: "Review immutable MemoryCandidate summary before promotion.",
      reason: promptLike
        ? "Prompt-injection-like text was detected in note content; keep it untrusted and review the proposed summary carefully."
        : "Obsidian note can be reviewed as a PLUR1BUS MemoryCandidate.",
      evidence: [evidenceQuote],
      evidenceQuote,
      sourceRefs: [file.rel],
      preconditions: { sourceHash: hash, sourcePath: file.rel },
      noteContent: body.slice(0, 4000),
      sourceTrust: "obsidian_untrusted",
      sourceTrustLevel: "untrusted_obsidian",
    });
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
    `- [ ] Show details with \`/plur1bus_review show ${bundle.bundleId}\`.`,
    `- [ ] Approve low-risk items with \`/plur1bus_review approve ${bundle.bundleId} low-risk\`.`,
    `- [ ] Reject all pending items with \`/plur1bus_review reject ${bundle.bundleId} all\`.`,
    `- [ ] Run \`/plur1bus_review apply ${bundle.bundleId}\` after approval.`,
    "",
    "## Apply Instructions",
    "",
    "A checked box in Obsidian is not approval. The apply command re-reads this bundle, revalidates preconditions and hashes, and applies approved items only.",
    "If you omit the bundle id in Telegram, PLUR1BUS uses the latest pending ReviewBundle.",
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

function readReviewBundleItems(rawConfig = {}, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) return [];
  const bundleDir = resolveUnder(paths.reviewPath, "review-bundles", paths.cfg);
  if (!existsSync(bundleDir)) return [];
  const items = [];
  for (const entry of readdirSync(bundleDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".items.json")) continue;
    const record = readJson(join(bundleDir, entry.name), null);
    if (!Array.isArray(record?.items)) continue;
    for (const item of record.items) {
      if (item.status && item.status !== "pending") continue;
      items.push({
        ...item,
        bundleId: record.bundle?.bundleId || entry.name.replace(/\.items\.json$/, ""),
      });
    }
  }
  return items;
}

function checkStatus({ ok = true, errors = 0, warnings = 0, count = 0 } = {}) {
  if (!ok || errors > 0) return { icon: "error", label: "error", count };
  if (warnings > 0) return { icon: "warning", label: "warning", count };
  return { icon: "pass", label: "pass", count };
}

function renderEveningDeepReviewMarkdown(summary) {
  const row = (name, status, details) => `| ${name} | ${status.label} | ${details} |`;
  return [
    "# PLUR1BUS Evening Deep Review",
    "",
    `- Created: ${summary.createdAt}`,
    `- Agent: ${summary.agentId}`,
    `- Workspace: ${summary.workspaceKey}`,
    "- Mode: proposal-only",
    "",
    "## Checks",
    "",
    "| Check | Status | Details |",
    "|---|---|---|",
    row("Maintenance Deep", summary.status.maintenance, `${summary.maintenance.count} finding(s)`),
    row("Adversarial Deep", summary.status.adversarial, `${summary.adversarial.reviewed.length} item(s), ${summary.adversarial.blocked.length} blocked, ${summary.adversarial.warnings.length} warning(s)`),
    row("Semantic Conflicts", summary.status.semanticConflicts, `${summary.semanticConflicts.count || 0} record(s)`),
    row("Duplicates Scan", summary.status.duplicates, `${summary.duplicates.count || 0} candidate(s)`),
    row("Provenance Build", summary.status.provenance, `${summary.provenance.count || 0} record(s)`),
    row("Impact Analyze All", summary.status.impact, `${summary.impact.count || 0} item(s)`),
    row("Dashboards Build", summary.status.dashboards, `${summary.dashboards.count || 0} dashboard(s)`),
    "",
    "## Blocked / Warning Items",
    "",
    summary.blockedOrWarningItems.length
      ? summary.blockedOrWarningItems.map((item) => `- ${item.kind}: ${item.id || item.code || item.path || "item"} - ${item.reason || item.message || "Review required."}`).join("\n")
      : "- None.",
    "",
    "## Pending Items",
    "",
    `- Pending review items: ${summary.pendingItems ?? 0}`,
    Array.isArray(summary.pendingBundles) && summary.pendingBundles.length
      ? `- Bundle(s): ${summary.pendingBundles.join(", ")}`
      : "- Bundle(s): see ReviewBundle artifacts.",
    "",
    "## What to do next",
    "",
    ...(Array.isArray(summary.pendingBundles) && summary.pendingBundles.length === 1
      ? [
          `- Show details: /plur1bus_review show ${summary.pendingBundles[0]}`,
          `- Approve low-risk items: /plur1bus_review approve ${summary.pendingBundles[0]} low-risk`,
          `- Reject all pending items: /plur1bus_review reject ${summary.pendingBundles[0]} all`,
          `- Apply approved items: /plur1bus_review apply ${summary.pendingBundles[0]}`,
        ]
      : [
          "- Show details: /plur1bus_review show",
          "- Approve low-risk items: /plur1bus_review approve low-risk",
          "- Reject all pending items: /plur1bus_review reject all",
          "- Apply approved items: /plur1bus_review apply",
        ]),
    "",
    "Approval only marks items as approved. Nothing is written to memory until the explicit apply command runs.",
    "If you omit the bundle id, PLUR1BUS uses the latest pending ReviewBundle.",
    "",
    "## Artifacts",
    "",
    `- ${summary.artifactPath}`,
    ...(Array.isArray(summary.dashboards.generated) ? summary.dashboards.generated.map((path) => `- ${path}`) : []),
    "",
    "This review is generated through the OpenClaw PLUR1BUS plugin command surface. No standalone PLUR1BUS shell CLI is required or expected.",
    "",
  ].join("\n");
}

export function runEveningDeepReview(rawConfig = {}, options = {}) {
  const agentId = options.agentId || "main";
  const workspaceKey = options.workspaceKey || "main";
  const createdAt = nowIso(options);
  const baseRecords = options.records || defaultLivingDashboardRecords(agentId, workspaceKey);
  const analysisOptions = {
    ...options,
    records: baseRecords,
    collections: options.collections || DEEP_ANALYSIS_RECORD_COLLECTIONS,
  };
  const recordIndex = buildRecordIndex(rawConfig, analysisOptions);
  const derivedOptions = {
    ...options,
    agentId,
    workspaceKey,
    records: recordIndex.records,
    readExistingRecords: false,
  };
  const reviewItems = Array.isArray(options.items) ? options.items : readReviewBundleItems(rawConfig, options);
  const maintenance = runLivingMaintenanceDeep(rawConfig, derivedOptions);
  const adversarial = runAdversarialDeep(reviewItems, { agentId, workspaceKey });
  const semanticConflicts = buildSemanticConflictGraph(rawConfig, derivedOptions);
  const duplicates = scanSemanticDuplicates(rawConfig, derivedOptions);
  const provenance = buildProvenanceGraph(rawConfig, derivedOptions);
  const impact = analyzeImpact(rawConfig, "all", derivedOptions);
  const dashboardRecords = [
    ...recordIndex.records,
    ...maintenance.findings,
    ...semanticConflicts.proposals,
    ...duplicates.proposals,
    ...provenance.records,
    ...impact.impacts,
  ];
  const dashboards = generateDashboards(rawConfig, { ...options, agentId, workspaceKey, records: dashboardRecords, readExistingRecords: false });
  const artifactStamp = `${createdAt.slice(0, 10)}-${createdAt.slice(11, 16).replace(":", "")}`;
  const artifactPath = `evening-deep-review-${artifactStamp}.md`;
  const maintenanceErrors = maintenance.findings.filter((item) => item.severity === "error").length;
  const maintenanceWarnings = maintenance.findings.filter((item) => item.severity === "warning").length;
  const blockedOrWarningItems = [
    ...maintenance.findings.filter((item) => ["error", "warning"].includes(item.severity)).map((item) => ({ ...item, kind: "maintenance" })),
    ...adversarial.blocked.map((item) => ({ ...item, kind: "adversarial_block", reason: item.adversarialDeep?.checks?.map((check) => check.reason).join("; ") || item.reason })),
    ...adversarial.warnings.map((item) => ({ ...item, kind: "adversarial_warning", reason: item.adversarialDeep?.checks?.map((check) => check.reason).join("; ") || item.reason })),
  ];
  const summary = {
    ok: maintenance.ok !== false && adversarial.ok !== false && semanticConflicts.ok !== false && duplicates.ok !== false && provenance.ok !== false && impact.ok !== false && dashboards.ok !== false,
    createdAt,
    agentId,
    workspaceKey,
    mode: "proposal-only",
    artifactPath,
    records: recordIndex.records.length,
    pendingItems: reviewItems.length,
    pendingBundles: [...new Set(reviewItems.map((item) => item.bundleId).filter(Boolean))],
    maintenance,
    adversarial,
    semanticConflicts,
    duplicates,
    provenance,
    impact,
    dashboards,
    blockedOrWarningItems,
    status: {
      maintenance: checkStatus({ ok: maintenance.ok, errors: maintenanceErrors, warnings: maintenanceWarnings, count: maintenance.count }),
      adversarial: checkStatus({ ok: adversarial.ok, errors: adversarial.blocked.length, warnings: adversarial.warnings.length, count: adversarial.reviewed.length }),
      semanticConflicts: checkStatus({ ok: semanticConflicts.ok, count: semanticConflicts.count }),
      duplicates: checkStatus({ ok: duplicates.ok, count: duplicates.count }),
      provenance: checkStatus({ ok: provenance.ok, count: provenance.count }),
      impact: checkStatus({ ok: impact.ok, count: impact.count }),
      dashboards: checkStatus({ ok: dashboards.ok, count: dashboards.count }),
    },
  };
  summary.artifact = writeManagedBlockFile(rawConfig, artifactPath, {
    id: "evening-deep-review",
    agent: agentId,
    bundle: createdAt.slice(0, 10),
  }, renderEveningDeepReviewMarkdown(summary), options);
  return summary;
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
    const approvedPayloadHash = item.applyPreview?.payloadHash || payloadHash(item.applyPreview?.payload || {});
    const approvedAt = nowIso(options);
    const approvedBy = options.approvedBy || options.agentId || "human";
    const approvalMetadata = status === "approved"
      ? {
          approvedBy,
          approvedAt,
          approvalSource: "human_review",
          approvedPayloadHash,
          approvalHash: payloadHash({
            itemId: item.id,
            payloadHash: approvedPayloadHash,
            sourceHash: item.preconditions?.sourceHash || "",
            approvedBy,
            approvedAt,
            approvalSource: "human_review",
          }),
          ...(options.approvedTrustLevel ? { approvedTrustLevel: options.approvedTrustLevel } : {}),
          ...(options.appliedTrustLevel ? { appliedTrustLevel: options.appliedTrustLevel } : {}),
          ...(options.explicitGlobalApproval === true ? { explicitGlobalApproval: true } : {}),
        }
      : item.approvalMetadata || null;
    changed += 1;
    return {
      ...item,
      status,
      approvedPayloadHash: status === "approved" ? approvedPayloadHash : item.approvedPayloadHash || "",
      approvalMetadata,
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

function validatePayloadApproval(paths, item) {
  const payload = item.applyPreview?.payload || {};
  for (const forbidden of ["trustLevel", "approvedTrustLevel", "appliedTrustLevel", "approvedBy", "approvedAt", "approvalSource", "approvalHash"]) {
    if (payload[forbidden] !== undefined) {
      return { ok: false, status: "invalid", reason: `${forbidden} is approval/audit metadata and must not be part of immutable semantic payload` };
    }
  }
  if (payload.sourceTrustLevel && payload.sourceTrustLevel !== "untrusted_obsidian") {
    return { ok: false, status: "invalid", reason: "Obsidian sourceTrustLevel must remain untrusted_obsidian." };
  }
  if ((payload.scope === "user" || item.targetScope === "global_user") && item.explicitGlobalApproval !== true && item.approvalMetadata?.explicitGlobalApproval !== true) {
    return { ok: false, status: "invalid", reason: "Global/user scope requires explicit reviewer approval." };
  }
  const actualPayloadHash = payloadHash(payload);
  const proposedPayloadHash = item.applyPreview?.payloadHash || "";
  const approvedPayloadHash = item.approvedPayloadHash || item.approvalMetadata?.approvedPayloadHash || "";
  if (!proposedPayloadHash) return { ok: false, status: "invalid", reason: "Missing applyPreview.payloadHash." };
  if (actualPayloadHash !== proposedPayloadHash) {
    return { ok: false, status: "invalid", reason: "applyPreview payload hash drift", expected: proposedPayloadHash, actual: actualPayloadHash };
  }
  if (!approvedPayloadHash) return { ok: false, status: "invalid", reason: "Missing approvedPayloadHash." };
  if (approvedPayloadHash !== proposedPayloadHash) {
    return { ok: false, status: "invalid", reason: "approvedPayloadHash does not match applyPreview.payloadHash", expected: approvedPayloadHash, actual: proposedPayloadHash };
  }
  const sourceHash = item.preconditions?.sourceHash || payload.sourceHash || payload.content_hash || "";
  if (payload.sourceHash && sourceHash && stripHashPrefix(payload.sourceHash) !== stripHashPrefix(sourceHash)) {
    return { ok: false, status: "stale", reason: "payload sourceHash does not match approved source precondition" };
  }
  const quote = String(payload.evidenceQuote || "");
  const sourcePath = item.preconditions?.sourcePath || payload.sourceRef || "";
  if (quote && sourcePath) {
    const abs = resolveUnder(paths.vaultPath, sourcePath, paths.cfg);
    if (existsSync(abs)) {
      const sourceText = readFileSync(abs, "utf8");
      if (!sourceText.includes(quote)) {
        return { ok: false, status: "invalid", reason: "evidenceQuote is not source-backed" };
      }
    }
  } else if (quote && item.noteContent && !String(item.noteContent).includes(quote)) {
    return { ok: false, status: "invalid", reason: "evidenceQuote is not source-backed" };
  }
  return { ok: true };
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
  if (["memory_promotion", "note_import_candidate", "knowledge_update"].includes(item.type)) {
    const payload = validatePayloadApproval(paths, item);
    if (!payload.ok) return payload;
  }
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

function approvedMemoryStorePayload(item) {
  const semanticPayload = item.applyPreview?.payload || {
    text: item.action || item.reason,
    category: "fact",
    origin: "internal",
    scope: item.targetScope === "global_user" ? "user" : "workspace",
    evidenceQuote: item.evidence?.[0] || "",
    sourceUrl: item.sourceRefs?.[0] || "",
  };
  return {
    ...semanticPayload,
    approvedPayloadHash: item.approvedPayloadHash,
    idempotencyKey: item.idempotencyKey || `${item.id}:${item.approvedPayloadHash || item.applyPreview?.payloadHash || ""}`,
    approvalMetadata: item.approvalMetadata || null,
    approvedTrustLevel: item.approvalMetadata?.approvedTrustLevel || undefined,
    appliedTrustLevel: item.approvalMetadata?.appliedTrustLevel || undefined,
  };
}

export async function applyApprovedReviewBundle(rawConfig, bundleId, options = {}) {
  const loaded = loadBundleRecord(rawConfig, bundleId, options);
  const { paths, record } = loaded;
  const applied = [];
  const blocked = [];

  for (const item of record.items) {
    if (item.status !== "approved") continue;
    if (item.appliedMemoryId) {
      item.status = "applied";
      applied.push({ id: item.id, type: item.type, memoryId: item.appliedMemoryId, idempotent: true });
      continue;
    }
    const safety = applySafetyBlock(item, options);
    if (safety) {
      item.status = "blocked";
      item.blockedReason = safety;
      blocked.push({ id: item.id, reason: safety });
      continue;
    }
    const validation = await revalidateItem(paths, item, options);
    if (!validation.ok) {
      item.status = validation.status || "stale";
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
      const result = await options.memoryStore({
        item,
        payload: approvedMemoryStorePayload(item),
      });
      item.appliedMemoryId = result?.details?.id || result?.memoryId || item.appliedMemoryId || "";
    } else if (item.type === "knowledge_update") {
      if (typeof options.knowledgeUpdate !== "function") {
        item.status = "blocked";
        item.blockedReason = "No knowledgeUpdate callback available in this runtime.";
        blocked.push({ id: item.id, reason: item.blockedReason });
        continue;
      }
      await options.knowledgeUpdate({ item, payload: approvedMemoryStorePayload(item) });
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
  } else if (record.items.every((item) => ["applied", "rejected", "blocked", "snoozed", "stale", "invalid"].includes(item.status))) {
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
    "  --message \"/plur1bus obsidian morning-review\" \\",
    "  --announce",
  ].join("\n");
}

function shellArg(value) {
  return `"${String(value || "").replace(/(["\\$`])/g, "\\$1")}"`;
}

function workspaceDisplayName(workspace) {
  return workspace.label || workspace.workspaceId || workspace.agentId || "Workspace";
}

function workspaceSelectorFromTokens(tokens = []) {
  const workspace = parseCommandOption(tokens, "--workspace", parseCommandOption(tokens, "--workspace-id", ""));
  const agent = parseCommandOption(tokens, "--agent", parseCommandOption(tokens, "--agent-id", ""));
  return {
    workspace: workspace === "all" ? "" : workspace,
    agent: agent === "all" ? "" : agent,
  };
}

function workspaceMatchesCommandSelector(workspace, selector = {}) {
  const workspaceNeedle = selector.workspace || "";
  const agentNeedle = selector.agent || "";
  if (!workspaceNeedle && !agentNeedle) return true;
  const aliases = [
    workspace.workspaceId,
    workspace.agentId,
    workspace.label,
    ...(Array.isArray(workspace.aliases) ? workspace.aliases : []),
    ...(Array.isArray(workspace.legacyKeys) ? workspace.legacyKeys : []),
  ].filter(Boolean).map(String);
  if (workspaceNeedle && aliases.includes(String(workspaceNeedle))) return true;
  if (agentNeedle && aliases.includes(String(agentNeedle))) return true;
  return false;
}

function selectCommandWorkspaces(rawConfig = {}, tokens = [], context = {}) {
  const selector = workspaceSelectorFromTokens(tokens);
  const configured = discoverObsidianWorkspaces(rawConfig)
    .filter((workspace) => workspaceMatchesCommandSelector(workspace, selector));
  if (configured.length > 0) return configured;
  if (selector.workspace || selector.agent) return [];
  const workspaceDir = context.workspaceDir || context.commandCtx?.workspaceDir;
  if (!workspaceDir) return [];
  const workspaceId = context.workspaceKey || context.commandCtx?.workspaceKey || basename(workspaceDir);
  const agentId = context.agentId || context.commandCtx?.agentId || workspaceId;
  return [{
    workspaceId,
    agentId,
    label: workspaceId,
    path: normalizeAbsPath(workspaceDir),
  }];
}

function cronCommandFromSpec(spec) {
  const parts = [
    "openclaw cron add",
    `--name ${shellArg(spec.name)}`,
    `--agent ${shellArg(spec.agentId)}`,
    `--cron ${shellArg(spec.cron)}`,
    `--tz ${shellArg(spec.timezone)}`,
    "--exact",
    `--session ${spec.session}`,
    `--timeout-seconds ${spec.timeoutSeconds}`,
  ];
  if (spec.channel) parts.push(`--channel ${shellArg(spec.channel)}`);
  if (spec.to) parts.push(`--to ${shellArg(spec.to)}`);
  if (spec.delivery === "announce") parts.push("--announce");
  parts.push(`--message ${shellArg(spec.message)}`);
  return parts.map((part, index) => `${index === 0 ? part : `  ${part}`}${index < parts.length - 1 ? " \\" : ""}`).join("\n");
}

export function buildWorkspaceReviewCronJobs(rawConfig = {}, options = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  const workspaces = options.workspaces || selectCommandWorkspaces(rawConfig, options.tokens || [], options.context || {});
  const includeMorning = options.includeMorning !== false;
  const includeEvening = options.includeEvening !== false;
  const channel = options.channel || "";
  const to = options.to || "";
  const jobs = [];

  for (const workspace of workspaces) {
    const label = workspaceDisplayName(workspace);
    if (includeMorning) {
      const spec = {
        type: "morning",
        name: `PLUR1BUS Morning Review - ${label}`,
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
        cron: cfg.morningReview.cron,
        timezone: cfg.morningReview.timezone,
        session: cfg.morningReview.session,
        delivery: cfg.morningReview.delivery,
        channel,
        to,
        timeoutSeconds: 900,
        message: "/plur1bus obsidian morning-review",
      };
      jobs.push({ ...spec, command: cronCommandFromSpec(spec) });
    }
    if (includeEvening) {
      const spec = {
        type: "evening_deep",
        name: `PLUR1BUS Evening Deep Review - ${label}`,
        workspaceId: workspace.workspaceId,
        agentId: workspace.agentId,
        cron: cfg.eveningReview.cron,
        timezone: cfg.eveningReview.timezone,
        session: cfg.eveningReview.session,
        delivery: cfg.eveningReview.delivery,
        channel,
        to,
        timeoutSeconds: 1200,
        message: "/plur1bus obsidian evening-review",
      };
      jobs.push({ ...spec, command: cronCommandFromSpec(spec) });
    }
  }
  return { ok: true, workspaces: workspaces.length, jobs };
}

function parseCommandOption(tokens, name, fallback = "") {
  const index = tokens.indexOf(name);
  if (index < 0) return fallback;
  return tokens[index + 1] || fallback;
}

function countBy(items = [], predicate = () => false) {
  return Array.isArray(items) ? items.filter(predicate).length : 0;
}

function compactPathList(paths = [], max = 8) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (list.length <= max) return list;
  return [...list.slice(0, max), `... ${list.length - max} more`];
}

function normalizeCommandWord(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  const ascii = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const compact = ascii.replace(/[_\s]+/g, "-");
  const aliases = new Map([
    ["morning", "morning-review"],
    ["morgen", "morning-review"],
    ["morning-review", "morning-review"],
    ["evening", "evening-review"],
    ["abend", "evening-review"],
    ["evening-review", "evening-review"],
    ["evening-deep-review", "evening-deep-review"],
    ["show", "show"],
    ["details", "show"],
    ["detail", "show"],
    ["anzeigen", "show"],
    ["zeigen", "show"],
    ["zeige", "show"],
    ["approve", "approve"],
    ["approved", "approve"],
    ["freigabe", "approve"],
    ["freigeben", "approve"],
    ["zustimmen", "approve"],
    ["zustimmung", "approve"],
    ["akzeptieren", "approve"],
    ["reject", "reject"],
    ["rejected", "reject"],
    ["ablehnen", "reject"],
    ["verwerfen", "reject"],
    ["snooze", "snooze"],
    ["verschieben", "snooze"],
    ["apply", "apply"],
    ["anwenden", "apply"],
    ["ausfuehren", "apply"],
    ["ausfuhren", "apply"],
    ["ausführen", "apply"],
    ["prepare", "prepare"],
    ["vorbereiten", "prepare"],
  ]);
  return aliases.get(compact) || compact;
}

function normalizeItemSelector(value = "") {
  const normalized = normalizeCommandWord(value);
  if (["lowrisk", "low-risk", "niedriges-risiko", "niedrigrisiko"].includes(normalized)) return "low-risk";
  if (["all", "alle", "alles"].includes(normalized)) return "all";
  return String(value || "").trim();
}

function looksLikeReviewBundleId(value = "") {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("--")) return false;
  if (["all", "alle", "alles", "low-risk", "lowrisk", "low_risk", "niedrigrisiko"].includes(raw.toLowerCase())) return false;
  return /^rb[-_]/i.test(raw) || /\.items\.json$/i.test(raw);
}

function bundleCreatedAt(record = {}, mtimeMs = 0) {
  const raw = record.bundle?.createdAt || record.createdAt || "";
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : mtimeMs;
}

function latestReviewBundleId(rawConfig, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) return "";
  const dir = resolveUnder(paths.reviewPath, "review-bundles", paths.cfg);
  if (!existsSync(dir)) return "";
  const entries = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".items.json")) continue;
    const target = join(dir, file);
    const record = readJson(target, null);
    if (!record) continue;
    const bundleId = record.bundle?.bundleId || file.replace(/\.items\.json$/, "");
    const mtimeMs = statSync(target).mtimeMs;
    const items = Array.isArray(record.items) ? record.items : [];
    entries.push({
      bundleId,
      record,
      sortAt: bundleCreatedAt(record, mtimeMs),
      actionable: items.some((item) => !item.status || item.status === "pending"),
      approved: items.some((item) => item.status === "approved"),
    });
  }
  if (entries.length === 0) return "";
  const pool = options.preferApproved && entries.some((entry) => entry.approved)
    ? entries.filter((entry) => entry.approved)
    : entries.some((entry) => entry.actionable)
      ? entries.filter((entry) => entry.actionable)
      : entries;
  pool.sort((a, b) => b.sortAt - a.sortAt || b.bundleId.localeCompare(a.bundleId));
  return pool[0]?.bundleId || "";
}

function formatReviewTimestamp(value) {
  if (!value) return nowIso();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function statusMarker(status = {}) {
  const label = status.label || status.severity || "pass";
  if (label === "error" || label === "block") return "[ERROR]";
  if (label === "warning") return "[WARN]";
  return "[OK]";
}

function reviewStatus(errors = 0, warnings = 0) {
  if (errors > 0) return { label: "error" };
  if (warnings > 0) return { label: "warning" };
  return { label: "pass" };
}

function countByValue(items = [], pick = () => "") {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const value = pick(item) || "unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function formatCounts(counts = [], max = 4) {
  if (!counts.length) return "none";
  const shown = counts.slice(0, max).map(([name, count]) => `${count} ${name}`);
  const hidden = counts.slice(max).reduce((sum, [, count]) => sum + count, 0);
  return hidden ? `${shown.join(", ")}, ${hidden} more` : shown.join(", ");
}

function dedupeFindings(findings = []) {
  const grouped = new Map();
  for (const finding of Array.isArray(findings) ? findings : []) {
    const key = [
      finding.severity || finding.kind || "warning",
      finding.code || finding.type || "",
      finding.message || finding.reason || "",
    ].join("|");
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { ...finding, count: 1 });
    }
  }
  return [...grouped.values()];
}

function formatFinding(finding = {}) {
  const severity = finding.severity || finding.kind || "warning";
  const subject = finding.id || finding.code || finding.path || finding.target || "item";
  const detail = finding.message || finding.reason || finding.action || "Review required.";
  const repeat = finding.count > 1 ? ` (${finding.count}x)` : "";
  return `- ${severity}: ${subject}${repeat} - ${detail}`;
}

function reviewCommands(bundleId) {
  const bundle = bundleId || "";
  const suffix = bundle ? ` ${bundle}` : "";
  const approveDefault = bundle ? ` ${bundle} low-risk` : " low-risk";
  const rejectDefault = bundle ? ` ${bundle} all` : " all";
  return [
    "## What to do next",
    "",
    `- Show details: /plur1bus_review show${suffix}`,
    `- Approve low-risk items: /plur1bus_review approve${approveDefault}`,
    `- Reject all pending items: /plur1bus_review reject${rejectDefault}`,
    `- Apply approved items: /plur1bus_review apply${suffix}`,
    "",
    "Approval only marks items as approved. Nothing is written to memory until the explicit apply command runs.",
    "If you omit the bundle id, PLUR1BUS uses the latest pending ReviewBundle.",
  ].join("\n");
}

function reviewActionSummary(result = {}) {
  const action = result.action || "review";
  const next = action === "approve"
    ? `Next: /plur1bus_review apply ${result.bundleId || ""}`.trim()
    : action === "reject"
      ? "Rejected items will not be applied."
      : action === "snooze"
        ? "Snoozed items stay out of the active review queue until their snooze expires."
        : "";
  return [
    `PLUR1BUS ReviewBundle ${action} result`,
    `Bundle: ${result.bundleId || "n/a"}`,
    `Selector: ${result.selector || "n/a"}`,
    `Changed: ${result.changed ?? 0}`,
    next,
  ].filter(Boolean).join("\n");
}

function obsidianCommandHelp() {
  return [
    "PLUR1BUS quick commands:",
    "",
    "- /plur1bus_morning - prepare today's review proposals",
    "- /plur1bus_evening - run the deep evening checks",
    "- /plur1bus_review show - show the latest pending ReviewBundle",
    "- /plur1bus_review approve low-risk - approve only low-risk items",
    "- /plur1bus_review reject all - reject all pending items",
    "- /plur1bus_review apply - apply approved items",
    "",
    "Nothing is written by show, morning, evening, or approve. Memory changes require the final apply command.",
    "Advanced: /plur1bus help advanced",
  ].join("\n");
}

function reviewBundleSummary(result = {}, label = "PLUR1BUS ReviewBundle") {
  const bundle = result.bundle || result.record?.bundle || {};
  const items = Array.isArray(result.items) ? result.items : Array.isArray(result.record?.items) ? result.record.items : [];
  const maintenanceFindings = Array.isArray(result.maintenance?.findings)
    ? result.maintenance.findings
    : Array.isArray(result.record?.maintenance?.findings)
      ? result.record.maintenance.findings
      : [];
  const pending = countBy(items, (item) => !item.status || item.status === "pending");
  const approved = countBy(items, (item) => item.status === "approved");
  const rejected = countBy(items, (item) => item.status === "rejected");
  const warnings = countBy(items, (item) => item.adversarialReview?.status === "warning")
    + countBy(maintenanceFindings, (item) => item.severity === "warning");
  const blocks = countBy(items, (item) => item.adversarialReview?.status === "block")
    + countBy(maintenanceFindings, (item) => item.severity === "error");
  const written = result.written || {};
  const inferredMarkdownPath = !written.markdownPath && result.paths?.reviewRoot && bundle.bundleId
    ? `${result.paths.reviewRoot}/review-bundles/${bundle.bundleId}.md`
    : null;
  const inferredItemsPath = !written.itemsPath && result.paths?.reviewRoot && bundle.bundleId
    ? `${result.paths.reviewRoot}/review-bundles/${bundle.bundleId}.items.json`
    : null;
  const artifactPaths = compactPathList([written.markdownPath || inferredMarkdownPath, written.itemsPath || inferredItemsPath].filter(Boolean));
  const maintenanceWarnings = countBy(maintenanceFindings, (item) => item.severity === "warning");
  const maintenanceErrors = countBy(maintenanceFindings, (item) => item.severity === "error");
  const adversarialWarnings = countBy(items, (item) => item.adversarialReview?.status === "warning");
  const adversarialBlocks = countBy(items, (item) => item.adversarialReview?.status === "block");
  const adversarialPass = countBy(items, (item) => item.adversarialReview?.status === "pass");
  const checkRows = [
    ["Maintenance Light", reviewStatus(maintenanceErrors, maintenanceWarnings), `${maintenanceFindings.length} finding(s), ${maintenanceErrors} error(s), ${maintenanceWarnings} warning(s)`],
    ["Adversarial Light", reviewStatus(adversarialBlocks, adversarialWarnings), `${adversarialPass}/${items.length} pass, ${adversarialBlocks} block(s), ${adversarialWarnings} warning(s)`],
    ["ReviewBundle Build", reviewStatus(result.ok === false || result.status === "blocked" ? 1 : 0, 0), `${items.length} item(s), ${pending} pending`],
  ];
  const findings = dedupeFindings([
    ...maintenanceFindings.filter((item) => ["error", "warning"].includes(item.severity)),
    ...items.filter((item) => ["block", "warning"].includes(item.adversarialReview?.status)).map((item) => ({
      ...item,
      severity: item.adversarialReview.status === "block" ? "error" : "warning",
      message: item.adversarialReview.reason || item.reason,
    })),
  ]);
  const typeSummary = formatCounts(countByValue(items, (item) => item.type));
  const riskSummary = formatCounts(countByValue(items, (item) => item.risk));
  const title = label.includes("Morning")
    ? `${label} - ${bundle.workspaceKey || "main"} (${bundle.createdByAgent || "main"})`
    : label;
  return [
    title,
    `${formatReviewTimestamp(bundle.createdAt)} | Proposal-only mode`,
    "",
    "## Result",
    "",
    "| Check | Status | Details |",
    "|---|---|---|",
    ...checkRows.map(([name, check, detail]) => `| ${name} | ${statusMarker(check)} ${check.label} | ${detail} |`),
    "",
    "## Blocked / Warning",
    "",
    findings.length ? findings.slice(0, 8).map(formatFinding).join("\n") : "- None.",
    findings.length > 8 ? `- ... ${findings.length - 8} more in the ReviewBundle artifact.` : "",
    "",
    "## Pending Items",
    "",
    `- ${items.length} total, ${pending} pending, ${approved} approved, ${rejected} rejected`,
    `- Types: ${typeSummary}`,
    `- Risk: ${riskSummary}`,
    `- Findings: ${blocks} block(s), ${warnings} warning(s)`,
    "",
    "## Artifacts",
    "",
    artifactPaths.length ? artifactPaths.map((path) => `- ${path}`).join("\n") : "- No artifact path available.",
    "",
    reviewCommands(bundle.bundleId),
    "",
    result.note || "",
    "Full item details are written to the ReviewBundle artifact; no changes were applied.",
  ].filter(Boolean).join("\n");
}

function eveningReviewSummary(summary = {}) {
  const checks = summary.status || {};
  const rows = [
    ["Maintenance Deep", checks.maintenance],
    ["Adversarial Deep", checks.adversarial],
    ["Semantic Conflicts", checks.semanticConflicts],
    ["Duplicates Scan", checks.duplicates],
    ["Provenance Build", checks.provenance],
    ["Impact Analyze All", checks.impact],
    ["Dashboards Build", checks.dashboards],
  ].map(([name, status]) => {
    const count = status?.count ?? 0;
    return `| ${name} | ${statusMarker(status)} ${status?.label || "unknown"} | ${count} |`;
  });
  const findings = dedupeFindings(Array.isArray(summary.blockedOrWarningItems) ? summary.blockedOrWarningItems : []);
  const bundles = Array.isArray(summary.pendingBundles) ? summary.pendingBundles.filter(Boolean) : [];
  const reviewHelp = bundles.length === 1
    ? reviewCommands(bundles[0])
    : [
        "## What to do next",
        "",
        "- Open the listed ReviewBundle artifact, then use:",
        "- /plur1bus_review show",
        "- /plur1bus_review approve low-risk",
        "- /plur1bus_review reject all",
        "- /plur1bus_review apply",
        "",
        "Approval only marks items as approved. Nothing is written to memory until the explicit apply command runs.",
        "If you omit the bundle id, PLUR1BUS uses the latest pending ReviewBundle.",
      ].join("\n");
  return [
    `PLUR1BUS Evening Deep Review - ${summary.workspaceKey || "main"} (${summary.agentId || "main"})`,
    `${formatReviewTimestamp(summary.createdAt)} | Proposal-only mode`,
    "",
    "## Result",
    "",
    "| Check | Status | Count |",
    "|---|---|---|",
    ...rows,
    "",
    "## Blocked / Warning",
    "",
    findings.length ? findings.slice(0, 8).map(formatFinding).join("\n") : "- None.",
    findings.length > 8 ? `- ... ${findings.length - 8} more in the evening artifact.` : "",
    "",
    "## Pending Items",
    "",
    `- Pending review items: ${summary.pendingItems ?? 0}`,
    bundles.length ? `- Bundle(s): ${compactPathList(bundles, 5).join(", ")}` : "- Bundle(s): see ReviewBundle artifacts.",
    "",
    "## Artifacts",
    "",
    `- ${summary.artifactPath || summary.artifact?.path || "n/a"}`,
    "",
    reviewHelp,
    "",
    "No changes were applied.",
  ].filter(Boolean).join("\n");
}

function applySummary(result = {}) {
  const applied = Array.isArray(result.applied) ? result.applied.length : 0;
  const blocked = Array.isArray(result.blocked) ? result.blocked.length : 0;
  const next = applied > 0
    ? "Approved items were applied."
    : blocked > 0
      ? "Some approved items were blocked during safety revalidation; show the bundle for details."
      : "No approved items were ready to apply.";
  return [
    "PLUR1BUS ReviewBundle apply result",
    `Bundle: ${result.bundleId || "n/a"}`,
    `Applied: ${applied}`,
    `Blocked: ${blocked}`,
    `Items: ${Array.isArray(result.items) ? result.items.length : 0}`,
    next,
  ].join("\n");
}

function commandResult(value, options = {}) {
  const maxChars = options.maxChars || 12_000;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxChars) return { text };
  return {
    text: [
      text.slice(0, maxChars),
      "",
      `[truncated ${text.length - maxChars} chars; use the written PLUR1BUS artifact or a narrower command for full details]`,
    ].join("\n"),
  };
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
  const command = normalizeCommandWord(tokens[0] || "doctor");
  const sub = normalizeCommandWord(tokens[1] || "");
  const agentId = context.commandCtx?.agentId || context.agentId || "main";
  const workspaceKey = context.commandCtx?.workspaceKey || context.workspaceKey || "main";
  const selectedVault = selectWorkspaceVaultPath(rawConfig, normalizeObsidianControlRoomConfig(rawConfig), {
    agentId,
    workspaceKey,
    workspaceDir: context.workspaceDir || context.commandCtx?.workspaceDir,
    commandCtx: context.commandCtx,
  });
  const commandConfig = selectedVault?.vaultPath ? { ...rawConfig, vaultPath: selectedVault.vaultPath } : rawConfig;

  try {
    if (command === "help") return commandResult(obsidianCommandHelp());
    if (command === "doctor") return commandResult(runVaultDoctor(commandConfig, { agentId, workspaceKey, workspaceDir: context.workspaceDir, commandCtx: context.commandCtx }));
    if (command === "init" && sub === "workspaces") {
      const dryRun = tokens.includes("--dry-run");
      const verbose = tokens.includes("--verbose");
      const workspaces = selectCommandWorkspaces(rawConfig, tokens, context);
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
    if (command === "discover" && sub === "workspaces") {
      const write = tokens.includes("--write");
      const dryRun = !write || tokens.includes("--dry-run");
      const verbose = tokens.includes("--verbose");
      const backupDir = parseCommandOption(tokens, "--backup-dir", parseCommandOption(tokens, "--backup", ""));
      const discovery = discoverLocalObsidianWorkspaceCandidates(rawConfig, {
        dryRun,
        openclawConfig: context.openclawConfig,
        openclawHome: context.openclawHome,
        neoRoot: context.neoRoot,
      });
      const summary = {
        ok: true,
        dryRun,
        writeRequested: write,
        candidates: discovery.candidates.length,
        existing: discovery.existing.length,
        wouldAdd: discovery.wouldAdd.length,
        orphanLegacyKeys: discovery.orphanLegacyKeys,
        results: verbose ? discovery.candidates : discovery.candidates.map((candidate) => ({
          workspaceId: candidate.workspaceId,
          path: candidate.path,
          existing: candidate.existing,
          confidence: candidate.confidence,
          sources: candidate.sources,
        })),
      };
      if (!write) return commandResult(summary);
      if (!context.configPath) {
        return commandResult({ ...summary, ok: false, error: "OpenClaw config path unavailable; pass configPath in command context" });
      }
      const written = writeDiscoveredObsidianWorkspaces(context.configPath, discovery.candidates, {
        backupDir,
        dryRun,
      });
      return commandResult({ ...summary, ok: written.ok, write: written });
    }
    if (command === "morning-review") {
      const result = await runMorningReview(commandConfig, { agentId, workspaceKey, workspaceDir: context.workspaceDir, proposals: context.proposals });
      return commandResult(reviewBundleSummary(result, "PLUR1BUS Morning Review"));
    }
    if (command === "evening-review" || command === "evening-deep-review") {
      return commandResult(eveningReviewSummary(runEveningDeepReview(commandConfig, { agentId, workspaceKey, workspaceDir: context.workspaceDir, records: context.records, items: context.items })));
    }
    if (command === "records" && sub === "rebuild") {
      const records = context.records || defaultLivingDashboardRecords(agentId, workspaceKey);
      return commandResult({ ok: true, written: writeRecords(commandConfig, records, { agentId, workspaceKey, workspaceDir: context.workspaceDir }) });
    }
    if (command === "dashboards" && sub === "build") return commandResult(generateDashboards(commandConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
    if (command === "bases" && sub === "build") return commandResult(generateBases(commandConfig, { agentId, workspaceKey }));
    if (command === "dataview" && sub === "build") return commandResult(generateDashboards({ ...commandConfig, optionalIntegrations: { ...(commandConfig.optionalIntegrations || {}), dataview: true } }, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
    if (command === "tasks" && sub === "build") return commandResult(generateTaskSuggestions(commandConfig, context.tasks || [], { agentId, workspaceKey }));
    if (command === "weekly") {
      if (sub === "build") return commandResult(buildWeeklySynthesis(commandConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
      return commandResult(reviewBundleSummary(await prepareReviewBundle(commandConfig, { agentId, workspaceKey, reviewProfiles: ["maintenance", "adversarial", "project_manager"] }), "PLUR1BUS Weekly Review"));
    }
    if (command === "conflicts") {
      if (sub === "build") return commandResult(generateLivingConflictReport(commandConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
      return commandResult(generateConflictReport(commandConfig, { agentId, workspaceKey }));
    }
    if (command === "project-hub") {
      const topic = tokens.filter((token) => token !== "--refresh").slice(1).join(" ").trim();
      if (!topic) return commandResult("Usage: /plur1bus obsidian project-hub <topic>");
      if (tokens.includes("--refresh")) return commandResult(buildProjectHub(commandConfig, topic, { agentId, workspaceKey, records: context.records || [] }));
      return commandResult(generateProjectHub(commandConfig, topic, { agentId, workspaceKey }));
    }
    if (command === "memory" && sub === "explain") {
      const id = tokens[2] || "";
      if (!id) return commandResult("Usage: /plur1bus obsidian memory explain <id>");
      const record = typeof context.findRecord === "function" ? context.findRecord(id) : null;
      if (tokens.includes("--deep")) return commandResult(buildMemoryExplanation(commandConfig, id, { agentId, workspaceKey, findRecord: context.findRecord, records: context.records || [] }));
      return commandResult(writeMemoryExplanation(commandConfig, id, record, { agentId, workspaceKey }));
    }
    if (command === "maintenance" && sub === "deep") return commandResult(runLivingMaintenanceDeep(commandConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey) }));
    if (command === "adversarial" && sub === "deep") return commandResult(runAdversarialDeep(context.items || [], { agentId, workspaceKey }));
    if (command === "semantic-conflicts" && sub === "build") return commandResult(buildSemanticConflictGraph(commandConfig, { agentId, workspaceKey, records: context.records || [] }));
    if (command === "duplicates" && sub === "scan") return commandResult(scanSemanticDuplicates(commandConfig, { agentId, workspaceKey, records: context.records || [] }));
    if (command === "provenance" && sub === "build") return commandResult(buildProvenanceGraph(commandConfig, { agentId, workspaceKey, records: context.records || [] }));
    if (command === "impact" && sub === "analyze") return commandResult(analyzeImpact(commandConfig, tokens[2] || "all", { agentId, workspaceKey, records: context.records || [] }));
    if (command === "links" && sub === "suggest") return commandResult(generateLinkSuggestions(commandConfig, { agentId, workspaceKey, records: buildRecordIndex(commandConfig, { records: context.records || [] }).records }));
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
      if (sub === "print-morning-review") return commandResult({ command: printMorningReviewCronCommand(commandConfig) });
      if (sub === "print-workspace-reviews") {
        const plan = buildWorkspaceReviewCronJobs(rawConfig, {
          tokens,
          context,
          includeMorning: !tokens.includes("--evening-only"),
          includeEvening: !tokens.includes("--morning-only"),
          channel: parseCommandOption(tokens, "--channel", ""),
          to: parseCommandOption(tokens, "--to", ""),
        });
        return commandResult({
          ...plan,
          commands: plan.jobs.map((job) => job.command),
        });
      }
      if (sub === "install-workspace-reviews") {
        const plan = buildWorkspaceReviewCronJobs(rawConfig, {
          tokens,
          context,
          includeMorning: !tokens.includes("--evening-only"),
          includeEvening: !tokens.includes("--morning-only"),
          channel: parseCommandOption(tokens, "--channel", ""),
          to: parseCommandOption(tokens, "--to", ""),
        });
        if (!tokens.includes("--force")) {
          return commandResult({
            installed: false,
            reason: "Refusing to install without --force. Review the OpenClaw cron commands first.",
            ...plan,
            commands: plan.jobs.map((job) => job.command),
          });
        }
        if (typeof context.openclawCronAdd !== "function") {
          return commandResult({
            installed: false,
            reason: "No OpenClaw cron API is available in this runtime; run the printed commands manually.",
            ...plan,
            commands: plan.jobs.map((job) => job.command),
          });
        }
        const results = [];
        for (const job of plan.jobs) {
          results.push(await context.openclawCronAdd({ command: job.command, job }));
        }
        return commandResult({ installed: true, ...plan, results });
      }
      if (sub === "install-morning-review") {
        const cronCommand = printMorningReviewCronCommand(commandConfig);
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
      const rawBundleOrSelector = tokens[2] || "";
      const rawMaybeSelector = tokens[3] || "";
      const optionSelector = normalizeItemSelector(parseCommandOption(tokens, "--items", ""));
      const hasExplicitBundle = looksLikeReviewBundleId(rawBundleOrSelector);
      const bundleId = hasExplicitBundle
        ? rawBundleOrSelector
        : latestReviewBundleId(commandConfig, { agentId, workspaceKey, workspaceDir: context.workspaceDir, preferApproved: sub === "apply" });
      const positionalSelector = hasExplicitBundle ? rawMaybeSelector : rawBundleOrSelector;
      const selector = normalizeItemSelector(optionSelector || positionalSelector || (sub === "approve" ? "low-risk" : "all"));
      if (sub === "prepare") return commandResult(reviewBundleSummary(await prepareReviewBundle(commandConfig, { agentId, workspaceKey, proposals: context.proposals }), "PLUR1BUS ReviewBundle"));
      if (sub === "show") {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(reviewBundleSummary(loadBundleRecord(commandConfig, bundleId), "PLUR1BUS ReviewBundle"));
      }
      if (["approve", "reject", "snooze"].includes(sub)) {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(reviewActionSummary(updateReviewBundleItems(commandConfig, bundleId, sub, selector, {
          until: parseCommandOption(tokens, "--until", ""),
        })));
      }
      if (sub === "apply") {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(applySummary(await applyApprovedReviewBundle(commandConfig, bundleId, {
          memoryStore: context.memoryStore,
          knowledgeUpdate: context.knowledgeUpdate,
        })));
      }
    }
    return commandResult(obsidianCommandHelp());
  } catch (err) {
    return commandResult({ ok: false, error: String(err?.message || err) });
  }
}

export function cleanupTempFile(path) {
  try {
    if (path && existsSync(path)) unlinkSync(path);
  } catch (_) {}
}
