/**
 * Manual test runner for skill-miner telegram commands (Task 6)
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listPendingProposals,
  approveProposal,
  rejectProposal,
  listActiveSkills,
  showProposal,
  isSkillNameBlocked,
} from "../lib/telegram-commands/skill-commands.js";

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), "sm-cmd-"));
  mkdirSync(join(tmpDir, ".adaptive-learning"), { recursive: true });
  return tmpDir;
}
function teardown(tmpDir) {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

let passed = 0;
let failed = 0;

async function runTests() {
  for (const t of tests) {
    const tmpDir = setup();
    try {
      await t.fn(tmpDir);
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(`    ${e.message}`);
    } finally {
      teardown(tmpDir);
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

test("listPendingProposals shows pending items", async (tmpDir) => {
  writeFileSync(
    join(tmpDir, ".adaptive-learning", "skill-proposals.jsonl"),
    JSON.stringify({ id: "p-1", skillName: "test-skill", skillTitle: "Test Skill", status: "pending_review", evidence: { score: 5, llmConfidence: 0.8 } }) + "\n"
  );
  const result = listPendingProposals(tmpDir);
  assert.ok(result.includes("Test Skill"));
  assert.ok(result.includes("p-1"));
});

test("listPendingProposals shows empty message", async (tmpDir) => {
  const result = listPendingProposals(tmpDir);
  assert.ok(result.includes("Keine offenen"));
});

test("approveProposal creates SKILL.md", async (tmpDir) => {
  writeFileSync(
    join(tmpDir, ".adaptive-learning", "skill-proposals.jsonl"),
    JSON.stringify({
      id: "p-2", skillName: "approved-skill", skillTitle: "Approved", description: "desc", instructions: "instr", examples: [], evidence: { memoryIds: ["a"], score: 5, llmConfidence: 0.8 }, agentId: "agent", workspaceKey: "ws", proposedAt: "2026-06-03T12:00:00Z", status: "pending_review",
    }) + "\n"
  );
  const result = approveProposal(tmpDir, "p-2", { agentId: "agent", workspaceKey: "ws" });
  assert.strictEqual(result.ok, true);
  const skillPath = join(tmpDir, "skills", "approved-skill", "SKILL.md");
  assert.ok(existsSync(skillPath), "SKILL.md should exist");
  const content = readFileSync(skillPath, "utf8");
  assert.ok(content.includes("# Approved"));
  assert.ok(content.includes("Auto-discovered by PLUR1BUS Skill Miner"));
});

test("approveProposal fails for missing id", async (tmpDir) => {
  const result = approveProposal(tmpDir, "missing", {});
  assert.strictEqual(result.ok, false);
});

test("rejectProposal blocks re-proposal", async (tmpDir) => {
  writeFileSync(
    join(tmpDir, ".adaptive-learning", "skill-proposals.jsonl"),
    JSON.stringify({ id: "p-3", skillName: "rejected-skill", skillTitle: "Rejected", status: "pending_review" }) + "\n"
  );
  const result = rejectProposal(tmpDir, "p-3");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(isSkillNameBlocked(tmpDir, "rejected-skill"), true);
});

test("listActiveSkills shows active skills", async (tmpDir) => {
  writeFileSync(
    join(tmpDir, ".adaptive-learning", "skill-proposals.jsonl"),
    JSON.stringify({ id: "p-4", skillName: "active-skill", skillTitle: "Active Skill", status: "active" }) + "\n"
  );
  const result = listActiveSkills(tmpDir);
  assert.ok(result.includes("Active Skill"));
});

test("showProposal displays details", async (tmpDir) => {
  writeFileSync(
    join(tmpDir, ".adaptive-learning", "skill-proposals.jsonl"),
    JSON.stringify({ id: "p-5", skillName: "show-skill", skillTitle: "Show Skill", description: "desc", instructions: "instr", examples: ["ex1"], status: "pending_review", evidence: { score: 5, llmConfidence: 0.9 } }) + "\n"
  );
  const result = showProposal(tmpDir, "p-5");
  assert.ok(result.text.includes("Show Skill"));
  assert.ok(result.text.includes("desc"));
  assert.ok(result.text.includes("instr"));
  assert.ok(result.text.includes("ex1"));
});

runTests();
