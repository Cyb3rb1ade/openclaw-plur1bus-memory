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

export function redactError(err) {
  if (!err) return { message: "unknown error", stack: "" };
  const raw = typeof err === "string" ? err : err.message || String(err);
  let message = raw;
  for (const pattern of TOKEN_PATTERNS) {
    message = message.replace(pattern, "[REDACTED]");
  }
  // Truncate very long messages
  if (message.length > 500) {
    message = message.slice(0, 250) + " ... [truncated]";
  }
  const stack = typeof err === "object" && err && typeof err.stack === "string"
    ? err.stack.split("\n").slice(0, 3).join("; ")
    : "";
  return { message, stack };
}

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
  logger.warn(`[${scope}] failed: ${redacted.message}`, safeExtra);
}

/**
 * Attempt warning delivery without allowing a logger failure to replace the caller's result.
 * @param {object|null|undefined} logger Logger with an optional warn method.
 * @param {string} scope Non-sensitive diagnostic scope.
 * @param {unknown} err Error or safe reason to report.
 * @param {object} [extra] Non-sensitive structured context.
 * @returns {{ok: true}|{ok: false, error: unknown}} Warning delivery outcome.
 */
export function trySafeWarn(logger, scope, err, extra = {}) {
  try {
    safeWarn(logger, scope, err, extra);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function safeDebug(logger, scope, err, extra = {}) {
  if (!logger || typeof logger.debug !== "function") return;
  const redacted = redactError(err);
  logger.debug(`[${scope}] failed: ${redacted.message}`, extra);
}
