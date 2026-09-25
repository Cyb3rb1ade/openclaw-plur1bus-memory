/**
 * adapter/openclaw/register-recall-hook.js
 *
 * Registers the recall assembly on before_prompt_build with the plugin's own
 * envelope: recallTimeoutMs + 5 000 ms (index.js:13327,
 * lib/runtime-scheduler.js:7). The recall signal is mandatory (PR-05): this
 * adapter supplies `AbortSignal.timeout(recallTimeoutMs + 250)`, which cancels
 * the embedder and LanceDB waits if the hook's own budget runs out. Controller
 * ruling (fix round 1): the scheduler stays the single owner of the recall
 * budget — the 250 ms margin means the scheduler's own internal timeout wins
 * on a genuine overrun (keeping `stats.recallTimedOut` and its diagnostic warn
 * line), while this host signal is a cancellation backstop for the case the
 * scheduler's own timer somehow doesn't fire. The handler joins the engine's
 * RecallResult blocks through join-recall.js before handing OpenClaw its
 * `{ prependContext }` shape.
 */

import { createPromptContextAssembler } from "../../engine/recall/assemble-prompt-context.js";
import { prependContextFromRecall } from "./join-recall.js";
import { createTurnPrincipalResolver } from "./turn-principal.js";

/**
 * @param {Record<string, any>} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerRecallHook(ctx) {
  const recall = createPromptContextAssembler({ ...ctx, resolveTurnPrincipal: createTurnPrincipalResolver(ctx) });
  ctx.api.on("before_prompt_build", async (event, hookCtx) => prependContextFromRecall(
    await recall(event, hookCtx, { signal: AbortSignal.timeout(ctx.runtimeScheduler.config.recallTimeoutMs + 250) }),
  ), { timeoutMs: ctx.runtimeScheduler.config.recallTimeoutMs + 5_000 });
}
