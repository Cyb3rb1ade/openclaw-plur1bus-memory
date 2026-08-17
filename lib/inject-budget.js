/**
 * lib/inject-budget.js — aggregate char cap across prepend blocks.
 */

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
    if (block.text.length <= overflow + 8) {
      current.splice(idx, 1);
      continue;
    }
    current[idx] = { ...block, text: block.text.slice(0, Math.max(0, block.text.length - overflow - 8)) };
  }
  return join(current);
}
