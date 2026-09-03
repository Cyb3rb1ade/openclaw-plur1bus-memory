/**
 * lib/jobs/skill-miner/proposal-writer.js
 *
 * Read/write skill-proposals.jsonl, deduplicate by skillName, track rejections.
 */

import { existsSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonl } from "../../jsonl-utils.js";

const PROPOSALS_FILE = "skill-proposals.jsonl";
const REJECTED_FILE = "skill-rejected.jsonl";

function proposalsPath(workspaceDir) {
  return join(workspaceDir, ".adaptive-learning", PROPOSALS_FILE);
}

function rejectedPath(workspaceDir) {
  return join(workspaceDir, ".adaptive-learning", REJECTED_FILE);
}

export function readProposals(workspaceDir) {
  return readJsonl(proposalsPath(workspaceDir));
}

export function isSkillNameBlocked(workspaceDir, skillName) {
  const proposals = readProposals(workspaceDir);
  if (proposals.some(p => p.skillName === skillName)) return true;
  const rejected = readJsonl(rejectedPath(workspaceDir));
  if (rejected.some(r => r.skillName === skillName)) return true;
  return false;
}

export function writeProposal(workspaceDir, proposal) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (isSkillNameBlocked(workspaceDir, proposal.skillName)) {
    return { written: false, reason: "already_exists_or_rejected" };
  }

  const path = proposalsPath(workspaceDir);
  appendFileSync(path, JSON.stringify(proposal) + "\n", "utf8");
  return { written: true, path };
}

function persistProposals(workspaceDir, proposals) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const ppath = proposalsPath(workspaceDir);
  const lines = proposals.map((p) => JSON.stringify(p)).join("\n") + "\n";
  writeFileSync(ppath, lines, "utf8");
}

export function markProposalStatus(workspaceDir, id, status) {
  const proposals = readProposals(workspaceDir);
  const target = proposals.find(p => p.id === id);
  if (!target) return { ok: false, reason: "not_found" };

  if (target.status === status) {
    return { ok: true, idempotent: true, skillName: target.skillName, status };
  }

  if (status === "rejected") {
    const rpath = rejectedPath(workspaceDir);
    appendFileSync(rpath, JSON.stringify({ skillName: target.skillName, rejectedAt: new Date().toISOString() }) + "\n", "utf8");
  }

  target.status = status;
  target.updatedAt = new Date().toISOString();
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
  persistProposals(workspaceDir, proposals);
  return { ok: true, proposal: target };
}

export function getPendingProposals(workspaceDir) {
  return readProposals(workspaceDir).filter(p => p.status === "pending_review");
}

const PRESENTED_FILE = "skill-proposals-presented.jsonl";

function presentedPath(workspaceDir) {
  return join(workspaceDir, ".adaptive-learning", PRESENTED_FILE);
}

export function recordPresentation(workspaceDir, proposalIds) {
  const dir = join(workspaceDir, ".adaptive-learning");
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
