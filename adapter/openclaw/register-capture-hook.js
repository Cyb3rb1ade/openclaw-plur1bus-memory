/**
 * adapter/openclaw/register-capture-hook.js
 *
 * Registers auto-capture on agent_end with the plugin's 60 000 ms envelope
 * (index.js:11305). The work itself is queued inside runtimeScheduler with its
 * own AbortSignal; the harness awaits a CaptureHandle instead (ADR-002). Also
 * registers the before_compaction checkpoint: the host reports a compaction
 * boundary and it lands in the checkpoint store (engine/checkpoint/checkpoint-store.js)
 * that reactivation recall's compactedAt gate falls back to.
 */

import { createTurnCapture } from "../../engine/capture/capture-turn.js";

/**
 * @param {Record<string, any>} ctx Registration context: the engine's capture
 *   view plus `api`, and `captureTurn` — the engine's one capture handler
 *   (createTurnCapture binds the light-dream job owner, so it is built once).
 * @returns {void}
 */
export function registerCaptureHook(ctx) {
  const handler = ctx.captureTurn ?? createTurnCapture(ctx);
  ctx.api.on("agent_end", handler, { timeoutMs: 60_000 });

  if (ctx.checkpointStore) {
    ctx.api.on("before_compaction", (event, hookCtx) => {
      ctx.checkpointStore.checkpoint(hookCtx?.agentId || "default", "compaction", {
        sessionKey: hookCtx?.sessionKey ?? event?.sessionKey ?? "",
      });
    });
  }
}
