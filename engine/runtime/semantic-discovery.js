/**
 * engine/runtime/semantic-discovery.js — semantic-link discovery batching and its per-run statistics.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { discoverObsidianWorkspaces } from "../../lib/obsidian-bridge.js";
import { discoverSemanticLinks } from "../../lib/obsidian/semantic-link-discoverer.js";
import { writeMemoryNotes } from "../../lib/obsidian/memory-note-writer.js";
import { mutationAllowed } from "../../lib/obsidian-mutation-policy.js";

function semanticDiscoveryStats() {
  return {
    processed: 0,
    skipped: 0,
    unchanged: 0,
    errors: 0,
    indexUpdated: false,
    blocked: false,
    batchAborted: false,
  };
}

function addSemanticDiscoveryStats(total, result = {}) {
  total.processed += result.processed || 0;
  total.skipped += result.skipped || 0;
  total.unchanged += result.unchanged || 0;
  total.errors += result.errors || 0;
  total.indexUpdated = total.indexUpdated || result.indexUpdated === true;
  total.blocked = total.blocked || result.blocked === true;
  total.batchAborted = total.batchAborted || result.batchAborted === true;
  if (result.reason && !total.reason) total.reason = result.reason;
  return total;
}

/**
 * Select the configured Obsidian workspaces owned by a cron's triggering agent.
 *
 * @param {object} rawConfig
 * @param {string} agentId
 * @returns {Array<object>}
 */
export function selectSemanticDiscoveryWorkspaces(rawConfig = {}, agentId) {
  const workspaceAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (!workspaceAgentId) return [];
  return discoverObsidianWorkspaces(rawConfig, { workspace: workspaceAgentId });
}

async function runSemanticDiscoveryBatches({ db, semVaultCfg, pool, logger, defaultAgentId, mutationPolicy }) {
  const discoveryCfg = semVaultCfg?.graphLinks?.semanticDiscovery || {};
  const batchSize = Math.max(1, Math.min(Number(discoveryCfg.batchSize || 500), 5000));
  let remaining = Math.max(1, Number(discoveryCfg.maxPerRun || 500));
  const total = semanticDiscoveryStats();
  if (!mutationAllowed(mutationPolicy, "semantic_index_write")
    || !mutationAllowed(mutationPolicy, "vault_write")) {
    return { ...total, blocked: true, reason: "bound_confirmation_required" };
  }

  const scanBatches = typeof db.scanActiveBatches === "function"
    ? db.scanActiveBatches({ batchSize })
    : (async function* fallbackScan() { yield await db.scanActive(); })();

  for await (const lancedbRecords of scanBatches) {
    if (!Array.isArray(lancedbRecords) || lancedbRecords.length === 0) continue;
    await writeMemoryNotes(semVaultCfg, lancedbRecords, { logger, mutationPolicy });
    const result = await discoverSemanticLinks(semVaultCfg, lancedbRecords, {
      db,
      pool,
      logger,
      defaultAgentId,
      maxPerRun: remaining,
      mutationPolicy,
      confirm: true,
    });
    addSemanticDiscoveryStats(total, result);
    const consumed = (result.processed || 0) + (result.skipped || 0) + (result.unchanged || 0) + (result.errors || 0);
    remaining -= Math.max(consumed, 0);
    if (result.batchAborted || remaining <= 0) break;
  }

  return total;
}

export { runSemanticDiscoveryBatches };
