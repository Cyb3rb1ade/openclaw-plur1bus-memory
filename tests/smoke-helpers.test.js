import { describe, it } from "node:test";
import assert from "node:assert";

import {
  computeDecayedStrength,
  applyRetrievalReinforcement,
  applyDailyDecay,
  applyDynamicsDefaults,
  isCoreMemory,
} from "../lib/memory-dynamics.js";

import {
  getMemoryHistory,
  getMemoryCurrentVersion,
} from "../lib/memory-history.js";

import {
  safeUuid,
  safeTimestamp,
} from "../lib/sql-safety.js";

import {
  inferEmotionalValence,
} from "../lib/emotion.js";

describe("memory-dynamics", () => {
  it("decays memory strength over time", () => {
    const row = { memoryStrength: 1.0, halfLifeDays: 30, createdAt: Date.now() - 86400000 };
    const strength = computeDecayedStrength(row);
    assert.ok(strength < 1.0, "strength should decay");
    assert.ok(strength >= 0.01, "strength should not go below min");
  });

  it("reinforces on retrieval", () => {
    const row = { memoryStrength: 0.5, createdAt: Date.now() };
    const result = applyRetrievalReinforcement(row);
    assert.ok(result.memoryStrength > 0.5, "strength should increase after retrieval");
    assert.strictEqual(result.retrievalCount, 1, "retrieval count should be 1");
  });

  it("core memory does not decay", () => {
    const row = { memoryClass: "core", memoryStrength: 0.5 };
    const strength = computeDecayedStrength(row);
    assert.strictEqual(strength, 1.0, "core memory should stay at 1.0");
  });

  it("daily decay reduces strength", () => {
    const row = { memoryStrength: 0.8, halfLifeDays: 30, createdAt: Date.now() - 86400000 };
    const result = applyDailyDecay(row);
    assert.ok(result.memoryStrength < 0.8, "daily decay should reduce strength");
  });

  it("applies replay column defaults for new entries", () => {
    const result = applyDynamicsDefaults({ category: "fact" }, 1234567890);
    assert.strictEqual(result.replayCount, 0, "default replayCount should be 0");
    assert.strictEqual(result.lastReplayed, 0, "default lastReplayed should be 0");
  });

  it("preserves replay columns for existing entries during decay", () => {
    const result = applyDynamicsDefaults({
      category: "fact",
      replayCount: 3,
      lastReplayed: 123,
      lastDynamicsAt: 100,
      memoryStrength: 0.9,
      halfLifeDays: 30,
    }, 200);

    assert.strictEqual(result.replayCount, 3, "existing replayCount should be preserved");
    assert.strictEqual(result.lastReplayed, 123, "existing lastReplayed should be preserved");
  });
});

describe("sql-safety", () => {
  it("safeUuid rejects injection", () => {
    assert.throws(() => safeUuid("'; DROP TABLE --"), /invalid/i);
    assert.throws(() => safeUuid("not-a-uuid"), /invalid/i);
  });

  it("safeUuid accepts valid uuid", () => {
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.strictEqual(safeUuid(validUuid), validUuid);
  });

  it("safeTimestamp rejects non-numeric", () => {
    assert.throws(() => safeTimestamp("not-a-number"), /invalid/i);
    assert.strictEqual(safeTimestamp(1234567890), 1234567890);
  });
});

describe("emotion", () => {
  it("infers emotion from text", () => {
    const result = inferEmotionalValence("I am very happy today!");
    assert.ok(typeof result.emotionalDominant === "string", "should have emotionalDominant");
    assert.ok(typeof result.emotionalIntensity === "number", "should have emotionalIntensity");
    assert.ok(typeof result.joy === "number", "should have joy score");
  });
});
