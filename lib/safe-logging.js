/**
 * lib/safe-logging.js — Safe error logging helpers.
 *
 * Never logs: full memory text, Telegram payloads, API keys, tokens,
 * vault contents, or any other user-sensitive data.
 * Only logs: scope, IDs, counts, and a truncated, redacted error message.
 */

const TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9_\-\.]+/gi,
  /\bsk-[A-Za-z0-9]{20,}/gi,
  /\bapi[_-]?key\s*[:=]\s*[A-Za-z0-9_\-\.]+/gi,
  /\btoken\s*[:=]\s*[A-Za-z0-9_\-\.]+/gi,
];

const SENSITIVE_HINTS = [
  "password", "secret", "token", "apikey", "api_key", "bearer",
  "authorization", "vault", "memory", "telegram", "message",
];

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
  let message = raw;
  for (const pattern of TOKEN_PATTERNS) {
    message = message.replace(pattern, "[REDACTED]");
  }
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
  if (!logger || typeof logger.warn !== "function") return;
  const redacted = redactError(err);
  const safeExtra = {};
  for (const [key, value] of Object.entries(extra)) {
    if (key === "text" || key === "content" || key === "body" || key === "payload" || key === "message") {
      safeExtra[key] = typeof value === "string" ? `[${value.length} chars]` : "[redacted]";
    } else if (typeof value === "string" && value.length > 200) {
      safeExtra[key] = value.slice(0, 100) + "...";
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
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  let then;
  try {
    then = Reflect.get(value, "then");
  } catch (error) {
    return Promise.resolve({ ok: false, error });
  }
  if (typeof then !== "function") return null;
  const assimilated = new Promise((resolve, reject) => {
    Reflect.apply(then, value, [resolve, reject]);
  });
  return assimilated.then(
    (result) => ({ ok: true, value: result }),
    (error) => ({ ok: false, error }),
  );
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
    const delivery = safeWarn(logger, scope, err, extra);
    const settlement = captureThenableSettlement(delivery);
    if (settlement) return { ok: true, pending: true, settlement };
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Resolve a trySafeWarn outcome without allowing a non-settling logger to block cleanup.
 * @param {ReturnType<typeof trySafeWarn>} outcome Warning delivery outcome.
 * @param {{timeoutMs?: number}} [options] Bounded wait configuration.
 * @returns {Promise<{ok: true}|{ok: true, value: unknown}|{ok: false, error: unknown}>} Final non-rejecting warning outcome.
 */
export async function settleSafeWarning(outcome, { timeoutMs = 100 } = {}) {
  if (!outcome?.pending || !outcome.settlement) return outcome;
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 100;
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({ ok: false, error: new Error("warning delivery did not settle before cleanup deadline") });
    }, boundedTimeoutMs);
  });
  try {
    return await Promise.race([outcome.settlement, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function safeDebug(logger, scope, err, extra = {}) {
  if (!logger || typeof logger.debug !== "function") return;
  const redacted = redactError(err);
  logger.debug(`[${scope}] failed: ${redacted.message}`, extra);
}
