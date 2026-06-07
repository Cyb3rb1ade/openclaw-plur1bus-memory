/**
 * Manual test runner for skill-miner tasks 3-4
 * (node --test hangs in this environment, so we use direct assertions)
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readProposals,
  writeProposal,
  markProposalStatus,
  isSkillNameBlocked,
} from "../lib/jobs/skill-miner/proposal-writer.js";

import { renderSkillMd } from "../lib/jobs/skill-miner/skill-md-renderer.js";

let tmpDir;
function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "sm-test-"));
}
function teardown() {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    setup();
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  } finally {
    teardown();
  }
}

// ===== proposal-writer tests =====

test("writeProposal creates .adaptive-learning and appends proposal", () => {
  const proposal = {
    id: "p1",
    skillName: "dark-mode-preference",
    skillTitle: "Dark Mode Preference",
    description: "User prefers dark mode",
    instructions: "Offer dark mode by default",
    confidence: 0.75,
    status: "pending_review",
    proposedAt: new Date().toISOString(),
  };
  const result = writeProposal(tmpDir, proposal);
  assert.strictEqual(result.written, true);
  const proposals = readProposals(tmpDir);
  assert.strictEqual(proposals.length, 1);
  assert.strictEqual(proposals[0].skillName, "dark-mode-preference");
});

test("writeProposal deduplicates by skillName", () => {
  const proposal = {
    id: "p1",
    skillName: "dark-mode-preference",
    skillTitle: "Dark Mode Preference",
    description: "User prefers dark mode",
    instructions: "Offer dark mode by default",
    confidence: 0.75,
    status: "pending_review",
    proposedAt: new Date().toISOString(),
  };
  writeProposal(tmpDir, proposal);
  const result = writeProposal(tmpDir, { ...proposal, id: "p2" });
  assert.strictEqual(result.written, false);
  assert.strictEqual(result.reason, "already_exists_or_rejected");
});

test("isSkillNameBlocked returns true for existing proposal", () => {
  const proposal = {
    id: "p1",
    skillName: "blocked-skill",
    skillTitle: "Blocked",
    description: "X",
    instructions: "Y",
    confidence: 0.75,
    status: "pending_review",
    proposedAt: new Date().toISOString(),
  };
  writeProposal(tmpDir, proposal);
  assert.strictEqual(isSkillNameBlocked(tmpDir, "blocked-skill"), true);
  assert.strictEqual(isSkillNameBlocked(tmpDir, "other-skill"), false);
});

test("markProposalStatus updates status and writes rejected record", () => {
  const proposal = {
    id: "p1",
    skillName: "reject-me",
    skillTitle: "Reject Me",
    description: "X",
    instructions: "Y",
    confidence: 0.75,
    status: "pending_review",
    proposedAt: new Date().toISOString(),
  };
  writeProposal(tmpDir, proposal);
  const result = markProposalStatus(tmpDir, "p1", "rejected");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, "rejected");

  const proposals = readProposals(tmpDir);
  assert.strictEqual(proposals[0].status, "rejected");
  assert.ok(proposals[0].updatedAt);

  const rejectedPath = join(tmpDir, ".adaptive-learning", "skill-rejected.jsonl");
  const rejected = readFileSync(rejectedPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].skillName, "reject-me");
});

test("markProposalStatus returns not_found for missing id", () => {
  const result = markProposalStatus(tmpDir, "nonexistent", "active");
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "not_found");
});

test("rejected skillName is blocked from re-proposal", () => {
  const proposal = {
    id: "p1",
    skillName: "once-rejected",
    skillTitle: "Once Rejected",
    description: "X",
    instructions: "Y",
    confidence: 0.75,
    status: "pending_review",
    proposedAt: new Date().toISOString(),
  };
  writeProposal(tmpDir, proposal);
  markProposalStatus(tmpDir, "p1", "rejected");
  const result = writeProposal(tmpDir, { ...proposal, id: "p2" });
  assert.strictEqual(result.written, false);
  assert.strictEqual(result.reason, "already_exists_or_rejected");
});

// ===== skill-md-renderer tests =====

test("renderSkillMd produces valid markdown with all fields", () => {
  const proposal = {
    skillTitle: "Dark Mode Preference",
    skillName: "dark-mode-preference",
    description: "User prefers dark mode in all apps.",
    instructions: "Always offer dark mode when presenting UI options.",
    examples: ["Enable dark mode by default", "Ask user for theme preference"],
    evidence: { llmConfidence: 0.75, memoryIds: ["m1", "m2", "m3"] },
    agentId: "heisenberg",
    workspaceKey: "heisenberg-ws",
    proposedAt: "2026-06-01T12:00:00Z",
  };
  const md = renderSkillMd(proposal, { approvedAt: "2026-06-02T12:00:00Z" });
  assert.ok(md.includes("# Dark Mode Preference"));
  assert.ok(md.includes("**Agent:** heisenberg"));
  assert.ok(md.includes("**Workspace:** heisenberg-ws"));
  assert.ok(md.includes("**Discovered:** 2026-06-01T12:00:00Z"));
  assert.ok(md.includes("**Approved:** 2026-06-02T12:00:00Z"));
  assert.ok(md.includes("**Confidence:** 0.75"));
  assert.ok(md.includes("**Evidenced by:** 3 memories"));
  assert.ok(md.includes("User prefers dark mode in all apps."));
  assert.ok(md.includes("Always offer dark mode when presenting UI options."));
  assert.ok(md.includes("- Enable dark mode by default"));
  assert.ok(md.includes("- Ask user for theme preference"));
  assert.ok(md.includes("Auto-discovered by PLUR1BUS Skill Miner"));
  assert.ok(md.includes("m1, m2, m3"));
  assert.ok(md.includes("`dark-mode-preference`"));
});

test("renderSkillMd handles missing optional fields gracefully", () => {
  const proposal = {
    skillTitle: "Minimal Skill",
    skillName: "minimal",
  };
  const md = renderSkillMd(proposal);
  assert.ok(md.includes("# Minimal Skill"));
  assert.ok(md.includes("**Agent:** unknown"));
  assert.ok(md.includes("**Workspace:** unknown"));
  assert.ok(md.includes("No description provided."));
  assert.ok(md.includes("No instructions provided."));
  assert.ok(md.includes("- No examples provided."));
  assert.ok(md.includes("**Confidence:** unknown"));
  assert.ok(md.includes("**Evidenced by:** 0 memories"));
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
