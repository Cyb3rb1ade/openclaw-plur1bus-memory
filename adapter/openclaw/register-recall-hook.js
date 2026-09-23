/**
 * adapter/openclaw/register-recall-hook.js
 *
 * Registers the recall assembly on before_prompt_build with the plugin's own
 * envelope: recallTimeoutMs + 5 000 ms (index.js:13327,
 * lib/runtime-scheduler.js:7). The recall signal is mandatory (PR-05): this
 * adapter supplies `AbortSignal.timeout(recallTimeoutMs)`, which cancels the
 * embedder and LanceDB waits when the hook's own budget runs out. The handler
 * joins the engine's RecallResult blocks through join-recall.js before
 * handing OpenClaw its `{ prependContext }` shape.
 */

import { createPromptContextAssembler } from "../../engine/recall/assemble-prompt-context.js";
import { prependContextFromRecall } from "./join-recall.js";

/**
 * @param {Record<string, any>} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerRecallHook(ctx) {
  const recall = createPromptContextAssembler(ctx);
  ctx.api.on("before_prompt_build", async (event, hookCtx) => prependContextFromRecall(
    await recall(event, hookCtx, { signal: AbortSignal.timeout(ctx.runtimeScheduler.config.recallTimeoutMs) }),
  ), { timeoutMs: ctx.runtimeScheduler.config.recallTimeoutMs + 5_000 });
}
