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
    return "Keine offenen Skill-Vorschläge. Der Skill Miner läuft wöchentlich und schlägt neue Skills vor, sobald genügend Evidenz vorliegt.";
  }
  const lines = ["🛠️ Skill-Vorschläge:", ""];
  for (const p of proposals) {
    lines.push(`• ${p.skillTitle} (ID: ${p.id})`);
    lines.push(
      `  Confidence: ${p.evidence?.llmConfidence ?? "?"} | Evidenz: ${p.evidence?.score ?? "?"} Memories`
    );
    lines.push(`  ${p.description?.slice(0, 80) || ""}`);
    lines.push("");
  }
  lines.push(
    "Befehle: `/plur1bus skills approve <id>` | `/plur1bus skills reject <id>` | `/plur1bus skills show <id>`"
  );
  return lines.join("\n");
}

export function approveProposal(workspaceDir, id, ctx = {}) {
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal)
    return { ok: false, text: `❌ Vorschlag ${id} nicht gefunden.` };
  if (proposal.status !== "pending_review")
    return { ok: false, text: `❌ Vorschlag ${id} ist nicht pending.` };

  const skillDir = join(workspaceDir, "skills", proposal.skillName);
  mkdirSync(skillDir, { recursive: true });

  const md = renderSkillMd(proposal, { approvedAt: new Date().toISOString() });
  writeFileSync(join(skillDir, "SKILL.md"), md, "utf8");

  markProposalStatus(workspaceDir, id, "active");

  return {
    ok: true,
    text: `✅ Skill "${proposal.skillTitle}" bestätigt.\nGespeichert unter: skills/${proposal.skillName}/SKILL.md`,
    skillPath: join(skillDir, "SKILL.md"),
  };
}

export function rejectProposal(workspaceDir, id) {
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal)
    return { ok: false, text: `❌ Vorschlag ${id} nicht gefunden.` };

  markProposalStatus(workspaceDir, id, "rejected");

  return {
    ok: true,
    text: `🚫 Skill "${proposal.skillTitle}" abgelehnt. Wird nicht erneut vorgeschlagen.`,
  };
}

export function listActiveSkills(workspaceDir) {
  const proposals = readProposals(workspaceDir).filter(
    (p) => p.status === "active"
  );
  if (proposals.length === 0) {
    return "Keine aktiven Skills. Bestätige Vorschläge mit `/plur1bus skills approve <id>`.";
  }
  const lines = ["✅ Aktive Skills:", ""];
  for (const p of proposals) {
    lines.push(`• ${p.skillTitle} → skills/${p.skillName}/SKILL.md`);
  }
  return lines.join("\n");
}

export function showProposal(workspaceDir, id) {
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return { text: `❌ Vorschlag ${id} nicht gefunden.` };
  const lines = [
    `🛠️ ${proposal.skillTitle} (ID: ${proposal.id})`,
    `Status: ${proposal.status}`,
    `Confidence: ${proposal.evidence?.llmConfidence ?? "?"}`,
    `Evidenz-Score: ${proposal.evidence?.score ?? "?"}`,
    "",
    `**Beschreibung:**`,
    proposal.description || "(keine)",
    "",
    `**Instructions:**`,
    proposal.instructions || "(keine)",
    "",
    `**Examples:**`,
    ...(proposal.examples || []).map((e) => `- ${e}`),
  ];
  return { text: lines.join("\n") };
}

export { isSkillNameBlocked };
