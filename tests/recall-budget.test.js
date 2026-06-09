/**
 * tests/recall-budget.test.js
 *
 * P2: Adaptive Recall Budget + Memory Tier Allocation
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolveRecallBudget,
  allocateMemoryTiers,
} from "../lib/recall-budget.js";

describe("resolveRecallBudget", () => {
  it("small prompt → budget 5–8", () => {
    const result = resolveRecallBudget({ promptLength: 30 });
    assert.ok(
      result.budget >= 5 && result.budget <= 8,
      `expected 5–8, got ${result.budget}`,
    );
    assert.strictEqual(result.reason, "small_prompt");
  });

  it("normal prompt → budget 8–12", () => {
    const result = resolveRecallBudget({ promptLength: 100 });
    assert.ok(
      result.budget >= 8 && result.budget <= 12,
      `expected 8–12, got ${result.budget}`,
    );
    assert.strictEqual(result.reason, "normal_prompt");
  });

  it("project signal → budget > 12", () => {
    const result = resolveRecallBudget({
      promptLength: 30,
      hasProjectSignals: true,
      tokenBudgetPct: 0.5,
    });
    assert.ok(result.budget > 12, `expected > 12, got ${result.budget}`);
    assert.strictEqual(result.reason, "project_signals");
  });

  it("maxPromptMemories wird nie überschritten wenn tokenBudgetPct klein", () => {
    const result = resolveRecallBudget({
      promptLength: 500,
      maxPromptMemories: 12,
      tokenBudgetPct: 0.3,
    });
    assert.ok(result.budget <= 12, `expected <= 12, got ${result.budget}`);
  });

  it("complex prompt darf expanded cap nutzen wenn tokenBudgetPct > 0.3", () => {
    const result = resolveRecallBudget({
      promptLength: 500,
      maxPromptMemories: 12,
      tokenBudgetPct: 0.5,
    });
    assert.ok(result.budget > 12, `expected > 12, got ${result.budget}`);
    assert.strictEqual(result.reason, "complex_prompt");
  });

  it("respektiert niedriges maxPromptMemories auch bei normal prompt", () => {
    const result = resolveRecallBudget({
      promptLength: 100,
      maxPromptMemories: 6,
      tokenBudgetPct: 0.3,
    });
    assert.ok(result.budget <= 6, `expected <= 6, got ${result.budget}`);
  });
});

describe("allocateMemoryTiers", () => {
  it("core wird bevorzugt", () => {
    const core = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const canonical = [{ id: 4 }, { id: 5 }];
    const result = allocateMemoryTiers({ core, canonical, budget: 4 });
    assert.strictEqual(result.tierCounts.core, 3);
    assert.strictEqual(result.tierCounts.canonical, 1);
    assert.strictEqual(result.tierCounts.project, 0);
    assert.deepStrictEqual(
      result.selected.map((m) => m.id),
      [1, 2, 3, 4],
    );
  });

  it("canonical wird bevorzugt nach core", () => {
    const core = [{ id: 1 }];
    const canonical = [{ id: 2 }, { id: 3 }];
    const project = [{ id: 4 }, { id: 5 }];
    const result = allocateMemoryTiers({
      core,
      canonical,
      project,
      budget: 3,
    });
    assert.strictEqual(result.tierCounts.core, 1);
    assert.strictEqual(result.tierCounts.canonical, 2);
    assert.strictEqual(result.tierCounts.project, 0);
  });

  it("associative darf nicht dominieren (max 30%)", () => {
    const core = [{ id: 1 }];
    const episodic = [
      { id: 2 },
      { id: 3 },
      { id: 4 },
      { id: 5 },
      { id: 6 },
      { id: 7 },
    ];
    const associative = [
      { id: 8 },
      { id: 9 },
      { id: 10 },
      { id: 11 },
      { id: 12 },
    ];
    const result = allocateMemoryTiers({
      core,
      episodic,
      associative,
      budget: 10,
    });
    assert.strictEqual(result.tierCounts.core, 1);
    assert.strictEqual(result.tierCounts.associative, 3); // 30% von 10
    assert.strictEqual(result.tierCounts.episodic, 6);
    assert.strictEqual(result.selected.length, 10);
  });

  it("respektiert budget genau", () => {
    const core = [{ id: 1 }];
    const canonical = [{ id: 2 }];
    const project = [{ id: 3 }];
    const episodic = [{ id: 4 }];
    const associative = [{ id: 5 }];
    const result = allocateMemoryTiers({
      core,
      canonical,
      project,
      episodic,
      associative,
      budget: 3,
    });
    assert.strictEqual(result.selected.length, 3);
    assert.strictEqual(result.tierCounts.core, 1);
    assert.strictEqual(result.tierCounts.canonical, 1);
    assert.strictEqual(result.tierCounts.project, 1);
    assert.strictEqual(result.tierCounts.episodic, 0);
    assert.strictEqual(result.tierCounts.associative, 0);
  });

  it("gibt leere arrays zurück wenn budget 0", () => {
    const core = [{ id: 1 }];
    const result = allocateMemoryTiers({ core, budget: 0 });
    assert.strictEqual(result.selected.length, 0);
    assert.strictEqual(result.tierCounts.core, 0);
  });

  it("associative cap gilt auch wenn wenig andere tiers vorhanden", () => {
    const core = [{ id: 1 }];
    const associative = [
      { id: 2 },
      { id: 3 },
      { id: 4 },
      { id: 5 },
      { id: 6 },
    ];
    const result = allocateMemoryTiers({
      core,
      associative,
      budget: 10,
    });
    assert.strictEqual(result.tierCounts.core, 1);
    assert.strictEqual(result.tierCounts.associative, 3); // 30% cap
    assert.strictEqual(result.selected.length, 4);
  });
});
