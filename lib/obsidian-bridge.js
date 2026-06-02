/**
 * PLUR1BUS <-> Obsidian bridge.
 *
 * The bridge treats Obsidian as an editable Markdown surface. Runtime memory
 * ownership stays in PLUR1BUS: raw Vault scans create untrusted proposals only.
 * Approved apply paths may call the provided memory_store / knowledge_update
 * callbacks, or append a queue item for a runtime worker. This module never
 * writes LanceDB directly.
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

export const DEFAULT_OBSIDIAN_WORKSPACES = [];

export const DEFAULT_INCLUDE_GLOBS = [
  "**/*.md",
  "memory/cards/**/*.md",
  "memory/KNOWLEDGE.md",
  "decisions/**/*.md",
];

export const DEFAULT_IGNORE_GLOBS = [
  ".git/**",
  ".obsidian/**",
  ".adaptive-learning/**",
  "plur1bus/**",
  "node_modules/**",
  "memory/archive/expired/**",
  "cron/**",
  "_neo/**",
  "defaults/**",
  "list/**",
  // PLUR1BUS-generated review output files — must not be scanned as vault notes
  "evening-deep-review-*.md",
  "morning-review-*.md",
  // P1-Fix (2026-05-28): Self-Hash-Mismatch verhindern — PLUR1BUS-eigene
  // Archive- und Review-Dateien rekursiv ignorieren (auch in Unterverzeichnissen).
  "**/_archive/**",
  "**/evening-deep-review-*.md",
  "plur1bus/_archive/**",
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
  "emotional_dominant",
  "emotional_intensity",
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
    reviewRoot: cfg.reviewRoot || "plur1bus",
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
        default: "standard",
      },
    },
    morningReview: {
      enabled: cfg.morningReview?.enabled === true,
      cron: cfg.morningReview?.cron || "0 9 * * *",
      timezone: cfg.morningReview?.timezone || "Europe/Berlin",
      delivery: cfg.morningReview?.delivery || "announce",
      session: cfg.morningReview?.session || "isolated",
      writeReviewBundle: cfg.morningReview?.writeReviewBundle !== false,
      applyMode: cfg.morningReview?.applyMode || "manual",
    },
    eveningReview: {
      enabled: cfg.eveningReview?.enabled === true,
      cron: cfg.eveningReview?.cron || "0 18 * * *",
      timezone: cfg.eveningReview?.timezone || cfg.morningReview?.timezone || "Europe/Berlin",
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

const WORKSPACE_DISCOVERY_MARKERS = [
  "AGENTS.md",
  "SOUL.MD",
  "memory/KNOWLEDGE.md",
  "memory/cards",
  "decisions",
  ".obsidian/workspace.json",
];

const WORKSPACE_DISCOVERY_SKIP_DIRS = new Set([
  ".git",
  "agents",
  "backups",
  "cache",
  "docker",
  "extensions",
  "logs",
  "memory",
  "node_modules",
  "plugins",
  "tmp",
]);

function safeWorkspaceIdFromPath(path) {
  const name = safeName(basename(path || "workspace")).toLowerCase();
  return name || "workspace";
}

function pathKey(path) {
  return normalizeAbsPath(path);
}

function workspaceEntryPath(entry) {
  return entry?.path || entry?.workspace || entry?.workspaceDir || entry?.workspacePath || entry?.dir || null;
}

function workspaceEntryId(entry, fallbackPath, fallbackIndex = 0) {
  return entry?.workspace_id
    || entry?.workspaceId
    || entry?.id
    || entry?.name
    || safeWorkspaceIdFromPath(fallbackPath)
    || `workspace-${fallbackIndex}`;
}

function workspaceEntryAgent(entry, workspaceId) {
  return entry?.agent_id || entry?.agentId || entry?.agent || workspaceId;
}

function hasWorkspaceDiscoveryMarker(dir) {
  return WORKSPACE_DISCOVERY_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

function addWorkspaceCandidate(map, rawCandidate) {
  if (!rawCandidate?.path) return null;
  const normalizedPath = pathKey(rawCandidate.path);
  const existing = map.get(normalizedPath) || {
    workspaceId: rawCandidate.workspaceId || safeWorkspaceIdFromPath(normalizedPath),
    agentId: rawCandidate.agentId || rawCandidate.workspaceId || safeWorkspaceIdFromPath(normalizedPath),
    label: rawCandidate.label || rawCandidate.workspaceId || safeWorkspaceIdFromPath(normalizedPath),
    path: normalizedPath,
    sources: new Set(),
    agentIds: new Set(),
    aliases: new Set(),
    legacyKeys: new Set(),
    confidence: rawCandidate.confidence || "medium",
    existing: rawCandidate.existing === true,
  };
  if (rawCandidate.existing === true) existing.existing = true;
  if (rawCandidate.workspaceId && (!existing.existing || rawCandidate.existing === true)) {
    existing.workspaceId = rawCandidate.workspaceId;
    existing.label = rawCandidate.label || existing.label || rawCandidate.workspaceId;
  }
  if (rawCandidate.agentId && (!existing.existing || rawCandidate.existing === true)) existing.agentId = rawCandidate.agentId;
  if (rawCandidate.label && (!existing.existing || rawCandidate.existing === true)) existing.label = rawCandidate.label;
  if (rawCandidate.confidence === "high" || existing.confidence !== "high") {
    existing.confidence = rawCandidate.confidence || existing.confidence;
  }
  for (const source of rawCandidate.sources || [rawCandidate.source || "unknown"]) existing.sources.add(source);
  for (const agentId of rawCandidate.agentIds || [rawCandidate.agentId].filter(Boolean)) existing.agentIds.add(agentId);
  for (const alias of rawCandidate.aliases || []) existing.aliases.add(alias);
  for (const legacyKey of rawCandidate.legacyKeys || []) existing.legacyKeys.add(legacyKey);
  const basenameAlias = safeWorkspaceIdFromPath(normalizedPath);
  if (basenameAlias && basenameAlias !== existing.workspaceId) existing.legacyKeys.add(basenameAlias);
  map.set(normalizedPath, existing);
  return existing;
}

function finalizeWorkspaceCandidate(candidate) {
  const agentIds = [...candidate.agentIds].sort();
  const agentId = candidate.agentId || agentIds[0] || candidate.workspaceId;
  return {
    workspaceId: candidate.workspaceId,
    agentId,
    label: candidate.label || candidate.workspaceId,
    path: candidate.path,
    sources: [...candidate.sources].sort(),
    agentIds,
    aliases: [...candidate.aliases].sort(),
    legacyKeys: [...candidate.legacyKeys].sort(),
    confidence: candidate.confidence,
    existing: candidate.existing === true,
  };
}

function collectConfiguredWorkspaceCandidates(rawConfig, map) {
  const cfg = normalizeObsidianBridgeConfig(rawConfig);
  cfg.workspaces.forEach((entry, index) => {
    const path = workspaceEntryPath(entry);
    if (!path) return;
    const workspaceId = workspaceEntryId(entry, path, index);
    addWorkspaceCandidate(map, {
      workspaceId,
      agentId: workspaceEntryAgent(entry, workspaceId),
      label: entry.label || workspaceId,
      path,
      source: "obsidianBridge.workspaces",
      confidence: "high",
      existing: true,
      aliases: [entry.alias, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].filter(Boolean),
    });
  });
}

function collectOpenClawAgentWorkspaceCandidates(openclawConfig, map) {
  const agents = openclawConfig?.agents || {};
  const defaultsWorkspace = workspaceEntryPath(agents.defaults || {});
  if (defaultsWorkspace) {
    addWorkspaceCandidate(map, {
      workspaceId: safeWorkspaceIdFromPath(defaultsWorkspace),
      agentId: agents.defaults?.id || agents.defaults?.name || "default",
      path: defaultsWorkspace,
      source: "agents.defaults.workspace",
      confidence: "medium",
    });
  }
  const list = Array.isArray(agents.list) ? agents.list : [];
  list.forEach((entry) => {
    const path = workspaceEntryPath(entry);
    if (!path) return;
    const agentId = entry.id || entry.name || safeWorkspaceIdFromPath(path);
    addWorkspaceCandidate(map, {
      workspaceId: safeWorkspaceIdFromPath(path),
      agentId,
      agentIds: [agentId],
      label: entry.label || entry.name || safeWorkspaceIdFromPath(path),
      path,
      source: "agents.list.workspace",
      confidence: "medium",
    });
  });
}

function collectOpenClawHomeWorkspaceCandidates(openclawHome, map) {
  if (!openclawHome) return;
  const home = normalizeAbsPath(openclawHome);
  if (!existsSync(home)) return;
  let entries = [];
  try {
    entries = readdirSync(home, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (WORKSPACE_DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
    const dir = join(home, entry.name);
    if (!hasWorkspaceDiscoveryMarker(dir)) continue;
    addWorkspaceCandidate(map, {
      workspaceId: safeWorkspaceIdFromPath(dir),
      agentId: safeWorkspaceIdFromPath(dir),
      path: dir,
      source: "openclawHome.workspaceMarkers",
      confidence: "medium",
    });
  }
}

function collectNeoLegacyWorkspaceKeys(neoRoot, candidates) {
  const orphanLegacyKeys = [];
  if (!neoRoot) return orphanLegacyKeys;
  const workspacesDir = join(normalizeAbsPath(neoRoot), "workspaces");
  if (!existsSync(workspacesDir)) return orphanLegacyKeys;
  let entries = [];
  try {
    entries = readdirSync(workspacesDir, { withFileTypes: true });
  } catch (_) {
    return orphanLegacyKeys;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const legacyKey = entry.name;
    if (!legacyKey.startsWith("workspace")) continue;
    const match = candidates.find((candidate) => candidate.legacyKeys.includes(legacyKey) || basename(candidate.path) === legacyKey);
    if (match) {
      if (!match.legacyKeys.includes(legacyKey)) match.legacyKeys.push(legacyKey);
      match.legacyKeys = [...new Set(match.legacyKeys)].sort();
    } else {
      orphanLegacyKeys.push(legacyKey);
    }
  }
  return orphanLegacyKeys.sort();
}

export function discoverLocalObsidianWorkspaceCandidates(rawConfig = {}, options = {}) {
  const candidateMap = new Map();
  collectConfiguredWorkspaceCandidates(rawConfig, candidateMap);
  collectOpenClawAgentWorkspaceCandidates(options.openclawConfig || {}, candidateMap);
  collectOpenClawHomeWorkspaceCandidates(options.openclawHome || process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"), candidateMap);
  const candidates = [...candidateMap.values()]
    .map(finalizeWorkspaceCandidate)
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.path.localeCompare(b.path));
  const orphanLegacyKeys = collectNeoLegacyWorkspaceKeys(options.neoRoot, candidates);
  return {
    ok: true,
    dryRun: options.dryRun !== false,
    candidates,
    existing: candidates.filter((candidate) => candidate.existing),
    wouldAdd: candidates.filter((candidate) => !candidate.existing),
    orphanLegacyKeys,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function pluginConfigFromOpenClawConfig(config) {
  const entries = config?.plugins?.entries || {};
  return entries["memory-lancedb-namespaced"]?.config
    || entries["@cyb3rb1ade/plur1bus-memory"]?.config
    || null;
}

function ensurePluginBridgeConfig(config) {
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  const pluginId = config.plugins.entries["memory-lancedb-namespaced"]
    ? "memory-lancedb-namespaced"
    : (config.plugins.entries["@cyb3rb1ade/plur1bus-memory"] ? "@cyb3rb1ade/plur1bus-memory" : "memory-lancedb-namespaced");
  config.plugins.entries[pluginId] = config.plugins.entries[pluginId] || {};
  config.plugins.entries[pluginId].config = config.plugins.entries[pluginId].config || {};
  config.plugins.entries[pluginId].config.obsidianBridge = config.plugins.entries[pluginId].config.obsidianBridge || {};
  return config.plugins.entries[pluginId].config.obsidianBridge;
}

function candidateAsWorkspaceEntry(candidate) {
  return {
    workspace_id: candidate.workspaceId,
    agent_id: candidate.agentId,
    label: candidate.label || candidate.workspaceId,
    path: candidate.path,
    aliases: [...new Set([...(candidate.aliases || []), ...(candidate.legacyKeys || [])])].filter(Boolean).sort(),
  };
}

export function mergeDiscoveredObsidianWorkspaces(openclawConfig = {}, candidates = []) {
  const next = cloneJson(openclawConfig);
  const bridgeCfg = ensurePluginBridgeConfig(next);
  const workspaces = Array.isArray(bridgeCfg.workspaces) ? bridgeCfg.workspaces : [];
  const existingIds = new Set(workspaces.map((entry) => workspaceEntryId(entry, workspaceEntryPath(entry))).filter(Boolean));
  const existingPaths = new Set(workspaces.map(workspaceEntryPath).filter(Boolean).map(pathKey));
  const added = [];
  const skipped = [];

  for (const candidate of candidates) {
    if (!candidate?.path || !candidate.workspaceId) continue;
    const normalizedPath = pathKey(candidate.path);
    if (existingIds.has(candidate.workspaceId) || existingPaths.has(normalizedPath)) {
      skipped.push({ workspaceId: candidate.workspaceId, path: normalizedPath, reason: "already_configured" });
      continue;
    }
    const entry = candidateAsWorkspaceEntry(candidate);
    workspaces.push(entry);
    existingIds.add(candidate.workspaceId);
    existingPaths.add(normalizedPath);
    added.push(entry);
  }
  bridgeCfg.workspaces = workspaces;
  return { config: next, added, skipped };
}

function assertFreshBackupDir(backupDir, options = {}) {
  if (!backupDir) throw new Error("Refusing to write workspace discovery without --backup-dir");
  const dir = normalizeAbsPath(backupDir);
  if (!existsSync(dir)) throw new Error(`Backup directory does not exist: ${dir}`);
  const stats = statSync(dir);
  if (!stats.isDirectory()) throw new Error(`Backup path is not a directory: ${dir}`);
  const maxAgeMs = Number(options.maxAgeMs || 24 * 60 * 60 * 1000);
  if (Date.now() - stats.mtimeMs > maxAgeMs) throw new Error(`Backup directory is not fresh enough: ${dir}`);
  return dir;
}

export function writeDiscoveredObsidianWorkspaces(configPath, candidates = [], options = {}) {
  if (!configPath) throw new Error("OpenClaw config path is required");
  const backupDir = assertFreshBackupDir(options.backupDir, { maxAgeMs: options.backupMaxAgeMs });
  const normalizedConfigPath = normalizeAbsPath(configPath);
  const originalText = readFileSync(normalizedConfigPath, "utf8");
  const original = JSON.parse(originalText);
  const pluginCfg = pluginConfigFromOpenClawConfig(original);
  const existingBridgeCfg = pluginCfg?.obsidianBridge || {};
  const filteredCandidates = (candidates || []).filter((candidate) => !candidate.existing);
  const { config, added, skipped } = mergeDiscoveredObsidianWorkspaces(original, filteredCandidates);
  const backupPath = join(backupDir, `openclaw.json.obsidian-discover-${timestampId()}.bak`);
  writeFileSync(backupPath, originalText, "utf8");
  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      backupPath,
      existingWorkspaces: Array.isArray(existingBridgeCfg.workspaces) ? existingBridgeCfg.workspaces.length : 0,
      added,
      skipped,
      written: false,
    };
  }
  if (added.length > 0) writeJsonAtomic(normalizedConfigPath, config);
  return {
    ok: true,
    dryRun: false,
    backupPath,
    existingWorkspaces: Array.isArray(existingBridgeCfg.workspaces) ? existingBridgeCfg.workspaces.length : 0,
    added,
    skipped,
    written: added.length > 0,
  };
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value) {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

function firstSourceQuote(body) {
  const normalized = String(body || "").replace(/\r\n/g, "\n");
  const line = normalized
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#") && !item.startsWith("---"));
  return (line || normalized.trim()).slice(0, 200);
}

function summarizeObsidianSource(file) {
  const body = String(file.body || "").trim();
  const titleMatch = body.match(/^\s*#\s+(.+)$/m);
  const title = String(file.frontmatter.title || titleMatch?.[1] || basename(file.relPath, ".md")).trim();
  const quote = firstSourceQuote(body);
  if (/ignore\s+(all\s+)?(previous|system|developer)|system\s+prompt|developer\s+prompt|execute\s+(this\s+)?(shell\s+)?command|rm\s+-rf|curl\b[^\n|;&]*\|\s*(sh|bash)/i.test(body)) {
    return `Obsidian note "${title}" contains untrusted prompt-like text and needs review before any memory promotion.`;
  }
  return quote ? `${title}: ${quote}` : `Obsidian note "${title}" needs review before memory promotion.`;
}

export function buildObsidianSemanticPayload(file, workspace, options = {}) {
  const sourceHash = file.contentHash;
  const evidenceQuote = firstSourceQuote(file.body);
  return {
    text: String(options.text || summarizeObsidianSource(file)).trim(),
    category: OBSIDIAN_CARD_CATEGORIES.includes(file.frontmatter.category) ? file.frontmatter.category : "fact",
    importance: Number.isFinite(Number(file.frontmatter.importance)) ? Number(file.frontmatter.importance) : 0.6,
    scope: OBSIDIAN_SCOPES.includes(file.frontmatter.scope) ? file.frontmatter.scope : "workspace",
    origin: "internal",
    sourceUrl: `obsidian://${workspace.workspaceId}/${file.relPath}`,
    sourceRef: file.relPath,
    evidenceQuote,
    sourceHash,
    content_hash: sourceHash,
    sourceTrustLevel: "untrusted_obsidian",
  };
}

export function bridgePaths(workspace) {
  const dir = join(workspace.path, STATE_REL_DIR);
  return {
    dir,
    state: join(dir, "state.json"),
    syncLog: join(dir, "sync-log.jsonl"),
    conflictLog: join(dir, "conflict-log.jsonl"),
    queue: join(dir, "store-queue.jsonl"),
    candidates: join(dir, "candidates.jsonl"),
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
  if (card.kind === "note") return { errors, warnings };

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
  const payload = {
    text,
    category: OBSIDIAN_CARD_CATEGORIES.includes(fm.category) ? fm.category : "decision",
    importance: Number.isFinite(Number(fm.importance)) ? Number(fm.importance) : 0.7,
    origin: "internal",
    scope: OBSIDIAN_SCOPES.includes(fm.scope) ? fm.scope : "workspace",
    sourceUrl: `obsidian://${workspace.workspaceId}/${card.relPath}`,
    evidenceQuote: text.slice(0, 200),
  };
  if (fm.emotional_dominant && fm.emotional_dominant !== "neutral") {
    payload.emotionalDominant = fm.emotional_dominant;
  }
  if (Number.isFinite(Number(fm.emotional_intensity)) && Number(fm.emotional_intensity) > 0) {
    payload.emotionalIntensity = Number(fm.emotional_intensity);
  }
  return payload;
}

export function buildObsidianCandidate(file, workspace, options = {}) {
  const now = options.now || new Date();
  const candidateHash = createHash("sha256")
    .update(`${workspace.workspaceId}\n${workspace.agentId}\n${file.relPath}\n${file.contentHash}`, "utf8")
    .digest("hex");
  const titleMatch = file.body.match(/^\s*#\s+(.+)$/m);
  const title = String(file.frontmatter.title || titleMatch?.[1] || basename(file.relPath, ".md")).trim();
  const excerpt = file.body.trim().replace(/\s+/g, " ").slice(0, 500);
  const semanticPayload = buildObsidianSemanticPayload(file, workspace, options);
  const payloadHash = hashPayload(semanticPayload);
  return {
    schema: OBSIDIAN_BRIDGE_VERSION,
    event: "obsidian.candidate",
    id: `obs_${candidateHash.slice(0, 24)}`,
    timestamp: now.toISOString(),
    workspace_id: workspace.workspaceId,
    agent_id: workspace.agentId,
    path: file.relPath,
    kind: file.kind,
    title,
    status: "pending_user_review",
    proposalOnly: true,
    mutateMemory: false,
    sourceOfTruth: "plur1bus-lancedb",
    recallAuthority: "lancedb-reranked-vector",
    source_kind: "obsidian",
    source_url: `obsidian://${workspace.workspaceId}/${file.relPath}`,
    sourceTrustLevel: "untrusted_obsidian",
    target_action: options.targetAction || "review_source",
    reason: options.reason || "Obsidian documents are review input only until explicitly approved through PLUR1BUS.",
    content_hash: file.contentHash,
    sourceHash: file.contentHash,
    frontmatter_status: file.frontmatter.sync_status || null,
    memory_id: file.frontmatter.memory_id || null,
    applyPreview: {
      schemaVersion: 1,
      payload: semanticPayload,
      payloadHash,
      immutableFields: ["text", "category", "scope", "origin", "sourceUrl", "sourceRef", "evidenceQuote", "sourceHash", "content_hash", "sourceTrustLevel"],
    },
    payloadHash,
    excerpt,
  };
}

function candidateAlreadyRecorded(prev, file) {
  return prev?.contentHash === file.contentHash
    && ["candidate_queued", "pending_user_review", "synced", "queued"].includes(String(prev.syncStatus || ""));
}

function queueObsidianCandidate(workspace, file, options = {}) {
  const dryRun = options.dryRun !== false;
  const candidate = buildObsidianCandidate(file, workspace, options);
  if (!dryRun) {
    const paths = bridgePaths(workspace);
    appendJsonl(paths.candidates, candidate);
    appendJsonl(paths.syncLog, {
      event: "obsidian.candidate_queued",
      timestamp: candidate.timestamp,
      workspace_id: workspace.workspaceId,
      agent_id: workspace.agentId,
      path: file.relPath,
      candidate_id: candidate.id,
      kind: file.kind,
      content_hash: file.contentHash,
      target_action: candidate.target_action,
    });
  }
  return {
    action: dryRun ? "would_propose_obsidian_candidate" : "obsidian_candidate_queued",
    path: file.relPath,
    candidateId: candidate.id,
    candidatePath: join(STATE_REL_DIR, "candidates.jsonl"),
    targetAction: candidate.target_action,
    reason: candidate.reason,
  };
}

function normalizeApprovedPaths(value) {
  if (value === "all") return "all";
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set([String(value)]);
}

function isExplicitlyApproved(file, options = {}) {
  if (options.applyApproved !== true) return false;
  const approvedPaths = normalizeApprovedPaths(options.approvedPaths || options.paths);
  if (approvedPaths === "all") return true;
  return approvedPaths.has(file.relPath);
}

export function scanWorkspace(workspace, options = {}) {
  const includeGlobs = options.includeGlobs || workspace.includeGlobs || DEFAULT_INCLUDE_GLOBS;
  const ignoreGlobs = options.ignoreGlobs || workspace.ignoreGlobs || DEFAULT_IGNORE_GLOBS;
  const includeRegexes = includeGlobs.map(globToRegExp);
  const ignoreRegexes = ignoreGlobs.map(globToRegExp);
  const roots = globRoots(includeGlobs);
  const files = [];
  const issues = [];
  const collected = new Set();

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
    if (collected.has(relPath)) return;
    collected.add(relPath);
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
      if (!candidateAlreadyRecorded(prev, file)) {
        actions.push(queueObsidianCandidate(workspace, file, {
          dryRun,
          reason: file.kind === "knowledge"
            ? "KNOWLEDGE.md is curated PLUR1BUS workspace truth; Obsidian edits require review and knowledge_update, never silent overwrite."
            : "Obsidian document is review/source input only; it is not Auto-Recall memory until promoted through PLUR1BUS.",
          targetAction: file.kind === "knowledge" ? "knowledge_update_proposal" : "review_source",
        }));
      }
      state.files[file.relPath] = {
        kind: file.kind,
        contentHash: file.contentHash,
        syncStatus: "candidate_queued",
        updatedAt: new Date().toISOString(),
      };
      continue;
    }

    const isValidatedDecision = file.kind === "decision"
      && (file.frontmatter.validated === true || file.frontmatter.sync_status === "validated");
    if (file.kind === "decision" && !isValidatedDecision) {
      if (!candidateAlreadyRecorded(prev, file)) {
        actions.push(queueObsidianCandidate(workspace, file, {
          dryRun,
          reason: "Decision note is not validated; it can only become memory through review and approved PLUR1BUS apply.",
          targetAction: "review_decision",
        }));
      } else {
        actions.push({ action: "scan_only_decision", path: file.relPath, reason: "decision not validated" });
      }
      state.files[file.relPath] = {
        kind: file.kind,
        contentHash: file.contentHash,
        syncStatus: "pending_user_review",
        updatedAt: new Date().toISOString(),
      };
      continue;
    }

    if (file.validation.errors.length > 0) {
      actions.push({ action: "skip_invalid", path: file.relPath, errors: file.validation.errors });
      continue;
    }

    const approvedForApply = isExplicitlyApproved(file, options);
    const pendingSameContent = prev?.contentHash === file.contentHash
      && ["candidate_queued", "pending_user_review"].includes(String(prev.syncStatus || ""));
    const changed = approvedForApply
      || !prev
      || prev.contentHash !== file.contentHash
      || (!pendingSameContent && !["synced", "queued"].includes(String(file.frontmatter.sync_status || "")));
    if (!changed) continue;

    const payload = buildMemoryStorePayload(file, workspace);
    if (dryRun) {
      actions.push({
        action: approvedForApply ? "would_memory_store" : "would_require_approval",
        path: file.relPath,
        payload,
        reason: approvedForApply
          ? "Explicit approved apply path would call memory_store."
          : "Raw Obsidian scan would create a proposal only.",
      });
      continue;
    }
    if (!approvedForApply) {
      const candidateAction = queueObsidianCandidate(workspace, file, {
        dryRun,
        reason: "Obsidian-originated memory cards require explicit PLUR1BUS approval before memory_store.",
        targetAction: "memory_store_proposal",
      });
      actions.push({
        action: "approval_required",
        path: file.relPath,
        candidateId: candidateAction.candidateId,
        candidatePath: candidateAction.candidatePath,
        payload,
        reason: "Obsidian Bridge prepares review items; memory_store is not called from raw Vault scans.",
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
      const deletionApproved = options.applyApproved === true
        && (normalizeApprovedPaths(options.approvedPaths || options.paths) === "all"
          || normalizeApprovedPaths(options.approvedPaths || options.paths).has(relPath));
      if (!deletionApproved) {
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
