/**
 * lib/telegram-commands/skill-commands.js
 *
 * Telegram command handlers for skill-miner proposals.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  readProposals,
  markProposalStatus,
  isSkillNameBlocked,
  patchProposal,
} from "../jobs/skill-miner/proposal-writer.js";
import { renderSkillMd } from "../jobs/skill-miner/skill-md-renderer.js";
import { safeSlug } from "../obsidian/safe-paths.js";
import { writeTextFsync } from "../fsync-atomic.js";
import { t } from "../i18n.js";
import { checkAccess } from "../acl-middleware.js";
import { createConfirmation } from "../security.js";

function nextEvidenceStatus(raw) {
  const value = raw == null ? "" : String(raw);
  if (value === "" || value === "observed") return value === "observed" ? "corroborated" : "observed";
  if (value === "corroborated" || value === "trusted") return "noop";
  if (value === "untrusted" || value === "disputed" || value === "invalidated") return "skip";
  return "skip";
}

function writeSkillMdAtomic(skillPath, markdown) {
  mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 });
  writeTextFsync(skillPath, markdown);
}

/**
 * Crash-repairable activation: SKILL.md first, then per-id transitions.
 * @param {string} workspaceDir
 * @param {string} id
 * @param {object} ctx
 * @returns {Promise<object>}
 */
export async function activateSkillProposal(workspaceDir, id, ctx = {}) {
  const { lang = "en", tone = "default" } = ctx;
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) {
    return { ok: false, text: t("skill.approve_not_found", { lang, tone, vars: { id } }) };
  }
  if (proposal.status !== "pending_review" && proposal.status !== "activation_partial") {
    return { ok: false, text: t("skill.approve_not_pending", { lang, tone, vars: { id } }) };
  }

  const safeName = safeSlug(proposal.skillName, "skill");
  const skillPath = join(workspaceDir, "skills", safeName, "SKILL.md");
  if (!existsSync(skillPath)) {
    const md = renderSkillMd(proposal, { approvedAt: new Date().toISOString() });
    writeSkillMdAtomic(skillPath, md);
    patchProposal(workspaceDir, id, {
      status: "activation_partial",
      activation: { ...(proposal.activation || {}), skillPath, evidence: proposal.activation?.evidence || {} },
    });
  } else if (proposal.status === "pending_review") {
    patchProposal(workspaceDir, id, {
      status: "activation_partial",
      activation: { ...(proposal.activation || {}), skillPath, evidence: proposal.activation?.evidence || {} },
    });
  }

  const current = readProposals(workspaceDir).find((p) => p.id === id);
  const evidenceIds = Array.isArray(current.evidence?.memoryIds) ? current.evidence.memoryIds : [];
  const results = { ...(current.activation?.evidence || {}) };
  const loadRecord = typeof ctx.loadEvidenceRecord === "function" ? ctx.loadEvidenceRecord : null;
  const applyStatus = typeof ctx.applyEpistemicStatus === "function" ? ctx.applyEpistemicStatus : null;
  const memoryCtx = ctx.memoryCtx || null;

  for (const memoryId of evidenceIds) {
    const prior = results[memoryId];
    if (prior && (prior.ok === true || prior.reason === "skipped" || prior.reason === "noop")) continue;
    try {
      const record = loadRecord ? await loadRecord(memoryId, current.aclBindings) : null;
      if (!record) {
        results[memoryId] = { ok: false, reason: "acl_or_missing" };
        continue;
      }
      if (memoryCtx && !checkAccess(memoryCtx, record).allowed) {
        results[memoryId] = { ok: false, reason: "acl_or_missing" };
        continue;
      }
      const next = nextEvidenceStatus(record.epistemicStatus);
      if (next === "noop") {
        results[memoryId] = { ok: true, reason: "noop", from: record.epistemicStatus, to: record.epistemicStatus };
        continue;
      }
      if (next === "skip") {
        results[memoryId] = { ok: true, reason: "skipped", from: record.epistemicStatus };
        continue;
      }
      if (!applyStatus) {
        results[memoryId] = { ok: false, reason: "adapter_missing" };
        continue;
      }
      const applied = await applyStatus(memoryId, next, record);
      if (applied?.ok) {
        results[memoryId] = { ok: true, reason: "transitioned", from: record.epistemicStatus, to: next };
      } else {
        results[memoryId] = { ok: false, reason: applied?.reason || "transition_failed" };
      }
    } catch (error) {
      results[memoryId] = { ok: false, reason: String(error?.message || error) };
    }
  }

  const unfinished = Object.values(results).some((entry) => entry && entry.ok === false);
  const nextStatus = unfinished ? "activation_partial" : "active";
  patchProposal(workspaceDir, id, {
    status: nextStatus,
    activation: { skillPath, evidence: results },
  });

  return {
    ok: true,
    partial: unfinished,
    status: nextStatus,
    skillPath,
    evidence: results,
    text: unfinished
      ? t("skill.approve_partial", { lang, tone, vars: { title: current.skillTitle, name: current.skillName } })
      : t("skill.approve_success", { lang, tone, vars: { title: current.skillTitle, name: current.skillName } }),
  };
}

