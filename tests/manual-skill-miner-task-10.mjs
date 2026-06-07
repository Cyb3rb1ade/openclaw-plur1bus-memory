/**
 * Manual test runner for skill-miner weekly notification (Task 10)
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getPendingProposals,
  recordPresentation,
  lastPresentationAgeMs,
} from "../lib/jobs/skill-miner/proposal-writer.js";

function setup() {
  const tmpDir = mkdtempSync(join(tmpdir(), "sm-note-"));
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

test("getPendingProposals returns only pending_review items", async (tmpDir) => {
  const fs = await import("node:fs");
  fs.writeFileSync(
    join(tmpDir, ".adaptive-learning", "skill-proposals.jsonl"),
    JSON.stringify({ id: "p1", skillName: "a", status: "pending_review" }) + "\n" +
    JSON.stringify({ id: "p2", skillName: "b", status: "active" }) + "\n" +
    JSON.stringify({ id: "p3", skillName: "c", status: "pending_review" }) + "\n"
  );
  const pending = getPendingProposals(tmpDir);
  assert.strictEqual(pending.length, 2);
  assert.ok(pending.some(p => p.id === "p1"));
  assert.ok(pending.some(p => p.id === "p3"));
});

test("lastPresentationAgeMs is Infinity when no presentation recorded", async (tmpDir) => {
  assert.strictEqual(lastPresentationAgeMs(tmpDir), Infinity);
});

test("recordPresentation writes presented IDs and lastPresentationAgeMs is small", async (tmpDir) => {
  recordPresentation(tmpDir, ["p1", "p2"]);
  const age = lastPresentationAgeMs(tmpDir);
  assert.ok(age < 1000, `age should be < 1000ms but was ${age}`);

  const path = join(tmpDir, ".adaptive-learning", "skill-proposals-presented.jsonl");
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.strictEqual(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.ok(entry.presentedAt);
  assert.deepStrictEqual(entry.proposalIds, ["p1", "p2"]);
});

test("multiple presentations are tracked", async (tmpDir) => {
  recordPresentation(tmpDir, ["p1"]);
  await new Promise(r => setTimeout(r, 50));
  recordPresentation(tmpDir, ["p2"]);
  const age = lastPresentationAgeMs(tmpDir);
  assert.ok(age < 100, `age should be < 100ms but was ${age}`);
});

runTests();
