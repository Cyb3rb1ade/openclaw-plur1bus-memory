/**
 * lib/setup/skill-workshop-dashboard.js
 *
 * 7.12.48: Sammelt die geminten Skills aller Agenten fuer den PLUR1BUS-Reiter.
 *
 * Das Vorschlags-Ledger des Skill-Miners liegt je ACL-Partition unter dem
 * Neo-Store. Der Aufrufer reicht je Agent die Ledger-Verzeichnisse und ein
 * Workspace-Label herein; dieses Modul liest nur und gruppiert nach
 * Workspace. Alles Weitere (Kuerzen, Whitelists, Escaping) uebernimmt die
 * Projektion bzw. der Renderer.
 */

import { basename } from "node:path";
import { readProposals } from "../jobs/skill-miner/proposal-writer.js";

const PROPOSAL_STATUSES = new Set(["pending_review", "activation_partial", "active", "rejected"]);

/**
 * @param {{agents: Array<{agentId: string, workspace?: string, ledgerDirs: string[]}>}} input
 * @returns {{workspaces: Array<{id: string, agents: Array<{agentId: string, proposals: object[]}>}>}}
 */
export function collectSkillWorkshopProposals({ agents = [] } = {}) {
  const byWorkspace = new Map();
  for (const entry of Array.isArray(agents) ? agents : []) {
    const agentId = typeof entry?.agentId === "string" ? entry.agentId : "";
    if (!agentId) continue;
    const dirs = [...new Set((Array.isArray(entry.ledgerDirs) ? entry.ledgerDirs : []).filter((dir) => typeof dir === "string" && dir))];
    const seen = new Set();
    const proposals = [];
    for (const dir of dirs) {
      let rows = [];
      try { rows = readProposals(dir); } catch { rows = []; }
      for (const proposal of rows) {
        if (!proposal || typeof proposal !== "object" || typeof proposal.id !== "string" || seen.has(proposal.id)) continue;
        if (!PROPOSAL_STATUSES.has(proposal.status)) continue;
        seen.add(proposal.id);
        proposals.push({ ...proposal, ledgerDir: dir });
      }
    }
    if (proposals.length === 0) continue;
    const workspace = typeof entry.workspace === "string" && entry.workspace
      ? basename(entry.workspace) || entry.workspace
      : "default";
    if (!byWorkspace.has(workspace)) byWorkspace.set(workspace, []);
    byWorkspace.get(workspace).push({ agentId, proposals });
  }
  return {
    workspaces: [...byWorkspace.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, agentEntries]) => ({
        id,
        agents: agentEntries.sort((left, right) => left.agentId.localeCompare(right.agentId)),
      })),
  };
}
