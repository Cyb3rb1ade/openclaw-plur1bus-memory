/**
 * Sanitizers for memory context attributes and prompt text.
 */

import { escapeMemoryText, sanitizeMemoryTextForPrompt } from "./neo-arch.js";

/**
 * Allowed source markers for memory records in prompt context.
 */
export const DISPLAY_SOURCES = new Set(["group", "cron", "internal", "dream"]);

/**
 * Sanitizes a memory context attribute to a safe XML attribute identifier.
 * Replaces non-word characters (except :, ., -) with underscores, truncates
 * to 160 characters, and HTML-escapes the result.
 *
 * @param {string} value
 * @param {string} [fallback="memory"]
 * @returns {string}
 */
export function sanitizeMemoryContextAttribute(value, fallback = "memory") {
  const raw = String(value || fallback).replace(/[^\w:.-]+/g, "_").slice(0, 160);
  return escapeMemoryText(raw || fallback);
}

export { sanitizeMemoryTextForPrompt };
