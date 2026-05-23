/**
 * PLUR1BUS <-> Obsidian bridge.
 *
 * The bridge treats Obsidian as an editable Markdown surface. Runtime memory
 * ownership stays in PLUR1BUS: sync either calls the provided memory_store /
 * knowledge_update callbacks, or appends a queue item for a runtime worker.
 * This module never writes LanceDB directly.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const OBSIDIAN_BRIDGE_VERSION = 1;

export const DEFAULT_OBSIDIAN_WORKSPACES = [
  { workspace_id: "main", agent_id: "main", path: "~/.openclaw/workspace", label: "Bernd" },
  { workspace_id: "bernhardine", agent_id: "bernhardine", path: "~/.openclaw/workspace-bernhardine", label: "Bernhardine" },
  { workspace_id: "heisenberg", agent_id: "heisenberg", path: "~/.openclaw/workspace-heisenberg", label: "Heisenberg" },
];

export const DEFAULT_INCLUDE_GLOBS = [
  "memory/cards/**/*.md",
  "memory/KNOWLEDGE.md",
  "decisions/**/*.md",
];

export const DEFAULT_IGNORE_GLOBS = [
  ".git/**",
  ".obsidian/**",
  ".adaptive-learning/**",
  "node_modules/**",
  "memory/archive/expired/**",
  "workspace-main/**",
  "cron/**",
  "_neo/**",
  "defaults/**",
  "list/**",
];

export const VAULT_DIRECTORIES = [
  "memory/cards",
  "memory/daily",
  "memory/dream-diary",
  "memory/archive/expired",
  "decisions",
  "people",
  "projects",
];

export const OBSIDIAN_CARD_CATEGORIES = ["preference", "fact", "decision", "entity", "other"];
export const OBSIDIAN_SCOPES = ["agent-private", "workspace", "user"];
export const STATE_REL_DIR = ".adaptive-learning/obsidian-bridge";

const FRONTMATTER_ORDER = [
  "plur1bus_type",
  "workspace_id",
  "agent_id",
  "memory_id",
  "category",
  "importance",
  "scope",
  "source_kind",
  "sync_status",
  "content_hash",
  "validated",
  "updated_at",
];

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function expandPath(value) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function normalizeAbsPath(value) {
  const expanded = expandPath(value);
  const absolute = isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  try {
    return realpathSync(absolute);
  } catch (_) {
    return resolve(absolute);
  }
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readJson(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {}
  return fallback;
}

function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function writeTextAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, value, "utf8");
  renameSync(tmp, path);
}

function appendJsonl(path, value) {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(value) + "\n", "utf8");
}

function safeName(value) {
  return String(value || "item")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "item";
}

