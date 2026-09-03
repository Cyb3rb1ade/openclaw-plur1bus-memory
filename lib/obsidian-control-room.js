/**
 * PLUR1BUS Obsidian Bridge control-room layer.
 *
 * This module writes review, dashboard, curation, and project-management
 * artifacts into an Obsidian vault. PLUR1BUS stays authoritative: Obsidian text
 * is treated as untrusted input and apply never mutates memory without explicit
 * approval plus immediate revalidation.
 */

import { createHash, randomUUID } from "node:crypto";
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
import { redactError } from "./safe-logging.js";
import { isAuthorized, resolveChatKind, resolveIdentity } from "./security.js";
import { resolveLocale, readSoulToneCached, pickTone, t } from "./i18n.js";
import { normalizeWorkspaceTarget } from "./memory-request-context.js";
import {
  assertMutationAllowed,
  closedMutationGates,
  deriveTargetMutationPolicy,
  mutationAllowed,
  parseObsidianCommandPlan,
} from "./obsidian-mutation-policy.js";
import {
  createOwnedReviewBundle,
  latestOwnedReviewBundleId,
  listOwnedReviewBundles,
  loadOwnedReviewBundle,
  updateOwnedReviewBundle,
} from "./obsidian-review-authority.js";
import {
  confirmSemanticDiscovery,
  prepareSemanticDiscovery,
  semanticConfirmationCallbackForNonce,
} from "./obsidian-semantic-discovery-flow.js";
import {
  confirmVaultConfirmation,
  prepareVaultConfirmation,
  vaultConfirmationCallbackForNonce,
} from "./obsidian-vault-confirmation-flow.js";
import { isOwnedVaultConfirmed } from "./obsidian-vault-authority.js";

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
import { buildReviewNarrativeLead } from "./review-narrative-lead.js";
import { generateLinkSuggestions } from "./obsidian/link-suggestions.js";
import { writeRecords } from "./obsidian/record-writer.js";
import { buildRecordIndex, DEEP_ANALYSIS_RECORD_COLLECTIONS } from "./obsidian/record-index.js";
import { patchSoulMd } from "./install/soul-patcher.js";
import { rotateOldArchives } from "./obsidian/archive-rotation.js";
import { resolveReviewPath } from "./obsidian/safe-paths.js";
import {
  discoverLocalObsidianWorkspaceCandidates,
  discoverObsidianWorkspaces,
  initWorkspace,
  writeDiscoveredObsidianWorkspaces,
} from "./obsidian-bridge.js";

export const OBSIDIAN_CONTROL_ROOM_VERSION = "5.1.0";
export const REVIEW_BUNDLE_SCHEMA_VERSION = 1;
export const DEFAULT_REVIEW_ROOT = "plur1bus";
export const DEFAULT_MORNING_CRON = "0 9 * * *";
export const DEFAULT_EVENING_CRON = "0 18 * * *";
export const DEFAULT_MORNING_TZ = "Europe/Berlin";
export const OPENCLAW_COMMAND_SURFACE_NOTICE = "Use the OpenClaw plugin command surface only. /plur1bus is a registered slash/plugin command, not a shell binary; do not search PATH, do not run a plur1bus executable, and do not run openclaw plur1bus.";

const CANONICAL_WORKSPACE_AGENT_IDS = Object.freeze(["main", "bernhardine", "heisenberg"]);

