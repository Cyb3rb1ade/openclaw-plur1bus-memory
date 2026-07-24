import { describe, it } from "node:test";
import assert from "node:assert";

import { normalizeCommandInput } from "../lib/semantic-input.js";
import {
  INPUT_LIMITS,
  validateCommandArgs,
  validateSemanticCommandArgs,
} from "../lib/input-limits.js";

describe("semantic-input", () => {
  it("passes short input through directly", async () => {
    const result = await normalizeCommandInput({ kind: "recall-query", text: "hello world" });
    assert.strictEqual(result.canonicalText, "hello world");
    assert.strictEqual(result.wasCompressed, false);
    assert.ok(!result.error);
  });

  it("compresses long input heuristically", async () => {
    const longText = "This is sentence one. " + "This is sentence two. ".repeat(500);
    const result = await normalizeCommandInput({ kind: "recall-query", text: longText });
    assert.ok(result.canonicalText.length < longText.length, "should be compressed");
    assert.strictEqual(result.wasCompressed, true);
    assert.ok(!result.error);
  });

  it("rejects input above hard payload limit", async () => {
    const hugeText = "x".repeat(110000);
    const result = await normalizeCommandInput({ kind: "recall-query", text: hugeText });
    assert.ok(result.error, "should return error");
    assert.ok(result.error.includes("file/vault note/source"), "should suggest external source");
    assert.ok(!result.canonicalText);
  });

  it("centralizes exact semantic and generic command boundaries", async () => {
    assert.strictEqual(INPUT_LIMITS.SEMANTIC_COMMAND_ARGS, 100_000);
    assert.strictEqual(validateSemanticCommandArgs("x".repeat(100_000)).ok, true);
    assert.strictEqual(validateSemanticCommandArgs("x".repeat(100_001)).ok, false);
    assert.strictEqual(validateCommandArgs("x".repeat(4_001)).ok, false);

    const exact = await normalizeCommandInput({ kind: "recall-query", text: "x".repeat(100_000) });
    const over = await normalizeCommandInput({ kind: "recall-query", text: "x".repeat(100_001) });
    assert.ok(!exact.error);
    assert.ok(
      exact.canonicalText.length <= INPUT_LIMITS.SEARCH_QUERY,
      `exact-limit fallback must stay within the direct-input budget, got ${exact.canonicalText.length}`,
    );
    assert.ok(over.error);
  });

  it("keeps representative head, middle, and tail evidence for punctuation-free input", async () => {
    const text = `HEAD ${"alpha ".repeat(8_000)}MIDDLE ${"beta ".repeat(9_600)}TAIL`;
    assert.ok(text.length <= INPUT_LIMITS.SEMANTIC_COMMAND_ARGS);

    const result = await normalizeCommandInput({ kind: "recall-query", text });

    assert.ok(!result.error);
    assert.ok(result.canonicalText.length <= INPUT_LIMITS.SEARCH_QUERY);
    assert.match(result.canonicalText, /HEAD/);
    assert.match(result.canonicalText, /MIDDLE/);
    assert.match(result.canonicalText, /TAIL/);
    assert.strictEqual(result.wasCompressed, true);
  });

  it("preserves semantic meaning in heuristic compression", async () => {
    const text = "Hello world. ".repeat(100) + "The unique key phrase is banana republic. " + "Goodbye world.".repeat(100);
    const result = await normalizeCommandInput({ kind: "recall-query", text: text });
    assert.ok(result.canonicalText.includes("banana republic") || result.canonicalText.includes("banana"), "key phrase should be preserved");
  });

  it("uses provided summarizer when available", async () => {
    const summarizer = async (text) => `SUMMARIZED:${text.slice(0, 20)}`;
    const longText = "a".repeat(7000);
    const result = await normalizeCommandInput({ kind: "forget-intent", text: longText, summarizer });
    assert.ok(result.canonicalText.startsWith("SUMMARIZED:"), "should use summarizer");
  });

  it("falls back to heuristic when summarizer fails", async () => {
    const warnings = [];
    const summarizer = async () => { throw new Error("Authorization Bearer TEST_SECRET"); };
    const longText = `HEAD ${"alpha ".repeat(8_000)}MIDDLE ${"beta ".repeat(9_600)}TAIL`;
    const result = await normalizeCommandInput({
      kind: "correction-new",
      text: longText,
      summarizer,
      maxDirectChars: INPUT_LIMITS.CORRECTION_TEXT,
      logger: { warn(message) { warnings.push(message); } },
    });
    assert.ok(!result.error, "should not error");
    assert.ok(result.canonicalText.length > 0, "should have fallback text");
    assert.ok(result.canonicalText.length <= INPUT_LIMITS.CORRECTION_TEXT);
    assert.match(result.canonicalText, /HEAD/);
    assert.match(result.canonicalText, /MIDDLE/);
    assert.match(result.canonicalText, /TAIL/);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /TEST_SECRET|Authorization|Bearer/);
  });

  it("bounds an oversized summarizer result to the requested direct-input budget", async () => {
    const source = `HEAD ${"alpha ".repeat(8_000)}MIDDLE ${"beta ".repeat(9_600)}TAIL`;
    const result = await normalizeCommandInput({
      kind: "correction-new",
      text: source,
      maxDirectChars: INPUT_LIMITS.CORRECTION_TEXT,
      summarizer: async () => source,
    });

    assert.ok(!result.error);
    assert.ok(result.canonicalText.length <= INPUT_LIMITS.CORRECTION_TEXT);
    assert.strictEqual(result.wasCompressed, true);
  });

  it("returns rawHash instead of raw text in logs", async () => {
    const result = await normalizeCommandInput({ kind: "recall-query", text: "test input" });
    assert.ok(result.rawHash, "should have rawHash");
    assert.strictEqual(result.rawHash.length, 16, "hash should be 16 chars");
  });

  it("handles empty input gracefully", async () => {
    const result = await normalizeCommandInput({ kind: "recall-query", text: "" });
    assert.ok(result.error, "should return error for empty input");
  });
});
