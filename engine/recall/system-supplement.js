/**
 * engine/recall/system-supplement.js
 *
 * The static system-prompt supplement (was index.js:7082-7087): the recall
 * safety preamble, plus three standing instructions when Neo is on. It
 * returns constants, which is what keeps the system prompt stable per turn
 * and therefore cacheable (ADR-010). Engine.systemSupplement() returns it;
 * the OpenClaw adapter hands the same builder to the host's
 * registerMemoryPromptSupplement (adapter/openclaw/register-prompt-supplements.js).
 */

import { buildRecallSafetyPreamble } from "../../lib/relevant-memory-context.js";

/**
 * @param {{neoEnabled: boolean}} options
 * @returns {string[]} The supplement lines, in order.
 */
export function buildSystemSupplement({ neoEnabled }) {
  if (!neoEnabled) {
    // Without Neo there is no other path for the full action-safety header;
    // the compact marker in relevant-memory-context is not enough.
    return [buildRecallSafetyPreamble()];
  }
  return [
    buildRecallSafetyPreamble(),
    "Dynamic PLUR1BUS recall is injected once per turn by the configured auto-recall hook; do not duplicate the same recall block.",
    "Use active/promoted BehaviorCards as operating preferences only when they do not conflict with current user instructions.",
    "Assistant-authored memories are evidence of prior output, not validated truth unless confirmed by user, tool, test, or curation.",
  ];
}
