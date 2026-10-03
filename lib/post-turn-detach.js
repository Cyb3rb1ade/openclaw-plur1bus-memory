// Post-turn work (capture, episodes, insights, light dream) is enqueued from
// the agent_end hook and runs after the turn has finished. OpenClaw carries the
// turn's tool-caller identity through AsyncLocalStorage into every async
// continuation; once the turn ends that identity is revoked, and plugin LLM
// completions fail with LLM_COMPLETION_NOT_AUTHORIZED ("agent tool caller
// authority is no longer active", openclaw/openclaw#162941).
//
// The host's own helper for this (withoutGatewayToolCallerIdentity) is not in
// the plugin SDK. Workaround: run the queued task inside an
// AsyncLocalStorage.snapshot() taken at plugin registration, i.e. outside any
// turn. A snapshot restores *every* store of that moment, so this stays behind
// runtime.detachPostTurnWork (default off) until it has been observed live.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Build a wrapper that runs post-turn tasks outside the triggering turn.
 * Capture this at plugin registration, never inside a turn.
 * @param {{ enabled?: boolean, snapshot?: () => Function }} [options]
 * @returns {(task: Function) => Function} Identity when disabled.
 */
export function createPostTurnDetacher(options = {}) {
  const snapshot = Object.hasOwn(options, "snapshot") ? options.snapshot : AsyncLocalStorage.snapshot;
  if (options.enabled !== true || typeof snapshot !== "function") return (task) => task;
  const runOutsideTurn = snapshot.call(AsyncLocalStorage);
  return (task) => (...args) => runOutsideTurn(() => task(...args));
}
