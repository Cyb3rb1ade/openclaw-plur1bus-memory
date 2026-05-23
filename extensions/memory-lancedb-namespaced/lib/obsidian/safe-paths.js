import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_REVIEW_ROOT = "00-system/plur1bus";

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
    .replace(/^-+|-+$/g, "")
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

export function resolveReviewRoot(rawConfig = {}) {
  return assertSafeRelativePath(rawConfig.reviewRoot || DEFAULT_REVIEW_ROOT, rawConfig);
}

export function resolveReviewPath(rawConfig = {}, relPath = ".") {
  const vaultPath = resolveVaultPath(rawConfig);
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

