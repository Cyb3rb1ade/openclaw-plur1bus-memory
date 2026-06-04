/**
 * lib/jobs/skill-miner/proposal-writer.js
 *
 * Read/write skill-proposals.jsonl, deduplicate by skillName, track rejections.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PROPOSALS_FILE = "skill-proposals.jsonl";
const REJECTED_FILE = "skill-rejected.jsonl";

function proposalsPath(workspaceDir) {
  return join(workspaceDir, ".adaptive-learning", PROPOSALS_FILE);
}

function rejectedPath(workspaceDir) {
  return join(workspaceDir, ".adaptive-learning", REJECTED_FILE);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
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

export function markProposalStatus(workspaceDir, id, status) {
  const proposals = readProposals(workspaceDir);
  const target = proposals.find(p => p.id === id);
  if (!target) return { ok: false, reason: "not_found" };

  if (status === "rejected") {
    const rpath = rejectedPath(workspaceDir);
    appendFileSync(rpath, JSON.stringify({ skillName: target.skillName, rejectedAt: new Date().toISOString() }) + "\n", "utf8");
  }

  target.status = status;
  target.updatedAt = new Date().toISOString();

  const ppath = proposalsPath(workspaceDir);
  const lines = proposals.map(p => JSON.stringify(p)).join("\n") + "\n";
  writeFileSync(ppath, lines, "utf8");

  return { ok: true, skillName: target.skillName, status };
}
