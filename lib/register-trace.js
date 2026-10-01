// Registration trace for openclaw/openclaw#163029.
//
// OpenClaw 2026.9.7 loads a fresh copy of the plugin in the middle of turns,
// in waves after a Gateway start, and each load blocks the main thread for
// 40–70 s. Upstream asked for the call stack of such a load. A reload imports
// a new copy of this module, so the counter lives on globalThis (one per
// process), and the stack is only captured when `runtime.traceRegistrations`
// is on.

const COUNTER_KEY = Symbol.for("plur1bus.registerTrace");
const STACK_LIMIT = 60;

function processState() {
  const existing = globalThis[COUNTER_KEY];
  if (existing && Number.isSafeInteger(existing.count)) return existing;
  const fresh = { count: 0, lastAt: 0 };
  globalThis[COUNTER_KEY] = fresh;
  return fresh;
}

function captureStack() {
  const previous = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = STACK_LIMIT;
    const stack = String(new Error("register").stack || "");
    // First line is the message, second this helper, third recordRegistration.
    return stack.split("\n").slice(3).map((line) => line.trim()).filter(Boolean);
  } finally {
    Error.stackTraceLimit = previous;
  }
}

/**
 * Count this plugin registration in the process and, when enabled, describe
 * where it came from.
 * @param {{ enabled?: boolean, now?: () => number, uptime?: () => number }} [options]
 * @returns {{ count: number, sincePreviousMs: number|null, uptimeSec: number, stack: string[]|null }}
 */
export function recordRegistration({ enabled = false, now = Date.now, uptime = process.uptime } = {}) {
  const state = processState();
  const at = now();
  const sincePreviousMs = state.lastAt > 0 ? at - state.lastAt : null;
  state.count += 1;
  state.lastAt = at;
  return {
    count: state.count,
    sincePreviousMs,
    uptimeSec: Math.round(uptime()),
    stack: enabled === true ? captureStack() : null,
  };
}

/**
 * One log message for a traced registration.
 * @param {{ count: number, sincePreviousMs: number|null, uptimeSec: number, stack: string[]|null }} trace
 * @returns {string|null} null when no stack was captured
 */
export function formatRegistrationTrace(trace) {
  if (!trace?.stack) return null;
  const since = trace.sincePreviousMs === null ? "first" : `${Math.round(trace.sincePreviousMs / 1000)}s after previous`;
  return `memory-lancedb-namespaced: register trace #${trace.count} (uptime ${trace.uptimeSec}s, ${since})\n    ${trace.stack.join("\n    ")}`;
}
