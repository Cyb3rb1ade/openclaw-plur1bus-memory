/**
 * lib/jobs/skill-miner/nudge-renderer.js
 *
 * Render a skill-proposal reminder nudge in the user's language and
 * the agent's tone (from SOUL.MD / IDENTITY.MD if available).
 *
 * Now uses lib/i18n.js for language detection, tone resolution, and rendering.
 */

import { detectLanguage, readSoulToneCached, pickTone, t } from "../../i18n.js";

export function renderSkillProposalNudge(proposal, pendingCount, opts = {}) {
  const { workspaceDir, messages } = opts;
  const lang = detectLanguage(messages);
  const toneHint = readSoulToneCached(workspaceDir);
  const tone = pickTone(toneHint);

  const more = pendingCount > 1
    ? t("nudge.skill_proposal_more", { lang, tone, vars: { count: pendingCount - 1 } })
    : "";

  return t("nudge.skill_proposal", {
    lang,
    tone,
    vars: {
      description: `${proposal.evidence?.grade ? `[${proposal.evidence.grade}] ` : ""}${proposal.description || proposal.skillTitle || ""}`,
      more,
    },
  });
}
