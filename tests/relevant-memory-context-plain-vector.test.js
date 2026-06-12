// tests/relevant-memory-context-plain-vector.test.js
//
// Formatter-level regression test: a plain vector-sourced memory must not
// acquire continuity artifacts (depth attributes, memory-continuity blocks,
// or interpretation-overlay tags) when formatted by itself.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

describe("formatRelevantMemoriesContext — plain vector memory", () => {
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
