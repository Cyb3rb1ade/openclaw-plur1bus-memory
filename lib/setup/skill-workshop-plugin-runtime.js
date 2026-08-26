import { safeAgentId } from "../sql-safety.js";
import { renderSkillMd } from "../jobs/skill-miner/skill-md-renderer.js";
import { loadOpenClawGatewayRuntime } from "./feature-cron-plugin-runtime.js";

const SKILL_WORKSHOP_TIMEOUT_MS = 60_000;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`OpenClaw Skill Workshop returned an invalid ${name}`);
  }
  return value.trim();
}

function requireRevisionHash(value) {
  const revisionHash = requireString(value, "revision hash");
  if (!SHA256_RE.test(revisionHash)) {
    throw new Error("OpenClaw Skill Workshop returned an invalid revision hash");
  }
  return revisionHash.toLowerCase();
}

function normalizeProposalReadResult(response) {
  const proposalId = requireString(response?.record?.id, "proposal id");
  const status = requireString(response?.record?.status, "proposal status");
  const skillName = requireString(
    response?.record?.target?.skillKey || response?.record?.target?.skillName,
    "skill target",
  );
  return {
    proposalId,
    revisionHash: requireRevisionHash(response?.revisionHash),
    status,
    skillName,
  };
}

function normalizeProposalMutationResult(response) {
  const record = response?.record && typeof response.record === "object"
    ? response.record
    : response;
  return {
    proposalId: requireString(record?.id, "proposal id"),
    status: requireString(record?.status, "proposal status"),
    ...(typeof response?.targetSkillFile === "string" && response.targetSkillFile.trim()
      ? { targetSkillFile: response.targetSkillFile.trim() }
      : {}),
  };
}

function proposalEvidenceSummary(proposal) {
  const count = Array.isArray(proposal?.evidence?.memoryIds)
    ? proposal.evidence.memoryIds.length
    : 0;
  const grade = String(proposal?.evidence?.grade || "unknown").slice(0, 80);
  const score = Number.isFinite(proposal?.evidence?.score) ? proposal.evidence.score : "unknown";
  return `PLUR1BUS evidence: ${count} memories; grade=${grade}; score=${score}; localProposal=${proposal.id}`;
}

/**
 * Create an adapter for OpenClaw's public, workspace-resolving Skill Workshop RPCs.
 * @param {{loadGatewayRuntime?: Function, timeoutMs?: number}} [options]
 * @returns {{createProposal: Function, inspectProposal: Function, applyProposal: Function, rejectProposal: Function}}
 */
export function createOpenClawSkillWorkshopClient(options = {}) {
  const loadGatewayRuntime = options.loadGatewayRuntime || loadOpenClawGatewayRuntime;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.trunc(options.timeoutMs))
    : SKILL_WORKSHOP_TIMEOUT_MS;
  let runtimePromise;

  const call = async (method, params, scopes) => {
    runtimePromise ||= Promise.resolve().then(() => loadGatewayRuntime());
    const runtime = await runtimePromise;
    if (typeof runtime?.callGatewayFromCli !== "function") {
      throw new Error("OpenClaw Skill Workshop public Gateway capability unavailable");
    }
    return runtime.callGatewayFromCli(
      method,
      { timeout: String(timeoutMs), json: true },
      params,
      { progress: false, scopes },
    );
  };

  return {
    async createProposal({ agentId, proposal }) {
      const safeAgent = safeAgentId(agentId);
      if (!proposal || typeof proposal !== "object") {
        throw new Error("PLUR1BUS Skill Workshop proposal is required");
      }
      const response = await call(
        "skills.proposals.create",
        {
          agentId: safeAgent,
          name: requireString(proposal.skillName, "skill name"),
          description: requireString(proposal.description, "skill description"),
          content: renderSkillMd(proposal, { proposalMode: true }),
          goal: "Review a workflow mined from corroborated PLUR1BUS workspace memory.",
          evidence: proposalEvidenceSummary(proposal),
        },
        ["operator.admin"],
      );
      return normalizeProposalReadResult(response);
    },

    async inspectProposal({ agentId, proposalId }) {
      const response = await call(
        "skills.proposals.inspect",
        { agentId: safeAgentId(agentId), proposalId: requireString(proposalId, "proposal id") },
        ["operator.read"],
      );
      return normalizeProposalReadResult(response);
    },

    async applyProposal({ agentId, proposalId, expectedRevisionHash }) {
      const response = await call(
        "skills.proposals.apply",
        {
          agentId: safeAgentId(agentId),
          proposalId: requireString(proposalId, "proposal id"),
          expectedRevisionHash: requireRevisionHash(expectedRevisionHash),
          reason: "Approved through the authorized PLUR1BUS Skill Miner review flow.",
        },
        ["operator.admin"],
      );
      return normalizeProposalMutationResult(response);
    },

    async rejectProposal({ agentId, proposalId, expectedRevisionHash }) {
      const response = await call(
        "skills.proposals.reject",
        {
          agentId: safeAgentId(agentId),
          proposalId: requireString(proposalId, "proposal id"),
          expectedRevisionHash: requireRevisionHash(expectedRevisionHash),
          reason: "Rejected through the authorized PLUR1BUS Skill Miner review flow.",
        },
        ["operator.admin"],
      );
      return normalizeProposalMutationResult(response);
    },
  };
}
