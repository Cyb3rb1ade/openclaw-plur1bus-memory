/**
 * lib/telegram-commands/skill-commands.js
 *
 * Telegram command handlers for skill-miner proposals.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
import { safeWarn } from "../safe-logging.js";

const WORKSHOP_REVISION_RE = /^[a-f0-9]{64}$/i;
const WORKSHOP_TERMINAL_ACTIONS = new Set(["applied", "rejected"]);

function requireWorkshopLifecycleEvent(event, context) {
  const action = event?.action;
  if (!WORKSHOP_TERMINAL_ACTIONS.has(action)) return null;
  const proposal = event?.proposal;
  if (
    typeof event?.eventId !== "string"
    || !event.eventId.trim()
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 1
    || !Number.isFinite(Date.parse(event.occurredAt))
    || !proposal
    || typeof proposal !== "object"
    || typeof proposal.id !== "string"
    || !proposal.id.trim()
    || proposal.status !== action
    || !WORKSHOP_REVISION_RE.test(proposal.revisionSha256 || "")
    || typeof proposal.skillName !== "string"
    || typeof proposal.skillKey !== "string"
    || typeof proposal.skillFile !== "string"
    || typeof context?.workspaceDir !== "string"
    || !context.workspaceDir.trim()
    || typeof context?.agentId !== "string"
    || !context.agentId.trim()
  ) {
    throw new Error("invalid Workshop lifecycle event");
  }
  return { action, proposal };
}

function terminalStatusMatches(localProposal, action) {
  if (action === "applied") {
    return localProposal.status === "active"
      && localProposal.openClawWorkshop?.status === "applied";
  }
  return localProposal.status === "rejected"
    && localProposal.openClawWorkshop?.status === "rejected";
}

function validateWorkshopLifecycleBinding(eventWorkspaceDir, agentId, proposal, localProposal) {
  if (localProposal.agentId !== agentId) {
    throw new Error("Workshop agent binding changed");
  }
  const binding = localProposal.openClawWorkshop;
  if (binding?.revisionHash !== proposal.revisionSha256) {
    throw new Error("Workshop revision binding changed");
  }
  const safeName = safeSlug(localProposal.skillName, "skill");
  if (
    safeName !== localProposal.skillName
    || proposal.skillName !== safeName
    || proposal.skillKey !== safeName
  ) {
    throw new Error("Workshop skill binding changed");
  }
  const expectedSkillFile = resolve(eventWorkspaceDir, "skills", safeName, "SKILL.md");
  if (resolve(proposal.skillFile) !== expectedSkillFile) {
    throw new Error("Workshop skill file binding changed");
  }
}

/**
 * Synchronize committed OpenClaw Skill Workshop terminal events with one
 * exactly bound PLUR1BUS proposal.
 * @param {object} options
 * @returns {(event: object, context: object) => Promise<object>}
 */
