/**
 * adapter/openclaw/register-tools.js
 *
 * Hands the engine's tool factory to OpenClaw. `api.registerTool` is called
 * unguarded, exactly as index.js:7672 did, and the `names` metadata travels
 * with it verbatim: OpenClaw's allowlist discovery reads that array to learn
 * the five tool names a *factory* registration would otherwise hide
 * (tests/tool-registration-metadata.test.js pins it against
 * openclaw.plugin.json's `contracts.tools`).
 */

import { createMemoryTools } from "../../engine/tools/memory-tools.js";

/**
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerMemoryTools(ctx) {
  ctx.api.registerTool(createMemoryTools(ctx), {
    names: ["memory_recall", "memory_search", "memory_store", "memory_forget", "knowledge_update"],
  });
}
