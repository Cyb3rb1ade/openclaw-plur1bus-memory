export const MEMORY_OP_ERROR_CODES = Object.freeze(["not-found", "denied", "invalid-input", "approval-required", "conflict", "storage"]);

export function memoryOpError(code, message) {
  if (!MEMORY_OP_ERROR_CODES.includes(code)) throw new TypeError(`unknown MemoryOp error code: ${code}`);
  const err = new Error(message);
  err.name = "MemoryOpError";
  Object.defineProperty(err, "code", { value: code, enumerable: true });
  return err;
}

export const isMemoryOpError = (e) => e instanceof Error && e.name === "MemoryOpError" && MEMORY_OP_ERROR_CODES.includes(e.code);
