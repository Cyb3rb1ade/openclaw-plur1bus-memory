import { createHash } from "node:crypto";

export const CODE_INDEX_VERSION = 1;
export const CODE_INDEX_KIND = "plur1bus-code-index";

export function sha256Text(value) {
  return `sha256:${createHash("sha256").update(String(value || ""), "utf8").digest("hex")}`;
}

export function normalizeCodePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function stableCodeId(prefix, parts) {
  const hash = sha256Text(parts.map((part) => String(part ?? "")).join("\x00")).slice("sha256:".length, "sha256:".length + 20);
  return `${prefix}:${hash}`;
}

export function createEmptyCodeIndex(options = {}) {
  return {
    version: CODE_INDEX_VERSION,
    kind: CODE_INDEX_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    rootDir: options.rootDir || "",
    files: [],
    symbols: [],
    edges: [],
    chunks: [],
  };
}

export function normalizeCodeIndex(index = {}, options = {}) {
  return {
    ...createEmptyCodeIndex(options),
    ...index,
    version: CODE_INDEX_VERSION,
    kind: CODE_INDEX_KIND,
    files: Array.isArray(index.files) ? index.files : [],
    symbols: Array.isArray(index.symbols) ? index.symbols : [],
    edges: Array.isArray(index.edges) ? index.edges : [],
    chunks: Array.isArray(index.chunks) ? index.chunks : [],
  };
}
