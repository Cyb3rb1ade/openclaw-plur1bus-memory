// lib/memory-context-sanitize.js
//
// Sanitizers for memory context attributes injected into LLM prompts.
// Extracted here to avoid circular imports: relevant-memory-context.js
// imports from this file, NOT from index.js.

import { escapeMemoryText, sanitizeMemoryTextForPrompt } from "./neo-arch.js";

// Sources shown verbatim in the memory-record source attribute.
// Everything else collapses to "memory".
export const DISPLAY_SOURCES = new Set(["group", "cron", "internal"]);

export function sanitizeMemoryContextAttribute(value, fallback = "memory") {
  const raw = String(value || fallback).replace(/[^\w:.-]+/g, "_").slice(0, 160);
  return escapeMemoryText(raw || fallback);
}

export { sanitizeMemoryTextForPrompt };