function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === "*" && next === "*") {
      const after = glob[i + 2];
      if (after === "/") {
        out += "(?:.*\\/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if ("\\^$+?.()|{}[]".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(out + "$");
}

function globRoots(globs) {
  const roots = new Set();
  for (const glob of globs) {
    const wildcard = glob.search(/[*?[]/);
    const prefix = wildcard >= 0 ? glob.slice(0, wildcard) : glob;
    const cleaned = prefix.replace(/\/+$/, "");
    if (!cleaned) {
      roots.add(".");
    } else if (cleaned.endsWith(".md")) {
      roots.add(cleaned);
    } else {
      roots.add(cleaned || ".");
    }
  }
  return [...roots];
}

function matchesAny(relPath, regexes) {
  return regexes.some((re) => re.test(relPath));
}

export function normalizeObsidianBridgeConfig(raw = {}, options = {}) {
  const cfg = raw?.obsidianBridge || raw || {};
  const includeGlobs = Array.isArray(cfg.includeGlobs) && cfg.includeGlobs.length > 0
    ? cfg.includeGlobs
    : DEFAULT_INCLUDE_GLOBS;
  const ignoreGlobs = Array.isArray(cfg.ignoreGlobs) && cfg.ignoreGlobs.length > 0
    ? cfg.ignoreGlobs
    : DEFAULT_IGNORE_GLOBS;
  const workspaces = Array.isArray(cfg.workspaces) && cfg.workspaces.length > 0
    ? cfg.workspaces
    : DEFAULT_OBSIDIAN_WORKSPACES;
  return {
    enabled: cfg.enabled === true,
    mode: cfg.mode || "augment",
    dryRun: cfg.dryRun !== false,
    watch: cfg.watch === true,
    vaultPath: cfg.vaultPath || null,
    workspaceRoot: cfg.workspaceRoot || null,
    reviewRoot: cfg.reviewRoot || "00-system/plur1bus",
    requireUserApproval: cfg.requireUserApproval !== false,
    applyApprovedOnly: cfg.applyApprovedOnly !== false,
    writeManagedBlocks: cfg.writeManagedBlocks !== false,
    allowWrite: cfg.allowWrite !== false,
    allowDotObsidianWrite: cfg.allowDotObsidianWrite === true,
    capabilityPack: cfg.capabilityPack || "full",
    agents: cfg.agents || {
      include: ["*"],
      equalCapabilities: true,
      defaultProfiles: {
        main: "standard",
        bernhardine: "conservative",
        heisenberg: "adversarial",
      },
    },
    morningReview: {
      enabled: cfg.morningReview?.enabled === true,
      cron: cfg.morningReview?.cron || "0 9 * * *",
      timezone: cfg.morningReview?.timezone || "Europe/Zurich",
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
    tombstoneOnDelete: cfg.tombstoneOnDelete !== false,
    includeGlobs,
    ignoreGlobs,
    workspaces,
    intervalMs: Number(cfg.intervalMs || options.intervalMs || 5000),
  };
}

export function discoverObsidianWorkspaces(rawConfig = {}, options = {}) {
  const cfg = normalizeObsidianBridgeConfig(rawConfig, options);
  const filter = options.workspace || options.workspaceId || null;
  return cfg.workspaces
    .map((workspace, index) => {
      const workspaceId = workspace.workspace_id || workspace.workspaceId || workspace.id || workspace.name || `workspace-${index}`;
      const agentId = workspace.agent_id || workspace.agentId || workspace.agent || workspaceId;
      return {
        workspaceId,
        agentId,
        label: workspace.label || workspaceId,
        path: normalizeAbsPath(workspace.path || workspace.workspace || workspace.dir),
        includeGlobs: workspace.includeGlobs || cfg.includeGlobs,
        ignoreGlobs: workspace.ignoreGlobs || cfg.ignoreGlobs,
        tombstoneOnDelete: workspace.tombstoneOnDelete ?? cfg.tombstoneOnDelete,
        requireUserApproval: workspace.requireUserApproval ?? cfg.requireUserApproval,
        allowDotObsidianWrite: workspace.allowDotObsidianWrite ?? cfg.allowDotObsidianWrite,
      };
    })
    .filter((workspace) => !filter || workspace.workspaceId === filter || workspace.agentId === filter || workspace.label === filter);
}

export function parseMarkdownFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---\n")) return { frontmatter: {}, body: text, rawFrontmatter: null };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: text, rawFrontmatter: null };
  const raw = text.slice(4, end);
  const body = text.slice(end + 5);
  const data = {};
  const lines = raw.split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(parseScalar(listMatch[1]));
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) {
      currentKey = null;
      continue;
    }
    const [, key, rawValue = ""] = match;
    if (rawValue === "") {
      data[key] = "";
      currentKey = key;
    } else {
      data[key] = parseScalar(rawValue);
      currentKey = key;
    }
  }
  return { frontmatter: data, body, rawFrontmatter: raw };
}

