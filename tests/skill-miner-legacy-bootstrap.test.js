import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemories, runSkillMiner } from "../lib/jobs/skill-miner.js";
import { ensureEpistemicCutoff, readEpistemicCutoff } from "../lib/epistemic-cutoff.js";

const DAY = 86_400_000;
const NOW = 1_787_000_000_000;

function mockDb(rows) {
  return {
    init: async () => {},
    table: {
      async schema() {
        return {
          fields: ["id", "text", "status", "category", "createdAt", "epistemicStatus", "sourceMessageRole", "scope"]
            .map((name) => ({ name })),
        };
      },
      query() {
        return {
          where() { return this; },
          limit() { return this; },
          offset() { return this; },
          toArray: async () => rows,
        };
      },
    },
  };
}

function legacyRow(id, daysAgo, extra = {}) {
  return {
    id,
    text: "Always verify weekly releases with the same deployment checklist before shipping",
    category: "workspace_rule",
    status: "active",
    epistemicStatus: "",
    sourceMessageRole: extra.sourceMessageRole ?? "",
    createdAt: NOW - daysAgo * DAY,
    scope: "agent-private",
    agentId: "agent-1",
    storedBy: "agent-1",
    ...extra,
  };
}

describe("skill-miner first-upgrade legacy bootstrap", () => {
  it("admits pre-cutoff empty skill rows older than the recency lookback", async () => {
    const since = NOW;
    const db = mockDb([
      legacyRow("old-legacy", 90),
      legacyRow("fresh-untrusted", 2, { epistemicStatus: "untrusted", sourceMessageRole: "user" }),
    ]);
    const memories = await loadMemories(db, 7, {
      admission: { cutoff: since, legacyOpen: true },
      now: NOW,
    });
    const ids = memories.map((row) => row.id);
    assert.ok(ids.includes("old-legacy"), `expected old legacy, got ${ids.join(",")}`);
    assert.ok(!ids.includes("fresh-untrusted"));
  });

  it("creates the cutoff on first miner run and then admits existing empty rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "miner-boot-"));
    const baseDbPath = join(root, "lancedb-namespaced");
    mkdirSync(baseDbPath, { recursive: true });
    const workspaceDir = mkdtempSync(join(tmpdir(), "miner-boot-ws-"));
    assert.equal(readEpistemicCutoff(baseDbPath).ok, false);
    const db = mockDb([legacyRow("old-legacy", 90)]);
    let llmCalls = 0;
    const result = await runSkillMiner(db, "agent-1", {
      workspaceDir,
      workspaceKey: "ws-1",
      baseDbPath,
      now: NOW,
      dryRun: true,
      callLlm: async () => {
        llmCalls += 1;
        return JSON.stringify({
          skillName: "verify-weekly-releases",
          skillTitle: "Verify Weekly Releases",
          description: "Use the checklist.",
          instructions: "Run the checklist.",
          examples: ["verify"],
          confidence: 0.9,
          category: "workflow",
        });
      },
      llmCfg: { model: "m" },
    });
    const cutoff = readEpistemicCutoff(baseDbPath);
    assert.equal(cutoff.ok, true);
    assert.equal(cutoff.legacyOpen, true);
    assert.ok(result.scanned > 0, `scanned=${result.scanned}`);
    assert.ok(llmCalls > 0 || result.skippedLowEvidence > 0 || result.proposalsCreated > 0);
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
});
