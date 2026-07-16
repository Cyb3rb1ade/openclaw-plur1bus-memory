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
const TELEGRAM_REACTION_RULES_MARKER = "<!-- plur1bus:telegram-reaction-rules -->";

const TELEGRAM_REACTION_RULES_BLOCK = [
  TELEGRAM_REACTION_RULES_MARKER,
  "",
  "### ⚠️ Telegram Reaction Rules (managed by plur1bus)",
  "",
  "**Allowed emoji set:** Telegram bots may ONLY use the fixed `ReactionTypeEmoji` set; anything else fails with `REACTION_INVALID` / \"Reaction unavailable\". Common traps: 😂 → use 🤣; 😊/🙂 → 😁 or 🥰; ❤️ (with variation selector) → ❤ (without); no skin tones (👍🏻 → 👍). Safe picks: 👍 ❤ 🤣 🔥 🤔.",
  "",
  "**Reaction target:** Always react to the **current** message — its `message_id` is in the \"Conversation info (untrusted metadata)\" block of your current turn. Never guess, increment, or reuse message IDs from earlier turns; only target an older message when the user explicitly names one.",
].join("\n");

const REACTION_GUIDANCE_CUE = /reaction|emoji-reactions/i;

/**
 * Append the managed Telegram reaction rules when the file already gives
 * reaction guidance but lacks the managed block.
 * @param {string} content - Existing AGENTS.md content.
 * @returns {string}
 */
function withTelegramReactionRules(content) {
  if (content.includes(TELEGRAM_REACTION_RULES_MARKER)) return content;
  if (!REACTION_GUIDANCE_CUE.test(content)) return content;
  const base = content.endsWith("\n") ? content : `${content}\n`;
  return `${base}\n${TELEGRAM_REACTION_RULES_BLOCK}\n`;
}

export function patchAgentsContent(content = "") {
  let next = String(content || "").replace(LEGACY_MEMORY_STORE_BLOCK, MEMORY_STORE_GUIDANCE);
  next = withTelegramReactionRules(next);
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
