import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_REVIEW_ROOT = "plur1bus";

export function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return text;
}

export function safeSlug(value, fallback = "item") {
  return String(value || fallback)
    .normalize("NFKD")
    .replace(/[^\w .-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    // Führende/abschließende Punkte UND Bindestriche entfernen, damit kein
    // Slug zu "." oder ".." kollabiert (Defense-in-depth gegen Traversal,
    // falls ein Slug je außerhalb von assertSafeRelativePath als Pfad-Segment
    // landet).
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100) || fallback;
}

export function assertSafeRelativePath(value, options = {}) {
  const input = String(value || "").replace(/\\/g, "/");
  if (!input || input === ".") return ".";
  if (input.includes("\0")) throw new Error("Path contains NUL byte");
  if (input.startsWith("/") || /^[A-Za-z]:\//.test(input)) throw new Error(`Absolute path rejected: ${value}`);
  const parts = input.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) throw new Error(`Path traversal rejected: ${value}`);
  if (parts[0] === ".obsidian" && options.allowDotObsidianWrite !== true) {
    throw new Error(".obsidian writes require obsidianBridge.allowDotObsidianWrite=true");
  }
  return parts.join("/") || ".";
}

export function resolveVaultPath(rawConfig = {}) {
  const vault = rawConfig.vaultPath ?? rawConfig.vault ?? null;
  if (!vault) return null;
  const expanded = expandHome(vault);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
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
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

function workspaceMatchesContext(entry = {}, index = 0, options = {}) {
  const rawPath = workspaceEntryPath(entry);
  const workspaceId = workspaceEntryId(entry, rawPath ? rawPath.split(/[\\/]/).filter(Boolean).at(-1) : `workspace-${index}`);
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

export function resolveContextVaultPath(rawConfig = {}, options = {}) {
  const explicit = rawConfig.vaultPath ?? rawConfig.vault ?? null;
  if (explicit) return explicit;

  const contextPath = options.workspaceDir || options.commandCtx?.workspaceDir;
  const workspaces = Array.isArray(rawConfig.workspaces) ? rawConfig.workspaces : [];
  const matchingWorkspace = workspaces.find((workspace, index) => workspaceMatchesContext(workspace, index, options));
  const matchingPath = workspaceEntryPath(matchingWorkspace);
  if (matchingPath) return matchingPath;
  if (contextPath) return contextPath;
  if (workspaces.length === 1) return workspaceEntryPath(workspaces[0]);
  return null;
}

export function resolveReviewRoot(rawConfig = {}) {
  return assertSafeRelativePath(rawConfig.reviewRoot || DEFAULT_REVIEW_ROOT, rawConfig);
}

export function resolveReviewPath(rawConfig = {}, relPath = ".", options = {}) {
  const vaultPath = resolveVaultPath({ ...rawConfig, vaultPath: resolveContextVaultPath(rawConfig, options) });
  if (!vaultPath) throw new Error("obsidianBridge.vaultPath is not configured");
  const reviewRoot = resolveReviewRoot(rawConfig);
  const safeRel = assertSafeRelativePath(relPath, rawConfig);
  const root = resolve(vaultPath, reviewRoot);
  const target = safeRel === "." ? root : resolve(root, safeRel);
  const diff = relative(root, target);
  if (diff.startsWith("..") || isAbsolute(diff)) throw new Error(`Path traversal rejected: ${relPath}`);
  return { vaultPath, reviewRoot, reviewPath: root, targetPath: target, relPath: safeRel };
}

export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function atomicWriteText(path, content) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, String(content), "utf8");
  renameSync(tmp, path);
}
