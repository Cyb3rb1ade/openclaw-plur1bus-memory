/**
 * lib/prompt-memory-fields.js — render-time status/epistemic/age labels.
 * Does not change LanceDB scoring: callers must not write these labels back.
 */

import { normalizeEpistemicStatus } from "./epistemic-status.js";
import { parseMemoryTimestamp } from "./temporal-provenance.js";

/**
 * @param {object} entry
 * @returns {{status: string, epistemic: string, createdAtMs: number|null}}
 */
export function renderPromptMemoryAttrs(entry = {}) {
  const status = entry.status ? String(entry.status) : "active";
  const epistemic = normalizeEpistemicStatus(entry.epistemicStatus);
  const createdAtMs = parseMemoryTimestamp(entry.createdAt)
    ?? parseMemoryTimestamp(entry.updatedAt)
    ?? null;
  return { status, epistemic, createdAtMs };
}
