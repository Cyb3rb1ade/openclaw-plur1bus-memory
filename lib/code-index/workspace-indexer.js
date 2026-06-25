import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";

import { resolveInside } from "../sql-safety.js";
import { atomicWriteText } from "../obsidian/safe-paths.js";
import { createEmptyCodeIndex, normalizeCodeIndex, normalizeCodePath } from "./schema.js";
import { indexSourceFileWithTypescript } from "./ts-source-indexer.js";

export const CODE_INDEX_PATH_REL = ".plur1bus/code-index.json";

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".plur1bus",
  "coverage",
  "dist",
  "node_modules",
]);

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function shouldIgnoreDir(name, options = {}) {
  if (IGNORED_DIRS.has(name)) return true;
  if (options.includeTests === false && (name === "test" || name === "tests")) return true;
  return false;
}

async function walkCodeFiles(rootDir, currentDir, out, options) {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldIgnoreDir(entry.name, options)) continue;
      await walkCodeFiles(rootDir, resolveInside(rootDir, relative(rootDir, join(currentDir, entry.name))), out, options);
      continue;
    }
    if (!entry.isFile() || !isCodeFile(entry.name)) continue;
    out.push(resolveInside(rootDir, relative(rootDir, join(currentDir, entry.name))));
  }
}

/**
 * Discover JS/TS source files inside a workspace.
 * @param {string} rootDir Workspace root.
 * @param {Object} options Discovery options.
 * @returns {Promise<string[]>} Absolute source file paths.
 */
export async function discoverCodeFiles(rootDir, options = {}) {
  const root = resolveInside(rootDir);
  const files = [];
  await walkCodeFiles(root, root, files, options);
  return files.sort();
}

export async function loadTypeScriptCompiler() {
  try {
    const mod = await import("typescript");
    return mod.default || mod;
  } catch (err) {
    throw new Error(`PLUR1BUS code index requires optional dependency "typescript": ${err.message}`);
  }
}

function resolveWorkspacePath(root, rawPath) {
  const text = String(rawPath || "");
  return isAbsolute(text) ? resolveInside(root, relative(root, text)) : resolveInside(root, text);
}

function sortByIdOrPath(a, b) {
  const left = a.path || a.id || a.name || "";
  const right = b.path || b.id || b.name || "";
  return left.localeCompare(right);
}

/**
 * Build a normalized PLUR1BUS code index for explicit files.
 * @param {Object} options Build options.
 * @returns {Promise<Object>} Normalized code index.
 */
export async function buildCodeIndexForFiles(options = {}) {
  const { rootDir, filePaths = [], ts, readFileFn = readFile } = options;
  if (!rootDir) throw new Error("buildCodeIndexForFiles requires rootDir");
  const compiler = ts || await loadTypeScriptCompiler();
  const root = resolveInside(rootDir);
  const index = createEmptyCodeIndex({ rootDir: root });

  for (const rawPath of filePaths) {
    const filePath = resolveWorkspacePath(root, rawPath);
    const sourceText = await readFileFn(filePath, "utf8");
    const fragment = indexSourceFileWithTypescript({ filePath, rootDir: root, sourceText, ts: compiler });
    index.files.push(fragment.file);
    index.symbols.push(...fragment.symbols);
    index.edges.push(...fragment.edges);
    index.chunks.push(...fragment.chunks);
  }

  index.files.sort(sortByIdOrPath);
  index.symbols.sort(sortByIdOrPath);
  index.edges.sort(sortByIdOrPath);
  index.chunks.sort(sortByIdOrPath);
  return normalizeCodeIndex(index, { rootDir: root });
}

export async function buildCodeIndexForWorkspace(rootDir, options = {}) {
  const filePaths = options.filePaths || await discoverCodeFiles(rootDir, options);
  return buildCodeIndexForFiles({ ...options, rootDir, filePaths });
}

export function saveCodeIndex(rootDir, index) {
  const root = resolveInside(rootDir);
  const indexPath = resolveInside(root, CODE_INDEX_PATH_REL);
  atomicWriteText(indexPath, JSON.stringify(normalizeCodeIndex(index, { rootDir: root }), null, 2) + "\n");
}

export function loadCodeIndex(rootDir) {
  const root = resolveInside(rootDir);
  const indexPath = resolveInside(root, CODE_INDEX_PATH_REL);
  if (!existsSync(indexPath)) return createEmptyCodeIndex({ rootDir: root });
  try {
    return normalizeCodeIndex(JSON.parse(readFileSync(indexPath, "utf8")), { rootDir: root });
  } catch {
    return createEmptyCodeIndex({ rootDir: root });
  }
}

export function codeIndexRelativePath(filePath, rootDir) {
  const root = resolveInside(rootDir);
  return normalizeCodePath(relative(root, resolveWorkspacePath(root, filePath)));
}