export function createSkillWorkshopLifecycleSynchronizer({
  onApplied,
  onRejected,
  resolveProposalWorkspaces = ({ context }) => [context.workspaceDir],
} = {}) {
  if (typeof onApplied !== "function" || typeof onRejected !== "function") {
    throw new TypeError("Skill Workshop lifecycle callbacks are required");
  }
  if (typeof resolveProposalWorkspaces !== "function") {
    throw new TypeError("Skill Workshop proposal workspace resolver must be a function");
  }
  const queues = new Map();

  return async function synchronizeSkillWorkshopLifecycle(workshopEvent, context) {
    const parsed = requireWorkshopLifecycleEvent(workshopEvent, context);
    if (!parsed) return { status: "ignored", reason: "non_terminal_event" };
    const eventWorkspaceDir = resolve(context.workspaceDir);
    if (eventWorkspaceDir !== context.workspaceDir) {
      throw new Error("Workshop workspace binding must be absolute and normalized");
    }
    const queueKey = `${eventWorkspaceDir}\0${parsed.proposal.id}`;
    const predecessor = queues.get(queueKey);
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    queues.set(queueKey, gate);
    try {
      if (predecessor) await predecessor;
      const rawProposalWorkspaces = await resolveProposalWorkspaces({
        context,
        eventWorkspaceDir,
        workshopEvent,
      });
      if (!Array.isArray(rawProposalWorkspaces) || rawProposalWorkspaces.length === 0) {
        throw new Error("Skill Workshop proposal workspace resolver returned no roots");
      }
      const proposalWorkspaces = [...new Set(rawProposalWorkspaces.map((candidate) => {
        if (typeof candidate !== "string" || !candidate.trim() || resolve(candidate) !== candidate) {
          throw new Error("Skill Workshop proposal workspace must be absolute and normalized");
        }
        return candidate;
      }))];
      const matches = proposalWorkspaces.flatMap((proposalWorkspaceDir) =>
        readProposals(proposalWorkspaceDir)
          .filter((candidate) => candidate?.openClawWorkshop?.proposalId === parsed.proposal.id)
          .map((localProposal) => ({ localProposal, proposalWorkspaceDir })));
      if (matches.length === 0) return { status: "ignored", reason: "foreign_proposal" };
      if (matches.length !== 1) throw new Error("ambiguous local Workshop binding");
      const { localProposal, proposalWorkspaceDir } = matches[0];
      validateWorkshopLifecycleBinding(eventWorkspaceDir, context.agentId, parsed.proposal, localProposal);
      if (terminalStatusMatches(localProposal, parsed.action)) {
        return { status: "already_synchronized", action: parsed.action, localProposalId: localProposal.id };
      }
      if (
        parsed.action === "applied"
        && localProposal.status !== "pending_review"
        && localProposal.status !== "activation_partial"
      ) {
        throw new Error(`local Workshop apply cannot continue from ${localProposal.status}`);
      }
      if (parsed.action === "rejected" && localProposal.status !== "pending_review") {
        throw new Error(`local Workshop rejection cannot continue from ${localProposal.status}`);
      }
      const callback = parsed.action === "applied" ? onApplied : onRejected;
      const callbackResult = await callback({
        workspaceDir: proposalWorkspaceDir,
        eventWorkspaceDir,
        agentId: context.agentId,
        localProposal,
        workshopEvent,
      });
      if (callbackResult?.ok !== true) {
        throw new Error(`local Workshop ${parsed.action} synchronization failed`);
      }
      const persisted = readProposals(proposalWorkspaceDir).filter(
        (candidate) => candidate?.id === localProposal.id
          && candidate?.openClawWorkshop?.proposalId === parsed.proposal.id,
      );
      if (persisted.length !== 1) {
        throw new Error("local Workshop synchronization did not preserve one exact binding");
      }
      const persistedProposal = persisted[0];
      const appliedPersisted = parsed.action === "applied"
        && ["active", "activation_partial"].includes(persistedProposal.status)
        && persistedProposal.openClawWorkshop?.status === "applied";
      const rejectedPersisted = parsed.action === "rejected"
        && persistedProposal.status === "rejected"
        && persistedProposal.openClawWorkshop?.status === "rejected";
      if (!appliedPersisted && !rejectedPersisted) {
        throw new Error(`local Workshop ${parsed.action} synchronization was not persisted`);
      }
      return {
        status: "synchronized",
        action: parsed.action,
        localProposalId: localProposal.id,
        localStatus: persistedProposal.status,
      };
    } finally {
      if (queues.get(queueKey) === gate) queues.delete(queueKey);
      release();
    }
  };
}

function activationResponse(proposal, skillPath, { lang, tone }) {
  const results = { ...(proposal.activation?.evidence || {}) };
  const unfinished = proposal.status === "activation_partial"
    || Object.values(results).some((entry) => entry && entry.ok === false);
  return {
    ok: true,
    partial: unfinished,
    status: unfinished ? "activation_partial" : "active",
    skillPath: proposal.activation?.skillPath || skillPath,
    evidence: results,
    text: unfinished
      ? t("skill.approve_partial", { lang, tone, vars: { title: proposal.skillTitle, name: proposal.skillName } })
      : t("skill.approve_success", { lang, tone, vars: { title: proposal.skillTitle, name: proposal.skillName } }),
  };
}

