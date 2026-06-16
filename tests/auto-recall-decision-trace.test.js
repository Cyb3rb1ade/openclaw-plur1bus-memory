// tests/auto-recall-decision-trace.test.js
//
// Decision-trace coverage for Conversation Reactivation Recall (CRR).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runConversationReactivationRecall,
} from "../lib/conversation-reactivation-recall.js";
import {
  createRecallDecisionTrace,
} from "../lib/recall-decision-trace.js";

describe("auto-recall-decision-trace", () => {
  const baseCfg = {
    enabled: true,
    idleThresholdMinutes: 45,
    cooldownMinutes: 30,
    maxReactivationMemories: 3,
    maxFadedReactivationMemories: 1,
    maxOpenThreads: 3,
    maxCommunities: 3,
    timeoutMs: 50,
    visibleHints: false,
  };

  function makeLensDir(memories, communities) {
    const dir = mkdtempSync(join(tmpdir(), "crr-trace-"));
    mkdirSync(join(dir, ".plur1bus"), { recursive: true });
    writeFileSync(
      join(dir, ".plur1bus", "semantic-lens-index.json"),
      JSON.stringify({ communities, memories, entries: {} }),
      "utf8"
    );
    return dir;
  }

  function makeArgs(overrides = {}) {
    return {
      prompt: "continue dashboard architecture",
      messageText: "continue dashboard architecture",
      baseRecallIds: new Set(),
      baseRecallTopScore: 0.1,
      workspaceDir: null,
      neoStore: null,
      graphEdges: [],
      cfg: baseCfg,
      agentId: `trace-agent-${Math.random()}`,
      sessionKey: `trace-session-${Math.random()}`,
      now: Date.now(),
      logger: { warn: () => {}, debug: () => {} },
      ...overrides,
    };
  }

  it("reactivation memory gets source=reactivation in trace", async () => {
    const trace = createRecallDecisionTrace({ query: "continue dashboard architecture" });
    const workspaceDir = makeLensDir(
      [{ id: "m1", category: "project", display: "dashboard architecture plan" }],
      [{ id: "c1", representativeMemoryIds: ["m1"] }]
    );

    const result = await runConversationReactivationRecall(makeArgs({ workspaceDir, decisionTrace: trace }));

    assert.ok(result.trace, "result.trace should be present");
    assert.strictEqual(result.additions.length, 1);
    assert.strictEqual(result.additions[0].id, "m1");

    const candidate = result.trace.candidates.find((c) => c.id === "m1");
    assert.ok(candidate, "selected memory should appear as a candidate");
    assert.strictEqual(candidate.source, "reactivation");

    const decision = result.trace.decisions.find((d) => d.memoryId === "m1" && d.action === "inclusion");
    assert.ok(decision, "selected memory should have an inclusion decision");
    assert.strictEqual(decision.scoreBreakdown?.source, "reactivation");
    assert.strictEqual(decision.scoreBreakdown?.evidence, "derived");
  });

  it("rejected reactivation candidates have reasons", async () => {
    const trace = createRecallDecisionTrace({ query: "continue dashboard architecture" });
    const workspaceDir = makeLensDir(
      [
        { id: "m1", category: "project", display: "dashboard architecture plan" },
        { id: "m2", category: "project", display: "unrelated topic content" },
      ],
      [{ id: "c1", representativeMemoryIds: ["m1", "m2"] }]
    );

    const result = await runConversationReactivationRecall(makeArgs({ workspaceDir, decisionTrace: trace }));

    assert.ok(result.trace, "result.trace should be present");
    assert.strictEqual(result.additions.length, 1);
    assert.strictEqual(result.additions[0].id, "m1");

    const rejection = result.trace.decisions.find((d) => d.memoryId === "m2" && d.action === "rejection");
    assert.ok(rejection, "non-overlapping candidate should have a rejection decision");
    assert.ok(
      rejection.reason.toLowerCase().includes("token overlap") || rejection.reason.toLowerCase().includes("overlap"),
      `expected overlap rejection reason, got: ${rejection.reason}`
    );
  });

  it("final returned trace object is populated", async () => {
    const trace = createRecallDecisionTrace({ query: "continue dashboard architecture" });
    const workspaceDir = makeLensDir(
      [
        { id: "m1", category: "project", display: "dashboard architecture plan" },
      ],
      [{ id: "c1", representativeMemoryIds: ["m1"] }]
    );

    const result = await runConversationReactivationRecall(makeArgs({ workspaceDir, decisionTrace: trace }));

    assert.ok(result.trace, "result.trace should be present");
    assert.ok(Array.isArray(result.trace.candidates));
    assert.ok(result.trace.candidates.length > 0, "trace should contain candidates");
    assert.ok(result.trace.decisions.length > 0, "trace should contain decisions");
    assert.ok(result.trace.guards.length > 0, "trace should contain the reactivation-trigger guard");
    assert.strictEqual(result.trace.summary.included, 1);
    assert.ok(result.trace.summary.totalCandidates >= 1);
  });
});
