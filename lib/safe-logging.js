/**
 * lib/safe-logging.js — Safe error logging helpers.
 *
 * Never logs: full memory text, Telegram payloads, API keys, tokens,
 * vault contents, or any other user-sensitive data.
 * Only logs: scope, IDs, counts, and a truncated, redacted error message.
 */

const TOKEN_PATTERNS = [
  /\bBearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
  /\bAuthorization["']?[ \t]*[:=][ \t]*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi,
  /\b(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|refresh[_-]?token|bot[_-]?token|token|password|(?:client|private|shared)?[_-]?secret|secret[_-]?access[_-]?key|credential)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
  /\bsk-[A-Za-z0-9_+=./-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b\d{6,12}:[A-Za-z0-9_+=./-]{20,}/g,
];

const MAX_THENABLE_CHAIN_DEPTH = 32;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;

function redactSensitiveText(raw) {
  let message = raw;
  for (const pattern of TOKEN_PATTERNS) {
    message = message.replace(pattern, "[REDACTED]");
  }
  return message;
}

function safeErrorMessage(err) {
  if (typeof err === "string") return err;
  if (err === null || err === undefined) return "unknown error";
  if (typeof err !== "object" && typeof err !== "function") {
    try {
      return String(err);
    } catch {
      return "non-standard error";
    }
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(err, "message");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
      return descriptor.value;
    }
  } catch {
    return "non-standard error";
  }
  return "non-standard error";
}

/**
 * Convert an arbitrary thrown value into a bounded credential-redacted diagnostic.
 * @param {unknown} err Thrown value or diagnostic string.
 * @returns {{message: string, stack: string}} Safe diagnostic fields.
 */
export function redactError(err) {
  const raw = safeErrorMessage(err);
  let message = redactSensitiveText(raw);
  // Truncate very long messages
  if (message.length > 500) {
    message = message.slice(0, 250) + " ... [truncated]";
  }
  return { message, stack: "" };
}

/**
 * Deliver one redacted warning through the supplied logger.
 * @param {object|null|undefined} logger Logger with an optional warn method.
 * @param {string} scope Non-sensitive diagnostic scope.
 * @param {unknown} err Error or safe reason to report.
 * @param {object} [extra] Non-sensitive structured context.
 * @returns {unknown} Logger return value, including a possible thenable.
 */
export function safeWarn(logger, scope, err, extra = {}) {
  const delivery = deliverSafeWarning(logger, scope, err, extra);
  captureThenableSettlement(delivery);
  return delivery;
}

function deliverSafeWarning(logger, scope, err, extra) {
  if (!logger || typeof logger.warn !== "function") return;
  const redacted = redactError(err);
  const safeExtra = {};
  for (const [key, value] of Object.entries(extra)) {
    if (key === "text" || key === "content" || key === "body" || key === "payload" || key === "message") {
      safeExtra[key] = typeof value === "string" ? `[${value.length} chars]` : "[redacted]";
    } else if (typeof value === "string" && value.length > 200) {
      safeExtra[key] = redactSensitiveText(value.slice(0, 100)) + "...";
    } else if (typeof value === "string") {
      safeExtra[key] = redactSensitiveText(value);
    } else {
      safeExtra[key] = value;
    }
  }
  return logger.warn(`[${scope}] failed: ${redacted.message}`, safeExtra);
}

/**
 * Attach handlers to a promise-like value and expose a settlement that never rejects.
 * @param {unknown} value Possible thenable returned by an optional callback.
 * @returns {Promise<{ok: true, value: unknown}|{ok: false, error: unknown}>|null} Observed settlement, or null for synchronous values.
 */
export function captureThenableSettlement(value) {
  const nativeSettlement = captureNativePromiseSettlement(value);
  if (nativeSettlement) return nativeSettlement;
  const inspected = inspectThenable(value);
  if (!inspected.thenable) return null;
  if (inspected.error) return Promise.resolve({ ok: false, error: inspected.error });
  return new Promise((resolve) => {
    observeThenableValue(value, inspected.then, new Set(), 0, resolve);
  });
}

function captureNativePromiseSettlement(value) {
  let settle;
  const settlement = new Promise((resolve) => {
    settle = resolve;
  });
  const observed = observeNativePromise(
    value,
    (result) => settle({ ok: true, value: result }),
    (error) => settle({ ok: false, error }),
  );
  return observed ? settlement : null;
}

function inspectThenable(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return { thenable: false };
  }
  try {
    const then = Reflect.get(value, "then");
    return typeof then === "function"
      ? { thenable: true, then }
      : { thenable: false };
  } catch (error) {
    return { thenable: true, error };
  }
}

