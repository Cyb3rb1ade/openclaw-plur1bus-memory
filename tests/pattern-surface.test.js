// tests/pattern-surface.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePatternScore, findBestPattern, formatPatternBlock } from "../lib/pattern-surface.js";

describe("computePatternScore", () => {
  it("returns 0 for empty memberIds", () => {
    const pattern = { memberIds: [] };
    assert.strictEqual(computePatternScore(pattern, ["a", "b"], 0), 0);
  });

  it("returns 0 for empty candidateIds", () => {
    const pattern = { memberIds: ["a", "b"] };
    assert.strictEqual(computePatternScore(pattern, [], 0), 0);
  });

  it("returns 0 when overlap < 2", () => {
    const pattern = { memberIds: ["a", "b", "c"] };
    assert.strictEqual(computePatternScore(pattern, ["a"], 0), 0);
  });

  it("scores perfect overlap at confidence when recent", () => {
    const pattern = { memberIds: ["a", "b"], confidence: 0.9 };
    const score = computePatternScore(pattern, ["a", "b"], 0);
    assert.ok(score > 0.89 && score <= 0.91, `expected ~0.9, got ${score}`);
  });

  it("penalizes large patterns via smaller-set normalization", () => {
    const smallPattern = { memberIds: ["a", "b"], confidence: 1.0 };
    const largePattern = { memberIds: ["a", "b", "x", "y", "z"], confidence: 1.0 };
    const candidates = ["a", "b", "c", "d"];
    const smallScore = computePatternScore(smallPattern, candidates, 0);
    const largeScore = computePatternScore(largePattern, candidates, 0);
    assert.ok(smallScore > largeScore, `small pattern should score higher, got small=${smallScore}, large=${largeScore}`);
  });

  it("decays score with age", () => {
    const pattern = { memberIds: ["a", "b"], confidence: 1.0 };
    const recent = computePatternScore(pattern, ["a", "b"], 0);
    const old = computePatternScore(pattern, ["a", "b"], 24);
    assert.ok(old < recent, "older pattern should score lower");
  });

  it("does not boost future-dated patterns above the recent score", () => {
    const pattern = { memberIds: ["a", "b"], confidence: 1.0 };
    const recent = computePatternScore(pattern, ["a", "b"], 0);
    const future = computePatternScore(pattern, ["a", "b"], -12);
    assert.ok(future <= recent, `future pattern score must not exceed recent score: ${future} > ${recent}`);
  });
});

describe("findBestPattern — options object", () => {
  it("returns null when patternRecords is empty", async () => {
    const result = await findBestPattern({ recentMemoryIds: ["a", "b"], patternRecords: [] });
    assert.strictEqual(result, null);
  });

  it("returns null when no pattern has sufficient overlap", async () => {
    const pattern = { id: "p1", memberIds: ["x", "y"], confidence: 1.0 };
    const result = await findBestPattern({
      recentMemoryIds: ["a", "b"],
      patternRecords: [pattern],
    });
    assert.strictEqual(result, null);
  });

  it("returns best matching pattern with triggerIds", async () => {
    const p1 = { id: "p1", memberIds: ["a", "b", "c"], confidence: 0.5 };
    const p2 = { id: "p2", memberIds: ["a", "b"], confidence: 1.0 };
    const result = await findBestPattern({
      recentMemoryIds: ["a", "b"],
      patternRecords: [p1, p2],
    });
    assert.ok(result);
    assert.strictEqual(result.pattern.id, "p2");
    assert.deepStrictEqual(result.triggerIds, ["a", "b"]);
  });

  it("filters patterns below threshold", async () => {
    const pattern = { id: "p1", memberIds: ["a", "b", "c", "d"], confidence: 0.5 };
    const result = await findBestPattern({
      recentMemoryIds: ["a", "b"],
      patternRecords: [pattern],
      threshold: 0.9,
    });
    assert.strictEqual(result, null);
  });
});

describe("formatPatternBlock", () => {
  it("includes required humility phrase", () => {
    const pattern = { patternName: "Test pattern", description: "A test pattern" };
    const block = formatPatternBlock(pattern, ["a", "b"], 0.85);
    assert.ok(block.includes("may connect"));
    assert.ok(block.includes("partial"));
    assert.ok(block.includes("I've noticed"));
    assert.ok(block.includes("appeared across"));
  });

  it("includes pattern name and description", () => {
    const pattern = { patternName: "Naming", description: "Describing" };
    const block = formatPatternBlock(pattern, ["a"], 0.75);
    assert.ok(block.includes("Naming"));
    assert.ok(block.includes("Describing"));
  });

  it("emits valid XML with source and confidence", () => {
    const pattern = { patternName: "X" };
    const block = formatPatternBlock(pattern, ["m1", "m2"], 0.81);
    assert.ok(block.includes('source="rem-pattern"'));
    assert.ok(block.includes('confidence="0.81"'));
    assert.ok(block.includes('trigger-memory-ids="m1,m2"'));
  });

  it("sanitizes trigger ids in memory-continuity attribute", () => {
    const pattern = { patternName: "X" };
    const block = formatPatternBlock(pattern, ["m1", 'm2" data-x="y'], 0.81);
    assert.ok(!block.includes('trigger-memory-ids="m1,m2"'), "raw double quotes must not survive in attribute");
    assert.ok(!block.includes('data-x="y"'), "attribute injection must not survive");
    assert.ok(block.includes("m2_data-x_y"), "malicious id should be sanitized to underscore form");
  });
});
