import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { ensureDir } from "../obsidian/safe-paths.js";

const LEGACY_MEMORY_STORE_BLOCK =
  /(\*\*WIE speichern:\*\*\s*\n)```(?:[^\n]*\n)?\s*memory_store:0\{[^\n]*\}\s*\n```/m;

const MEMORY_STORE_GUIDANCE = [
  "**WIE speichern:**",
  "",
  "- Use the actual `memory_store` tool when it is available.",
  "- Never print legacy text-form tool calls in chat, code fences, or explanations.",
  "- If a memory tool is unavailable or fails, say that directly; do not claim that anything was stored.",
  "- Use `knowledge_update` only for durable curated workspace truth. If it is blocked by `security.allowModelDestructiveMemoryOps=false`, report the block as intentional security behavior.",
].join("\n");

/**
 * Replace legacy text examples that made agents print fake memory tool calls.
 * @param {string} content - Existing AGENTS.md content.
 * @returns {{content: string, changed: boolean}}
 */
export function patchAgentsContent(content = "") {
  const next = String(content || "").replace(LEGACY_MEMORY_STORE_BLOCK, MEMORY_STORE_GUIDANCE);
  return { content: next, changed: next !== content };
}

/**
 * Patch AGENTS.md in place and keep a timestamped backup by default.
 * @param {string} path - AGENTS.md path.
 * @param {{backup?: boolean}} options - Patch options.
 * @returns {{ok: boolean, changed: boolean, reason?: string, path?: string}}
 */
export function patchAgentsMd(path, options = {}) {
  const target = resolve(path);
  if (!target.endsWith("AGENTS.md")) throw new Error("AGENTS patch target must be AGENTS.md");
  if (!existsSync(target)) return { ok: true, changed: false, reason: "missing" };

  const existing = readFileSync(target, "utf8");
  const result = patchAgentsContent(existing);
  if (!result.changed) return { ok: true, changed: false, reason: "already current", path: target };

  ensureDir(dirname(target));
  if (options.backup !== false) {
    writeFileSync(`${target}.bak-plur1bus-agents-${Date.now()}-${process.pid}`, existing, "utf8");
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, result.content, "utf8");
  renameSync(tmp, target);
  return { ok: true, changed: true, path: target };
}
