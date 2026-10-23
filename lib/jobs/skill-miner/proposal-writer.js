/**
 * lib/jobs/skill-miner/proposal-writer.js
 *
 * Read/write skill-proposals.jsonl, deduplicate by skillName, track rejections.
 */

import { existsSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { readJsonl } from "../../jsonl-utils.js";
import { sameSkillOwnershipTuple } from "./evidence-aggregator.js";
import { resolveInside } from "../../sql-safety.js";

const PROPOSALS_FILE = "skill-proposals.jsonl";
const REJECTED_FILE = "skill-rejected.jsonl";

function ledgerPath(workspaceDir, ...parts) {
  const base = resolve(workspaceDir);
  let anchor = base;
  while (!existsSync(anchor)) anchor = dirname(anchor);
  return resolveInside(anchor, relative(anchor, base), ...parts);
}

function proposalsPath(workspaceDir) {
  return ledgerPath(workspaceDir, ".adaptive-learning", PROPOSALS_FILE);
}

function rejectedPath(workspaceDir) {
  return ledgerPath(workspaceDir, ".adaptive-learning", REJECTED_FILE);
}

/**
 * Read the local skill version history.
 * @param {string} workspaceDir
 * @returns {object[]}
 */
export function readProposals(workspaceDir) {
  return readJsonl(proposalsPath(workspaceDir));
}

/**
 * Check existing names and explicit rejections.
 * @param {string} workspaceDir
 * @param {string} skillName
 * @returns {boolean}
 */
export function isSkillNameBlocked(workspaceDir, skillName) {
  const proposals = readProposals(workspaceDir);
  if (proposals.some(p => p.skillName === skillName)) return true;
  const rejected = readJsonl(rejectedPath(workspaceDir));
  if (rejected.some(r => r.skillName === skillName)) return true;
  return false;
}

function sameOwner(a, b) {
  const legacyPrivate = !a.aclBindings && (!b.aclBindings || (b.aclBindings.scope === "agent-private" && b.aclBindings.agentId === a.agentId));
  return a.agentId === b.agentId && (legacyPrivate
    || (a.aclBindings && b.aclBindings && sameSkillOwnershipTuple(a.aclBindings, b.aclBindings)));
}

function validUpdate(proposals, proposal) {
  const base = proposals.find(p => p.id === proposal.updateOf);
  return base?.status === "active" && base.skillName === proposal.skillName && sameOwner(base, proposal)
    && proposal.openClawWorkshop?.operation === "update"
    && /^[a-f0-9]{64}$/i.test(proposal.openClawWorkshop.baseContentHash || "")
    && !proposals.some(p => p.skillName === proposal.skillName && ["pending_review", "activation_partial"].includes(p.status));
}

/**
 * Persist a new skill or a version-bound extension.
 * @param {string} workspaceDir
 * @param {object} proposal
 * @returns {object}
 */
export function writeProposal(workspaceDir, proposal) {
  const dir = ledgerPath(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (proposal.updateOf ? (!validUpdate(readProposals(workspaceDir), proposal)
    || readJsonl(rejectedPath(workspaceDir)).some(r => r.skillName === proposal.skillName))
    : isSkillNameBlocked(workspaceDir, proposal.skillName)) {
    return { written: false, reason: "already_exists_or_rejected" };
  }

  const path = proposalsPath(workspaceDir);
  if (proposal.updateOf) {
    const base = readProposals(workspaceDir).find(p => p.id === proposal.updateOf);
    proposal.extensionInstructions = proposal.instructions;
    proposal.instructions = `${base.instructions || ""}\n\n${proposal.instructions}`;
  }
  appendFileSync(path, JSON.stringify(proposal) + "\n", "utf8");
  return { written: true, path };
}

function persistProposals(workspaceDir, proposals) {
  const dir = ledgerPath(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ppath = proposalsPath(workspaceDir);
  const lines = proposals.map((p) => JSON.stringify(p)).join("\n") + "\n";
  writeFileSync(ppath, lines, "utf8");
}

function supersedeBase(proposals, target) {
  if (!target.updateOf || target.status !== "active") return;
  const base = proposals.find(p => p.id === target.updateOf);
  if (!base || base.skillName !== target.skillName || !sameOwner(base, target)
    || (base.status !== "active" && base.supersededBy !== target.id)) {
    throw new Error("Cannot supersede a mismatched skill version");
  }
  base.status = "superseded";
  base.supersededBy = target.id;
  base.updatedAt = new Date().toISOString();
}

/**
 * Change a proposal status while retaining version history.
 * @param {string} workspaceDir
 * @param {string} id
 * @param {string} status
 * @returns {object}
 */
export function markProposalStatus(workspaceDir, id, status) {
  const proposals = readProposals(workspaceDir);
  const target = proposals.find(p => p.id === id);
  if (!target) return { ok: false, reason: "not_found" };

  if (target.status === status) {
    return { ok: true, idempotent: true, skillName: target.skillName, status };
  }

  if (status === "rejected" && !target.updateOf) {
    const rpath = rejectedPath(workspaceDir);
    appendFileSync(rpath, JSON.stringify({ skillName: target.skillName, rejectedAt: new Date().toISOString() }) + "\n", "utf8");
  }

  target.status = status;
  target.updatedAt = new Date().toISOString();
  supersedeBase(proposals, target);
  persistProposals(workspaceDir, proposals);

  return { ok: true, skillName: target.skillName, status };
}

/**
 * Patch one proposal in place and rewrite the JSONL.
 * @param {string} workspaceDir
 * @param {string} id
 * @param {object} patch
 * @returns {{ok: boolean, proposal?: object, reason?: string}}
 */
export function patchProposal(workspaceDir, id, patch) {
  const proposals = readProposals(workspaceDir);
  const target = proposals.find((p) => p.id === id);
  if (!target) return { ok: false, reason: "not_found" };
  Object.assign(target, patch, { updatedAt: new Date().toISOString() });
  supersedeBase(proposals, target);
  persistProposals(workspaceDir, proposals);
  return { ok: true, proposal: target };
}

export function getPendingProposals(workspaceDir) {
  return readProposals(workspaceDir).filter(p => p.status === "pending_review");
}

const PRESENTED_FILE = "skill-proposals-presented.jsonl";

function presentedPath(workspaceDir) {
  return ledgerPath(workspaceDir, ".adaptive-learning", PRESENTED_FILE);
}

/**
 * Record which review proposals have been shown.
 * @param {string} workspaceDir
 * @param {string[]} proposalIds
 * @returns {void}
 */
export function recordPresentation(workspaceDir, proposalIds) {
  const dir = ledgerPath(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = presentedPath(workspaceDir);
  appendFileSync(path, JSON.stringify({ presentedAt: new Date().toISOString(), proposalIds }) + "\n", "utf8");
}

export function lastPresentationAgeMs(workspaceDir) {
  const entries = readJsonl(presentedPath(workspaceDir));
  if (entries.length === 0) return Infinity;
  const last = entries[entries.length - 1];
  const lastAt = last?.presentedAt ? new Date(last.presentedAt).getTime() : 0;
  return Date.now() - lastAt;
}
