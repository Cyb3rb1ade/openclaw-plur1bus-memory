import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeAssociativeResults } from "../lib/memory-graph.js";

function makeMemory(id, score = 0.8) {
  return { entry: { id }, score };
}

describe("mergeAssociativeResults – H1-01 graph-only score cap", () => {
  it("caps graph-only score below the best vector score", () => {
    const originals = [makeMemory("v1", 0.95), makeMemory("v2", 0.70)];
    const associative = [
      { memoryId: "g1", associatedScore: 0.99, depth: 1, path: ["v1", "g1"] },
    ];
    const merged = mergeAssociativeResults(originals, associative, 10);
    const graphItem = merged.find(r => r.entry?.id === "g1");
    assert.ok(graphItem, "graph item must be present");
    assert.ok(graphItem.score <= 0.95 * 0.85 + 1e-9, `expected <= ${0.95 * 0.85}, got ${graphItem.score}`);
    assert.strictEqual(graphItem.source, "graph");
  });

  it("downscales graph-only scores when no vector results exist", () => {
    const originals = [];
    const associative = [
      { memoryId: "g1", associatedScore: 0.8, depth: 1, path: [] },
    ];
    const merged = mergeAssociativeResults(originals, associative, 10);
    const graphItem = merged.find(r => r.entry?.id === "g1");
    assert.ok(graphItem, "graph item must be present");
    assert.ok(graphItem.score < 0.8, "graph score must be downscaled when no vector anchor exists");
  });
});

describe("mergeAssociativeResults – H1-02 no artificial vector boost", () => {
  it("does not raise a vector score just because graph also found it", () => {
    const originals = [makeMemory("v1", 0.50)];
    const associative = [
      { memoryId: "v1", associatedScore: 0.95, depth: 1, path: ["seed", "v1"] },
    ];
    const merged = mergeAssociativeResults(originals, associative, 10);
    const item = merged.find(r => r.entry?.id === "v1");
    assert.ok(item, "item must be present");
    assert.strictEqual(item.score, 0.50, "vector score must stay unchanged");
    assert.strictEqual(item.source, "both");
  });
});