function parseScalar(rawValue) {
  const value = String(rawValue || "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const quoted = value.match(/^"(.*)"$/) || value.match(/^'(.*)'$/);
  if (quoted) return quoted[1];
  return value;
}

function formatScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!s || /[:#\n\r]|^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

export function formatMarkdownFrontmatter(frontmatter, body) {
  const keys = [
    ...FRONTMATTER_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(frontmatter, key)),
    ...Object.keys(frontmatter).filter((key) => !FRONTMATTER_ORDER.includes(key)).sort(),
  ];
  const lines = ["---"];
  for (const key of keys) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${formatScalar(item)}`);
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n${String(body || "").replace(/^\n+/, "")}`;
}

export function stableContentHash(body) {
  const normalized = String(body || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function bridgePaths(workspace) {
  const dir = join(workspace.path, STATE_REL_DIR);
  return {
    dir,
    state: join(dir, "state.json"),
    syncLog: join(dir, "sync-log.jsonl"),
    conflictLog: join(dir, "conflict-log.jsonl"),
    queue: join(dir, "store-queue.jsonl"),
    conflictsDir: join(dir, "conflicts"),
  };
}

export function readBridgeState(workspace) {
  return normalizeState(readJson(bridgePaths(workspace).state, {}));
}

function normalizeState(raw) {
  return {
    schema: OBSIDIAN_BRIDGE_VERSION,
    updatedAt: raw?.updatedAt || null,
    files: raw && typeof raw.files === "object" && !Array.isArray(raw.files) ? raw.files : {},
    tombstones: Array.isArray(raw?.tombstones) ? raw.tombstones : [],
  };
}

export function writeBridgeState(workspace, state) {
  writeJsonAtomic(bridgePaths(workspace).state, normalizeState({ ...state, updatedAt: new Date().toISOString() }));
}

function classifyMarkdown(relPath, frontmatter) {
  if (relPath === "memory/KNOWLEDGE.md") return "knowledge";
  if (frontmatter.plur1bus_type === "memory_card" || relPath.startsWith("memory/cards/")) return "memory_card";
  if (frontmatter.plur1bus_type === "decision" || relPath.startsWith("decisions/")) return "decision";
  return "note";
}

export function validateBridgeCard(card, workspace) {
  const errors = [];
  const warnings = [];
  const fm = card.frontmatter;
  if (card.kind === "knowledge") return { errors, warnings };
  if (card.kind === "note") return { errors, warnings: ["not auto-recall relevant"] };

  const required = card.kind === "memory_card"
    ? ["plur1bus_type", "workspace_id", "agent_id", "category", "importance", "scope", "source_kind", "sync_status", "content_hash"]
    : ["plur1bus_type", "workspace_id", "agent_id", "sync_status"];
  for (const key of required) {
    if (fm[key] === undefined || fm[key] === "") errors.push(`missing ${key}`);
  }
  if (fm.workspace_id && fm.workspace_id !== workspace.workspaceId) errors.push(`workspace_id ${fm.workspace_id} != ${workspace.workspaceId}`);
  if (fm.agent_id && fm.agent_id !== workspace.agentId) errors.push(`agent_id ${fm.agent_id} != ${workspace.agentId}`);

  if (card.kind === "memory_card") {
    if (!OBSIDIAN_CARD_CATEGORIES.includes(fm.category)) errors.push(`invalid category ${fm.category}`);
    const importance = Number(fm.importance);
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) errors.push(`invalid importance ${fm.importance}`);
    if (!OBSIDIAN_SCOPES.includes(fm.scope)) errors.push(`invalid scope ${fm.scope}`);
  }
  if (fm.content_hash && fm.content_hash !== card.contentHash) errors.push(`content_hash mismatch ${fm.content_hash} != ${card.contentHash}`);
  if (!fm.content_hash) warnings.push("missing content_hash");
  return { errors, warnings };
}

export function buildMemoryStorePayload(card, workspace) {
  const fm = card.frontmatter;
  const text = card.body.trim();
  return {
    text,
    category: OBSIDIAN_CARD_CATEGORIES.includes(fm.category) ? fm.category : "decision",
    importance: Number.isFinite(Number(fm.importance)) ? Number(fm.importance) : 0.7,
    origin: "internal",
    scope: OBSIDIAN_SCOPES.includes(fm.scope) ? fm.scope : "workspace",
    sourceUrl: `obsidian://${workspace.workspaceId}/${card.relPath}`,
    evidenceQuote: text.slice(0, 200),
  };
}

export function scanWorkspace(workspace, options = {}) {
  const includeGlobs = options.includeGlobs || workspace.includeGlobs || DEFAULT_INCLUDE_GLOBS;
  const ignoreGlobs = options.ignoreGlobs || workspace.ignoreGlobs || DEFAULT_IGNORE_GLOBS;
  const includeRegexes = includeGlobs.map(globToRegExp);
  const ignoreRegexes = ignoreGlobs.map(globToRegExp);
  const roots = globRoots(includeGlobs);
  const files = [];
  const issues = [];

  for (const root of roots) {
    const absRoot = join(workspace.path, root);
    if (!existsSync(absRoot)) continue;
    if (statSync(absRoot).isFile()) {
      collectFile(absRoot);
    } else {
      walk(absRoot);
    }
  }

  function walk(dir) {
    const relDir = relative(workspace.path, dir).replace(/\\/g, "/") || ".";
    if (relDir !== "." && matchesAny(`${relDir}/`, ignoreRegexes)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(workspace.path, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!matchesAny(`${rel}/`, ignoreRegexes)) walk(abs);
      } else {
        collectFile(abs);
      }
    }
  }

  function collectFile(absPath) {
    const relPath = relative(workspace.path, absPath).replace(/\\/g, "/");
    if (!relPath.endsWith(".md")) return;
    if (!matchesAny(relPath, includeRegexes)) return;
    if (matchesAny(relPath, ignoreRegexes)) return;
    try {
      const content = readFileSync(absPath, "utf8");
      const parsed = parseMarkdownFrontmatter(content);
      const kind = classifyMarkdown(relPath, parsed.frontmatter);
      const card = {
        absPath,
        relPath,
        kind,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        contentHash: stableContentHash(parsed.body),
        mtimeMs: statSync(absPath).mtimeMs,
      };
      const validation = validateBridgeCard(card, workspace);
      files.push({ ...card, validation });
    } catch (err) {
      issues.push({ severity: "error", code: "read_failed", path: relPath, message: String(err?.message || err) });
    }
  }

  return { workspace, files: files.sort((a, b) => a.relPath.localeCompare(b.relPath)), issues };
}

function minimalObsidianFiles(workspace) {
  return {
    "app.json": {
      alwaysUpdateLinks: true,
      promptDelete: false,
      attachmentFolderPath: "attachments",
    },
    "core-plugins.json": [
      "file-explorer",
      "global-search",
      "switcher",
      "graph",
      "backlink",
      "outgoing-link",
      "tag-pane",
      "page-preview",
      "properties",
      "templates",
      "daily-notes",
      "note-composer",
      "command-palette",
      "editor-status",
      "bookmarks",
    ],
    "appearance.json": {
      theme: "obsidian",
      accentColor: "",
    },
    "workspace.json": {
      main: { id: "main", type: "split", children: [] },
      left: { id: "left", type: "split", children: [] },
      right: { id: "right", type: "split", children: [] },
      active: "main",
    },
    "plur1bus-bridge.json": {
      managedBy: "PLUR1BUS Obsidian Bridge",
      workspace_id: workspace.workspaceId,
      agent_id: workspace.agentId,
      schema: OBSIDIAN_BRIDGE_VERSION,
    },
  };
}

function hasBridgeMarker(obsidianDir, workspace) {
  const marker = readJson(join(obsidianDir, "plur1bus-bridge.json"), null);
  return marker?.managedBy === "PLUR1BUS Obsidian Bridge" && marker?.workspace_id === workspace.workspaceId;
}

export function initWorkspace(workspace, options = {}) {
  const dryRun = options.dryRun !== false;
  const allowDotObsidianWrite = options.allowDotObsidianWrite === true || workspace.allowDotObsidianWrite === true;
  const actions = [];
  const now = new Date();
  const obsidianDir = join(workspace.path, ".obsidian");

  for (const rel of VAULT_DIRECTORIES) {
    const abs = join(workspace.path, rel);
    if (!existsSync(abs)) {
      actions.push({ action: dryRun ? "would_create_dir" : "create_dir", path: abs });
      if (!dryRun) ensureDir(abs);
    }
  }

  if (!allowDotObsidianWrite) {
    actions.push({
      action: "skip_dot_obsidian_write",
      path: obsidianDir,
      reason: "obsidianBridge.allowDotObsidianWrite is not true",
    });
  } else if (existsSync(obsidianDir) && !hasBridgeMarker(obsidianDir, workspace)) {
    const backup = join(workspace.path, `.obsidian.legacy-${timestampId(now)}`);
    actions.push({ action: dryRun ? "would_backup_legacy_obsidian" : "backup_legacy_obsidian", from: obsidianDir, to: backup });
    if (!dryRun) renameSync(obsidianDir, backup);
  }

  if (allowDotObsidianWrite) {
    const files = minimalObsidianFiles(workspace);
    for (const [name, value] of Object.entries(files)) {
      const target = join(obsidianDir, name);
      actions.push({ action: dryRun ? "would_write_obsidian_config" : "write_obsidian_config", path: target });
      if (!dryRun) {
        ensureDir(obsidianDir);
        writeFileSync(target, JSON.stringify(value, null, 2) + "\n", "utf8");
      }
    }
  }

  if (!dryRun) {
    const state = readBridgeState(workspace);
    writeBridgeState(workspace, state);
    appendJsonl(bridgePaths(workspace).syncLog, {
      event: "bridge.init",
      timestamp: now.toISOString(),
      workspace_id: workspace.workspaceId,
      agent_id: workspace.agentId,
    });
  }
  return { workspace, actions };
}

export async function syncWorkspace(workspace, options = {}) {
  const dryRun = options.dryRun !== false;
  const requireUserApproval = options.requireUserApproval === true || workspace.requireUserApproval === true;
  const tombstoneOnDelete = options.tombstoneOnDelete ?? workspace.tombstoneOnDelete ?? true;
  const scan = scanWorkspace(workspace, options);
  const state = readBridgeState(workspace);
  const paths = bridgePaths(workspace);
  const actions = [];
  const issues = [...scan.issues];
  const seen = new Set(scan.files.map((file) => file.relPath));

  for (const file of scan.files) {
    for (const error of file.validation.errors) {
      issues.push({ severity: "error", code: "invalid_frontmatter", path: file.relPath, message: error });
    }
    for (const warning of file.validation.warnings) {
      issues.push({ severity: "warning", code: "frontmatter_warning", path: file.relPath, message: warning });
    }

    const prev = state.files[file.relPath];
    if (prev?.contentHash && prev.contentHash !== file.contentHash && (file.kind === "decision" || file.frontmatter.category === "decision") && prev.syncStatus === "synced") {
      const conflict = writeConflictReview(workspace, file, prev, { dryRun });
      actions.push(conflict);
    }

    if (!["memory_card", "decision"].includes(file.kind)) {
      state.files[file.relPath] = {
        kind: file.kind,
        contentHash: file.contentHash,
        syncStatus: file.frontmatter.sync_status || "scanned",
        updatedAt: new Date().toISOString(),
      };
      continue;
    }

    const isValidatedDecision = file.kind === "decision"
      && (file.frontmatter.validated === true || file.frontmatter.sync_status === "validated");
    if (file.kind === "decision" && !isValidatedDecision) {
      actions.push({ action: "scan_only_decision", path: file.relPath, reason: "decision not validated" });
      state.files[file.relPath] = {
        kind: file.kind,
        contentHash: file.contentHash,
        syncStatus: file.frontmatter.sync_status || "scanned",
        updatedAt: new Date().toISOString(),
      };
      continue;
    }

    if (file.validation.errors.length > 0) {
      actions.push({ action: "skip_invalid", path: file.relPath, errors: file.validation.errors });
      continue;
    }

    const changed = !prev || prev.contentHash !== file.contentHash || !["synced", "queued"].includes(String(file.frontmatter.sync_status || ""));
    if (!changed) continue;

    const payload = buildMemoryStorePayload(file, workspace);
    if (dryRun) {
      actions.push({ action: "would_memory_store", path: file.relPath, payload });
      continue;
    }
    if (requireUserApproval) {
      actions.push({
        action: "approval_required",
        path: file.relPath,
        payload,
        reason: "Obsidian Bridge v3.5 prepares review items; memory_store is not called without explicit approval.",
      });
      state.files[file.relPath] = {
        kind: file.kind,
        contentHash: file.contentHash,
        syncStatus: "pending_user_review",
        memoryId: file.frontmatter.memory_id || prev?.memoryId || "",
        updatedAt: new Date().toISOString(),
      };
      appendJsonl(paths.syncLog, {
        event: "memory.approval_required",
        timestamp: new Date().toISOString(),
        workspace_id: workspace.workspaceId,
        agent_id: workspace.agentId,
        path: file.relPath,
        content_hash: file.contentHash,
      });
      continue;
    }

    let syncStatus = "queued";
    let memoryId = file.frontmatter.memory_id || prev?.memoryId || "";
    if (typeof options.memoryStore === "function") {
      const result = await options.memoryStore({ workspace, card: file, payload });
      memoryId = result?.details?.id || result?.memoryId || memoryId || "";
      syncStatus = "synced";
    } else {
      appendJsonl(paths.queue, {
        schema: OBSIDIAN_BRIDGE_VERSION,
        event: "memory_store.requested",
        timestamp: new Date().toISOString(),
        workspace_id: workspace.workspaceId,
        agent_id: workspace.agentId,
        path: file.relPath,
        payload,
      });
    }

    const nextFrontmatter = {
      ...file.frontmatter,
      plur1bus_type: file.kind === "decision" ? "decision" : "memory_card",
      workspace_id: workspace.workspaceId,
      agent_id: workspace.agentId,
      category: payload.category,
      importance: payload.importance,
      scope: payload.scope,
      source_kind: file.frontmatter.source_kind || "obsidian",
      sync_status: syncStatus,
      content_hash: file.contentHash,
      updated_at: new Date().toISOString(),
    };
    if (memoryId) nextFrontmatter.memory_id = memoryId;
    writeTextAtomic(file.absPath, formatMarkdownFrontmatter(nextFrontmatter, file.body));
    state.files[file.relPath] = {
      kind: file.kind,
      contentHash: file.contentHash,
      syncStatus,
      memoryId,
      updatedAt: new Date().toISOString(),
    };
    actions.push({ action: syncStatus === "synced" ? "memory_stored" : "queued_memory_store", path: file.relPath, memoryId });
    appendJsonl(paths.syncLog, {
      event: syncStatus === "synced" ? "memory.stored" : "memory.queued",
      timestamp: new Date().toISOString(),
      workspace_id: workspace.workspaceId,
      agent_id: workspace.agentId,
      path: file.relPath,
      memory_id: memoryId || null,
      content_hash: file.contentHash,
    });
  }

  for (const [relPath, previous] of Object.entries(state.files)) {
    if (seen.has(relPath)) continue;
    if (tombstoneOnDelete && !previous.tombstonedAt) {
      if (requireUserApproval) {
        actions.push({
          action: "approval_required_tombstone",
          path: relPath,
          reason: "Deletion/tombstone requires explicit user approval.",
        });
        continue;
      }
      const tombstone = createTombstone(workspace, relPath, previous, { dryRun });
      actions.push(tombstone);
      state.tombstones.push({
        path: relPath,
        memoryId: previous.memoryId || null,
        tombstonedAt: new Date().toISOString(),
      });
      state.files[relPath] = { ...previous, syncStatus: "tombstoned", tombstonedAt: new Date().toISOString() };
    }
  }

  if (!dryRun) writeBridgeState(workspace, state);
  return { workspace, actions, issues, scan };
}

function createTombstone(workspace, relPath, previous, options = {}) {
  const dryRun = options.dryRun !== false;
  const stamp = timestampId();
  const targetRel = `memory/archive/expired/${safeName(relPath)}-${stamp}.md`;
  const target = join(workspace.path, targetRel);
  const body = [
    "---",
    "plur1bus_type: tombstone",
    `workspace_id: ${workspace.workspaceId}`,
    `agent_id: ${workspace.agentId}`,
    `memory_id: ${previous.memoryId || ""}`,
    `previous_path: ${relPath}`,
    `tombstoned_at: ${new Date().toISOString()}`,
    "---",
    "",
    `Obsidian bridge tombstone for deleted vault file: ${relPath}`,
    "",
  ].join("\n");
  if (!dryRun) {
    writeTextAtomic(target, body);
    appendJsonl(bridgePaths(workspace).syncLog, {
      event: "memory.tombstoned",
      timestamp: new Date().toISOString(),
      workspace_id: workspace.workspaceId,
      agent_id: workspace.agentId,
      path: relPath,
      tombstone_path: targetRel,
      memory_id: previous.memoryId || null,
    });
  }
  return { action: dryRun ? "would_tombstone" : "tombstone", path: relPath, tombstonePath: targetRel };
}

function writeConflictReview(workspace, file, previous, options = {}) {
  const dryRun = options.dryRun !== false;
  const stamp = timestampId();
  const rel = `${stamp}-${safeName(file.relPath)}.md`;
  const target = join(bridgePaths(workspace).conflictsDir, rel);
  const review = [
    "---",
    "plur1bus_type: conflict_review",
    `workspace_id: ${workspace.workspaceId}`,
    `agent_id: ${workspace.agentId}`,
    `path: ${file.relPath}`,
    `previous_hash: ${previous.contentHash || ""}`,
    `current_hash: ${file.contentHash}`,
    `created_at: ${new Date().toISOString()}`,
    "---",
    "",
    "# Obsidian Decision Conflict Review",
    "",
    "A decision-like note changed after it was synced. Review before promoting it into KNOWLEDGE.md.",
    "",
    "## Current Body",
    "",
    file.body.trim(),
    "",
  ].join("\n");
  const entry = {
    event: "decision.conflict_review",
    timestamp: new Date().toISOString(),
    workspace_id: workspace.workspaceId,
    agent_id: workspace.agentId,
    path: file.relPath,
    previous_hash: previous.contentHash || null,
    current_hash: file.contentHash,
    review_path: join(STATE_REL_DIR, "conflicts", rel),
  };
  if (!dryRun) {
    writeTextAtomic(target, review);
    appendJsonl(bridgePaths(workspace).conflictLog, entry);
  }
  return { action: dryRun ? "would_write_conflict_review" : "write_conflict_review", path: file.relPath, reviewPath: entry.review_path };
}

export async function doctorObsidianBridge(rawConfig = {}, options = {}) {
  const cfg = normalizeObsidianBridgeConfig(rawConfig, options);
  const workspaces = discoverObsidianWorkspaces(cfg, options);
  const reports = [];
  for (const workspace of workspaces) {
    const issues = [];
    if (!existsSync(workspace.path)) {
      issues.push({ severity: "error", code: "missing_workspace", message: `${workspace.path} does not exist` });
      reports.push({ workspace, issues, scan: null });
      continue;
    }
    for (const rel of VAULT_DIRECTORIES) {
      if (!existsSync(join(workspace.path, rel))) issues.push({ severity: "warning", code: "missing_vault_dir", path: rel, message: "vault directory is missing" });
    }
    const obsidianDir = join(workspace.path, ".obsidian");
    if (!existsSync(obsidianDir)) {
      issues.push({ severity: "warning", code: "missing_obsidian", path: ".obsidian", message: "minimal Obsidian config is missing" });
    } else if (!hasBridgeMarker(obsidianDir, workspace)) {
      issues.push({ severity: "error", code: "legacy_obsidian", path: ".obsidian", message: "active .obsidian is not bridge-managed" });
    }

    const scan = scanWorkspace(workspace, cfg);
    issues.push(...scan.issues);
    for (const file of scan.files) {
      for (const error of file.validation.errors) {
        const code = error.startsWith("content_hash mismatch") ? "hash_mismatch" : "invalid_frontmatter";
        issues.push({ severity: "error", code, path: file.relPath, message: error });
      }
      if (["memory_card", "decision"].includes(file.kind) && !["synced", "queued", "validated"].includes(String(file.frontmatter.sync_status || ""))) {
        issues.push({ severity: "warning", code: "unsynced_card", path: file.relPath, message: `sync_status=${file.frontmatter.sync_status || "(missing)"}` });
      }
    }
    const state = readBridgeState(workspace);
    const fileSet = new Set(scan.files.map((file) => file.relPath));
    for (const [relPath, entry] of Object.entries(state.files)) {
      if (!fileSet.has(relPath) && entry.syncStatus !== "tombstoned") {
        issues.push({ severity: "warning", code: "db_orphan", path: relPath, message: "state references a synced file that is not in the vault" });
      }
    }
    reports.push({ workspace, issues, scan });
  }
  return {
    enabled: cfg.enabled,
    dryRun: cfg.dryRun,
    reports,
    ok: reports.every((report) => report.issues.every((issue) => issue.severity !== "error")),
  };
}

export function createObsidianBridgeService(rawConfig = {}, options = {}) {
  const cfg = normalizeObsidianBridgeConfig(rawConfig, options);
  const logger = options.logger || console;
  let timer = null;
  let running = false;

  async function syncOnce() {
    const workspaces = discoverObsidianWorkspaces(cfg, options);
    const results = [];
    for (const workspace of workspaces) {
      results.push(await syncWorkspace(workspace, {
        ...cfg,
        dryRun: cfg.dryRun,
        memoryStore: options.memoryStore,
        knowledgeUpdate: options.knowledgeUpdate,
      }));
    }
    return results;
  }

  return {
    id: "plur1bus-obsidian-bridge",
    async start() {
      if (!cfg.enabled) return;
      running = true;
      logger.info?.(`plur1bus-obsidian-bridge: ${cfg.watch ? "watch" : "sync"} ready (dryRun=${cfg.dryRun})`);
      if (!cfg.watch) {
        await syncOnce().catch((err) => logger.warn?.(`plur1bus-obsidian-bridge: sync failed: ${String(err)}`));
        return;
      }
      timer = setInterval(() => {
        if (!running) return;
        syncOnce().catch((err) => logger.warn?.(`plur1bus-obsidian-bridge: watch sync failed: ${String(err)}`));
      }, Math.max(1000, cfg.intervalMs || 5000));
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      logger.info?.("plur1bus-obsidian-bridge: stopped");
    },
    syncOnce,
  };
}

export async function watchObsidianBridge(rawConfig = {}, options = {}) {
  const service = createObsidianBridgeService({ ...rawConfig, watch: true }, options);
  await service.start();
  return service;
}