export const REVIEW_PROFILES = Object.freeze([
  "standard",
  "conservative",
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

const MEMORY_REVIEW_ITEM_TYPES = new Set([
  "memory_promotion",
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

const AGENT_RUNTIME_MARKER_DIRS = Object.freeze([
  ".openclaw",
  ".adaptive-learning",
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

function normalizeOwnerToken(value) {
  return safeSlug(String(value || "").toLowerCase().replace(/_/g, "-"), "").toLowerCase();
}

function ownerTokensForWorkspaceEntry(entry = {}, fallback = "") {
  return [
    workspaceEntryId(entry, fallback),
    workspaceEntryAgent(entry, fallback),
    entry.label,
    entry.alias,
    ...(Array.isArray(entry.aliases) ? entry.aliases : []),
  ].map(normalizeOwnerToken).filter(Boolean);
}

function contextOwnerTokens(cfg, options = {}) {
  const direct = [
    options.workspaceKey,
    options.workspaceId,
    options.agentId,
    options.commandCtx?.workspaceKey,
    options.commandCtx?.agentId,
  ].map(normalizeOwnerToken).filter(Boolean);
  const matching = (Array.isArray(cfg?.workspaces) ? cfg.workspaces : [])
    .filter((workspace, index) => workspaceMatchesContext(workspace, index, options))
    .flatMap((workspace, index) => ownerTokensForWorkspaceEntry(workspace, `workspace-${index}`));
  return new Set([...direct, ...matching]);
}

function configuredForeignOwnerTokens(cfg, options = {}) {
  const current = contextOwnerTokens(cfg, options);
  const foreign = new Set();
  for (const [index, workspace] of (Array.isArray(cfg?.workspaces) ? cfg.workspaces : []).entries()) {
    const tokens = ownerTokensForWorkspaceEntry(workspace, `workspace-${index}`);
    if (tokens.length && tokens.every((token) => !current.has(token))) {
      for (const token of tokens) foreign.add(token);
    }
  }
  return foreign;
}

function sourceRelPathFromReviewItem(item = {}) {
  const candidates = [
    item.preconditions?.sourcePath,
    item.sourcePath,
    item.target,
    ...(Array.isArray(item.sourceRefs) ? item.sourceRefs : []),
  ];
  for (const candidate of candidates) {
    const raw = String(candidate || "").replace(/\\/g, "/").trim();
    if (!raw) continue;
    const obsidian = raw.match(/^obsidian:\/\/[^/]+\/(.+)$/i);
    return obsidian ? obsidian[1] : raw;
  }
  const sourceUrl = String(item.applyPreview?.payload?.sourceUrl || "").trim();
  const obsidian = sourceUrl.match(/^obsidian:\/\/[^/]+\/(.+)$/i);
  return obsidian ? obsidian[1] : "";
}

function firstPathSegment(relPath) {
  const safe = String(relPath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return safe[0] || "";
}

function rootHasAgentRuntimeMarker(vaultPath, relPath) {
  const rootSegment = firstPathSegment(relPath);
  if (!rootSegment || rootSegment.startsWith(".")) return false;
  let rootPath;
  try {
    rootPath = resolveUnder(vaultPath, rootSegment, { allowDotObsidianWrite: true });
  } catch (_) {
    return true;
  }
  try {
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) return false;
    return AGENT_RUNTIME_MARKER_DIRS.some((marker) => existsSync(join(rootPath, marker)));
  } catch (_) {
    return false;
  }
}

function validateAgentScopedSourcePath(paths, relPath, options = {}) {
  const raw = String(relPath || "").replace(/\\/g, "/").trim();
  if (!raw) return { ok: true };
  let safeRel;
  try {
    safeRel = assertSafeRelativePath(raw, { allowDotObsidianWrite: paths?.cfg?.allowDotObsidianWrite === true });
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
  const rootSegment = firstPathSegment(safeRel);
  const rootToken = normalizeOwnerToken(rootSegment);
  const foreignTokens = configuredForeignOwnerTokens(paths?.cfg || {}, options);
  for (const token of foreignTokens) {
    if (rootToken === token || rootToken.startsWith(`${token}-`)) {
      return {
        ok: false,
        reason: `Foreign agent/workspace path '${rootSegment}' cannot be imported into ${options.workspaceKey || options.agentId || "this agent"}.`,
      };
    }
  }
  if (rootHasAgentRuntimeMarker(paths?.vaultPath || "", safeRel)) {
    return {
      ok: false,
      reason: `Agent runtime workspace path '${rootSegment}' cannot be imported as Obsidian memory.`,
    };
  }
  return { ok: true };
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
    enabled: cfg.enabled !== false,
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
      enabled: cfg.morningReview?.enabled !== false,
      cron: cfg.morningReview?.cron || DEFAULT_MORNING_CRON,
      timezone: cfg.morningReview?.timezone || DEFAULT_MORNING_TZ,
      delivery: cfg.morningReview?.delivery || "announce",
      session: cfg.morningReview?.session || "isolated",
      writeReviewBundle: cfg.morningReview?.writeReviewBundle !== false,
      applyMode: cfg.morningReview?.applyMode || "manual",
    },
    eveningReview: {
      enabled: cfg.eveningReview?.enabled !== false,
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
    bundleCooldownMs: Number(cfg.bundleCooldownMs || 0),
    staleBundleMaxAgeDays: Number.isFinite(Number(cfg.staleBundleMaxAgeDays)) ? Number(cfg.staleBundleMaxAgeDays) : 7,
    autoApplyLowRisk: cfg.autoApplyLowRisk === true,
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

/**
 * The vault a command acts on, resolved exactly as the command handler will
 * resolve it: explicit vaultPath, then the workspace matching the command's
 * agent/workspace, then the command's workspaceDir, then a single configured
 * workspace. Callers that decide vaultConfirmed before invoking the handler
 * must use this, not their own shortcut -- a Telegram command carries no
 * workspaceDir, and a shortcut that ends there yields "" and never consults
 * the receipt the confirm step just wrote.
 *
 * @returns {string} Selected vault path, or "" when nothing resolves.
 */
export function resolveCommandVaultPath(rawConfig = {}, options = {}) {
  const selected = selectWorkspaceVaultPath(rawConfig, normalizeObsidianControlRoomConfig(rawConfig), options);
  return selected?.vaultPath ? String(selected.vaultPath) : "";
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
    try { fsyncSync(fd); } catch (err) { console.warn(`[obsidian-control-room] fsync failed: ${redactError(err).message}`); }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dirFd = openSync(dirname(path), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch (err) { console.warn(`[obsidian-control-room] dir fsync failed: ${redactError(err).message}`); }
}

function atomicWriteJson(path, value) {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path, fallback = null) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) { console.warn(`[obsidian-control-room] readJson failed: ${redactError(err).message}`); }
  return fallback;
}

function maybeCreateReviewLayout(paths, options = {}) {
  if (!paths.ok || paths.cfg.allowWrite === false || options.readOnly === true) return [];
  assertMutationAllowed(options.mutationPolicy, "vault_write");
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
  // Hash is computed from the stored form (trailing whitespace stripped) so that
  // findManagedBlocks can verify the hash without a mismatch on every regeneration.
  const storedBody = String(body || "").replace(/\s+$/g, "");
  const hash = hashToken(storedBody);
  return [
    `<!-- plur1bus:managed:start id="${cleanId}" agent="${safeSlug(agent, "main")}" bundle="${safeSlug(bundle, "bundle")}" hash="${hash}" -->`,
    storedBody,
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
  if (!mutationAllowed(options.mutationPolicy, "vault_write")) {
    return {
      changed: false,
      conflict: null,
      path: relPath,
      applied: false,
      reason: "mutation_policy_denied",
      deniedGates: closedMutationGates(options.mutationPolicy),
      plannedActions: [{ capability: "vault_write", path: relPath }],
    };
  }
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
  void date;
  return `rb-${randomUUID()}`;
}

function itemIdFromBundle(bundleId, index) {
  return `rbi-${bundleId.replace(/^rb-/, "")}-${String(index + 1).padStart(3, "0")}`;
}

export function normalizeReviewProfile(profile) {
  if (profile === "adversarial") return "standard";
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
    const boundary = validateAgentScopedSourcePath(paths, file.rel, options);
    if (!boundary.ok) continue;
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
      reason: describeFinding(finding),
      evidence: [finding.code],
      maintenanceReview: {
        status: finding.severity === "error" ? "warning" : "pass",
        reason: describeFinding(finding),
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

function renderReviewBundleMarkdown(bundle, items, maintenance, mood = null) {
  const mode = reviewBundleMode(items);
  const warningItems = items.filter((item) => item.adversarialReview.status === "warning");
  const blockedItems = items.filter((item) => item.adversarialReview.status === "block");
  const conflicts = items.filter((item) => item.type === "conflict_resolution" || item.status === "blocked" || item.adversarialReview.status === "block");
  const stale = items.filter((item) => item.type === "stale_review" || item.status === "stale");
  const projectUpdates = items.filter((item) => item.type === "project_hub_update");
  const hygiene = items.filter((item) => item.type === "vault_hygiene");
  const taskItems = items.filter((item) => item.type === "task_suggestion");

  let lead = null;
  try {
    lead = buildReviewNarrativeLead({
      findings: maintenance?.findings?.length || 0,
      proposals: Math.max(0, items.length - conflicts.length - hygiene.length),
      conflicts: conflicts.length,
      duplicates: hygiene.length,
    }, mood);
  } catch { /* fail-open: missing or erroring module does not propagate */ }

  const body = [
    "# PLUR1BUS ReviewBundle",
    "",
    ...(lead ? [lead, ""] : []),
    "## Summary",
    "",
    `- Bundle: ${bundle.bundleId}`,
    `- Review mode: ${mode.label}`,
    `- Scope: ${mode.description}`,
    `- Status: ${bundle.status}`,
    `- Apply mode: ${bundle.applyMode}`,
    `- Items: ${items.length}`,
    `- Warnings: ${warningItems.length}`,
    `- Blocks: ${blockedItems.length}`,
    "",
    "## Maintenance Findings",
    "",
    maintenance.findings.length
      ? maintenance.findings.map(formatFinding).join("\n")
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
    ...reviewChecklist(bundle.bundleId, mode),
    "",
    "## Apply Instructions",
    "",
    mode.kind === "maintenance"
      ? "This bundle contains vault maintenance findings only. No memory approval is needed, and apply is not required for memory import."
      : "A checked box in Obsidian is not approval. The apply command re-reads this bundle, revalidates preconditions and hashes, and applies approved items only.",
    "A Telegram reply does not need to repeat the bundle id. Without an id, show/explain/approve/reject use the latest pending bundle; apply uses the latest approved bundle.",
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
  // U3: full item JSON lives in .items.json only — the .md stays human-readable
  return [
    `### ${item.id} - ${item.type}`,
    "",
    `- Status: ${item.status}`,
    `- Risk: ${item.risk}`,
    `- Target: ${item.target || "(none)"}`,
    `- Action: ${item.action || "(none)"}`,
    `- Reason: ${item.reason || "(none)"}`,
    `- Proposed by: ${item.proposedByAgent}`,
    `- Review profile: ${normalizeReviewProfile(item.reviewProfile)}`,
    `- Adversarial: ${item.adversarialReview.status} - ${item.adversarialReview.reason || "No issue"}`,
  ].join("\n");
}

function writeReviewBundleDisplay(paths, bundle, items, hygieneItems, maintenance, mood, options) {
  assertMutationAllowed(options.mutationPolicy, "vault_write");
  maybeCreateReviewLayout(paths, { ...options, createLayout: true });
  const rel = `review-bundles/${bundle.bundleId}.md`;
  const jsonRel = `review-bundles/${bundle.bundleId}.items.json`;
  const target = resolveUnder(paths.reviewPath, rel, paths.cfg);
  const jsonTarget = resolveUnder(paths.reviewPath, jsonRel, paths.cfg);
  // Markdown shows all items (merged) so existing Obsidian rendering continues to work.
  atomicWriteText(target, renderReviewBundleMarkdown(bundle, [...items, ...hygieneItems], maintenance, mood));
  // JSON stores items and hygieneItems separately so the loader can distinguish them.
  atomicWriteJson(jsonTarget, { bundle, items, hygieneItems, maintenance });
  return {
    markdownPath: `${paths.reviewRoot}/${rel}`,
    itemsPath: `${paths.reviewRoot}/${jsonRel}`,
  };
}

function writeReviewBundle(paths, bundle, items, hygieneItems, maintenance, mood = null, options = {}) {
  // hygieneItems is optional for backward compat — callers that pass (paths, bundle, items, maintenance)
  // (4 args) will have hygieneItems=maintenance and maintenance=undefined; detect and fix that.
  if (!Array.isArray(hygieneItems) && hygieneItems && typeof hygieneItems === "object" && !Array.isArray(maintenance)) {
    maintenance = hygieneItems;
    hygieneItems = [];
  }
  const safeHygieneItems = Array.isArray(hygieneItems) ? hygieneItems : [];
  assertMutationAllowed(options.mutationPolicy, "review_write");
  const authoritativeRecord = { bundle, items, hygieneItems: safeHygieneItems, maintenance };
  const existing = loadOwnedReviewBundle({
    policy: options.mutationPolicy,
    bundleId: bundle.bundleId,
  });
  if (existing) {
    updateOwnedReviewBundle({
      policy: options.mutationPolicy,
      bundleId: bundle.bundleId,
      update: () => authoritativeRecord,
    });
  } else {
    createOwnedReviewBundle({
      policy: options.mutationPolicy,
      bundleId: bundle.bundleId,
      bundle: authoritativeRecord,
    });
  }
  return writeReviewBundleDisplay(
    paths,
    bundle,
    items,
    safeHygieneItems,
    maintenance,
    mood,
    options,
  );
}

export async function prepareReviewBundle(rawConfig = {}, options = {}) {
  assertMutationAllowed(options.mutationPolicy, "review_write");
  assertMutationAllowed(options.mutationPolicy, "vault_write");
  const paths = resolveObsidianBridgePaths(rawConfig, options);

  // Bundle cooldown is opt-in. Manual slash commands must never look like an
  // empty review just because a previous bundle was created moments earlier.
  const bundleCooldownMs = Number.isFinite(options.bundleCooldownMs)
    ? options.bundleCooldownMs
    : Number.isFinite(paths.cfg?.bundleCooldownMs)
      ? paths.cfg.bundleCooldownMs
      : 0;
  const isAutoBundleId = !options.bundleId;
  if (bundleCooldownMs > 0 && paths.ok && isAutoBundleId) {
    const cooldownPath = join(paths.reviewPath, "bundle-cooldown.json");
    const cooldownState = readJson(cooldownPath, {});
    const lastBundleAt = cooldownState.lastBundleAt ? new Date(cooldownState.lastBundleAt) : null;
    const now = options.now || new Date();
    if (lastBundleAt && Number.isFinite(lastBundleAt.getTime()) && (now - lastBundleAt) < bundleCooldownMs) {
      return {
        status: "skipped_cooldown",
        ok: true,
        applied: false,
        bundle: null,
        items: [],
        hygieneItems: [],
        maintenance: null,
        written: null,
        pipeline: ["cooldown_skipped"],
        cooldownRemainingMs: bundleCooldownMs - (now - lastBundleAt),
        latestBundleId: latestReviewBundleId(rawConfig, options),
      };
    }
  }

  const pipeline = [];
  const createdAt = nowIso(options);
  const bundleId = options.bundleId || bundleIdFromDate(options.now || new Date());
  const agentId = options.agentId || "main";
  const workspaceKey = options.mutationPolicy?.workspaceIdentity || options.workspaceKey || "main";
  const reviewProfiles = Array.isArray(options.reviewProfiles) && options.reviewProfiles.length
    ? options.reviewProfiles.map(normalizeReviewProfile)
    : ["standard", "maintenance"];

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

  // D2: vault_hygiene findings are separated from user-facing items.
  // They are system artefacts — the user cannot meaningfully approve or reject them.
  // They live in hygieneItems and are displayed in a dedicated section, not in the
  // candidate-changes queue that requires human approval.
  let hygieneItems = maintenanceFindingsToItems(maintenance, {
    bundleId,
    index: items.length,
    generatedAt: createdAt,
    agentId,
    reviewProfile: "maintenance",
  });
  pipeline.push("generate_review_proposals");

  items = items.map((item, index) => adversarialLightReviewItem(item, {
    bundleId,
    index,
    generatedAt: createdAt,
    agentId,
    reviewProfile: item.reviewProfile,
  }));
  hygieneItems = hygieneItems.map((item, index) => adversarialLightReviewItem(item, {
    bundleId,
    index: items.length + index,
    generatedAt: createdAt,
    agentId,
    reviewProfile: item.reviewProfile,
  }));
  pipeline.push("adversarial_light");

  items = dedupeItems(items).map((item, index) => ({ ...item, id: item.id || itemIdFromBundle(bundleId, index) }));
  hygieneItems = dedupeItems(hygieneItems).map((item, index) => ({ ...item, id: item.id || itemIdFromBundle(bundleId, items.length + index) }));
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
    written = writeReviewBundle(paths, bundle, items, hygieneItems, maintenance, options.mood ?? null, options);
    pipeline.push("write_review_bundle");
    // P3: Record bundle creation time for cooldown tracking (auto bundles only).
    if (bundleCooldownMs > 0 && isAutoBundleId) {
      const cooldownPath = join(paths.reviewPath, "bundle-cooldown.json");
      try {
        atomicWriteText(cooldownPath, JSON.stringify({ lastBundleAt: (options.now || new Date()).toISOString() }, null, 2) + "\n");
      } catch (_) {}
    }
  }
  pipeline.push("notify_user");

  pipeline.push("await_explicit_approval");

  const result = {
    status: paths.ok ? "prepared" : "blocked",
    ok: paths.ok,
    error: paths.ok ? null : paths.error,
    applied: false,
    bundle,
    items,
    hygieneItems,
    maintenance,
    written,
    pipeline,
  };

  if (bundleId && result.written !== null && result.items?.length > 0) {
    try {
      await autoApproveAndApplyLowRisk(rawConfig, bundleId, options);
    } catch (_) { /* best-effort — never block bundle creation */ }
  }

  return result;
}

export async function runMorningReview(rawConfig = {}, options = {}) {
  const result = await prepareReviewBundle(rawConfig, {
    ...options,
    reviewProfiles: options.reviewProfiles || ["standard", "maintenance"],
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

function renderEveningDeepReviewMarkdown(summary, mood = null) {
  let lead = null;
  try {
    lead = buildReviewNarrativeLead({
      findings: summary.maintenance?.count || 0,
      proposals: summary.adversarial?.reviewed?.length || 0,
      conflicts: summary.semanticConflicts?.count || 0,
      duplicates: summary.duplicates?.count || 0,
    }, mood);
  } catch { /* fail-open: missing or erroring module does not propagate */ }
  const row = (name, status, details) => `| ${name} | ${status.label} | ${details} |`;
  return [
    "# PLUR1BUS Evening Deep Review",
    "",
    ...(lead ? [lead, ""] : []),
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
          `- Open the listed ReviewBundle artifact in Obsidian for full item details.`,
          `- Approve low-risk items in Telegram: /plur1bus_review approve ${summary.pendingBundles[0]} low-risk`,
          `- Apply approved memory items: /plur1bus_review apply ${summary.pendingBundles[0]}`,
          `- Or reject all pending items: /plur1bus_review reject ${summary.pendingBundles[0]} all`,
          `- Refresh the Telegram summary: /plur1bus_review show ${summary.pendingBundles[0]}`,
        ]
      : [
          "- Open the listed ReviewBundle artifact in Obsidian for full item details.",
          "- Approve low-risk items in Telegram: /plur1bus_review approve low-risk",
          "- Apply approved memory items: /plur1bus_review apply",
          "- Or reject all pending items: /plur1bus_review reject all",
          "- Refresh the Telegram summary: /plur1bus_review show",
        ]),
    "",
    "Approval only marks items as approved. Apply is the only step that writes to memory.",
    "A Telegram reply does not need to repeat the bundle id. Without an id, show/explain/approve/reject use the latest pending bundle; apply uses the latest approved bundle.",
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

function inferWorkspaceKeyForAgent(agentId) {
  const value = String(agentId || "").trim();
  if (!value) return "";
  if (CANONICAL_WORKSPACE_AGENT_IDS.includes(value)) return value;
  const match = CANONICAL_WORKSPACE_AGENT_IDS.find((workspace) => value.startsWith(`${workspace}-`));
  return match || "";
}

function validateEveningDeepReviewContext(options = {}) {
  const agentId = String(options.agentId || "").trim();
  const workspaceKey = String(options.workspaceKey || "").trim();
  if (!agentId || !workspaceKey) {
    return {
      ok: false,
      error: "missing_evening_review_context",
      message: "Evening Deep Review requires explicit agentId and workspaceKey; refusing to default to main.",
      agentId: agentId || null,
      workspaceKey: workspaceKey || null,
    };
  }
  const inferredWorkspace = inferWorkspaceKeyForAgent(agentId);
  if (!inferredWorkspace || inferredWorkspace !== workspaceKey) {
    return {
      ok: false,
      error: "workspace_agent_mismatch",
      message: `Evening Deep Review context mismatch: agentId=${agentId} workspaceKey=${workspaceKey}.`,
      agentId,
      workspaceKey,
      inferredWorkspace: inferredWorkspace || null,
    };
  }
  return { ok: true, agentId, workspaceKey };
}

export function runEveningDeepReview(rawConfig = {}, options = {}) {
  const context = validateEveningDeepReviewContext(options);
  if (!context.ok) {
    return {
      ok: false,
      createdAt: nowIso(options),
      mode: "blocked",
      ...context,
    };
  }
  const { agentId, workspaceKey } = context;
  const createdAt = nowIso(options);
  const baseRecords = options.records || defaultLivingDashboardRecords(agentId, workspaceKey);
  const analysisOptions = {
    ...options,
    records: baseRecords,
    collections: options.collections || DEEP_ANALYSIS_RECORD_COLLECTIONS,
    deepReviewInput: true,
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
  }, renderEveningDeepReviewMarkdown(summary, options.mood ?? null), options);
  return summary;
}

function loadBundleRecord(rawConfig, bundleId, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) throw new Error(paths.error);
  const safeBundle = safeSlug(bundleId, "bundle");
  const jsonTarget = resolveUnder(paths.reviewPath, `review-bundles/${safeBundle}.items.json`, paths.cfg);
  const protectedRecord = options.mutationPolicy
    ? loadOwnedReviewBundle({ policy: options.mutationPolicy, bundleId })
    : null;
  const record = protectedRecord || (options.allowLegacyView === true ? readJson(jsonTarget, null) : null);
  if (!record) throw new Error(`ReviewBundle not found: ${bundleId}`);
  if (protectedRecord) {
    const ownerMatches = record.bundle?.createdByAgent === options.mutationPolicy.agentId
      && (record.bundle?.workspaceIdentity || record.bundle?.workspaceKey) === options.mutationPolicy.workspaceIdentity;
    if (!ownerMatches) throw new Error(`ReviewBundle not found: ${bundleId}`);
  }
  return { paths, record, jsonTarget, safeBundle, mutationPolicy: options.mutationPolicy || null };
}

function saveBundleRecord(loaded) {
  const { paths, record } = loaded;
  assertMutationAllowed(loaded.mutationPolicy, "review_write");
  const maintenance = record.maintenance || { findings: [] };
  const authoritative = updateOwnedReviewBundle({
    policy: loaded.mutationPolicy,
    bundleId: record.bundle.bundleId,
    update: () => record,
  });
  if (!authoritative) return null;
  if (mutationAllowed(loaded.mutationPolicy, "vault_write")) {
    writeReviewBundleDisplay(
      paths,
      record.bundle,
      record.items,
      record.hygieneItems || [],
      maintenance,
      null,
      { mutationPolicy: loaded.mutationPolicy },
    );
  }
  return record;
}

function selectItems(items, selector) {
  const raw = String(selector || "all").trim();
  if (raw === "all") return new Set(items.map((item) => item.id));
  if (raw === "low-risk") return new Set(items.filter((item) => item.risk === "low").map((item) => item.id));
  const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
  return new Set(ids);
}

function itemIsClosed(item = {}) {
  return ["applied", "rejected", "blocked", "snoozed", "stale", "invalid"].includes(item.status);
}

function updateReviewItemStatus(item, status, options = {}) {
  if (["applied", "blocked"].includes(item.status)) return { item, changed: 0 };
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
  return {
    changed: 1,
    item: {
      ...item,
      status,
      approvedPayloadHash: status === "approved" ? approvedPayloadHash : item.approvedPayloadHash || "",
      approvalMetadata,
      snoozedUntil: status === "snoozed" ? options.until || "" : item.snoozedUntil || "",
      updatedAt: nowIso(options),
    },
  };
}

export function updateReviewBundleItems(rawConfig, bundleId, action, selector = "all", options = {}) {
  assertMutationAllowed(options.mutationPolicy, "review_write");
  const loaded = loadBundleRecord(rawConfig, bundleId, options);
  const selected = selectItems(loaded.record.items, selector);
  const selectedHygiene = action === "approve"
    ? new Set()
    : selectItems(loaded.record.hygieneItems || [], selector);
  const status = action === "approve" ? "approved"
    : action === "reject" ? "rejected"
      : action === "snooze" ? "snoozed"
        : null;
  if (!status) throw new Error(`Unsupported review action: ${action}`);
  let changed = 0;
  loaded.record.items = loaded.record.items.map((item) => {
    if (!selected.has(item.id)) return item;
    const updated = updateReviewItemStatus(item, status, options);
    changed += updated.changed;
    return updated.item;
  });
  loaded.record.hygieneItems = (loaded.record.hygieneItems || []).map((item) => {
    if (!selectedHygiene.has(item.id)) return item;
    const updated = updateReviewItemStatus(item, status, options);
    changed += updated.changed;
    return updated.item;
  });
  const allItems = [...loaded.record.items, ...(loaded.record.hygieneItems || [])];
  if (allItems.length > 0 && allItems.every(itemIsClosed)) {
    loaded.record.bundle.status = "reviewed";
  }
  saveBundleRecord(loaded);
  return { bundleId, action, selector, changed, items: loaded.record.items, hygieneItems: loaded.record.hygieneItems || [] };
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
  if (options.paths && ["memory_promotion", "note_import_candidate", "knowledge_update", "task_suggestion"].includes(item.type)) {
    const sourceRel = sourceRelPathFromReviewItem(item);
    const boundary = validateAgentScopedSourcePath(options.paths, sourceRel, options);
    if (!boundary.ok) return boundary.reason;
  }
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
  assertMutationAllowed(options.mutationPolicy, "review_write");
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
    const safety = applySafetyBlock(item, { ...options, paths, rawConfig });
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
      assertMutationAllowed(options.mutationPolicy, "memory_write");
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
      assertMutationAllowed(options.mutationPolicy, "knowledge_write");
      if (typeof options.knowledgeUpdate !== "function") {
        item.status = "blocked";
        item.blockedReason = "No knowledgeUpdate callback available in this runtime.";
        blocked.push({ id: item.id, reason: item.blockedReason });
        continue;
      }
      await options.knowledgeUpdate({ item, payload: approvedMemoryStorePayload(item) });
    } else if (item.type === "task_suggestion") {
      assertMutationAllowed(options.mutationPolicy, "vault_write");
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

  // Auto-apply vault hygiene items — they are system artefacts and do not require user review.
  // D2: hygieneItems are separate from user-facing items; apply marks them processed automatically.
  // NOTE: hygiene items are NOT added to `applied` (the user-item counter) — they are tracked
  // via result.hygieneItems and counted in reviewEffectSummary as review-only hygiene.
  for (const hygieneItem of (record.hygieneItems || [])) {
    if (["applied", "rejected"].includes(hygieneItem.status)) continue;
    hygieneItem.status = "applied";
    hygieneItem.appliedAt = nowIso(options);
  }

  const allItems = [...record.items, ...(record.hygieneItems || [])];
  if (allItems.length > 0 && allItems.every(itemIsClosed)) {
    record.bundle.status = "reviewed";
  } else if (applied.length === 0 && blocked.length === 0) {
    record.bundle.status = "pending_user_review";
  }
  saveBundleRecord(loaded);
  return { bundleId, applied, blocked, items: record.items, hygieneItems: record.hygieneItems || [] };
}

// D1/B: automatically reject bundles that have been pending longer than staleBundleMaxAgeDays.
// This drains the review backlog without any user action — stale items are rejected and archived.
export function expireStaleBundles(rawConfig = {}, options = {}) {
  if (!mutationAllowed(options.mutationPolicy, "review_write")) {
    return {
      expired: 0,
      expiredIds: [],
      applied: false,
      reason: "mutation_policy_denied",
      deniedGates: closedMutationGates(options.mutationPolicy),
    };
  }
  const maxAgeDays = Number.isFinite(options.staleBundleMaxAgeDays) ? options.staleBundleMaxAgeDays : 7;
  const maxAgeMs = maxAgeDays * 86_400_000;
  const now = options.now ? new Date(options.now) : new Date();
  const expiredIds = [];
  for (const record of listOwnedReviewBundles({ policy: options.mutationPolicy })) {
    if (!record?.bundle) continue;
    if (record.bundle.status !== "pending_user_review") continue;
    const createdAt = record.bundle.createdAt ? new Date(record.bundle.createdAt) : null;
    if (!createdAt || !Number.isFinite(createdAt.getTime())) continue;
    if ((now - createdAt) < maxAgeMs) continue;
    // Mark all pending items as rejected and the bundle as expired
    record.items = (record.items || []).map((item) =>
      (!item.status || item.status === "pending") ? { ...item, status: "rejected", rejectedReason: "auto_expired", updatedAt: now.toISOString() } : item
    );
    record.hygieneItems = (record.hygieneItems || []).map((item) =>
      (!item.status || item.status === "pending") ? { ...item, status: "rejected", rejectedReason: "auto_expired", updatedAt: now.toISOString() } : item
    );
    record.bundle.status = "expired";
    record.bundle.expiredAt = now.toISOString();
    updateOwnedReviewBundle({
      policy: options.mutationPolicy,
      bundleId: record.bundle.bundleId,
      update: () => record,
    });
    expiredIds.push(record.bundle.bundleId);
  }
  return { expired: expiredIds.length, expiredIds };
}

// D1/A: auto-approve pending low-risk items that passed adversarial review, then apply them.
// Opt-in via cfg.autoApplyLowRisk — default false so existing setups are not affected.
// vault_hygiene items are excluded (D2 handles those separately).
// If options.memoryStore is absent, memory_promotion items land in blocked (safe deferral).
export async function autoApproveAndApplyLowRisk(rawConfig = {}, bundleId, options = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  if (!cfg.autoApplyLowRisk) return { autoApproved: 0, autoApplied: 0, blocked: [] };

  let loaded;
  try {
    loaded = loadBundleRecord(rawConfig, bundleId, options);
  } catch (_) {
    return { autoApproved: 0, autoApplied: 0, blocked: [] };
  }
  if (!loaded?.record) return { autoApproved: 0, autoApplied: 0, blocked: [] };

  const candidates = loaded.record.items.filter(
    (item) =>
      item.status === "pending" &&
      item.risk === "low" &&
      item.adversarialReview?.status === "pass" &&
      item.type !== "vault_hygiene"
  );
  if (candidates.length === 0) return { autoApproved: 0, autoApplied: 0, blocked: [] };

  const nowIsoStr = (options.now ? new Date(options.now) : new Date()).toISOString();
  for (const item of candidates) {
    item.status = "approved";
    item.approvedAt = nowIsoStr;
    item.approvedBy = "auto";
  }
  saveBundleRecord(loaded);

  const applyResult = await applyApprovedReviewBundle(rawConfig, bundleId, options);
  return {
    autoApproved: candidates.length,
    autoApplied: applyResult.applied.length,
    blocked: applyResult.blocked,
  };
}

// U7: produce a ready-to-use Obsidian memory card template with all required fields.
// The bridge scanner recognises sync_status: draft as a user-created candidate and fills
// content_hash on the first scan, so the template intentionally leaves it blank.
export function generateMemoryCardTemplate(options = {}) {
  const workspaceId = options.workspaceId || "main";
  const agentId = options.agentId || "main";
  const body = options.body || "<!-- Describe the memory here. Delete this comment. -->";
  const frontmatter = [
    "---",
    "plur1bus_type: memory_card",
    `workspace_id: ${workspaceId}`,
    `agent_id: ${agentId}`,
    "memory_id: ",
    "category: fact",
    "importance: 0.7",
    "scope: workspace",
    "source_kind: obsidian",
    "sync_status: draft",
    "content_hash: ",
    "validated: false",
    `updated_at: ${options.updatedAt || new Date().toISOString()}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
  return frontmatter;
}

export function writeCommandsMarkdown(rawConfig = {}, options = {}) {
  if (!mutationAllowed(options.mutationPolicy, "vault_write")) {
    return {
      written: false,
      applied: false,
      reason: "mutation_policy_denied",
      deniedGates: closedMutationGates(options.mutationPolicy),
    };
  }
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) return { written: false, reason: "paths-not-ok" };
  if (paths.cfg.allowWrite === false) return { written: false, reason: "allowWrite-false" };
  const generatedAt = (options.now ? new Date(options.now) : new Date()).toISOString();
  const content = [
    "---",
    "plur1bus_type: command_reference",
    `generated_at: ${generatedAt}`,
    `obsidian_bridge_version: ${OBSIDIAN_CONTROL_ROOM_VERSION}`,
    "---",
    "",
    "# PLUR1BUS Commands",
    "",
    obsidianCommandHelp(),
    "",
  ].join("\n");
  const destPath = resolveUnder(paths.reviewPath, "commands.md", paths.cfg);
  atomicWriteText(destPath, content);
  return { written: true, path: destPath };
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
  assertMutationAllowed(options.mutationPolicy, "vault_write");
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) return { ok: false, error: paths.error, conflicts: [] };
  maybeCreateReviewLayout(paths, { ...options, createLayout: true });
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

function workspaceMatchesCommandPlan(workspace, commandPlan) {
  let workspaceIdentity;
  try {
    workspaceIdentity = normalizeWorkspaceTarget(
      workspace.workspaceId,
      "Obsidian configured workspace identity",
    );
  } catch {
    return false;
  }
  return workspace.agentId === commandPlan.selectors.agentId
    && workspaceIdentity === commandPlan.selectors.workspaceIdentity;
}

function selectCommandWorkspaces(rawConfig = {}, commandPlan, context = {}) {
  const configured = discoverObsidianWorkspaces(rawConfig)
    .filter((workspace) => workspaceMatchesCommandPlan(workspace, commandPlan));
  if (configured.length > 0) return configured;
  const workspaceDir = context.workspaceDir || context.commandCtx?.workspaceDir;
  if (!workspaceDir) return [];
  return [{
    workspaceId: commandPlan.selectors.workspaceIdentity,
    agentId: commandPlan.selectors.agentId,
    label: commandPlan.selectors.workspaceIdentity,
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
  const workspaces = options.workspaces
    || selectCommandWorkspaces(rawConfig, options.commandPlan, options.context || {});
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
    ["explain", "explain"],
    ["explanation", "explain"],
    ["summary", "explain"],
    ["summarize", "explain"],
    ["erklaeren", "explain"],
    ["erklären", "explain"],
    ["aufdroeseln", "explain"],
    ["aufdröseln", "explain"],
    ["was", "explain"],
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
  if (options.mutationPolicy) {
    return latestOwnedReviewBundleId({ policy: options.mutationPolicy });
  }
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
    const hygieneItems = Array.isArray(record.hygieneItems) ? record.hygieneItems : [];
    entries.push({
      bundleId,
      record,
      sortAt: bundleCreatedAt(record, mtimeMs),
      actionable: [...items, ...hygieneItems].some((item) => !item.status || item.status === "pending"),
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

function formatDurationMs(ms = 0) {
  const seconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes <= 0) return `${restSeconds}s`;
  if (restSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${restSeconds}s`;
}

// ─── Telegram-UX: Deutsche Formatierungs-Helfer ───────────────────────────────

// Deutschen Datumsstring: "27. Mai 2026, 14:29"
function formatGermanDate(isoString) {
  const MONTHS = ["Januar","Februar","März","April","Mai","Juni",
                  "Juli","August","September","Oktober","November","Dezember"];
  const date = new Date(isoString || Date.now());
  if (Number.isNaN(date.getTime())) return String(isoString || "");
  const day = date.getUTCDate();
  const month = MONTHS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day}. ${month} ${year}, ${hh}:${mm}`;
}

// Mappt technische Labels auf deutsche Emoji-Titel
function telegramBundleTitle(label = "") {
  if (label.includes("Morning")) return "🌅 Morgen-Review";
  if (label.includes("Evening")) return "🌙 Abend-Review";
  if (label.includes("Weekly")) return "📅 Wochen-Review";
  return "🧠 Memory Review";
}

// Einzelne Finding-Zeile: kein Code-Bezeichner, kein Pfad, nur Beschreibung
function telegramFindingLine(finding = {}) {
  const desc = describeFinding(finding);
  const repeat = finding.count > 1 ? ` (${finding.count}×)` : "";
  return `• ${desc}${repeat}`;
}

function telegramPreviewLines(userItems = [], maxPreview = 3) {
  const pending = (Array.isArray(userItems) ? userItems : [])
    .filter((i) => !i.status || i.status === "pending");
  const previewable = pending.filter((i) =>
    ["note_import_candidate", "memory_promotion"].includes(i.type));
  const tasks = pending.filter((i) => i.type === "task_suggestion");
  const other = pending.filter((i) =>
    !["note_import_candidate", "memory_promotion", "task_suggestion"].includes(i.type));

  const lines = [];

  for (const item of previewable.slice(0, maxPreview)) {
    const name = (item.target || item.id || "unbekannt").split("/").pop();
    const text = item.applyPreview?.payload?.text || item.reason || item.action || "";
    const snippet = shortenText(text, 55);
    lines.push(snippet ? `• ${name} — ${snippet}` : `• ${name}`);
  }

  const hiddenPreviewable = Math.max(0, previewable.length - maxPreview);
  const restParts = [];
  if (hiddenPreviewable > 0) {
    restParts.push(`${hiddenPreviewable} ${hiddenPreviewable === 1 ? "Notiz" : "Notizen"}`);
  }
  if (tasks.length > 0) {
    restParts.push(`${tasks.length} Aufgabe${tasks.length === 1 ? "" : "n"}`);
  }
  if (other.length > 0) {
    restParts.push(`${other.length} weitere`);
  }
  if (restParts.length > 0) {
    lines.push(`• … ${restParts.join(", ")}`);
  }

  return lines.join("\n");
}

// Risiko-Zusammenfassung auf Deutsch: "• Risiko: 12× niedrig, 3× mittel"
function telegramRiskSummary(items = []) {
  const LABELS = { low: "niedrig", medium: "mittel", high: "hoch", critical: "kritisch" };
  const ORDER  = ["critical", "high", "medium", "low"];
  const counts = {};
  for (const item of Array.isArray(items) ? items : []) {
    const r = item.risk || "low";
    counts[r] = (counts[r] || 0) + 1;
  }
  const parts = ORDER.filter((r) => counts[r] > 0).map((r) => `${counts[r]}× ${LABELS[r]}`);
  return parts.length ? `• Risiko: ${parts.join(", ")}` : "";
}

// Einfacher Next-Step-Block ohne Bundle-IDs
function telegramNextSteps(mode = {}, hasBlocks = false) {
  if (mode.kind === "maintenance") {
    return "ℹ️ Kein Memory-Handeln nötig — `show` für Details";
  }
  if (hasBlocks) {
    return "⚠️ Bitte Sicherheitswarnungen prüfen\n➡️ approve → apply";
  }
  return "➡️ approve low-risk → apply";
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

function describeFinding(finding = {}) {
  const code = finding.code || finding.type || finding.evidence?.[0] || "";
  if (code === "managed_block_hash_mismatch") {
    return "Interner Block wurde verändert — wird beim Anwenden korrigiert";
  }
  if (code === "generated_link_review") {
    return "Dashboard-Link zu prüfen (meist kein Problem)";
  }
  return finding.message || finding.reason || finding.action || "Bitte prüfen.";
}

function formatFinding(finding = {}) {
  const severity = finding.severity || finding.kind || "warning";
  const code = finding.code || finding.type || finding.evidence?.[0] || "";
  const subject = describeFinding(finding);
  const location = finding.path || finding.target || finding.id || "";
  const codeHint = code ? ` (${code}${location ? `, ${location}` : ""})` : location ? ` (${location})` : "";
  const detail = finding.message && finding.message !== subject ? finding.message : "";
  const repeat = finding.count > 1 ? ` (${finding.count}x)` : "";
  return `- ${severity}: ${subject}${repeat}${codeHint}${detail ? ` - ${detail}` : ""}`;
}

function reviewBundleMode(items = [], hygieneItems = []) {
  const list = Array.isArray(items) ? items : [];
  const hygiene = Array.isArray(hygieneItems) ? hygieneItems : [];
  const hasMemoryReview = list.some((item) => MEMORY_REVIEW_ITEM_TYPES.has(item.type));
  // hasMaintenance: vault_hygiene either in items (legacy path) or in hygieneItems (new path)
  const hasMaintenance = hygiene.length > 0 || list.some((item) => item.type === "vault_hygiene");
  // maintenanceOnly: no user-facing items at all, only hygiene work to do
  const maintenanceOnly = (list.length === 0 && hygiene.length > 0)
    || (list.length > 0 && list.every((item) => item.type === "vault_hygiene"));
  if (maintenanceOnly) {
    return {
      kind: "maintenance",
      label: "Maintenance only",
      description: "Vault maintenance only - no memory import",
    };
  }
  if (hasMemoryReview && hasMaintenance) {
    return {
      kind: "mixed",
      label: "Mixed review",
      description: "Memory candidates plus vault maintenance findings",
    };
  }
  if (hasMemoryReview) {
    return {
      kind: "memory",
      label: "Memory review",
      description: "Memory import or promotion candidates",
    };
  }
  return {
    kind: "review",
    label: "Review",
    description: "Non-memory review items",
  };
}

function reviewChecklist(bundleId, mode = reviewBundleMode([])) {
  if (mode.kind === "maintenance") {
    return [
      "- [ ] Review vault maintenance findings.",
      `- [ ] Inspect details with \`/plur1bus_review show ${bundleId}\`.`,
      `- [ ] Explain findings with \`/plur1bus_review explain ${bundleId}\`.`,
      "- [ ] Reject/close if expected with `/plur1bus_review reject all`.",
    ];
  }
  return [
    "- [ ] Review warnings and blocked items.",
    "- [ ] Open this ReviewBundle in Obsidian for full item details.",
    `- [ ] Refresh the Telegram summary with \`/plur1bus_review show ${bundleId}\`.`,
    `- [ ] Approve low-risk items with \`/plur1bus_review approve ${bundleId} low-risk\`.`,
    `- [ ] Reject all pending items with \`/plur1bus_review reject ${bundleId} all\`.`,
    `- [ ] Run \`/plur1bus_review apply ${bundleId}\` after approval.`,
  ];
}

function reviewActionSummary(result = {}) {
  const action = result.action || "review";
  const mode = reviewBundleMode(result.items || [], result.hygieneItems || []);
  const next = action === "approve"
    ? mode.kind === "maintenance"
      ? "No memory approval is needed; reject/close if expected with /plur1bus_review reject all."
      : `Next: /plur1bus_review apply ${result.bundleId || ""}`.trim()
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

function shortenText(value = "", max = 110) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function obsidianCommandHelp() {
  return [
    "PLUR1BUS quick commands:",
    "",
    "- /plur1bus_morning - prepare today's review proposals",
    "- /plur1bus_evening - run the deep evening checks",
    "- /plur1bus_review - show the latest pending ReviewBundle",
    "- /plur1bus_review explain - explain what was applied and what wrote memory",
    "- /plur1bus_review approve low-risk - mark safe low-risk items approved",
    "- /plur1bus_review reject all - mark all pending items rejected",
    "- /plur1bus_review apply - write approved memory candidates to memory",
    "- /plur1bus_review quickapply - approve low-risk items and apply them in one explicit step",
    "",
    "Normal memory flow: review -> approve or reject -> apply.",
    "Fast low-risk flow: quickapply -> revalidate -> apply. Medium/high-risk and blocked items stay pending.",
    "Maintenance-only bundles say 'Vault maintenance only - no memory import' and can be inspected, explained, or rejected/closed without approval.",
    "Morning, evening, review, and approve do not write memory. Apply is the only memory write step, and only memory-candidate items can become Memory DB writes.",
    "Bundle id is optional in Telegram replies and short commands. Without an id, review/show/explain/approve/reject use the latest pending bundle; apply uses the latest approved bundle.",
    "Advanced: /plur1bus help advanced",
  ].join("\n");
}

function reviewEffectSummary(items = [], hygieneItems = []) {
  const list = Array.isArray(items) ? items : [];
  const hygiene = Array.isArray(hygieneItems) ? hygieneItems : [];
  const applied = list.filter((item) => item.status === "applied");
  const appliedHygiene = hygiene.filter((item) => item.status === "applied");
  const memoryWrites = applied.filter((item) => ["memory_promotion", "note_import_candidate"].includes(item.type) && item.appliedMemoryId);
  const knowledgeWrites = applied.filter((item) => item.type === "knowledge_update");
  const taskWrites = applied.filter((item) => item.type === "task_suggestion");
  // reviewOnly: applied items that produced no DB/file writes, plus applied hygiene items (always review-only)
  const reviewOnly = [
    ...applied.filter((item) => !memoryWrites.includes(item) && !knowledgeWrites.includes(item) && !taskWrites.includes(item)),
    ...appliedHygiene,
  ];
  const pending = list.filter((item) => !item.status || item.status === "pending");
  const pendingHygiene = hygiene.filter((item) => !item.status || item.status === "pending");
  const blocked = list.filter((item) => item.status === "blocked" || item.status === "stale" || item.status === "invalid");
  const sourceAgents = formatCounts(countByValue(applied, (item) => item.proposedByAgent || item.reviewProfile || "unknown"), 3);
  return {
    applied,
    memoryWrites,
    knowledgeWrites,
    taskWrites,
    reviewOnly,
    pending,
    pendingHygiene,
    blocked,
    sourceAgents,
  };
}

function formatAppliedExamples(items = [], max = 8) {
  const examples = items.slice(0, max).map((item) => {
    const payload = item.applyPreview?.payload || {};
    const summary = payload.text || payload.summary || reviewItemSummary(item);
    const memory = item.appliedMemoryId ? ` -> ${item.appliedMemoryId}` : "";
    return `- ${reviewItemTypeLabel(item)}: ${item.target || item.id}${memory}${summary ? ` - ${shortenText(summary)}` : ""}`;
  });
  if (items.length > max) examples.push(`- ... ${items.length - max} more`);
  return examples.length ? examples.join("\n") : "- None.";
}

function reviewItemSummary(item = {}) {
  if (item.type === "vault_hygiene") {
    return describeFinding({
      code: item.evidence?.[0],
      type: item.evidence?.[0],
      message: item.reason || item.action,
    });
  }
  return item.blockedReason || item.reason || item.action || "Review pending.";
}

function reviewItemTypeLabel(item = {}) {
  if (item.type === "vault_hygiene") return "Vault hygiene";
  if (item.type === "note_import_candidate") return "Memory import candidate";
  if (item.type === "memory_promotion") return "Memory promotion";
  if (item.type === "task_suggestion") return "Task suggestion";
  if (item.type === "knowledge_update") return "Knowledge update";
  return item.type || "Review item";
}

function formatPendingExamples(items = [], max = 6) {
  const examples = items.slice(0, max).map((item) => `- ${reviewItemTypeLabel(item)}: ${item.target || item.id} - ${shortenText(reviewItemSummary(item))}`);
  if (items.length > max) examples.push(`- ... ${items.length - max} more`);
  return examples.length ? examples.join("\n") : "- None.";
}

function reviewExplainSummary(result = {}, label = "PLUR1BUS ReviewBundle explanation") {
  const bundle = result.bundle || result.record?.bundle || {};
  const items = Array.isArray(result.items) ? result.items : Array.isArray(result.record?.items) ? result.record.items : [];
  const hygieneItems = Array.isArray(result.hygieneItems) ? result.hygieneItems : Array.isArray(result.record?.hygieneItems) ? result.record.hygieneItems : [];
  const legacyHygieneItems = items.filter((item) => item.type === "vault_hygiene");
  const userItems = items.filter((item) => item.type !== "vault_hygiene");
  const allHygieneItems = [...hygieneItems, ...legacyHygieneItems];
  const allReviewItems = [...userItems, ...allHygieneItems];
  const mode = reviewBundleMode(items, hygieneItems);
  // Pass hygieneItems so applied hygiene counts appear in reviewOnly and pending hygiene in still-open
  const effects = reviewEffectSummary(items, hygieneItems);
  const approved = countBy(items, (item) => item.status === "approved");
  const rejected = countBy(items, (item) => item.status === "rejected");
  const snoozed = countBy(items, (item) => item.status === "snoozed");
  // Pending hygiene items appear in "Still open" with human-readable descriptions
  const pendingHygiene = hygieneItems.filter((item) => !item.status || item.status === "pending");
  return [
    label,
    `Bundle: ${bundle.bundleId || "n/a"}`,
    `${formatReviewTimestamp(bundle.createdAt)} | Workspace: ${bundle.workspaceKey || "main"} | Agent: ${bundle.createdByAgent || "main"}`,
    `Review mode: ${mode.label} | ${mode.description}`,
    "",
    "## What changed",
    "",
    `- Total items: ${items.length}`,
    `- Marked applied: ${effects.applied.length}`,
    `- Memory DB writes: ${effects.memoryWrites.length}`,
    `- Knowledge updates: ${effects.knowledgeWrites.length}`,
    `- Task/proposal files: ${effects.taskWrites.length}`,
    `- Review-only hygiene items: ${effects.reviewOnly.length}`,
    `- Still pending: ${effects.pending.length}`,
    `- Blocked/stale/invalid: ${effects.blocked.length}`,
    `- Approved but not applied: ${approved}`,
    `- Rejected: ${rejected}`,
    `- Snoozed: ${snoozed}`,
    `- Proposed by: ${effects.sourceAgents}`,
    "",
    "## Written to memory DB",
    "",
    ...(mode.kind === "maintenance" ? ["No memory DB writes were possible or needed."] : []),
    formatAppliedExamples(effects.memoryWrites),
    "",
    "## Applied but not memory DB writes",
    "",
    formatAppliedExamples([...effects.knowledgeWrites, ...effects.taskWrites, ...effects.reviewOnly]),
    "",
    "## Still open",
    "",
    formatPendingExamples([...effects.pending, ...effects.blocked, ...pendingHygiene]),
    "",
    "Apply means PLUR1BUS processed an approved item. Only Memory DB writes become LanceDB memories. Vault hygiene and task items can be marked applied without creating a memory entry.",
  ].join("\n");
}

export function reviewBundleSummary(result = {}, label = "PLUR1BUS ReviewBundle") {
  // ── Cooldown-Fall ────────────────────────────────────────────────────────
  if (result.status === "skipped_cooldown") {
    const remaining = formatDurationMs(result.cooldownRemainingMs);
    const lines = [
      `${telegramBundleTitle(label)} — ${formatGermanDate(result.createdAt)}`,
      `Kurze Pause: Nächstes Bundle in ${remaining} möglich.`,
    ];
    if (result.latestBundleId) lines.push("Vorhandenes Bundle: `show`");
    return lines.join("\n");
  }

  // ── Daten auflösen ───────────────────────────────────────────────────────
  const bundle = result.bundle || result.record?.bundle || {};
  const items = Array.isArray(result.items)
    ? result.items
    : Array.isArray(result.record?.items) ? result.record.items : [];
  const hygieneItems = Array.isArray(result.hygieneItems)
    ? result.hygieneItems
    : Array.isArray(result.record?.hygieneItems) ? result.record.hygieneItems : [];
  const legacyHygiene = items.filter((i) => i.type === "vault_hygiene");
  const userItems = items.filter((i) => i.type !== "vault_hygiene");
  const allHygiene = [...hygieneItems, ...legacyHygiene];
  const mode = reviewBundleMode(items, hygieneItems);

  const maintenanceFindings = Array.isArray(result.maintenance?.findings)
    ? result.maintenance.findings
    : Array.isArray(result.record?.maintenance?.findings)
      ? result.record.maintenance.findings : [];

  const SYSTEM_CODES = new Set(["managed_block_hash_mismatch", "generated_link_review"]);
  const systemFindings = dedupeFindings(
    maintenanceFindings.filter((f) => SYSTEM_CODES.has(f.code || f.type))
  );
  const nonSystemFindings = maintenanceFindings.filter((f) => !SYSTEM_CODES.has(f.code || f.type));

  const maintenanceErrors = countBy(nonSystemFindings, (f) => f.severity === "error");
  const maintenanceWarnings = countBy(nonSystemFindings, (f) => f.severity === "warning");
  const systemErrors = countBy(systemFindings, (f) => f.severity === "error");
  const systemWarnings = countBy(systemFindings, (f) => f.severity === "warning");
  const adversarialBlocks = countBy(userItems, (i) => i.adversarialReview?.status === "block");
  const adversarialWarnings = countBy(userItems, (i) => i.adversarialReview?.status === "warning");
  const totalUserItems = userItems.length;
  const pending = countBy(userItems, (i) => !i.status || i.status === "pending");
  const approved = countBy(userItems, (i) => i.status === "approved");

  // ── Titel & Untertitel ───────────────────────────────────────────────────
  const title = `${telegramBundleTitle(label)} — ${formatGermanDate(bundle.createdAt)}`;
  const subtitle = mode.kind === "maintenance"
    ? "Nur Systemwartung · Kein Memory-Import"
    : "Vorschau-Modus · Noch nichts gespeichert ✋";

  // ── Status-Zeilen ────────────────────────────────────────────────────────
  let adversarialLine = null;
  if (adversarialBlocks > 0) {
    adversarialLine = `❌ Sicherheitsprüfung: ${adversarialBlocks} blockiert`;
  } else if (adversarialWarnings > 0) {
    adversarialLine = `⚠️ Sicherheitsprüfung: ${adversarialWarnings} Warnung${adversarialWarnings === 1 ? "" : "en"}`;
  }
  // Kein else-Branch — alles OK bleibt still

  let maintenanceLine = null;
  const allMaintenanceErrors = maintenanceErrors + systemErrors;
  const allMaintenanceWarnings = maintenanceWarnings + systemWarnings;
  if (maintenanceFindings.length > 0) {
    if (allMaintenanceErrors > 0) {
      maintenanceLine = `❌ System: ${allMaintenanceErrors} Fehler — automatisch verwaltet`;
    } else if (allMaintenanceWarnings > 0) {
      maintenanceLine = `⚠️ System: ${allMaintenanceWarnings} Hinweis${allMaintenanceWarnings === 1 ? "" : "e"} — automatisch verwaltet`;
    } else {
      maintenanceLine = `✅ System: keine Probleme`;
    }
  }

  // ── Inhalt: Vorschläge ───────────────────────────────────────────────────
  const previewLines = telegramPreviewLines(userItems);
  const riskLine = telegramRiskSummary([...userItems, ...allHygiene]);

  // ── Adversarial-Warnungen (User muss handeln) ────────────────────────────
  const adversarialProblem = dedupeFindings(
    userItems
      .filter((i) => ["block", "warning"].includes(i.adversarialReview?.status))
      .map((i) => ({
        ...i,
        severity: i.adversarialReview.status === "block" ? "error" : "warning",
        message: i.adversarialReview.reason || i.reason,
      }))
  );

  // ── Ausgabe zusammenbauen ────────────────────────────────────────────────
  const out = [title, subtitle, ""];

  if (adversarialLine) out.push(adversarialLine);
  if (maintenanceLine) out.push(maintenanceLine);

  // Vorschläge-Sektion
  if (totalUserItems > 0) {
    out.push("");
    const pendingItems = userItems.filter((i) => !i.status || i.status === "pending");
    const allPreviewable = pendingItems.length > 0 && pendingItems.every((i) =>
      ["note_import_candidate", "memory_promotion"].includes(i.type));
    const allTasks = pendingItems.length > 0 && pendingItems.every((i) => i.type === "task_suggestion");
    const bucketLabel = allTasks
      ? (totalUserItems === 1 ? "1 Aufgabe" : `${totalUserItems} Aufgaben`)
      : allPreviewable
        ? (totalUserItems === 1 ? "1 neue Notiz" : `${totalUserItems} neue Notizen`)
        : (totalUserItems === 1 ? "1 Vorschlag" : `${totalUserItems} Vorschläge`);
    const pendingExtra = approved > 0 && pending < totalUserItems
      ? ` (${pending} offen, ${approved} freigegeben)` : "";
    out.push(`📋 ${bucketLabel}${pendingExtra}:`);
    if (previewLines) out.push(previewLines);
    if (riskLine) out.push(riskLine);
  } else if (mode.kind === "maintenance" && allHygiene.length > 0) {
    out.push("");
    out.push(`🔧 ${allHygiene.length} Systemwartungs-Einträge`);
  }

  // Adversarial-Probleme (User-Handeln nötig)
  if (adversarialProblem.length > 0) {
    out.push("");
    out.push("⚠️ Bitte prüfen:");
    out.push(...adversarialProblem.slice(0, 5).map(telegramFindingLine));
    if (adversarialProblem.length > 5) out.push(`• … ${adversarialProblem.length - 5} weitere`);
  }

  // Systemhinweise (kein Handeln nötig)
  if (systemFindings.length > 0) {
    out.push("");
    out.push("Systemhinweise (kein Handeln nötig):");
    out.push(...systemFindings.slice(0, 6).map(telegramFindingLine));
    if (systemFindings.length > 6) out.push(`• … ${systemFindings.length - 6} weitere`);
  }

  // Non-system maintenance findings (ernst, aber auto-verwaltet)
  if (nonSystemFindings.length > 0) {
    out.push("");
    out.push("Wartungshinweise:");
    out.push(...dedupeFindings(nonSystemFindings).slice(0, 4).map(telegramFindingLine));
  }

  // Next Step
  out.push("");
  out.push(telegramNextSteps(mode, adversarialBlocks > 0));

  if (result.note) out.push("", result.note);

  return out.filter((line) => line !== null && line !== undefined).join("\n");
}

export function eveningReviewSummary(summary = {}) {
  const checks = summary.status || {};
  const findings = dedupeFindings(
    Array.isArray(summary.blockedOrWarningItems) ? summary.blockedOrWarningItems : []
  );
  const pending = summary.pendingItems ?? 0;

  // Status-Zeilen auf Deutsch
  const CHECK_NAMES = {
    maintenance: "Systemprüfung",
    adversarial: "Sicherheit",
    semanticConflicts: "Konflikte",
    duplicates: "Duplikate",
    provenance: "Herkunft",
    impact: "Auswirkung",
    dashboards: "Dashboards",
  };
  const statusLines = Object.entries(CHECK_NAMES)
    .filter(([key]) => checks[key] !== undefined)
    .map(([key, name]) => {
      const s = checks[key];
      const icon = s?.label === "error" || s?.label === "block" ? "❌"
        : s?.label === "warning" ? "⚠️" : "✅";
      const count = s?.count != null ? ` (${s.count})` : "";
      return `${icon} ${name}${count}`;
    });

  const out = [
    `🌙 Abend-Review — ${formatGermanDate(summary.createdAt)}`,
    "Nur Vorschau · Noch nichts gespeichert",
    "",
    ...statusLines,
  ];

  if (findings.length > 0) {
    out.push("");
    out.push("⚠️ Bitte prüfen:");
    out.push(...findings.slice(0, 5).map(telegramFindingLine));
    if (findings.length > 5) out.push(`• … ${findings.length - 5} weitere`);
  }

  out.push("");
  if (pending > 0) {
    out.push(`📋 ${pending} Vorschlag${pending === 1 ? "" : "ä"}ge warten`);
  } else {
    out.push("✅ Keine Vorschläge offen");
  }

  out.push("");
  out.push("➡️ approve low-risk → apply");

  return out.join("\n");
}

export function quickapplySummary(applyResult = {}) {
  const applied = Array.isArray(applyResult.applied) ? applyResult.applied.length : 0;
  const blocked = Array.isArray(applyResult.blocked) ? applyResult.blocked.length : 0;
  const effects = reviewEffectSummary(applyResult.items || [], applyResult.hygieneItems || []);

  const lines = [];
  if (applied > 0) {
    lines.push(`✅ ${applied} ${applied === 1 ? "Eintrag" : "Einträge"} gespeichert`);
  }
  if (effects.pending.length > 0) {
    lines.push(`⏳ ${effects.pending.length} ${effects.pending.length === 1 ? "Vorschlag wartet" : "Vorschläge warten"} noch (mittleres/hohes Risiko)`);
    lines.push("→ show für Details");
  }
  if (blocked > 0) {
    lines.push(`⚠️ ${blocked} ${blocked === 1 ? "Eintrag" : "Einträge"} blockiert — show für Details`);
  }
  if (applied === 0 && effects.pending.length === 0 && blocked === 0) {
    lines.push("✅ Nichts zu tun — keine freigegebenen Einträge.");
  }
  return lines.join("\n");
}

function applySummary(result = {}) {
  const applied = Array.isArray(result.applied) ? result.applied.length : 0;
  const blocked = Array.isArray(result.blocked) ? result.blocked.length : 0;
  const effects = reviewEffectSummary(result.items || [], result.hygieneItems || []);
  const mode = reviewBundleMode(result.items || [], result.hygieneItems || []);
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
    "",
    "## What was actually written",
    "",
    `- Memory DB writes: ${effects.memoryWrites.length}`,
    ...(mode.kind === "maintenance" ? ["- No memory DB writes were possible or needed."] : []),
    `- Knowledge updates: ${effects.knowledgeWrites.length}`,
    `- Task/proposal files: ${effects.taskWrites.length}`,
    `- Review-only hygiene items: ${effects.reviewOnly.length}`,
    `- Still pending: ${effects.pending.length}`,
    ...(mode.kind === "maintenance" ? ["- Apply marked approved maintenance items as processed; it did not repair generated files."] : []),
    "",
    "## Memory DB examples",
    "",
    formatAppliedExamples(effects.memoryWrites, 5),
    "",
    `Details: /plur1bus_review explain ${result.bundleId || ""}`.trim(),
    "",
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

/**
 * AUTH-003: Determines whether an Obsidian control-room command is mutating or
 * destructive and therefore requires authorization before it is executed.
 *
 * The classifier is fail-safe: any dangerous flag (`--apply`, `--write`, `--delete`,
 * `--force-soul`, `--migrate-soul-memory-rules`, `--allow-delete`) anywhere in the
 * token stream makes the whole invocation destructive.  Subcommands that are known
 * to mutate memory, configuration, or the SOUL.MD file are also treated as
 * destructive even without an explicit flag.
 *
 * @param {string[]} tokens — tokens passed to handleObsidianBridgeCommand (the
 *   leading `obsidian` token has already been stripped by the caller).
 * @returns {boolean}
 */
export function isObsidianCommandDestructive(tokens = []) {
  try {
    const plan = parseObsidianCommandPlan(tokens, {
      memoryCtx: {
        agentId: "classifier",
        workspaceIdentity: "workspace:v1:classifier",
      },
      mode: "apply",
      allowWrite: true,
      vaultConfirmed: true,
      actionConfirmed: true,
    });
    return (plan.capabilities.length > 0 || plan.mutationFlags.length > 0)
      && plan.mutationPolicy.dryRun === false;
  } catch {
    // Invalid or contradictory write-like input is never treated as a safe
    // authorization bypass by this compatibility classifier.
    return true;
  }
}

export async function handleObsidianBridgeCommand(tokens = [], context = {}) {
  const rawConfig = context.config || {};
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  const commandCtx = context.commandCtx || {};
  const identity = resolveIdentity(commandCtx);
  const fallbackAgentId = context.agentId || commandCtx.agentId || "main";
  const fallbackWorkspace = context.workspaceKey || commandCtx.workspaceKey || fallbackAgentId;
  const memoryCtx = context.memoryCtx || Object.freeze({
    agentId: fallbackAgentId,
    workspaceIdentity: normalizeWorkspaceTarget(fallbackWorkspace, "Obsidian workspace identity"),
    workspaceId: normalizeWorkspaceTarget(fallbackWorkspace, "Obsidian workspace identity"),
    userId: identity.userId || "",
    userPrincipal: "",
    conversationPrincipal: commandCtx.conversationPrincipal || identity.chatId || "",
    chatId: identity.chatId || "",
    chatKind: commandCtx.chatKind || resolveChatKind(commandCtx),
    workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
  });
  let commandPlan;
  try {
    commandPlan = parseObsidianCommandPlan(tokens, {
      memoryCtx,
      mode: cfg.mode,
      dryRun: rawConfig.dryRun === true,
      allowWrite: cfg.allowWrite,
      vaultConfirmed: context.vaultConfirmed === true,
      actionConfirmed: context.actionConfirmed,
      baseDbPath: context.baseDbPath || context.pluginConfig?.baseDbPath || "",
    });
  } catch (err) {
    return commandResult({ ok: false, error: String(err?.message || err) });
  }
  const plan = commandPlan;

  // B14: every data-bearing read and effective mutation is authorized before
  // resolving a vault, reading records, or dispatching to any sink.
  if (plan.dataBearing) {
    const auth = isAuthorized(
      { ...commandCtx, ...identity, ...memoryCtx },
      context.pluginConfig || {},
      {
        destructive: plan.capabilities.length > 0 && plan.mutationPolicy.dryRun === false,
        chatKind: memoryCtx.chatKind,
      },
    );
    if (!auth.authorized) {
      const messages = commandCtx.messages || [];
      const lang = resolveLocale({ ctx: commandCtx, messages, fallback: "en" });
      const toneHint = commandCtx.workspaceDir ? readSoulToneCached(commandCtx.workspaceDir) : null;
      const tone = pickTone(toneHint);
      return { text: t(`plur1bus.${auth.reason || "unauthorized"}`, { lang, tone }) };
    }
  }

  const command = plan.command;
  const sub = plan.subcommand;
  const explicitAgentId = memoryCtx.agentId;
  const explicitWorkspaceKey = memoryCtx.workspaceIdentity;
  const agentId = explicitAgentId;
  const workspaceKey = explicitWorkspaceKey;
  const selectedVault = selectWorkspaceVaultPath(rawConfig, normalizeObsidianControlRoomConfig(rawConfig), {
    agentId,
    workspaceKey,
    workspaceDir: context.workspaceDir || context.commandCtx?.workspaceDir,
    commandCtx: context.commandCtx,
  });
  const commandConfig = selectedVault?.vaultPath ? { ...rawConfig, vaultPath: selectedVault.vaultPath } : rawConfig;
  let loadedRecords;
  const getRecords = async () => {
    if (loadedRecords !== undefined) return loadedRecords;
    loadedRecords = Array.isArray(context.records)
      ? context.records
      : typeof context.loadRecords === "function"
        ? await context.loadRecords()
        : [];
    return loadedRecords;
  };

  try {
    if (command === "vault-confirm" && sub === "prepare") {
      const confirmationStore = context.confirmationStore || context.semanticConfirmationStore;
      if (!(confirmationStore instanceof Map)) {
        return commandResult({ ok: false, error: "Vault confirmation store unavailable" });
      }
      if (!commandConfig.vaultPath) {
        return commandResult({ ok: false, error: "Vault path unavailable" });
      }
      return commandResult(prepareVaultConfirmation({
        baseDbPath: context.baseDbPath || context.pluginConfig?.baseDbPath || "",
        memoryCtx,
        vaultPath: commandConfig.vaultPath,
        confirmationStore,
        expiryMinutes: context.vaultConfirmationExpiryMinutes ?? 10,
      }));
    }
    if (command === "vault-confirm" && sub === "confirm") {
      const confirmationStore = context.confirmationStore || context.semanticConfirmationStore;
      const nonce = plan.operands[0] || "";
      const callbackData = vaultConfirmationCallbackForNonce(confirmationStore, nonce);
      if (!callbackData) return commandResult({ ok: false, reason: "not_found_or_expired" });
      if (!commandConfig.vaultPath) {
        return commandResult({ ok: false, error: "Vault path unavailable" });
      }
      return commandResult(confirmVaultConfirmation({
        callbackData,
        confirmationStore,
        baseDbPath: context.baseDbPath || context.pluginConfig?.baseDbPath || "",
        memoryCtx,
        vaultPath: commandConfig.vaultPath,
      }));
    }
    if (command === "semantic-discovery" && sub === "prepare") {
      if (!(context.semanticConfirmationStore instanceof Map)) {
        return commandResult({ ok: false, error: "Semantic Discovery confirmation store unavailable" });
      }
      const records = typeof context.loadSemanticRecords === "function"
        ? await context.loadSemanticRecords()
        : await getRecords();
      const prepared = await prepareSemanticDiscovery({
        rawConfig: commandConfig,
        memoryCtx,
        records,
        confirmationStore: context.semanticConfirmationStore,
        searchSimilar: context.searchSemanticNeighbors,
      });
      return commandResult(prepared);
    }
    if (command === "semantic-discovery" && sub === "confirm") {
      const nonce = plan.operands[0] || "";
      const callbackData = semanticConfirmationCallbackForNonce(context.semanticConfirmationStore, nonce);
      if (!callbackData) return commandResult({ ok: false, reason: "not_found_or_expired" });
      const confirmedPlan = parseObsidianCommandPlan(tokens, {
        memoryCtx,
        mode: cfg.mode,
        dryRun: rawConfig.dryRun === true,
        allowWrite: cfg.allowWrite,
        vaultConfirmed: context.vaultConfirmed === true,
        actionConfirmed: true,
        baseDbPath: context.baseDbPath || context.pluginConfig?.baseDbPath || "",
      });
      const confirmed = await confirmSemanticDiscovery({
        callbackData,
        confirmationStore: context.semanticConfirmationStore,
        memoryCtx,
        rawConfig: commandConfig,
        policy: confirmedPlan.mutationPolicy,
        writeMirrors: context.writeSemanticMirrors,
      });
      return commandResult(confirmed);
    }

    // A denied policy is a plan-only result. No vault content read, mkdir,
    // status write, callback, metric, checkpoint, or mtime change is allowed.
    if (plan.capabilities.length > 0 && !plan.capabilities.every((capability) => plan.mutationPolicy.allows(capability))) {
      return commandResult({
        ok: true,
        applied: false,
        dryRun: plan.mutationPolicy.dryRun,
        reason: "mutation_policy_denied",
        // Four independent gates can close a policy. Naming the closed ones is
        // the difference between "denied" and an operator knowing that the
        // vault was never confirmed.
        deniedGates: closedMutationGates(plan.mutationPolicy),
        ...(plan.vaultConfirmation && !plan.mutationPolicy.vaultConfirmed
          ? { vaultConfirmation: plan.vaultConfirmation }
          : {}),
        plannedActions: plan.capabilities.map((capability) => ({ capability })),
      });
    }
    if (new Set([
      "evening-review",
      "evening-deep-review",
      "records",
      "dashboards",
      "dataview",
      "weekly",
      "conflicts",
      "project-hub",
      "memory",
      "maintenance",
      "semantic-conflicts",
      "duplicates",
      "provenance",
      "impact",
      "links",
    ]).has(command) && !Array.isArray(context.records)) {
      context = { ...context, records: await getRecords() };
    }

    if (command === "help") return commandResult(obsidianCommandHelp());
    if (command === "doctor") return commandResult(runVaultDoctor(commandConfig, { agentId, workspaceKey, workspaceDir: context.workspaceDir, commandCtx: context.commandCtx }));
    if (command === "init" && sub === "workspaces") {
      assertMutationAllowed(plan.mutationPolicy, "vault_write");
      const dryRun = plan.mutationPolicy.dryRun;
      const verbose = plan.options.verbose === true;
      const workspaces = selectCommandWorkspaces(rawConfig, commandPlan, context);
      const targets = workspaces.map((workspace) => {
        const targetMemoryCtx = {
          agentId: workspace.agentId,
          workspaceIdentity: normalizeWorkspaceTarget(
            workspace.workspaceId,
            "Obsidian init workspace identity",
          ),
        };
        const targetPolicy = deriveTargetMutationPolicy(commandPlan, {
          ...targetMemoryCtx,
          vaultConfirmed: isOwnedVaultConfirmed({
            baseDbPath: commandPlan.mutationPolicy.baseDbPath,
            memoryCtx: targetMemoryCtx,
            vaultPath: workspace.path,
          }),
        });
        assertMutationAllowed(targetPolicy, "vault_write");
        return { workspace, targetPolicy };
      });
      const results = targets.map(({ workspace, targetPolicy }) => {
        const init = initWorkspace(workspace, {
          dryRun,
          allowDotObsidianWrite: rawConfig.allowDotObsidianWrite === true,
          mutationPolicy: targetPolicy,
        });
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
      const write = plan.options.write === true;
      const dryRun = !write || plan.mutationPolicy.dryRun;
      const verbose = plan.options.verbose === true;
      const backupDir = plan.options.backupDir || plan.options.backup || "";
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
      assertMutationAllowed(plan.mutationPolicy, "config_write");
      if (!context.configPath) {
        return commandResult({ ...summary, ok: false, error: "OpenClaw config path unavailable; pass configPath in command context" });
      }
      const written = writeDiscoveredObsidianWorkspaces(context.configPath, discovery.candidates, {
        backupDir,
        dryRun,
        mutationPolicy: plan.mutationPolicy,
      });
      return commandResult({ ...summary, ok: written.ok, write: written });
    }
    if (command === "morning-review") {
      const result = await runMorningReview(commandConfig, {
        agentId,
        workspaceKey,
        workspaceDir: context.workspaceDir,
        proposals: context.proposals,
        mutationPolicy: plan.mutationPolicy,
      });
      return commandResult(reviewBundleSummary(result, "PLUR1BUS Morning Review"));
    }
    if (command === "evening-review" || command === "evening-deep-review") {
      const eveningAgentId = explicitAgentId;
      const eveningWorkspaceKey = inferWorkspaceKeyForAgent(explicitAgentId) || explicitWorkspaceKey;
      const result = runEveningDeepReview(commandConfig, { agentId: eveningAgentId, workspaceKey: eveningWorkspaceKey, workspaceDir: context.workspaceDir, records: context.records, items: context.items, mutationPolicy: plan.mutationPolicy });
      if (result.ok === false) return commandResult(result);
      return commandResult(eveningReviewSummary(result));
    }
    if (command === "records" && sub === "rebuild") {
      const records = context.records || defaultLivingDashboardRecords(agentId, workspaceKey);
      return commandResult({ ok: true, written: writeRecords(commandConfig, records, { agentId, workspaceKey, workspaceDir: context.workspaceDir, mutationPolicy: plan.mutationPolicy }) });
    }
    if (command === "dashboards" && sub === "build") return commandResult(generateDashboards(commandConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey), mutationPolicy: plan.mutationPolicy }));
    if (command === "bases" && sub === "build") return commandResult(generateBases(commandConfig, { agentId, workspaceKey, mutationPolicy: plan.mutationPolicy }));
    if (command === "dataview" && sub === "build") return commandResult(generateDashboards({ ...commandConfig, optionalIntegrations: { ...(commandConfig.optionalIntegrations || {}), dataview: true } }, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey), mutationPolicy: plan.mutationPolicy }));
    if (command === "tasks" && sub === "build") return commandResult(generateTaskSuggestions(commandConfig, context.tasks || [], { agentId, workspaceKey, mutationPolicy: plan.mutationPolicy }));
    if (command === "weekly") {
      if (sub === "build") return commandResult(buildWeeklySynthesis(commandConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey), mutationPolicy: plan.mutationPolicy }));
      return commandResult(reviewBundleSummary(await prepareReviewBundle(commandConfig, {
        agentId,
        workspaceKey,
        reviewProfiles: ["maintenance", "project_manager"],
        mutationPolicy: plan.mutationPolicy,
      }), "PLUR1BUS Weekly Review"));
    }
    if (command === "conflicts") {
      if (sub === "build") return commandResult(generateLivingConflictReport(commandConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey), mutationPolicy: plan.mutationPolicy }));
      return commandResult(generateConflictReport(commandConfig, { agentId, workspaceKey, mutationPolicy: plan.mutationPolicy }));
    }
    if (command === "project-hub") {
      const topic = [plan.subcommand, ...plan.operands].filter(Boolean).join(" ").trim();
      if (!topic) return commandResult("Usage: /plur1bus obsidian project-hub <topic>");
      if (plan.options.refresh === true) return commandResult(buildProjectHub(commandConfig, topic, { agentId, workspaceKey, records: context.records || [], mutationPolicy: plan.mutationPolicy }));
      return commandResult(generateProjectHub(commandConfig, topic, { agentId, workspaceKey, mutationPolicy: plan.mutationPolicy }));
    }
    if (command === "memory" && sub === "explain") {
      const id = plan.operands[0] || "";
      if (!id) return commandResult("Usage: /plur1bus obsidian memory explain <id>");
      const record = typeof context.findRecord === "function" ? context.findRecord(id) : null;
      if (plan.options.deep === true) return commandResult(buildMemoryExplanation(commandConfig, id, { agentId, workspaceKey, findRecord: context.findRecord, records: context.records || [], mutationPolicy: plan.mutationPolicy }));
      return commandResult(writeMemoryExplanation(commandConfig, id, record, { agentId, workspaceKey, mutationPolicy: plan.mutationPolicy }));
    }
    if (command === "maintenance" && sub === "deep") return commandResult(runLivingMaintenanceDeep(commandConfig, { agentId, workspaceKey, records: context.records || defaultLivingDashboardRecords(agentId, workspaceKey), mutationPolicy: plan.mutationPolicy }));
    if (command === "adversarial" && sub === "deep") return commandResult(runAdversarialDeep(context.items || [], { agentId, workspaceKey }));
    if (command === "semantic-conflicts" && sub === "build") return commandResult(buildSemanticConflictGraph(commandConfig, { agentId, workspaceKey, records: context.records || [], mutationPolicy: plan.mutationPolicy }));
    if (command === "duplicates" && sub === "scan") return commandResult(scanSemanticDuplicates(commandConfig, { agentId, workspaceKey, records: context.records || [], mutationPolicy: plan.mutationPolicy }));
    if (command === "provenance" && sub === "build") return commandResult(buildProvenanceGraph(commandConfig, { agentId, workspaceKey, records: context.records || [], mutationPolicy: plan.mutationPolicy }));
    if (command === "impact" && sub === "analyze") return commandResult(analyzeImpact(commandConfig, plan.operands[0] || "all", { agentId, workspaceKey, records: context.records || [], mutationPolicy: plan.mutationPolicy }));
    if (command === "links" && sub === "suggest") return commandResult(generateLinkSuggestions(commandConfig, { agentId, workspaceKey, records: buildRecordIndex(commandConfig, { records: context.records || [] }).records, mutationPolicy: plan.mutationPolicy }));
    if (command === "soul" && sub === "patch") {
      const soulPath = context.soulPath || (context.workspaceDir ? join(context.workspaceDir, "SOUL.MD") : "");
      if (!soulPath) return commandResult({ ok: false, error: "SOUL.MD path unavailable" });
      return commandResult(patchSoulMd(soulPath, {
        version: OBSIDIAN_CONTROL_ROOM_VERSION,
        force: plan.options.forceSoul === true || rawConfig.soulPatch?.force === true,
        migrateLegacy: plan.options.migrateSoulMemoryRules === true || rawConfig.soulPatch?.migrateLegacy === true,
        dryRun: plan.mutationPolicy.dryRun,
        createIfMissing: rawConfig.soulPatch?.createIfMissing !== false,
        backup: rawConfig.soulPatch?.backup !== false,
        mutationPolicy: plan.mutationPolicy,
      }));
    }
    if (command === "rotate") {
      const { reviewPath } = resolveReviewPath(commandConfig, ".");
      const dryRun = plan.options.apply !== true;
      const allowDelete = plan.options.allowDelete === true;
      const action = plan.options.delete === true ? "delete" : "move";
      const maxAgeDaysRaw = plan.options.maxAgeDays || String(rawConfig.deepMaintenance?.archiveAfterDays ?? 30);
      const maxSizeMBRaw = plan.options.maxSizeMb || "";
      const result = rotateOldArchives(reviewPath, {
        dryRun,
        action,
        allowDelete,
        mutationPolicy: plan.mutationPolicy,
        maxAgeDays: maxAgeDaysRaw ? Number(maxAgeDaysRaw) : null,
        maxSizeMB: maxSizeMBRaw ? Number(maxSizeMBRaw) : null,
      });
      return commandResult({
        ok: true,
        dryRun: result.dryRun,
        action: result.action,
        moved: result.moved,
        deleted: result.deleted,
        skipped: result.skipped,
        totalSizeMB: result.totalSizeMB,
        files: result.files,
      });
    }
    if (command === "cron") {
      if (sub === "print-morning-review") return commandResult({ command: printMorningReviewCronCommand(commandConfig) });
      if (sub === "print-workspace-reviews") {
        const cronJobPlan = buildWorkspaceReviewCronJobs(rawConfig, {
          commandPlan,
          context,
          includeMorning: commandPlan.options.eveningOnly !== true,
          includeEvening: commandPlan.options.morningOnly !== true,
          channel: commandPlan.options.channel || "",
          to: commandPlan.options.to || "",
        });
        return commandResult({
          ...cronJobPlan,
          commands: cronJobPlan.jobs.map((job) => job.command),
        });
      }
      if (sub === "install-workspace-reviews") {
        const cronJobPlan = buildWorkspaceReviewCronJobs(rawConfig, {
          commandPlan,
          context,
          includeMorning: commandPlan.options.eveningOnly !== true,
          includeEvening: commandPlan.options.morningOnly !== true,
          channel: commandPlan.options.channel || "",
          to: commandPlan.options.to || "",
        });
        if (commandPlan.options.force !== true) {
          return commandResult({
            installed: false,
            reason: "Refusing to install without --force. Review the OpenClaw cron commands first.",
            ...cronJobPlan,
            commands: cronJobPlan.jobs.map((job) => job.command),
          });
        }
        if (typeof context.openclawCronAdd !== "function") {
          return commandResult({
            installed: false,
            reason: "No OpenClaw cron API is available in this runtime; run the printed commands manually.",
            ...cronJobPlan,
            commands: cronJobPlan.jobs.map((job) => job.command),
          });
        }
        const results = [];
        for (const job of cronJobPlan.jobs) {
          assertMutationAllowed(commandPlan.mutationPolicy, "cron_write");
          results.push(await context.openclawCronAdd({ command: job.command, job }));
        }
        return commandResult({ installed: true, ...cronJobPlan, results });
      }
      if (sub === "install-morning-review") {
        const cronCommand = printMorningReviewCronCommand(commandConfig);
        if (plan.options.force !== true) {
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
        assertMutationAllowed(plan.mutationPolicy, "cron_write");
        return commandResult(await context.openclawCronAdd({ command: cronCommand }));
      }
    }
    if (command === "review") {
      const effectiveSub = sub || "show";
      const rawBundleOrSelector = plan.operands[0] || "";
      const rawMaybeSelector = plan.operands[1] || "";
      const optionSelector = normalizeItemSelector(plan.options.items || "");
      const hasExplicitBundle = looksLikeReviewBundleId(rawBundleOrSelector);
      const bundleId = hasExplicitBundle
        ? rawBundleOrSelector
        : latestReviewBundleId(commandConfig, {
            agentId,
            workspaceKey,
            workspaceDir: context.workspaceDir,
            preferApproved: effectiveSub === "apply",
            mutationPolicy: plan.mutationPolicy,
          });
      const positionalSelector = hasExplicitBundle ? rawMaybeSelector : rawBundleOrSelector;
      const selector = normalizeItemSelector(optionSelector || positionalSelector || (effectiveSub === "approve" ? "low-risk" : "all"));
      if (effectiveSub === "prepare") return commandResult(reviewBundleSummary(await prepareReviewBundle(commandConfig, {
        agentId,
        workspaceKey,
        workspaceDir: context.workspaceDir,
        proposals: context.proposals,
        mutationPolicy: plan.mutationPolicy,
      }), "PLUR1BUS ReviewBundle"));
      if (effectiveSub === "show") {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(reviewBundleSummary(loadBundleRecord(commandConfig, bundleId, {
          mutationPolicy: plan.mutationPolicy,
          allowLegacyView: true,
        }), "PLUR1BUS ReviewBundle"));
      }
      if (effectiveSub === "explain") {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(reviewExplainSummary(loadBundleRecord(commandConfig, bundleId, {
          mutationPolicy: plan.mutationPolicy,
          allowLegacyView: true,
        }), "PLUR1BUS ReviewBundle explanation"));
      }
      if (["approve", "reject", "snooze"].includes(effectiveSub)) {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(reviewActionSummary(updateReviewBundleItems(commandConfig, bundleId, effectiveSub, selector, {
          until: plan.options.until || "",
          agentId,
          workspaceKey,
          mutationPolicy: plan.mutationPolicy,
        })));
      }
      if (effectiveSub === "apply") {
        if (!bundleId) return commandResult(`${obsidianCommandHelp()}\n\nNo ReviewBundle was found yet. Run /plur1bus_morning first.`);
        return commandResult(applySummary(await applyApprovedReviewBundle(commandConfig, bundleId, {
          agentId,
          workspaceKey,
          workspaceDir: context.workspaceDir,
          memoryStore: context.memoryStore,
          knowledgeUpdate: context.knowledgeUpdate,
          mutationPolicy: plan.mutationPolicy,
        })));
      }
      if (effectiveSub === "quickapply") {
        if (!bundleId) return commandResult("✅ Keine Vorschläge offen — nichts zu tun.");
        const quickSelector = normalizeItemSelector(positionalSelector || "low-risk");
        updateReviewBundleItems(commandConfig, bundleId, "approve", quickSelector, {
          agentId,
          workspaceKey,
          mutationPolicy: plan.mutationPolicy,
        });
        const applyResult = await applyApprovedReviewBundle(commandConfig, bundleId, {
          agentId,
          workspaceKey,
          workspaceDir: context.workspaceDir,
          memoryStore: context.memoryStore,
          knowledgeUpdate: context.knowledgeUpdate,
          mutationPolicy: plan.mutationPolicy,
        });
        return commandResult(quickapplySummary(applyResult));
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
