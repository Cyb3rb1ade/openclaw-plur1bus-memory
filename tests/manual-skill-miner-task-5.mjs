/**
 * Manual test runner for skill-miner orchestrator (Task 5)
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSkillMiner } from "../lib/jobs/skill-miner.js";

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), "sm-orch-"));
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

test("skips when workspaceDir is missing", async () => {
  const result = await runSkillMiner(null, "agent-1", {});
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, "missing_workspace_dir");
});

test("rate limits second run within 7 days", async (tmpDir) => {
  await runSkillMiner(null, "agent-1", {
    workspaceDir: tmpDir,
    workspaceKey: "ws-1",
    logger: { info: () => {}, warn: () => {} },
  });
  // Remove lock so rate limit is the next guard
  const lockPath = join(tmpDir, "locks", "skill-miner-agent-1.lock");
  if (existsSync(lockPath)) rmSync(lockPath);

  const result = await runSkillMiner(null, "agent-1", {
    workspaceDir: tmpDir,
    workspaceKey: "ws-1",
    logger: { info: () => {}, warn: () => {} },
  });
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, "rate_limited");
});

test("runs full pipeline and creates proposals", async (tmpDir) => {
  const mockDb = {
    init: async () => {},
    table: {
      query: () => ({
        limit: () => ({
          toArray: async () => [
            { id: "a", text: "User prefers dark mode in all applications", category: "preference", origin: "dm", retrievalCount: 1, status: "active", createdAt: Date.now() },
            { id: "b", text: "User prefers dark theme in all applications", category: "preference", origin: "dm", retrievalCount: 2, status: "active", createdAt: Date.now() },
          ],
        }),
      }),
    },
  };

  const mockLlm = async () => JSON.stringify({
    skillName: "dark-mode-preference",
    skillTitle: "Dark Mode Preference",
    description: "User prefers dark mode",
    instructions: "Offer dark mode",
    examples: ["Enable dark mode"],
    confidence: 0.75,
    category: "preference",
  });

  const result = await runSkillMiner(mockDb, "agent-1", {
    workspaceDir: tmpDir,
    workspaceKey: "ws-1",
    llmCfg: { model: "mock" },
    callLlm: mockLlm,
    logger: { info: () => {}, warn: () => {} },
    dryRun: true,
    minEvidenceScore: 2,
  });

  assert.strictEqual(result.skipped, undefined);
  assert.strictEqual(result.scanned, 2);
  assert.strictEqual(result.proposalsCreated, 1);
  assert.strictEqual(result.pushMessages.length, 1);
  assert.strictEqual(result.pushMessages[0].skillName, "dark-mode-preference");
});

test("respects maxPerRun", async (tmpDir) => {
  const mockDb = {
    init: async () => {},
    table: {
      query: () => ({
        limit: () => ({
          toArray: async () => [
            { id: "a", text: "User confirmed prefers darkmode everywhere", category: "preference", origin: "user_confirmation", trustLevel: "validated", retrievalCount: 1, status: "active", createdAt: Date.now() },
            { id: "b", text: "User confirmed likes lightmode everywhere", category: "preference", origin: "user_confirmation", trustLevel: "validated", retrievalCount: 1, status: "active", createdAt: Date.now() },
            { id: "c", text: "User confirmed uses vimeditor exclusively", category: "preference", origin: "user_confirmation", trustLevel: "validated", retrievalCount: 1, status: "active", createdAt: Date.now() },
            { id: "d", text: "User confirmed uses emacssystem exclusively", category: "preference", origin: "user_confirmation", trustLevel: "validated", retrievalCount: 1, status: "active", createdAt: Date.now() },
            { id: "e", text: "User confirmed uses vscodesystem exclusively", category: "preference", origin: "user_confirmation", trustLevel: "validated", retrievalCount: 1, status: "active", createdAt: Date.now() },
            { id: "f", text: "User confirmed uses neovimtool exclusively", category: "preference", origin: "user_confirmation", trustLevel: "validated", retrievalCount: 1, status: "active", createdAt: Date.now() },
          ],
        }),
      }),
    },
  };

  let callCount = 0;
  const mockLlm = async () => {
    callCount++;
    return JSON.stringify({
      skillName: `skill-${callCount}`,
      skillTitle: `Skill ${callCount}`,
      description: "desc",
      instructions: "instr",
      examples: [],
      confidence: 0.75,
      category: "preference",
    });
  };

  const result = await runSkillMiner(mockDb, "agent-1", {
    workspaceDir: tmpDir,
    workspaceKey: "ws-1",
    llmCfg: { model: "mock" },
    callLlm: mockLlm,
    logger: { info: () => {}, warn: () => {} },
    dryRun: true,
    maxPerRun: 2,
  });

  assert.strictEqual(result.proposalsCreated, 2);
});

runTests();
