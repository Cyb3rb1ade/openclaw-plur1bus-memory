/**
 * adapter/openclaw/register-recall-hook.js
 *
 * Registers the recall assembly on before_prompt_build with the plugin's own
 * envelope: recallTimeoutMs + 5 000 ms (index.js:13327,
 * lib/runtime-scheduler.js:7). The harness passes a real AbortSignal and a
 * much tighter budget instead; that is PR-05, not this task.
 */

import { createPromptContextAssembler } from "../../engine/recall/assemble-prompt-context.js";

/**
 * @param {Record<string, any>} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerRecallHook(ctx) {
  const handler = createPromptContextAssembler(ctx);
  ctx.api.on("before_prompt_build", handler, {
    timeoutMs: ctx.runtimeScheduler.config.recallTimeoutMs + 5_000,
  });
}
