/**
 * lib/input-limits.js — Centralized input validation with clear error messages.
 *
 * Policy: fail loudly with a clear error message instead of silently truncating.
 * Exception: embedding input may be truncated because API costs must be capped.
 */

export const INPUT_LIMITS = {
  COMMAND_ARGS: 4000,
  SEMANTIC_COMMAND_ARGS: 100_000,
  CALLBACK_DATA: 64,
  CORRECTION_TEXT: 4000,
  SEARCH_QUERY: 2000,
  TOPIC_QUERY: 2000,
  AGENT_ID: 128,
  CHAT_ID: 128,
  USER_ID: 128,
  CHANNEL_ID: 64,
  ACCOUNT_ID: 128,
  SESSION_KEY: 1024,
  SESSION_ID: 128,
  THREAD_ID: 128,
  PRINCIPAL: 128,
  MEMORY_TEXT: 50_000,
  OBSIDIAN_APPLY_PAYLOAD: 100 * 1024, // 100 KB
};

export function validateInput(value, { maxLength, name = "input", allowedPattern = null, required = false } = {}) {
  if (required && (value === undefined || value === null || value === "")) {
    return { ok: false, error: `${name} is required` };
  }
  if (value === undefined || value === null) {
    return { ok: true };
  }
  const str = typeof value === "string" ? value : String(value);
  if (maxLength && str.length > maxLength) {
    return { ok: false, error: `${name} exceeds maximum length of ${maxLength} characters (received ${str.length})` };
  }
  if (allowedPattern && !allowedPattern.test(str)) {
    return { ok: false, error: `${name} contains invalid characters` };
  }
  return { ok: true, value: str };
}

export function validateCommandArgs(args) {
  return validateInput(args, { maxLength: INPUT_LIMITS.COMMAND_ARGS, name: "command arguments" });
}

/**
 * Validate long semantic command payloads before summarization.
 * @param {unknown} args
 * @returns {{ok: boolean, error?: string, value?: string}}
 */
export function validateSemanticCommandArgs(args) {
  return validateInput(args, {
    maxLength: INPUT_LIMITS.SEMANTIC_COMMAND_ARGS,
    name: "command arguments",
  });
}

export function validateCallbackData(data) {
  return validateInput(data, { maxLength: INPUT_LIMITS.CALLBACK_DATA, name: "callback data" });
}

export function validateCorrectionText(text) {
  return validateInput(text, { maxLength: INPUT_LIMITS.CORRECTION_TEXT, name: "correction text" });
}

export function validateSearchQuery(query) {
  return validateInput(query, { maxLength: INPUT_LIMITS.SEARCH_QUERY, name: "search query" });
}

export function validateTopicQuery(query) {
  return validateInput(query, { maxLength: INPUT_LIMITS.TOPIC_QUERY, name: "topic query" });
}

export function validateMemoryText(text) {
  return validateInput(text, { maxLength: INPUT_LIMITS.MEMORY_TEXT, name: "memory text" });
}

/**
 * Validate the model-controlled fields of a memory_store call that the length
 * limit alone does not cover: blank text and a category outside the known list.
 * Fails loudly instead of embedding an empty text or storing a category the
 * conflict and promotion logic does not know. Omitted/empty `category` stays
 * valid (it is derived from the text). `ttl` is not rejected here: see
 * `resolveTtlMs`.
 * @param {{text?: unknown, category?: unknown}} params
 * @param {{categories: readonly string[]}} lookup
 * @returns {{ok: true} | {ok: false, error: string, reason: "invalid_text"|"invalid_category"}}
 */
export function validateMemoryStoreParams(params, { categories }) {
  const text = validateMemoryText(params?.text);
  if (!text.ok) return { ok: false, error: text.error, reason: "invalid_text" };
  if (typeof params?.text !== "string" || params.text.trim() === "") {
    return { ok: false, error: "memory text is required and must not be blank", reason: "invalid_text" };
  }
  const category = params.category;
  if (category !== undefined && category !== null && category !== "") {
    if (typeof category !== "string" || !categories.includes(category)) {
      return { ok: false, error: `category must be one of: ${categories.join(", ")}`, reason: "invalid_category" };
    }
  }
  return { ok: true };
}

/**
 * Lifetime in ms for a memory_store `ttl`, 0 (permanent) when it names no entry of
 * `ttlMap`. An own-property check: "constructor", "toString" or "__proto__" are
 * truthy on a plain object and used to turn `expiresAt` into a string.
 * @param {Record<string, number>} ttlMap
 * @param {unknown} ttl
 * @returns {number}
 */
export function resolveTtlMs(ttlMap, ttl) {
  return typeof ttl === "string" && Object.hasOwn(ttlMap, ttl) ? Number(ttlMap[ttl]) || 0 : 0;
}

export function validateAgentId(id) {
  return validateInput(id, { maxLength: INPUT_LIMITS.AGENT_ID, name: "agent ID" });
}

export function validateChatId(id) {
  return validateInput(id, { maxLength: INPUT_LIMITS.CHAT_ID, name: "chat ID" });
}

export function validateUserId(id) {
  return validateInput(id, { maxLength: INPUT_LIMITS.USER_ID, name: "user ID" });
}
