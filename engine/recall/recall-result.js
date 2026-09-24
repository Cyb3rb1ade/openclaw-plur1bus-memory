/**
 * engine/recall/recall-result.js
 *
 * Value helpers for the recall contract (types/engine.d.ts, target 1.4.0):
 * the engine returns ContextBlocks as data and the host joins and caps them.
 * `UNCAPPED` marks the exits that today inject an uncapped join; the host's
 * joiner treats a non-finite cap as "join only".
 */

export const UNCAPPED = Number.POSITIVE_INFINITY;

/** @type {{reason: string, capability: string}} */
export const ABORTED = Object.freeze({ reason: "aborted", capability: "recall" });

/**
 * @param {string} name Block name (neo, start, memories, time, temporal, reminder).
 * @param {unknown} text Block text; anything falsy becomes "".
 * @param {boolean} droppable Whether the host may clip or drop it.
 * @returns {{name: string, text: string, droppable: boolean, chars: number}}
 */
export function contextBlock(name, text, droppable) {
  const value = text ? String(text) : "";
  return { name, text: value, droppable: droppable === true, chars: value.length };
}

/**
 * @param {{blocks?: object[], capChars?: number, degraded?: object|null, timing?: object|null, deferrals?: object[]}} [fields]
 * @returns {{blocks: object[], capChars: number, degraded: object|null, timing: {phases: object|null, totalMs: number}, deferrals: object[]}}
 */
export function recallResult({ blocks = [], capChars = UNCAPPED, degraded = null, timing = null, deferrals = [] } = {}) {
  return {
    blocks,
    capChars,
    degraded,
    timing: timing ?? { phases: null, totalMs: 0 },
    deferrals,
  };
}

/**
 * A copy of a RecallResult whose blocks and deferrals are fresh objects, so a
 * value held by the recall cache is never handed out (or mutated) by
 * reference.
 * @param {object|undefined|null} value
 * @returns {object|undefined|null}
 */
export function copyRecallResult(value) {
  if (!value || typeof value !== "object") return value;
  return {
    ...value,
    ...(Array.isArray(value.blocks) ? { blocks: value.blocks.map((block) => ({ ...block })) } : {}),
    ...(Array.isArray(value.deferrals) ? { deferrals: value.deferrals.map((deferral) => ({ ...deferral })) } : {}),
  };
}