function observeThenableValue(value, then, seen, depth, finish) {
  if (depth >= MAX_THENABLE_CHAIN_DEPTH) {
    finish({ ok: false, error: new TypeError("thenable settlement chain depth exceeded") });
    return;
  }
  if (seen.has(value)) {
    finish({ ok: false, error: new TypeError("thenable settlement cycle detected") });
    return;
  }
  seen.add(value);
  let callbackCalled = false;
  const fulfill = (result) => {
    if (callbackCalled) return;
    callbackCalled = true;
    if (observeNativePromise(
      result,
      (value) => finish({ ok: true, value }),
      (error) => finish({ ok: false, error }),
    )) return;
    const nested = inspectThenable(result);
    if (nested.error) {
      finish({ ok: false, error: nested.error });
    } else if (!nested.thenable) {
      finish({ ok: true, value: result });
    } else {
      observeThenableValue(result, nested.then, seen, depth + 1, finish);
    }
  };
  const reject = (error) => {
    if (callbackCalled) return;
    callbackCalled = true;
    finish({ ok: false, error });
  };
  let invocationResult;
  try {
    invocationResult = Reflect.apply(then, value, [fulfill, reject]);
  } catch (error) {
    reject(error);
    return;
  }
  observeIgnoredThenReturn(invocationResult, reject, new Set(), 0);
}

function observeIgnoredThenReturn(value, reject, seen, depth) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  if (observeNativePromise(value, () => {}, reject)) return;
  if (depth >= MAX_THENABLE_CHAIN_DEPTH) {
    reject(new TypeError("thenable return chain depth exceeded"));
    return;
  }
  if (seen.has(value)) {
    reject(new TypeError("thenable return cycle detected"));
    return;
  }
  seen.add(value);
  const inspected = inspectThenable(value);
  if (inspected.error) {
    reject(inspected.error);
    return;
  }
  if (!inspected.thenable) return;
  let callbackCalled = false;
  const fulfill = (result) => {
    if (callbackCalled) return;
    callbackCalled = true;
    observeIgnoredThenReturn(result, reject, seen, depth + 1);
  };
  const rejectReturn = (error) => {
    if (callbackCalled) return;
    callbackCalled = true;
    reject(error);
  };
  let invocationResult;
  try {
    invocationResult = Reflect.apply(inspected.then, value, [fulfill, rejectReturn]);
  } catch (error) {
    rejectReturn(error);
    return;
  }
  observeIgnoredThenReturn(invocationResult, rejectReturn, seen, depth + 1);
}

function observeNativePromise(value, fulfill, reject) {
  try {
    const child = Reflect.apply(INTRINSIC_PROMISE_THEN, value, [fulfill, reject]);
    Reflect.apply(INTRINSIC_PROMISE_THEN, child, [() => {}, reject]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt warning delivery without allowing a logger failure to replace the caller's result.
 * @param {object|null|undefined} logger Logger with an optional warn method.
 * @param {string} scope Non-sensitive diagnostic scope.
 * @param {unknown} err Error or safe reason to report.
 * @param {object} [extra] Non-sensitive structured context.
 * @returns {{ok: true}|{ok: true, pending: true, settlement: Promise<{ok: true, value: unknown}|{ok: false, error: unknown}>}|{ok: false, error: unknown}} Warning delivery outcome.
 */
export function trySafeWarn(logger, scope, err, extra = {}) {
  try {
    const delivery = deliverSafeWarning(logger, scope, err, extra);
    const settlement = captureThenableSettlement(delivery);
    if (settlement) return { ok: true, pending: true, settlement };
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Resolve an observed logger outcome without allowing a non-settling logger to block cleanup.
 * @param {ReturnType<typeof trySafeWarn>} outcome Logger delivery outcome.
 * @param {{timeoutMs?: number}} [options] Bounded wait configuration.
 * @returns {Promise<{ok: true}|{ok: true, value: unknown}|{ok: false, error: unknown}>} Final non-rejecting warning outcome.
 */
export async function settleSafeWarning(outcome, { timeoutMs = 100 } = {}) {
  if (!outcome?.pending || !outcome.settlement) return outcome;
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 100;
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ ok: false, error: new Error("logger delivery did not settle before cleanup deadline") });
    }, boundedTimeoutMs);
  });
  try {
    return await Promise.race([outcome.settlement, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Deliver a redacted debug diagnostic and observe synchronous or async logger failure.
 * @param {object|null|undefined} logger Logger with an optional debug method.
 * @param {string} scope Non-sensitive diagnostic scope.
 * @param {unknown} err Error or safe reason to report.
 * @param {object} [extra] Non-sensitive structured context.
 * @returns {{ok: true}|{ok: true, pending: true, settlement: Promise<object>}|{ok: false, error: unknown}} Delivery outcome.
 */
export function safeDebug(logger, scope, err, extra = {}) {
  try {
    if (!logger || typeof logger.debug !== "function") return { ok: true };
    const redacted = redactError(err);
    const delivery = logger.debug(`[${scope}] failed: ${redacted.message}`, extra);
    const settlement = captureThenableSettlement(delivery);
    return settlement
      ? { ok: true, pending: true, settlement }
      : { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