export async function approveProposal(workspaceDir, id, ctx = {}) {
  return activateSkillProposal(workspaceDir, id, ctx);
}

export function rejectSkillProposal(workspaceDir, id, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const proposals = readProposals(workspaceDir);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return { ok: false, text: t("skill.reject_not_found", { lang, tone, vars: { id } }) };
  if (proposal.status !== "pending_review") {
    return { ok: false, text: t("skill.approve_not_pending", { lang, tone, vars: { id } }) };
  }
  markProposalStatus(workspaceDir, id, "rejected");
  return {
    ok: true,
    text: t("skill.reject_success", { lang, tone, vars: { title: proposal.skillTitle } }),
  };
}

export function rejectProposal(workspaceDir, id, opts = {}) {
  return rejectSkillProposal(workspaceDir, id, opts);
}

export function listPendingProposals(workspaceDir, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const proposals = readProposals(workspaceDir).filter(
    (p) => p.status === "pending_review" || p.status === "activation_partial",
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
      }),
    );
    if (p.evidence?.grade) lines.push(`  grade: ${p.evidence.grade}`);
    lines.push(`  ${p.description?.slice(0, 80) || ""}`);
    lines.push("");
  }
  lines.push(t("skill.proposal_commands", { lang, tone }));
  return lines.join("\n");
}

/**
 * Review payload with optional inline keyboard and confirm tokens.
 * @param {string} workspaceDir
 * @param {object} opts
 * @returns {{text: string, inline_keyboard: Array, confirmations: object[]}}
 */
export function buildSkillReviewPayload(workspaceDir, opts = {}) {
  const text = listPendingProposals(workspaceDir, opts);
  const proposals = readProposals(workspaceDir).filter(
    (p) => p.status === "pending_review" || p.status === "activation_partial",
  );
  const confirmations = [];
  const inline_keyboard = [];
  if (opts.userId && opts.chatId) {
    for (const proposal of proposals) {
      const approve = createConfirmation({
        userId: opts.userId,
        chatId: opts.chatId,
        command: "skills-approve",
        targetId: proposal.id,
      });
      const reject = createConfirmation({
        userId: opts.userId,
        chatId: opts.chatId,
        command: "skills-reject",
        targetId: proposal.id,
      });
      confirmations.push(approve, reject);
      inline_keyboard.push([
        { text: `Approve ${String(proposal.skillTitle || proposal.id).slice(0, 24)}`, callback_data: approve.callbackData },
        { text: "Reject", callback_data: reject.callbackData },
      ]);
    }
  }
  const confirmLines = confirmations.length > 0
    ? ["", ...confirmations.map((c) => `/plur1bus skills confirm ${c.nonce}`)]
    : [];
  return { text: [text, ...confirmLines].join("\n"), inline_keyboard, confirmations };
}

export function listActiveSkills(workspaceDir, opts = {}) {
  const { lang = "en", tone = "default" } = opts;
  const proposals = readProposals(workspaceDir).filter(
    (p) => p.status === "active" || p.status === "activation_partial",
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
    `Grade: ${proposal.evidence?.grade ?? "?"}`,
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