// Belege des Miners sind teils Dokument-Fakten mit Hash-ID statt UUID; die
// Speicherschicht weist sie ab ("Invalid memory ID format"). Sie sind nicht
// hebbar und gelten deshalb als übersprungen, nicht als Fehlschlag.
const EVIDENCE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Nächster Belegstatus, abhängig von der Stufe des Handelnden.
 *
 * 7.12.52: Beim Auto-Apply handelt der Miner als `system:skill-workshop`, und
 * diese Stufe darf eine Erinnerung ausschließlich nach `corroborated` heben
 * (siehe isLegalEpistemicTransition). Der Zwischenschritt "" → observed wäre
 * illegal; bis 7.12.51 versuchte die Aktivierung ihn trotzdem, scheiterte und
 * ließ jeden automatisch angewandten Skill auf `activation_partial` stehen.
 * @param {*} raw gespeicherter Status
 * @param {string} [actorTier]
 * @returns {"observed"|"corroborated"|"noop"|"skip"}
 */
function nextEvidenceStatus(raw, actorTier = "human") {
  const value = raw == null ? "" : String(raw);
  if (actorTier === "system:skill-workshop") {
    if (value === "observed") return "corroborated";
    if (value === "corroborated" || value === "trusted") return "noop";
    return "skip";
  }
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
  let skillPath = join(workspaceDir, "skills", safeName, "SKILL.md");
  const committedWorkshopEvent = ctx.committedWorkshopEvent;
  if (committedWorkshopEvent) {
    const binding = proposal.openClawWorkshop;
    const committedProposal = committedWorkshopEvent.proposal;
    if (
      committedWorkshopEvent.action !== "applied"
      || committedProposal?.status !== "applied"
      || committedProposal?.id !== binding?.proposalId
      || committedProposal?.revisionSha256 !== binding?.revisionHash
      || committedProposal?.skillName !== safeName
      || typeof committedProposal?.skillFile !== "string"
    ) {
      return {
        ok: false,
        reason: "workshop_binding_mismatch",
        text: t("skill.workshop_failed", { lang, tone, vars: { reason: "Workshop lifecycle binding mismatch" } }),
      };
    }
    skillPath = resolve(committedProposal.skillFile);
    patchProposal(workspaceDir, id, {
      status: "activation_partial",
      openClawWorkshop: { ...binding, status: "applied" },
      activation: {
        ...(proposal.activation || {}),
        skillPath,
        evidence: proposal.activation?.evidence || {},
      },
    });
  } else if (ctx.skillWorkshop) {
    const binding = proposal.openClawWorkshop;
    const agentId = ctx.agentId || proposal.agentId;
    if (
      !binding
      || typeof binding.proposalId !== "string"
      || typeof binding.revisionHash !== "string"
      || typeof ctx.skillWorkshop.inspectProposal !== "function"
      || typeof ctx.skillWorkshop.applyProposal !== "function"
      || typeof agentId !== "string"
    ) {
      return {
        ok: false,
        reason: "workshop_binding_missing",
        text: t("skill.workshop_failed", { lang, tone, vars: { reason: "Workshop binding unavailable" } }),
      };
    }
    try {
      const inspected = await ctx.skillWorkshop.inspectProposal({
        agentId,
        proposalId: binding.proposalId,
      });
      if (
        inspected?.proposalId !== binding.proposalId
        || inspected?.skillName !== safeName
      ) {
        return {
          ok: false,
          reason: "workshop_binding_mismatch",
          text: t("skill.workshop_failed", { lang, tone, vars: { reason: "Workshop target mismatch" } }),
        };
      }
      if (inspected.revisionHash !== binding.revisionHash) {
        return {
          ok: false,
          reason: "workshop_revision_changed",
          text: t("skill.workshop_failed", { lang, tone, vars: { reason: "Workshop revision changed; review it again" } }),
        };
      }
      let applied = null;
      if (inspected.status === "pending") {
        applied = await ctx.skillWorkshop.applyProposal({
          agentId,
          proposalId: binding.proposalId,
          expectedRevisionHash: binding.revisionHash,
        });
        if (applied?.proposalId !== binding.proposalId || applied?.status !== "applied") {
          throw new Error("OpenClaw Skill Workshop returned an invalid apply result");
        }
        // 7.12.51: Der Workshop schreibt in sein eigenes Verzeichnis
        // (agents/<id>/agent/workshop-skills/<name>/SKILL.md). Bis 7.12.50
        // verglich PLUR1BUS diesen Pfad mit einem selbst geratenen im
        // Ledger-Verzeichnis — jede Freigabe brach mit "unexpected target" ab,
        // obwohl der Skill bereits angewandt war. Geprueft wird jetzt die
        // Form des Host-Pfads, uebernommen wird er.
        const appliedTarget = workshopSkillTarget(applied.targetSkillFile, safeName);
        if (applied.targetSkillFile && !appliedTarget) {
          throw new Error("OpenClaw Skill Workshop applied the proposal to an unexpected target");
        }
        if (appliedTarget) skillPath = appliedTarget;
      } else if (inspected.status === "applied") {
        // Schon angewandt (z. B. nach einem Fehlschlag beim lokalen
        // Nachziehen): Pfad aus dem Workshop-Verzeichnis des Agenten holen,
        // damit `activation.skillPath` auf die echte Datei zeigt.
        const known = typeof ctx.workshopSkillPath === "function" ? ctx.workshopSkillPath(safeName) : "";
        const target = workshopSkillTarget(known, safeName);
        if (target && existsSync(target)) skillPath = target;
      } else if (inspected.status !== "applied") {
        return {
          ok: false,
          reason: "workshop_not_pending",
          text: t("skill.workshop_failed", { lang, tone, vars: { reason: `Workshop status is ${inspected.status}` } }),
        };
      }
      const synchronized = readProposals(workspaceDir).find((candidate) => candidate.id === id);
      if (
        synchronized?.openClawWorkshop?.proposalId === binding.proposalId
        && synchronized.openClawWorkshop.status === "applied"
        && ["active", "activation_partial"].includes(synchronized.status)
      ) {
        return activationResponse(synchronized, skillPath, { lang, tone });
      }
      patchProposal(workspaceDir, id, {
        status: "activation_partial",
        openClawWorkshop: { ...binding, status: "applied" },
        activation: {
          ...(proposal.activation || {}),
          skillPath: applied?.targetSkillFile || skillPath,
          evidence: proposal.activation?.evidence || {},
        },
      });
    } catch (error) {
      safeWarn(ctx.logger, "skill-workshop-apply", error, { proposalId: binding.proposalId });
      return {
        ok: false,
        reason: "workshop_apply_failed",
        text: t("skill.workshop_failed", { lang, tone, vars: { reason: "OpenClaw Skill Workshop apply failed" } }),
      };
    }
  } else if (!existsSync(skillPath)) {
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

  const persistEvidence = () => {
    const unfinishedNow = Object.values(results).some((entry) => entry && entry.ok === false);
    patchProposal(workspaceDir, id, {
      status: unfinishedNow ? "activation_partial" : "active",
      activation: { skillPath, evidence: { ...results } },
    });
  };

  const evidenceActorTier = typeof ctx.evidenceActorTier === "string" ? ctx.evidenceActorTier : "human";

  for (const memoryId of evidenceIds) {
    const prior = results[memoryId];
    if (prior && (prior.ok === true || prior.reason === "skipped" || prior.reason === "noop")) continue;
    if (!EVIDENCE_UUID_RE.test(String(memoryId))) {
      results[memoryId] = { ok: true, reason: "skipped", note: "non_uuid_id" };
      persistEvidence();
      continue;
    }
    try {
      const record = loadRecord ? await loadRecord(memoryId, current.aclBindings) : null;
      if (!record) {
        results[memoryId] = { ok: false, reason: "acl_or_missing" };
        persistEvidence();
        continue;
      }
      if (memoryCtx && !checkAccess(memoryCtx, record).allowed) {
        results[memoryId] = { ok: false, reason: "acl_or_missing" };
        persistEvidence();
        continue;
      }
      // Eine gemerkte Absicht aus einem früheren Versuch gilt nur, wenn die
      // jetzige Stufe sie auch ausführen darf — sonst liefe der Wiederholungs-
      // versuch erneut in denselben illegalen Übergang.
      const priorTarget = prior?.to && prior.to !== "noop" && prior.to !== "skip"
        && (evidenceActorTier !== "system:skill-workshop" || prior.to === "corroborated")
        ? prior.to
        : null;
      const intended = priorTarget || nextEvidenceStatus(record.epistemicStatus, evidenceActorTier);
      if (intended === "noop" || String(record.epistemicStatus || "") === intended) {
        results[memoryId] = { ok: true, reason: "noop", from: record.epistemicStatus, to: record.epistemicStatus };
        persistEvidence();
        continue;
      }
      if (intended === "skip") {
        results[memoryId] = { ok: true, reason: "skipped", from: record.epistemicStatus };
        persistEvidence();
        continue;
      }
      if (!applyStatus) {
        results[memoryId] = { ok: false, reason: "adapter_missing" };
        persistEvidence();
        continue;
      }
      results[memoryId] = { ok: false, reason: "pending", from: record.epistemicStatus, to: intended };
      persistEvidence();
      const applied = await applyStatus(memoryId, intended, record);
      if (applied?.ok) {
        results[memoryId] = { ok: true, reason: "transitioned", from: record.epistemicStatus, to: intended };
      } else {
        results[memoryId] = { ok: false, reason: applied?.reason || "transition_failed", from: record.epistemicStatus, to: intended };
      }
      persistEvidence();
    } catch (error) {
      results[memoryId] = { ok: false, reason: String(error?.message || error), to: results[memoryId]?.to };
      persistEvidence();
    }
  }

  const unfinished = Object.values(results).some((entry) => entry && entry.ok === false);
  const nextStatus = unfinished ? "activation_partial" : "active";
  patchProposal(workspaceDir, id, {
    status: nextStatus,
    activation: { skillPath, evidence: results },
  });

  return activationResponse(
    { ...current, status: nextStatus, activation: { skillPath, evidence: results } },
    skillPath,
    { lang, tone },
  );
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

/**
 * Reject a Workshop-bound proposal at its reviewed revision before updating PLUR1BUS.
 * @param {string} workspaceDir
 * @param {string} id
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function rejectSkillProposalWithWorkshop(workspaceDir, id, opts = {}) {
  if (!opts.skillWorkshop) return rejectSkillProposal(workspaceDir, id, opts);
  const { lang = "en", tone = "default" } = opts;
  const proposal = readProposals(workspaceDir).find((entry) => entry.id === id);
  if (!proposal) {
    return { ok: false, text: t("skill.reject_not_found", { lang, tone, vars: { id } }) };
  }
  if (proposal.status !== "pending_review") {
    return { ok: false, text: t("skill.approve_not_pending", { lang, tone, vars: { id } }) };
  }
  const binding = proposal.openClawWorkshop;
  const agentId = opts.agentId || proposal.agentId;
  if (
    !binding
    || typeof binding.proposalId !== "string"
    || typeof binding.revisionHash !== "string"
    || typeof opts.skillWorkshop.inspectProposal !== "function"
    || typeof opts.skillWorkshop.rejectProposal !== "function"
    || typeof agentId !== "string"
  ) {
    return {
      ok: false,
      reason: "workshop_binding_missing",
      text: t("skill.workshop_failed", { lang, tone, vars: { reason: "Workshop binding unavailable" } }),
    };
  }
  try {
    const inspected = await opts.skillWorkshop.inspectProposal({
      agentId,
      proposalId: binding.proposalId,
    });
    if (
      inspected?.proposalId !== binding.proposalId
      || inspected?.skillName !== safeSlug(proposal.skillName, "skill")
      || inspected?.revisionHash !== binding.revisionHash
      || inspected?.status !== "pending"
    ) {
      return {
        ok: false,
        reason: "workshop_revision_changed",
        text: t("skill.workshop_failed", { lang, tone, vars: { reason: "Workshop proposal changed; review it again" } }),
      };
    }
    const rejected = await opts.skillWorkshop.rejectProposal({
      agentId,
      proposalId: binding.proposalId,
      expectedRevisionHash: binding.revisionHash,
    });
    if (rejected?.proposalId !== binding.proposalId || rejected?.status !== "rejected") {
      throw new Error("OpenClaw Skill Workshop returned an invalid reject result");
    }
    markProposalStatus(workspaceDir, id, "rejected");
    patchProposal(workspaceDir, id, {
      openClawWorkshop: { ...binding, status: "rejected" },
    });
    return {
      ok: true,
      text: t("skill.reject_success", { lang, tone, vars: { title: proposal.skillTitle } }),
    };
  } catch (error) {
    safeWarn(opts.logger, "skill-workshop-reject", error, { proposalId: binding.proposalId });
    return {
      ok: false,
      reason: "workshop_reject_failed",
      text: t("skill.workshop_failed", { lang, tone, vars: { reason: "OpenClaw Skill Workshop reject failed" } }),
    };
  }
}

/**
 * 7.12.48: Das Vorschlags-Ledger liegt je ACL-Partition unter dem Neo-Store
 * (`_neo/workspaces/acl-owner-v1_agent-private_<agent>_…/.adaptive-learning`),
 * nicht im Agenten-Workspace. Chat-Befehle und Dashboard suchen den Vorschlag
 * daher ueber alle Partitionsverzeichnisse des Agenten; IDs sind UUIDs.
 * @param {string[]} workspaceDirs
 * @param {string} id
 * @returns {string|null} Verzeichnis, dessen Ledger die ID enthaelt.
 */
export function findProposalWorkspace(workspaceDirs, id) {
  if (typeof id !== "string" || !id) return null;
  for (const dir of Array.isArray(workspaceDirs) ? workspaceDirs : []) {
    if (typeof dir !== "string" || !dir) continue;
    try {
      if (readProposals(dir).some((proposal) => proposal?.id === id)) return dir;
    } catch {
      // Ein unlesbares Ledger blockiert die Suche in den uebrigen nicht.
    }
  }
  return null;
}

const RETIRABLE_PARENT_DIRS = new Set(["workshop-skills", "skills"]);

/**
 * Pruefe einen Skill-Pfad des Hosts: <…>/(workshop-skills|skills)/<name>/SKILL.md.
 * @param {string} candidate
 * @param {string} safeName
 * @returns {string} absoluter Pfad oder "" wenn die Form nicht stimmt
 */
function workshopSkillTarget(candidate, safeName) {
  if (typeof candidate !== "string" || !candidate.trim()) return "";
  const resolved = resolve(candidate);
  const skillDir = dirname(resolved);
  if (basename(resolved) !== "SKILL.md") return "";
  if (basename(skillDir) !== safeName) return "";
  if (!RETIRABLE_PARENT_DIRS.has(basename(dirname(skillDir)))) return "";
  return resolved;
}
// Kennung, die skill-md-renderer in jede vom Miner geschriebene SKILL.md setzt.
const MINER_PROVENANCE_MARKER = "Auto-discovered by PLUR1BUS Skill Miner";

function isMinerWrittenSkill(skillPath) {
  try {
    return readFileSync(skillPath, "utf8").includes(MINER_PROVENANCE_MARKER);
  } catch {
    return false;
  }
}

/**
 * 7.12.48: Einen bereits angewandten (aktiven) Skill zurueckziehen.
 *
 * Der Workshop kennt keinen RPC, der einen angewandten Skill entfernt; mit
 * Auto-Apply sind aber fast alle geminten Skills sofort aktiv. Deshalb loescht
 * PLUR1BUS das Skill-Verzeichnis selbst — nur wenn der bei der Aktivierung
 * gemerkte Pfad in einem `workshop-skills`- oder `skills`-Verzeichnis liegt
 * und der Ordnername dem Skill-Namen entspricht. Ein fehlendes Verzeichnis
 * (die woechentliche Collection-Review des Hosts darf umbauen) gilt als
 * bereits entfernt. Danach steht der Vorschlag auf `rejected`, der Name ist
 * fuer den Miner gesperrt (skill-rejected.jsonl).
 * @param {string} workspaceDir Ledger-Verzeichnis
 * @param {string} id
 * @param {{logger?: object}} [opts]
 * @returns {{ok: boolean, reason?: string, removed?: boolean, skillPath?: string}}
 */
export function retireActiveSkill(workspaceDir, id, opts = {}) {
  const proposal = readProposals(workspaceDir).find((entry) => entry.id === id);
  if (!proposal) return { ok: false, reason: "not_found" };
  if (proposal.status !== "active" && proposal.status !== "activation_partial") {
    return { ok: false, reason: "not_active", status: proposal.status };
  }
  const safeName = safeSlug(proposal.skillName, "skill");
  const skillPath = typeof proposal.activation?.skillPath === "string" && proposal.activation.skillPath
    ? resolve(proposal.activation.skillPath)
    : "";
  let removed = false;
  if (skillPath) {
    const skillDir = dirname(skillPath);
    const parentDir = basename(dirname(skillDir));
    if (basename(skillPath) !== "SKILL.md" || basename(skillDir) !== safeName || !RETIRABLE_PARENT_DIRS.has(parentDir)) {
      return { ok: false, reason: "unsafe_skill_path", skillPath };
    }
    // Im Workspace-`skills/` liegen auch handgeschriebene Skills. Eine alte
    // Aktivierung merkt sich den Pfad auch dann, wenn dort schon ein
    // gleichnamiger handgeschriebener Skill lag; geloescht wird nur, was der
    // Miner selbst geschrieben hat. `workshop-skills/` gehoert dem Workshop.
    if (parentDir === "skills" && existsSync(skillPath) && !isMinerWrittenSkill(skillPath)) {
      return { ok: false, reason: "foreign_skill", skillPath };
    }
    try {
      if (existsSync(skillDir)) {
        rmSync(skillDir, { recursive: true, force: true });
        removed = true;
      }
    } catch (error) {
      safeWarn(opts.logger, "skill-retire", error, { proposalId: id, skillPath });
      return { ok: false, reason: "remove_failed", skillPath };
    }
  }
  const marked = markProposalStatus(workspaceDir, id, "rejected");
  if (!marked.ok) return { ok: false, reason: marked.reason || "mark_failed" };
  patchProposal(workspaceDir, id, {
    retiredAt: new Date().toISOString(),
    ...(proposal.openClawWorkshop
      ? { openClawWorkshop: { ...proposal.openClawWorkshop, status: "retired" } }
      : {}),
  });
  return { ok: true, removed, skillPath: skillPath || undefined };
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
  const confirmLines = [];
  if (opts.userId && opts.chatId) {
    confirmLines.push("");
    for (const proposal of proposals) {
      const approve = confirmations.find((c) => c.command === "skills-approve" && c.targetId === proposal.id);
      const reject = confirmations.find((c) => c.command === "skills-reject" && c.targetId === proposal.id);
      if (approve) {
        confirmLines.push(`Approve "${proposal.skillTitle || proposal.id}" (${proposal.id}): /plur1bus skills confirm ${approve.nonce}`);
      }
      if (reject) {
        confirmLines.push(`Reject "${proposal.skillTitle || proposal.id}" (${proposal.id}): /plur1bus skills confirm ${reject.nonce}`);
      }
    }
  }
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
