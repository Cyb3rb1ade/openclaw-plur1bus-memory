/**
 * lib/telegram-commands/skill-commands.js
 *
 * Telegram command handlers for skill-miner proposals.
 *
 * /plur1bus skills review  — list pending proposals
 * /plur1bus skills approve <id> — approve and create SKILL.md
 * /plur1bus skills reject <id> — reject and block re-proposal
 * /plur1bus skills list — show active skills
 * /plur1bus skills show <id> — show proposal details
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readProposals,
  markProposalStatus,
  isSkillNameBlocked,
} from "../jobs/skill-miner/proposal-writer.js";
import { renderSkillMd } from "../jobs/skill-miner/skill-md-renderer.js";

export function listPendingProposals(workspaceDir) {
  const proposals = readProposals(workspaceDir).filter(
    (p) => p.status === "pending_review"
  );
  if (proposals.length === 0) {
    return "No open skill proposals. The Skill Miner runs weekly and suggests new skills once enough evidence is available.";
  }
  const lines = ["🛠️ Skill Proposals:", ""];
  for (const p of proposals) {
    lines.push(`• ${p.skillTitle} (ID: ${p.id})`);
    lines.push(
      `  Confidence: ${p.evidence?.llmConfidence ?? "?"} | Evidence: ${p.evidence?.score ?? "?"} memories`
    );
    lines.push(`  ${p.description?.slice(0, 80) || ""}`);
    lines.push("");
  }
  lines.push(
    "Commands: `/plur1bus skills approve <id>` | `/plur1bus skills reject <id>` | `/plur1bus skills show <id>`"
  );
  return lines.join("\n");
}

export function approveProposal(workspaceDir, id, ctx = {}) {
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal)
    return { ok: false, text: `❌ Proposal ${id} not found.` };
  if (proposal.status !== "pending_review")
    return { ok: false, text: `❌ Proposal ${id} is not pending.` };

  const skillDir = join(workspaceDir, "skills", proposal.skillName);
  mkdirSync(skillDir, { recursive: true });

  const md = renderSkillMd(proposal, { approvedAt: new Date().toISOString() });
  writeFileSync(join(skillDir, "SKILL.md"), md, "utf8");

  markProposalStatus(workspaceDir, id, "active");

  return {
    ok: true,
    text: `✅ Skill "${proposal.skillTitle}" approved.\nSaved to: skills/${proposal.skillName}/SKILL.md`,
    skillPath: join(skillDir, "SKILL.md"),
  };
}

export function rejectProposal(workspaceDir, id) {
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal)
    return { ok: false, text: `❌ Proposal ${id} not found.` };

  markProposalStatus(workspaceDir, id, "rejected");

  return {
    ok: true,
    text: `🚫 Skill "${proposal.skillTitle}" rejected. Will not be suggested again.`,
  };
}

export function listActiveSkills(workspaceDir) {
  const proposals = readProposals(workspaceDir).filter(
    (p) => p.status === "active"
  );
  if (proposals.length === 0) {
    return "No active skills. Approve proposals with `/plur1bus skills approve <id>`.";
  }
  const lines = ["✅ Active Skills:", ""];
  for (const p of proposals) {
    lines.push(`• ${p.skillTitle} → skills/${p.skillName}/SKILL.md`);
  }
  return lines.join("\n");
}

export function showProposal(workspaceDir, id) {
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return { text: `❌ Proposal ${id} not found.` };
  const lines = [
    `🛠️ ${proposal.skillTitle} (ID: ${proposal.id})`,
    `Status: ${proposal.status}`,
    `Confidence: ${proposal.evidence?.llmConfidence ?? "?"}`,
    `Evidence Score: ${proposal.evidence?.score ?? "?"}`,
    "",
    `**Description:**`,
    proposal.description || "(none)",
    "",
    `**Instructions:**`,
    proposal.instructions || "(none)",
    "",
    `**Examples:**`,
    ...(proposal.examples || []).map((e) => `- ${e}`),
  ];
  return { text: lines.join("\n") };
}

export { isSkillNameBlocked };
