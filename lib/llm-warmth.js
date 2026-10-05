// Cold-start guard for plugin LLM calls under OpenClaw 2026.9.7.
//
// The first `runtime.llm.complete` for an agent and model makes the host build
// a prepared model runtime, which loads every plugin again and blocks the
// Gateway for 40–70 s. When the caller aborts before that build finishes (the
// skill miner gives up after 30 s), the host releases the lease and throws the
// finished build away, so the next call builds again: an endless loop of
// reloads and timeouts (openclaw/openclaw#163029, 02.10.2026).
//
// For a key without a recent success the host call therefore gets its own
// long signal. The caller still stops waiting at its own timeout; the host
// call finishes in the background, its owner is retained, and later calls
// reuse it. State lives on globalThis because a reload imports a new copy of
// this module.

const STATE_KEY = Symbol.for("plur1bus.llmWarmth");
export const COLD_HOST_TIMEOUT_MS = 180_000;
const MAX_KEYS = 256;

function warmKeys() {
  const existing = globalThis[STATE_KEY];
  if (existing instanceof Map) return existing;
  const fresh = new Map();
  globalThis[STATE_KEY] = fresh;
  return fresh;
}

/**
 * Key for one host runtime owner as far as the plugin can tell it apart.
 * @param {string|null|undefined} agentId
 * @param {string|null|undefined} model
 * @returns {string}
 */
export function warmthKey(agentId, model) {
  return `${agentId || ""}\u0000${model || ""}`;
}

/** @param {string} key @returns {boolean} */
export function isWarm(key) {
  return warmKeys().has(key);
}

/** @param {string} key */
export function markWarm(key) {
  const keys = warmKeys();
  keys.delete(key);
  keys.set(key, true);
  while (keys.size > MAX_KEYS) keys.delete(keys.keys().next().value);
}

/** @param {string} key */
export function markCold(key) {
  warmKeys().delete(key);
}

function isTimeoutReason(reason) {
  return reason?.name === "TimeoutError";
}

/**
 * Signal for a cold host call. A caller's timeout does not reach the host (that
 * is what threw finished builds away); an explicit cancellation still does.
 * COLD_HOST_TIMEOUT_MS bounds a hung provider.
 * @param {AbortSignal|undefined} callerSignal
 * @param {number} [timeoutMs]
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
export function createColdHostSignal(callerSignal, timeoutMs = COLD_HOST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("OpenClaw LLM cold-start call timed out");
    error.name = "TimeoutError";
    error.code = "ETIMEOUT";
    controller.abort(error);
  }, timeoutMs);
  timer?.unref?.();
  const forward = () => {
    if (!isTimeoutReason(callerSignal.reason)) controller.abort(callerSignal.reason);
  };
  if (callerSignal?.aborted) forward();
  else callerSignal?.addEventListener?.("abort", forward, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener?.("abort", forward);
    },
  };
}
