import { describe, it } from "node:test";
import assert from "node:assert";
import { parseQuery } from "../lib/telegram-commands/memory-query.js";
import { explainResult, renderExplanation, explainResults } from "../lib/explainability.js";

describe("Explainability smoke", () => {
  it("parseQuery detects --explain flag", () => {
    const withFlag = parseQuery("Eva --explain");
    assert.strictEqual(withFlag.explain, true, "should detect --explain flag");
    assert.strictEqual(withFlag.topic, "Eva", "should strip flag from topic");

    const withoutFlag = parseQuery("Eva");
    assert.strictEqual(withoutFlag.explain, false, "should default to false");
  });

  it("explainResult returns breakdown with percentages", () => {
    const result = explainResult(
      { entry: { id: "test-1" }, score: 0.85 },
      "Test query",
      { vectorScore: 0.7, importanceBoost: 0.1, rerankScore: 0.05, temporalBoost: 0 }
    );
    assert.strictEqual(result.entryId, "test-1");
    assert.strictEqual(result.query, "Test query");
    assert.ok(result.breakdown, "should have breakdown");
    assert.ok(result.percentages, "should have percentages");
    assert.strictEqual(result.percentages.vectorSimilarity, 82); // 0.7 / 0.85 ≈ 82%
    assert.strictEqual(result.percentages.importanceBoost, 12); // 0.1 / 0.85 ≈ 12%
    assert.strictEqual(result.percentages.rerankScore, 6); // 0.05 / 0.85 ≈ 6%
  });

  it("renderExplanation produces human-readable text in German", () => {
    const explanation = explainResult(
      { entry: { id: "test-1" }, score: 0.9 },
      "Test",
      { vectorScore: 0.8, importanceBoost: 0.1, rerankScore: 0 }
    );
    const text = renderExplanation(explanation, "de");
    assert.ok(text.includes("Abgerufen wegen:"), "should have German header");
    assert.ok(text.includes("semantische Ähnlichkeit"), "should mention vector similarity");
    assert.ok(text.includes("Importance-Boost"), "should mention importance boost");
  });

  it("renderExplanation produces human-readable text in English", () => {
    const explanation = explainResult(
      { entry: { id: "test-1" }, score: 0.9 },
      "Test",
      { vectorScore: 0.8, importanceBoost: 0.1, rerankScore: 0 }
    );
    const text = renderExplanation(explanation, "en");
    assert.ok(text.includes("Retrieved because of:"), "should have English header");
    assert.ok(text.includes("semantic similarity"), "should mention semantic similarity");
  });

  it("explainResults handles empty array", () => {
    const results = explainResults([], "query");
    assert.deepStrictEqual(results, []);
  });

  it("explainResults maps over multiple items", () => {
    const results = explainResults(
      [
        { entry: { id: "a" }, score: 0.8 },
        { entry: { id: "b" }, score: 0.6 },
      ],
      "query"
    );
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].entryId, "a");
    assert.strictEqual(results[1].entryId, "b");
  });
});
