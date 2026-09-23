/**
 * adapter/openclaw/register-capture-hook.js
 *
 * Registers auto-capture on agent_end with the plugin's 60 000 ms envelope
 * (index.js:11305). The work itself is queued inside runtimeScheduler with its
 * own AbortSignal; the harness awaits a CaptureHandle instead (ADR-002).
 */

import { createTurnCapture } from "../../engine/capture/capture-turn.js";

/**
 * @param {Record<string, any>} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerCaptureHook(ctx) {
  const handler = createTurnCapture(ctx);
  ctx.api.on("agent_end", handler, { timeoutMs: 60_000 });
}
