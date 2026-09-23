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

// Marker `truncateMemoryContext` (lib/relevant-memory-context.js) and this
// module both use, so a block trimmed at either layer is equally
// self-describing, and a re-trim at the other layer can find and strip a
// pre-existing one instead of doubling it up.
export const TRUNCATION_MARKER = "\n<!-- memory context truncated -->";

// Wrapper elements that a `<memory-record>`-bearing block can be wrapped in.
// None of these ever nest inside one another in the text this module
// receives (relevant-memories, memory-semantic-lens and the pattern block
// are emitted as siblings by formatRelevantMemoriesContext; plur1bus-recall
// is neo's only wrapper) — but a cut can still land after one has opened and
// before it has closed, in which case it must be closed explicitly or the
// output is malformed XML.
const WRAPPER_TAGS = ["relevant-memories", "memory-semantic-lens", "plur1bus-recall"];

/**
 * Finds the highest offset at or before `budget` that ends a complete
 * `</memory-record>` element in `text`.
 *
 * @param {string} text
 * @param {number} budget
 * @returns {number} the offset just past the closing `>`, or -1 if none fits
 */
function lastRecordEndWithin(text, budget) {
  let cut = -1;
  let searchFrom = 0;
  for (;;) {
    const idx = text.indexOf(MEMORY_RECORD_CLOSE, searchFrom);
    if (idx === -1) break;
    const end = idx + MEMORY_RECORD_CLOSE.length;
    if (end > budget) break;
    cut = end;
    searchFrom = end;
  }
  return cut;
}

/**
 * Lists which of `WRAPPER_TAGS` are open (have a `<tag`) but not yet closed
 * (no later `</tag>`) in `text`, ordered innermost first — the tag whose
 * opening tag appears latest is the one that would need to close first.
 *
 * @param {string} text
 * @returns {string[]}
 */
function openWrapperTagsAt(text) {
  const open = [];
  for (const tag of WRAPPER_TAGS) {
    const lastOpen = text.lastIndexOf(`<${tag}`);
    if (lastOpen === -1) continue;
    const lastClose = text.lastIndexOf(`</${tag}>`);
    if (lastClose < lastOpen) open.push({ tag, at: lastOpen });
  }
  open.sort((a, b) => b.at - a.at);
  return open.map((entry) => entry.tag);
}

/**
 * @param {string[]} tags
 * @returns {string}
 */
function closingTagsFor(tags) {
  return tags.map((tag) => `\n</${tag}>`).join("");
}

/**
 * Cuts `text` down to at most `allowedLen` characters at the end of the last
 * complete `<memory-record>` element that fits, appends the shared
 * truncation marker, and closes any of `WRAPPER_TAGS` still open at that cut
 * point (innermost first) — an arbitrary character cut can otherwise leave a
 * half-open `<memory-record …>` element, a cut attribute, or an unclosed
 * `<relevant-memories>`/`<memory-semantic-lens>`/`<plur1bus-recall>` wrapper,
 * all of which are malformed XML the model then has to parse.
 *
 * A truncation marker already present anywhere in `text` (from a prior pass,
 * e.g. `truncateMemoryContext`'s own inner cap) is stripped, along with
 * anything after it (that "anything" can only be closing tags a previous
 * pass appended, by this same contract), before re-measuring — leaving it in
 * would both double the marker up and eat into the budget for content that's
 * about to be re-cut anyway.
 *
 * Reserving room for the wrapper closings a given cut needs can itself push
 * the cut earlier, which can in turn change which wrappers are still open;
 * the loop below re-measures against that revised reservation until it
 * converges (each iteration's budget is non-increasing, so it always
 * terminates) or gives up.
 *
 * @param {string} text
 * @param {number} allowedLen
 * @returns {string|null} the trimmed text, or `null` when not even one
 *   record fits (including its required marker and wrapper closings) —
 *   callers decide what "nothing fits" means for them.
 */
export function trimAtRecordBoundary(text, allowedLen) {
  if (allowedLen <= 0) return null;
  if (!text.includes(MEMORY_RECORD_CLOSE)) return null;

  const markerAt = text.indexOf(TRUNCATION_MARKER);
  const base = markerAt === -1 ? text : text.slice(0, markerAt);

  let reserve = 0;
  let previousCut = null;
  for (;;) {
    const budget = allowedLen - TRUNCATION_MARKER.length - reserve;
    if (budget <= 0) return null;
    const cut = lastRecordEndWithin(base, budget);
    if (cut === -1 || cut === previousCut) return null;
    previousCut = cut;
    const closings = closingTagsFor(openWrapperTagsAt(base.slice(0, cut)));
    if (cut + TRUNCATION_MARKER.length + closings.length <= allowedLen) {
      return base.slice(0, cut) + TRUNCATION_MARKER + closings;
    }
    reserve = Math.max(reserve, closings.length);
  }
}

/**
 * Trims a droppable block's text down to at most `allowedLen` characters.
 *
 * Delegates to `trimAtRecordBoundary` for text built from `<memory-record>`
 * elements. Text with no `<memory-record>` elements at all (e.g. a plain
 * notice block, or a memories block reduced to nudges/markers with no
 * records left) has no record boundary to align to — droppable means
 * droppable, so it is dropped entirely rather than sliced at an arbitrary
 * character.
 *
 * @param {string} text
 * @param {number} allowedLen
 * @returns {string} the trimmed text, or "" when nothing fits
 */
function trimDroppableBlockText(text, allowedLen) {
  if (allowedLen <= 0) return "";
  if (text.length <= allowedLen) return text;
  return trimAtRecordBoundary(text, allowedLen) ?? "";
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
