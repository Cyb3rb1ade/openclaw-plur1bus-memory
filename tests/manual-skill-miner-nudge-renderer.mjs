/**
 * Manual tests for nudge-renderer
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderSkillProposalNudge } from "../lib/jobs/skill-miner/nudge-renderer.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

test("renders English nudge by default", () => {
  const text = renderSkillProposalNudge(
    { description: "User prefers dark mode", skillTitle: "Dark Mode" },
    1,
    { messages: [] }
  );
  assert.ok(text.includes("dark mode"));
  assert.ok(text.includes("/plur1bus skills review"));
});

test("renders German nudge when German messages detected", () => {
  const text = renderSkillProposalNudge(
    { description: "User mag dunkle Modi", skillTitle: "Dunkler Modus" },
    1,
    { messages: [{ role: "user", content: "Hallo, wie geht es dir?" }] }
  );
  assert.ok(text.includes("dunkle Modi") || text.includes("Dunkler Modus"));
  assert.ok(text.includes("/plur1bus skills review"));
});

test("shows 'and X more' when multiple proposals", () => {
  const text = renderSkillProposalNudge(
    { description: "Pattern A", skillTitle: "Skill A" },
    3,
    { messages: [] }
  );
  assert.ok(text.includes("and 2 more") || text.includes("und 2 weitere"));
});

test("reads SOUL.MD tone when available", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "soul-"));
  writeFileSync(join(tmpDir, "SOUL.MD"), "# Agent\n\nTone: casual and friendly\n\nBe relaxed.");
  const text = renderSkillProposalNudge(
    { description: "Pattern", skillTitle: "Skill" },
    1,
    { workspaceDir: tmpDir, messages: [] }
  );
  assert.ok(text.includes("Want me to turn") || text.includes("Want me to"));
  rmSync(tmpDir, { recursive: true, force: true });
});

test("reads IDENTITY.md as fallback", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "id-"));
  writeFileSync(join(tmpDir, "IDENTITY.md"), "# Identity\n\nVoice: formal\n\nBe professional.");
  const text = renderSkillProposalNudge(
    { description: "Pattern", skillTitle: "Skill" },
    1,
    { workspaceDir: tmpDir, messages: [] }
  );
  assert.ok(text.includes("Shall this be converted") || text.includes("Soll dies in einen"));
  rmSync(tmpDir, { recursive: true, force: true });
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
