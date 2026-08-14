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

  it("scores corroborated and trusted evidence higher", () => {
    for (const epistemicStatus of ["corroborated", "trusted"]) {
      const groups = aggregateEvidence([{
        id: `memory-${epistemicStatus}`,
        text: "User wants weekly release verification reports",
        category: "preference",
        origin: "dm",
        epistemicStatus,
        retrievalCount: 1,
      }]);

      assert.strictEqual(groups.length, 1);
      assert.strictEqual(groups[0].score, 3, `${epistemicStatus} should receive the +2 trust bonus`);
    }
  });

  it("does not infer a trust bonus from NEO-only fields", () => {
    const groups = aggregateEvidence([{
      id: "legacy-neo-shape",
      text: "User wants weekly release verification reports",
      category: "preference",
      origin: "user_confirmation",
      trustLevel: "validated",
      epistemicStatus: "observed",
      retrievalCount: 1,
    }]);

    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].score, 1, "origin/trustLevel must not confer LanceDB trust");
  });
});

import { extractSkillFromEvidence } from "../lib/jobs/skill-miner/llm-extractor.js";

describe("skill-miner llm-extractor", () => {
  it("returns skip for low-confidence LLM response", async () => {
    const mockLlm = async () => JSON.stringify({ confidence: 0.3, skip: true });
    const group = {
      memories: [{ id: "a", text: "User likes coffee" }],
      keywords: ["coffee"],
      score: 1,
      topics: ["coffee"],
    };
    const result = await extractSkillFromEvidence(group, { callLlm: mockLlm, llmCfg: {} });
    assert.strictEqual(result.skip, true);
  });

  it("returns skill candidate for high-confidence response", async () => {
    const mockLlm = async () => JSON.stringify({
      skillName: "dark-mode-preference",
      skillTitle: "Dark Mode Preference",
      description: "User prefers dark mode in all apps",
      instructions: "Always offer dark mode when presenting UI options",
      examples: ["Enable dark mode by default"],
      confidence: 0.75,
      category: "preference",
    });
    const group = {
      memories: [
        { id: "a", text: "User prefers dark mode" },
        { id: "b", text: "User always enables dark mode" },
      ],
      keywords: ["dark", "mode", "prefers"],
      score: 5,
      topics: ["dark", "mode"],
    };
    const result = await extractSkillFromEvidence(group, { callLlm: mockLlm, llmCfg: {} });
    assert.strictEqual(result.skip, undefined);
    assert.strictEqual(result.skillName, "dark-mode-preference");
    assert.strictEqual(result.confidence, 0.75);
  });
});
