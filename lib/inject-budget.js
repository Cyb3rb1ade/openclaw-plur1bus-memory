/**
 * lib/inject-budget.js — aggregate char cap across prepend blocks.
 */

// The closing element every `<memory-record>` (from both
// lib/relevant-memory-context.js's renderMemoryItems and
// lib/neo-arch.js's formatNeoRecallContext) is rendered with, on its own or
// shared with the opening tag on one line. Record text is HTML-escaped
// before injection (escapeMemoryText / sanitizeMemoryTextForPrompt), so this
// literal string can only appear as a genuine element boundary.
const MEMORY_RECORD_CLOSE = "</memory-record>";

// Same marker `truncateMemoryContext` (lib/relevant-memory-context.js) uses
// for its own inner cap, reused here so a block trimmed at this outer layer
// is just as self-describing.
const TRUNCATION_MARKER = "\n<!-- memory context truncated -->";

/**
 * Trims a droppable block's text down to at most `allowedLen` characters.
 *
 * For text built from `<memory-record>` elements, cuts at the end of the
 * last complete record that still fits (plus the truncation marker) instead
 * of at an arbitrary character — an arbitrary cut can leave a half-open
 * `<memory-record …>` element or a cut attribute, which is malformed XML the
 * model then has to parse. Text with no `<memory-record>` elements at all
 * (e.g. a plain notice block) falls back to a plain character slice, since
 * there is no record boundary to align to.
 *
 * @param {string} text
 * @param {number} allowedLen
 * @returns {string} the trimmed text, or "" when nothing fits
 */
function trimDroppableBlockText(text, allowedLen) {
  if (allowedLen <= 0) return "";
  if (text.length <= allowedLen) return text;
  if (!text.includes(MEMORY_RECORD_CLOSE)) {
    return text.slice(0, allowedLen);
  }

  // Strip a truncation marker already appended by an inner cap (e.g.
  // truncateMemoryContext) before measuring — it is re-appended below, and
  // leaving the old one in would both double it up and eat into the budget
  // for no benefit (it doesn't itself end in a closed record).
  const base = text.endsWith(TRUNCATION_MARKER)
    ? text.slice(0, -TRUNCATION_MARKER.length)
    : text;

  const budget = allowedLen - TRUNCATION_MARKER.length;
  if (budget <= 0) return "";

  let cut = -1;
  let searchFrom = 0;
  for (;;) {
    const idx = base.indexOf(MEMORY_RECORD_CLOSE, searchFrom);
    if (idx === -1) break;
    const end = idx + MEMORY_RECORD_CLOSE.length;
    if (end > budget) break;
    cut = end;
    searchFrom = end;
  }
  // Not even one complete record fits in the remaining budget: droppable
  // means droppable — the caller drops the whole block rather than emit a
  // block that is just a dangling wrapper tag or preamble.
  if (cut === -1) return "";

  return base.slice(0, cut) + TRUNCATION_MARKER;
}

/**
 * @param {{blocks: Array<{name: string, text?: string, droppable?: boolean}>, maxChars: number}} input
 * @returns {string}
 */
export function applyGlobalInjectBudget({ blocks = [], maxChars } = {}) {
  const parts = (Array.isArray(blocks) ? blocks : [])
    .map((block) => ({
      name: String(block?.name || ""),
      text: String(block?.text || ""),
      droppable: block?.droppable === true,
    }))
    .filter((block) => block.text);
  const cap = Number(maxChars);
  if (!Number.isFinite(cap) || cap <= 0) {
    return parts.map((block) => block.text).join("\n\n");
  }
  const join = (items) => items.map((block) => block.text).join("\n\n");
  let current = [...parts];
  while (join(current).length > cap) {
    const idx = current.map((block, i) => (block.droppable ? i : -1)).filter((i) => i >= 0).pop();
    if (idx == null) break;
    const block = current[idx];
    const overflow = join(current).length - cap;
    const allowedLen = Math.max(0, block.text.length - overflow);
    const trimmed = trimDroppableBlockText(block.text, allowedLen);
    if (!trimmed) {
      current.splice(idx, 1);
      continue;
    }
    current[idx] = { ...block, text: trimmed };
  }
  return join(current);
}
