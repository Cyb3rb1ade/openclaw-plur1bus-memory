/**
 * test/meta-cognition.test.js — Tests für Meta-Cognition: Recall-Quality,
 * Coverage-Gaps, Threshold-Trigger.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeRecallMetrics,
  findCoverageGaps,
  shouldTriggerReflection,
} from "../lib/meta-cognition.js";
import { runReflectionJob } from "../lib/jobs/reflection-job.js";

describe("computeRecallMetrics", () => {
  it("berechnet Precision, Recall, F1 aus Feedback", () => {
    const feedback = [
      { feedback: "positive", query: "q1", memoryId: "m1" },
      { feedback: "positive", query: "q2", memoryId: "m2" },
      { feedback: "negative", query: "q3", memoryId: "m3" },
      { feedback: "neutral", query: "q4", memoryId: "m4" },
    ];
    const metrics = computeRecallMetrics(feedback);
    assert.strictEqual(metrics.precision, 0.67); // 2/3 (positive / (positive + negative))
    assert.strictEqual(metrics.recall, 0.5);     // 2/4 (positive / total)
    assert.ok(metrics.f1 > 0 && metrics.f1 <= 1);
    assert.strictEqual(metrics.total, 4);
  });

  it("gibt null zurück bei leerem Feedback", () => {
    assert.strictEqual(computeRecallMetrics([]), null);
  });

  it("Precision = 1.0 wenn kein negatives Feedback", () => {
    const feedback = [
      { feedback: "positive", query: "q1", memoryId: "m1" },
      { feedback: "positive", query: "q2", memoryId: "m2" },
    ];
    const metrics = computeRecallMetrics(feedback);
    assert.strictEqual(metrics.precision, 1.0);
  });
});

describe("findCoverageGaps", () => {
  it("findet Topics mit wenig Memories", () => {
    const memories = [
      { id: "m1", text: "API Design Pattern", topics: ["api", "design"], memoryStrength: 0.9 },
      { id: "m2", text: "API Rate Limiting", topics: ["api", "performance"], memoryStrength: 0.8 },
      { id: "m3", text: "Database Indexing", topics: ["database"], memoryStrength: 0.4 },
      { id: "m4", text: "React Hooks", topics: ["frontend"], memoryStrength: 0.3 },
    ];
    const gaps = findCoverageGaps(memories, { minMemories: 2, minStrength: 0.5 });
    assert.ok(gaps.length > 0, "Sollte Gaps finden");
    // "database" hat nur 1 Memory → Gap
    const dbGap = gaps.find((g) => g.topic === "database");
    assert.ok(dbGap, "Sollte database-Gap finden");
    assert.strictEqual(dbGap.memoryCount, 1);
  });

  it("findet Topics mit niedriger memoryStrength", () => {
    const memories = [
      { id: "m1", text: "API Design", topics: ["api"], memoryStrength: 0.9 },
      { id: "m2", text: "API Patterns", topics: ["api"], memoryStrength: 0.2 },
    ];
    const gaps = findCoverageGaps(memories, { minMemories: 1, minStrength: 0.6 });
    const apiGap = gaps.find((g) => g.topic === "api");
    assert.ok(apiGap, "Sollte api-Gap finden");
    assert.ok(apiGap.avgStrength < 0.6);
  });

  it("gibt leeres Array wenn keine Gaps", () => {
    const memories = [
      { id: "m1", text: "API Design", topics: ["api"], memoryStrength: 0.9 },
      { id: "m2", text: "API Patterns", topics: ["api"], memoryStrength: 0.8 },
    ];
    const gaps = findCoverageGaps(memories, { minMemories: 1, minStrength: 0.5 });
    assert.strictEqual(gaps.length, 0);
  });
});

describe("shouldTriggerReflection", () => {
  it("triggert wenn Session-Threshold erreicht", () => {
    assert.strictEqual(shouldTriggerReflection(50, 50, 0), true);
  });

  it("triggert nicht wenn unter Threshold", () => {
    assert.strictEqual(shouldTriggerReflection(49, 50, 0), false);
  });

  it("triggert wenn Zeit seit letztem Run > Intervall", () => {
    const weekAgo = Date.now() - 8 * 24 * 3600_000;
    assert.strictEqual(shouldTriggerReflection(0, 50, weekAgo, { intervalMs: 7 * 24 * 3600_000 }), true);
  });

  it("triggert nicht wenn Zeit seit letztem Run < Intervall", () => {
    const dayAgo = Date.now() - 1 * 24 * 3600_000;
    assert.strictEqual(shouldTriggerReflection(0, 50, dayAgo, { intervalMs: 7 * 24 * 3600_000 }), false);
  });
});

describe("runReflectionJob End-to-End", () => {
  it("aggregiert Feedback und findet Gaps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-meta-"));

    try {
      // Feedback-Log erstellen
      const feedbackLog = [
        { timestamp: Date.now(), query: "q1", memoryId: "m1", feedback: "positive", scoreComponents: {} },
        { timestamp: Date.now(), query: "q2", memoryId: "m2", feedback: "negative", scoreComponents: {} },
      ];
      const adaptiveDir = join(dir, ".adaptive-learning");
      mkdirSync(adaptiveDir, { recursive: true });
      writeFileSync(join(adaptiveDir, "feedback-log.jsonl"), feedbackLog.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const mockStore = {
        readTurns: (n) => [
          { id: "t1", sessionId: "s1", content: "API Design" },
          { id: "t2", sessionId: "s1", content: "API Patterns" },
        ],
        readRetrievalLedger: (n) => [
          { sessionId: "s1", memory: { id: "m1", text: "API Design", topics: ["api"], memoryStrength: 0.9 } },
          { sessionId: "s1", memory: { id: "m2", text: "React Hooks", topics: ["frontend"], memoryStrength: 0.3 } },
        ],
        hasCompletedRun: () => false,
        markRunCompleted: () => {},
        readBehaviorCards: () => [],
        appendBehaviorCards: () => {},
        appendCandidates: () => {},
        readMemories: () => [
          { id: "m1", text: "API Design", topics: ["api"], memoryStrength: 0.9 },
          { id: "m2", text: "React Hooks", topics: ["frontend"], memoryStrength: 0.3 },
        ],
      };

      const result = await runReflectionJob({
        store: mockStore,
        workspaceDir: dir,
        logger: { info: () => {}, warn: () => {} },
      });

      assert.strictEqual(result.ok, true);
      assert.ok(result.metrics, "Sollte Metriken haben");
      assert.strictEqual(result.metrics.total, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
