/**
 * lib/input-limits.js — Centralized input validation with clear error messages.
 *
 * Policy: fail loudly with a clear error message instead of silently truncating.
 * Exception: embedding input may be truncated because API costs must be capped.
 */

export const INPUT_LIMITS = {
  COMMAND_ARGS: 4000,
  CALLBACK_DATA: 64,
  CORRECTION_TEXT: 4000,
  SEARCH_QUERY: 2000,
  TOPIC_QUERY: 2000,
  AGENT_ID: 128,
  CHAT_ID: 128,
  USER_ID: 128,
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

export function validateAgentId(id) {
  return validateInput(id, { maxLength: INPUT_LIMITS.AGENT_ID, name: "agent ID" });
}

export function validateChatId(id) {
  return validateInput(id, { maxLength: INPUT_LIMITS.CHAT_ID, name: "chat ID" });
}

export function validateUserId(id) {
  return validateInput(id, { maxLength: INPUT_LIMITS.USER_ID, name: "user ID" });
}
