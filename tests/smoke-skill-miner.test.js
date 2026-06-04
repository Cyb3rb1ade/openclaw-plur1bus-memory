import { describe, it } from "node:test";
import assert from "node:assert";
import { aggregateEvidence } from "../lib/jobs/skill-miner/evidence-aggregator.js";

describe("skill-miner evidence-aggregator", () => {
  it("clusters memories by keyword overlap", () => {
    const memories = [
      { id: "a", text: "User prefers dark mode in all applications", category: "user_preference", origin: "dm", retrievalCount: 1 },
      { id: "b", text: "User prefers dark theme in all applications", category: "user_preference", origin: "dm", retrievalCount: 2 },
      { id: "c", text: "The API returns JSON format by default", category: "fact", origin: "dm", retrievalCount: 0 },
    ];
    const groups = aggregateEvidence(memories);
    assert.strictEqual(groups.length, 2, "should form 2 groups");
    const darkModeGroup = groups.find(g => g.keywords.includes("dark"));
    assert.ok(darkModeGroup, "should have a dark-mode group");
    assert.strictEqual(darkModeGroup.memories.length, 2);
    assert.ok(darkModeGroup.score >= 3, "dark mode group should have score >= 3");
  });

  it("scores user_confirmation memories higher", () => {
    const memories = [
      { id: "a", text: "User confirmed they want weekly reports", category: "preference", origin: "user_confirmation", trustLevel: "validated", retrievalCount: 1 },
    ];
    const groups = aggregateEvidence(memories);
    assert.strictEqual(groups.length, 1);
    assert.ok(groups[0].score > 2, "validated user_confirmation should score high");
  });
});
