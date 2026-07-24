import { parseObsidianCommandPlan } from "../../lib/obsidian-mutation-policy.js";

export function confirmedObsidianPolicy({
  baseDbPath,
  agentId = "test-agent",
  workspaceIdentity = "workspace:v1:test-ws",
  command = ["review", "apply"],
} = {}) {
  return parseObsidianCommandPlan(command, {
    memoryCtx: { agentId, workspaceIdentity },
    baseDbPath,
    mode: "apply",
    dryRun: false,
    allowWrite: true,
    vaultConfirmed: true,
    actionConfirmed: true,
  }).mutationPolicy;
}
