// tests/continuity-engine-disabled.test.js
//
// Verifies that when the Inner Continuity Engine is disabled, the recall
// formatter path produces no continuity artifacts (depth attributes,
// memory-continuity blocks, or interpretation-overlay tags) for plain
// vector-sourced memories.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("continuity engine disabled behavior", () => {
  it("formats plain vector memories without continuity artifacts", () => {
    const ctx = formatRelevantMemoriesContext([
      { id: "m1", source: "dm", category: "fact", display: "Hello world", memoryStrength: 1.0 },
    ]);
    assert.ok(ctx.includes("<relevant-memories"));
    assert.ok(!ctx.includes("depth="));
    assert.ok(!ctx.includes("<memory-continuity>"));
    assert.ok(!ctx.includes("<interpretation-overlay>"));
  });
});
