// tests/continuity-gate-association-score.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterAssociativeCandidates } from "../lib/continuity-gate.js";

describe("filterAssociativeCandidates — association score over memoryStrength", () => {
  it("blocks graph item with high memoryStrength but low relevanceScore", () => {
    const items = [
      { id: "g1", graphSource: "graph", memoryStrength: 1.0, relevanceScore: 0.5, depth: 1 },
    ];
    const result = filterAssociativeCandidates(items, {
      maxAssociations: 1,
      assocThreshold: 0.75,
      sessionState: {},
    });
    assert.deepStrictEqual(result, []);
  });

  it("allows graph item with low memoryStrength but high relevanceScore", () => {
    const items = [
      { id: "g1", graphSource: "graph", memoryStrength: 0.5, relevanceScore: 1.0, depth: 1 },
    ];
    const result = filterAssociativeCandidates(items, {
      maxAssociations: 1,
      assocThreshold: 0.75,
      sessionState: {},
    });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, "g1");
  });

  it("blocks graph item when all association scores are missing", () => {
    const items = [
      { id: "g1", graphSource: "graph", memoryStrength: 1.0, depth: 1 },
    ];
    const result = filterAssociativeCandidates(items, {
      maxAssociations: 1,
      assocThreshold: 0.75,
      sessionState: {},
    });
    assert.deepStrictEqual(result, []);
  });

  it("prefers relevanceScore over associatedScore over associationStrength", () => {
    const items = [
      { id: "g1", graphSource: "graph", memoryStrength: 0.1, relevanceScore: 0.9, associatedScore: 0.4, associationStrength: 0.3, depth: 1 },
      { id: "g2", graphSource: "graph", memoryStrength: 0.1, associatedScore: 0.9, associationStrength: 0.3, depth: 1 },
      { id: "g3", graphSource: "graph", memoryStrength: 0.1, associationStrength: 0.9, depth: 1 },
    ];
    const result = filterAssociativeCandidates(items, {
      maxAssociations: 3,
      assocThreshold: 0.75,
      sessionState: {},
    });
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].id, "g1");
    assert.strictEqual(result[1].id, "g2");
    assert.strictEqual(result[2].id, "g3");
  });
});
