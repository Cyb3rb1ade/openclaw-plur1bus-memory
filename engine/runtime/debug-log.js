/**
 * engine/runtime/debug-log.js — the module-level debug logger (`dbg`), the purge throttle and the speaker-proposal pipeline.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { getMergeResultByMediaOutputId } from "../../lib/speaker-mapping-store.js";
import { proposeSpeakerNames, storeNewProposals } from "../../lib/speaker-proposer.js";

// Modulweiter Debug-Logger: wird in register() per setPluginLogger(host.logger)
// gesetzt. So können auch leere best-effort-catches (#10) ihren Fehler auf
// Debug-Level loggen statt ihn komplett zu schlucken — ohne dass jeder Helper
// das Host-Objekt braucht.
let pluginLogger = null;

/** Install the host logger dbg() and the speaker pipeline write to (was the assignment in register()). */
export function setPluginLogger(logger) {
  pluginLogger = logger ?? null;
}

/** The logger setPluginLogger() installed, or null. */
export function getPluginLogger() {
  return pluginLogger;
}

// Lightweight per-DB throttle for hot-path purgeExpired() calls (Scope C).
const PURGE_THROTTLE_MS = 5 * 60 * 1000;
const purgeThrottleMap = new Map();
function dbg(e, scope = "") {
  try {
    pluginLogger?.debug?.(`[plur1bus]${scope ? " " + scope : ""}: ${e?.message ?? e}`);
  } catch { /* debug darf niemals werfen */ }
}

async function runSpeakerProposalPipeline(agentId, mediaOutputIds) {
  if (!mediaOutputIds || mediaOutputIds.length === 0) {
    return { proposals: 0 };
  }
  try {
    let totalStored = 0;
    for (const mediaOutputId of mediaOutputIds) {
      const segments = getMergeResultByMediaOutputId(mediaOutputId);
      if (!segments || segments.length === 0) {
        continue;
      }
      const proposals = await proposeSpeakerNames(segments, agentId);
      if (proposals.length > 0) {
        const { stored } = storeNewProposals(agentId, proposals);
        totalStored += stored;
      }
    }
    if (totalStored > 0) {
      pluginLogger?.info?.(
        `[plur1bus] speaker proposal pipeline: stored ${totalStored} new proposal(s) for agent=${agentId}`,
      );
    }
    return { proposals: totalStored };
  } catch (err) {
    pluginLogger?.warn?.(`[plur1bus] speaker proposal pipeline failed: ${String(err)}`);
    return { proposals: 0 };
  }
}

export { PURGE_THROTTLE_MS, purgeThrottleMap, dbg, runSpeakerProposalPipeline };
