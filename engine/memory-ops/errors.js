export const MEMORY_OP_ERROR_CODES = Object.freeze(["not-found", "denied", "invalid-input", "approval-required", "conflict", "storage"]);

/**
 * @param {string} code One of MEMORY_OP_ERROR_CODES.
 * @param {string} message Fixed, log-safe English message.
 * @param {object} [detail] Optional non-secret detail (e.g. ids a partial failure left behind).
 */
export function memoryOpError(code, message, detail) {
  if (!MEMORY_OP_ERROR_CODES.includes(code)) throw new TypeError(`unknown MemoryOp error code: ${code}`);
  const err = new Error(message);
  err.name = "MemoryOpError";
  Object.defineProperty(err, "code", { value: code, enumerable: true });
  if (detail !== undefined) Object.defineProperty(err, "detail", { value: Object.freeze({ ...detail }), enumerable: true });
  return err;
}

export const isMemoryOpError = (e) => e instanceof Error && e.name === "MemoryOpError" && MEMORY_OP_ERROR_CODES.includes(e.code);
