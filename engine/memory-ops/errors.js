export const MEMORY_OP_ERROR_CODES = Object.freeze(["not-found", "denied", "invalid-input", "approval-required", "conflict", "storage", "unsupported"]);

/**
 * @param {string} code One of MEMORY_OP_ERROR_CODES.
 * @param {string} message Fixed, log-safe English message.
 * @param {Record<string, string>} [detail] Optional non-secret ids a caller needs to recover (e.g. a half-finished shared-copy refresh); non-string values are dropped.
 */
export function memoryOpError(code, message, detail) {
  if (!MEMORY_OP_ERROR_CODES.includes(code)) throw new TypeError(`unknown MemoryOp error code: ${code}`);
  const err = new Error(message);
  err.name = "MemoryOpError";
  Object.defineProperty(err, "code", { value: code, enumerable: true });
  if (detail !== undefined) {
    // Contract 1.6.0: detail is Readonly<Record<string, string>> — only string values survive.
    const strings = {};
    for (const [key, value] of Object.entries(detail ?? {})) if (typeof value === "string") strings[key] = value;
    Object.defineProperty(err, "detail", { value: Object.freeze(strings), enumerable: true });
  }
  return err;
}

export const isMemoryOpError = (e) => e instanceof Error && e.name === "MemoryOpError" && MEMORY_OP_ERROR_CODES.includes(e.code);
