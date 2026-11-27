/**
 * adapter/openclaw/join-recall.js
 *
 * The OpenClaw host's half of the recall contract: join the engine's blocks
 * and cap them with the record-boundary budget (lib/inject-budget.js), then
 * hand OpenClaw the `{ prependContext }` shape its before_prompt_build hook
 * expects. Zero blocks means "inject nothing", which OpenClaw expresses as
 * returning undefined.
 */

import { applyGlobalInjectBudget } from "../../lib/inject-budget.js";

/**
 * @param {{blocks?: object[], capChars?: number}|undefined} result RecallResult.
 * @returns {{prependContext: string}|undefined}
 */
export function prependContextFromRecall(result) {
  if (!result || !Array.isArray(result.blocks) || result.blocks.length === 0) return undefined;
  return { prependContext: applyGlobalInjectBudget({ blocks: result.blocks, maxChars: result.capChars }) };
}
