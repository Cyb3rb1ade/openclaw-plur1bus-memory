import { safeWarn } from "./safe-logging.js";
import { TimeoutError } from "./with-timeout.js";

/** Stable failure reasons safe for logs, results, and persisted records. */
export const LLM_FAILURE_REASONS = Object.freeze({
  LLM_ERROR: "llm_error",
  TIMEOUT: "timeout",
  INVALID_RESPONSE: "invalid_response",
});

/**
 * Map an LLM failure to a stable, non-sensitive reason.
 * @param {unknown} error
 * @returns {"llm_error"|"timeout"|"invalid_response"}
 */
export function classifyLlmFailure(error) {
  if (error instanceof TimeoutError
    || (error?.name === "TimeoutError" && error?.code === "ETIMEOUT")) {
    return LLM_FAILURE_REASONS.TIMEOUT;
  }
  if (error instanceof SyntaxError) {
    return LLM_FAILURE_REASONS.INVALID_RESPONSE;
  }
  return LLM_FAILURE_REASONS.LLM_ERROR;
}

function stableErrorClass(error) {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error?.name === "TimeoutError" && error?.code === "ETIMEOUT") return "TimeoutError";
  if (typeof DOMException === "function"
    && error instanceof DOMException
    && error.name === "AbortError") {
    return "AbortError";
  }
  if (error instanceof Error) return "Error";
  return "NonError";
}

/**
 * Log an LLM failure without exposing provider-controlled error text.
 * @param {object} logger
 * @param {string} scope
 * @param {unknown} error
 * @param {object} [extra]
 * @returns {"llm_error"|"timeout"|"invalid_response"}
 */
export function safeWarnLlmFailure(logger, scope, error, extra = {}) {
  const reason = classifyLlmFailure(error);
  safeWarn(logger, scope, reason, {
    ...extra,
    errorClass: stableErrorClass(error),
    errorCode: reason === LLM_FAILURE_REASONS.TIMEOUT
      ? "ETIMEOUT"
      : reason === LLM_FAILURE_REASONS.INVALID_RESPONSE
        ? "EINVALID_RESPONSE"
        : "ELLM",
  });
  return reason;
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error("LLM call aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * Run an LLM transport with a cleared timer and a signal combining caller aborts with timeout aborts.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} startCall
 * @param {{timeoutMs?: number, signal?: AbortSignal, label?: string}} [options]
 * @returns {Promise<T>}
 */
export async function withAbortableLlmTimeout(startCall, options = {}) {
  const timeoutMs = Number(options.timeoutMs);
  const callerSignal = options.signal;
  const controller = new AbortController();
  let callerAbortListener = null;
  let timeout;
  let rejectAbort;

  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const rejectFromAbort = () => rejectAbort(abortError(controller.signal.reason));
  controller.signal.addEventListener("abort", rejectFromAbort, { once: true });

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else if (typeof callerSignal?.addEventListener === "function") {
    callerAbortListener = () => controller.abort(callerSignal.reason);
    callerSignal.addEventListener("abort", callerAbortListener, { once: true });
  }

  const operation = Promise.resolve().then(() => startCall(controller.signal));
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new TimeoutError(options.label || "LLM call", timeoutMs, operation));
      }
    }, timeoutMs);
  }

  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.signal.removeEventListener("abort", rejectFromAbort);
    if (callerAbortListener && typeof callerSignal?.removeEventListener === "function") {
      callerSignal.removeEventListener("abort", callerAbortListener);
    }
  }
}
