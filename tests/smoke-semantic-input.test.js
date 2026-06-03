import { describe, it } from "node:test";
import assert from "node:assert";

import { normalizeCommandInput } from "../lib/semantic-input.js";

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
    assert.ok(result.error.includes("Datei/Vault-Note/Quelle"), "should suggest external source");
    assert.ok(!result.canonicalText);
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
    const summarizer = async () => { throw new Error("summarizer fail"); };
    const longText = "Hello world. ".repeat(500);
    const result = await normalizeCommandInput({ kind: "correction-old", text: longText, summarizer });
    assert.ok(!result.error, "should not error");
    assert.ok(result.canonicalText.length > 0, "should have fallback text");
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
