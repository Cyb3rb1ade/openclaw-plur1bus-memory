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

// Matches one of: an XML comment (ignored — never a wrapper), a closing tag
// (name in group 1), or an opening tag (name in group 2; self-closing is
// detected separately, see below, because a naive capture group for the
// trailing "/" is swallowed by the attribute-matching group first). Record
// text is HTML-escaped before injection (escapeMemoryText /
// sanitizeMemoryTextForPrompt), so a literal "<" or ">" here can only be a
// genuine tag boundary, never something from evidence text.
const TAG_TOKEN_RE = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)(?:\s[^<>]*)?>/g;

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
 * Scans `text` for element-like tags — comments and self-closing tags (e.g.
 * `<trace-summary … />`) are ignored — and returns the elements still open
 * at the end of `text`, outermost first: an actual open-element stack, not
 * a fixed list of "known wrapper" names. This is what lets a cut correctly
 * close *whatever* wrapper it happens to land inside — `<relevant-memories>`,
 * `<memory-semantic-lens>`, `<plur1bus-recall>`, `<memory-reactivation>`, or
 * any future one — without this file needing to know its name in advance.
 *
 * A mismatched closing tag (should not occur in well-formed input, since
 * `text` is always a prefix of otherwise-valid output up to the cut point)
 * pops the nearest matching open element and everything opened after it,
 * the same recovery a lenient HTML parser would apply.
 *
 * @param {string} text
 * @returns {string[]}
 */
function openElementStack(text) {
  const stack = [];
  let match;
  TAG_TOKEN_RE.lastIndex = 0;
  while ((match = TAG_TOKEN_RE.exec(text)) !== null) {
    const closeName = match[1];
    if (closeName) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === closeName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const openName = match[2];
    if (openName && !match[0].endsWith("/>")) {
      stack.push(openName);
    }
  }
  return stack;
}

/**
 * Lists the elements still open at the end of `text`, innermost first (the
 * one opened last is the one that needs to close first).
 *
 * @param {string} text
 * @returns {string[]}
 */
function openTagsAt(text) {
  return openElementStack(text).reverse();
}

/**
 * @param {string[]} tags
 * @returns {string}
 */
function closingTagsFor(tags) {
  return tags.map((tag) => `\n</${tag}>`).join("");
}

/**
 * Renders the closing tags (innermost first) for whatever elements are
 * still open at the end of `prefix`. Exported so a caller with its own
 * last-resort cut point (e.g. `truncateMemoryContext`'s no-record-fits
 * fallback) can still close any wrapper it lands inside of, without
 * duplicating `openTagsAt`'s tag-stream scan.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function closeOpenElements(prefix) {
  return closingTagsFor(openTagsAt(prefix));
}

/**
 * Cuts `text` down to at most `allowedLen` characters at the end of the last
 * complete `<memory-record>` element that fits, appends the shared
 * truncation marker, and closes whatever element(s) the cut point falls
 * inside of (innermost first, via `openTagsAt`'s scan of the actual tag
 * stream — not a fixed list of "known wrapper" names, so this stays correct
 * however many nested or sibling wrapper elements a block happens to use,
 * e.g. `<relevant-memories>`, `<memory-semantic-lens>`, `<plur1bus-recall>`,
 * `<memory-reactivation>`). An arbitrary character cut can otherwise leave a
 * half-open `<memory-record …>` element, a cut attribute, or an unclosed
 * wrapper, all of which are malformed XML the model then has to parse.
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
    const closings = closingTagsFor(openTagsAt(base.slice(0, cut)));
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
 * Plan the aggregate cap: the joined text plus one deferral per block the cap
 * actually clipped or dropped. A deferral is recorded only when a block's text
 * changes, so an over-cap result with nothing droppable left reports none.
 *
 * @param {{blocks: Array<{name: string, text?: string, droppable?: boolean}>, maxChars: number}} input
 * @returns {{text: string, deferrals: Array<{block: string, kind: "clipped"|"dropped", from: number, to: number, reason: "global-cap"}>}}
 */
export function planGlobalInjectBudget({ blocks = [], maxChars } = {}) {
  const parts = (Array.isArray(blocks) ? blocks : [])
    .map((block) => ({
      name: String(block?.name || ""),
      text: String(block?.text || ""),
      droppable: block?.droppable === true,
    }))
    .filter((block) => block.text);
  const join = (items) => items.map((block) => block.text).join("\n\n");
  const deferrals = [];
  const cap = Number(maxChars);
  if (!Number.isFinite(cap) || cap <= 0) {
    return { text: join(parts), deferrals };
  }
  let current = [...parts];
  while (join(current).length > cap) {
    const idx = current.map((block, i) => (block.droppable ? i : -1)).filter((i) => i >= 0).pop();
    if (idx == null) break;
    const block = current[idx];
    const overflow = join(current).length - cap;
    const allowedLen = Math.max(0, block.text.length - overflow);
    const trimmed = trimDroppableBlockText(block.text, allowedLen);
    if (!trimmed) {
      deferrals.push({ block: block.name, kind: "dropped", from: block.text.length, to: 0, reason: "global-cap" });
      current.splice(idx, 1);
      continue;
    }
    deferrals.push({ block: block.name, kind: "clipped", from: block.text.length, to: trimmed.length, reason: "global-cap" });
    current[idx] = { ...block, text: trimmed };
  }
  return { text: join(current), deferrals };
}

/**
 * @param {{blocks: Array<{name: string, text?: string, droppable?: boolean}>, maxChars: number}} input
 * @returns {string}
 */
export function applyGlobalInjectBudget(input = {}) {
  return planGlobalInjectBudget(input).text;
}
