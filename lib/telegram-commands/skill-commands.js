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
import { safeSlug } from "../obsidian/safe-paths.js";
import { t } from "../i18n.js";

export function listPendingProposals(workspaceDir, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const proposals = readProposals(workspaceDir).filter(
    (p) => p.status === "pending_review"
  );
  if (proposals.length === 0) {
    return t("skill.no_proposals", { lang, tone });
  }
  const lines = [t("skill.proposals_header", { lang, tone }), ""];
  for (const p of proposals) {
    lines.push(t("skill.proposal_item", { lang, tone, vars: { title: p.skillTitle, id: p.id } }));
    lines.push(
      t("skill.proposal_evidence", {
        lang,
        tone,
        vars: {
          confidence: p.evidence?.llmConfidence ?? "?",
          evidence: p.evidence?.score ?? "?",
        },
      })
    );
    lines.push(`  ${p.description?.slice(0, 80) || ""}`);
    lines.push("");
  }
  lines.push(t("skill.proposal_commands", { lang, tone }));
  return lines.join("\n");
}

export function approveProposal(workspaceDir, id, ctx = {}) {
  const { lang = "en", tone = "default" } = ctx;
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal)
    return { ok: false, text: t("skill.approve_not_found", { lang, tone, vars: { id } }) };
  if (proposal.status !== "pending_review")
    return { ok: false, text: t("skill.approve_not_pending", { lang, tone, vars: { id } }) };

  // Security: skillName stammt aus LLM-Output (llm-extractor) und ist
  // unvalidiert — über safeSlug härten, damit kein "../"-Segment aus dem
  // skills/-Verzeichnis ausbrechen kann (Path-Traversal beim SKILL.md-Write).
  const safeName = safeSlug(proposal.skillName, "skill");
  const skillDir = join(workspaceDir, "skills", safeName);
  mkdirSync(skillDir, { recursive: true });

  const md = renderSkillMd(proposal, { approvedAt: new Date().toISOString() });
  writeFileSync(join(skillDir, "SKILL.md"), md, "utf8");

  markProposalStatus(workspaceDir, id, "active");

  return {
    ok: true,
    text: t("skill.approve_success", {
      lang,
      tone,
      vars: { title: proposal.skillTitle, name: proposal.skillName },
    }),
    skillPath: join(skillDir, "SKILL.md"),
  };
}

export function rejectProposal(workspaceDir, id, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal)
    return { ok: false, text: t("skill.reject_not_found", { lang, tone, vars: { id } }) };

  markProposalStatus(workspaceDir, id, "rejected");

  return {
    ok: true,
    text: t("skill.reject_success", { lang, tone, vars: { title: proposal.skillTitle } }),
  };
}

export function listActiveSkills(workspaceDir, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const proposals = readProposals(workspaceDir).filter(
    (p) => p.status === "active"
  );
  if (proposals.length === 0) {
    return t("skill.active_none", { lang, tone });
  }
  const lines = [t("skill.active_header", { lang, tone }), ""];
  for (const p of proposals) {
    lines.push(t("skill.active_item", { lang, tone, vars: { title: p.skillTitle, name: p.skillName } }));
  }
  return lines.join("\n");
}

export function showProposal(workspaceDir, id, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return { text: t("skill.show_not_found", { lang, tone, vars: { id } }) };
  const lines = [
    `🛠️ ${proposal.skillTitle} (ID: ${proposal.id})`,
    `Status: ${proposal.status}`,
    `Confidence: ${proposal.evidence?.llmConfidence ?? "?"}`,
    `Evidence Score: ${proposal.evidence?.score ?? "?"}`,
    "",
    t("skill.show_description", { lang, tone }),
    proposal.description || "(none)",
    "",
    t("skill.show_instructions", { lang, tone }),
    proposal.instructions || "(none)",
    "",
    t("skill.show_examples", { lang, tone }),
    ...(proposal.examples || []).map((e) => `- ${e}`),
  ];
  return { text: lines.join("\n") };
}

export { isSkillNameBlocked };
