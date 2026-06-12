// tests/overlay-generator.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OverlayGenerator } from "../lib/overlay-generator.js";
import { InterpretationOverlayStore } from "../lib/interpretation-overlay.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("OverlayGenerator", () => {
  it("returns null when disabled", async () => {
    const generator = new OverlayGenerator({ enabled: false, llm: async () => "x" });
    const result = await generator.generate({ memory: { id: "m1", text: "x" }, conversationContext: "x" });
    assert.strictEqual(result, null);
  });

  it("does not call LLM for canonical or knowledge memory", async () => {
    let called = false;
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => { called = true; return "no shift"; },
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We chose Postgres.", category: "canonical", source: "knowledge" },
      conversationContext: "Since then we keep using Postgres.",
      relevanceScore: 0.95,
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, false, "LLM must not be called for canonical or knowledge memory");
  });

  it("does not call LLM when relevance score is below threshold", async () => {
    let called = false;
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => { called = true; return "no shift"; },
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We chose Postgres." },
      conversationContext: "Since then we keep using Postgres.",
      relevanceScore: 0.5,
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, false, "LLM must not be called when relevance score is below threshold");
  });

  it("returns null when LLM says 'no shift'", async () => {
    const generator = new OverlayGenerator({ enabled: true, llm: async () => "no shift" });
    const result = await generator.generate({
      memory: { id: "m1", text: "We chose Postgres." },
      conversationContext: "Since then, Postgres is now the default.",
      relevanceScore: 0.9,
      currentRegister: "neutral",
    });
    assert.strictEqual(result, null);
  });

  it("parses a valid meaning shift and marks it provisional", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({
        shiftType: "meaning",
        shiftDescription: "Postgres is now the default for new projects.",
        confidence: 0.85,
      }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We decided to use Postgres." },
      conversationContext: "Since then, Postgres is now the default for new projects.",
      relevanceScore: 0.9,
      currentRegister: "neutral",
    });
    assert.ok(result);
    assert.strictEqual(result.shiftType, "meaning");
    assert.strictEqual(result.status, "provisional");
    assert.strictEqual(result.targetMemoryId, "m1");
    assert.ok(Array.isArray(result.provenance.triggerMemoryIds));
  });

  it("drops generated overlays below confidenceThreshold", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      confidenceThreshold: 0.7,
      llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "x", confidence: 0.5 }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We decided to use Postgres." },
      conversationContext: "Since then, the meaning of this decision has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
  });

  it("enforces per-session rate limit", async () => {
    const sessionState = {};
    const generator = new OverlayGenerator({
      enabled: true,
      maxPerSession: 1,
      llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "x", confidence: 0.9 }),
    });
    const first = await generator.generate({
      memory: { id: "m1", text: "a" },
      conversationContext: "Since then, everything changed.",
      relevanceScore: 0.9,
      sessionState,
    });
    assert.ok(first);
    const second = await generator.generate({
      memory: { id: "m2", text: "b" },
      conversationContext: "Now this is unresolved.",
      relevanceScore: 0.9,
      sessionState,
    });
    assert.strictEqual(second, null);
  });

  it("enforces one overlay per target memory per session", async () => {
    const sessionState = {};
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "x", confidence: 0.9 }),
    });
    const first = await generator.generate({
      memory: { id: "m1", text: "a" },
      conversationContext: "Since then, everything changed.",
      relevanceScore: 0.9,
      sessionState,
    });
    assert.ok(first);
    const second = await generator.generate({
      memory: { id: "m1", text: "a" },
      conversationContext: "Now the meaning has shifted again.",
      relevanceScore: 0.9,
      sessionState,
    });
    assert.strictEqual(second, null);
  });

  it("prevents duplicate overlays via dedupe key", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plur1bus-test-"));
    const store = new InterpretationOverlayStore(tmpDir);
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "x", confidence: 0.9 }),
      overlayStore: store,
    });

    try {
      const sharedContext = "Since then, the meaning has shifted.";
      const first = await generator.generate({
        memory: { id: "m1", text: "a" },
        conversationContext: sharedContext,
        relevanceScore: 0.9,
      });
      assert.ok(first);
      await store.append(first);

      const second = await generator.generate({
        memory: { id: "m1", text: "a" },
        conversationContext: sharedContext,
        relevanceScore: 0.9,
      });
      assert.strictEqual(second, null, "duplicate overlay must be suppressed");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when LLM returns malformed JSON", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => "{not valid json",
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We decided to use Postgres." },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
  });

  it("returns null when LLM returns confidence out of range", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "x", confidence: 1.5 }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We decided to use Postgres." },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
  });

  it("returns null when LLM returns confidence NaN", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "x", confidence: NaN }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We decided to use Postgres." },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
  });

  it("returns null when LLM returns missing shiftDescription", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({ shiftType: "meaning", confidence: 0.9 }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We decided to use Postgres." },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
  });

  it("returns null when LLM returns empty shiftDescription", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({ shiftType: "meaning", shiftDescription: "", confidence: 0.9 }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We decided to use Postgres." },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
  });

  it("returns null when LLM returns invalid shiftType", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({ shiftType: "invalid-type", shiftDescription: "x", confidence: 0.9 }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We decided to use Postgres." },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
  });

  it("returns null for knowledge source memory", async () => {
    let called = false;
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => { called = true; return "no shift"; },
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We chose Postgres.", source: "knowledge" },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, false, "LLM must not be called for knowledge source memory");
  });

  it("returns null when memory lacks text and summary", async () => {
    let called = false;
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => { called = true; return "no shift"; },
    });
    const result = await generator.generate({
      memory: { id: "m1" },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, false, "LLM must not be called when memory lacks text and summary");
  });

  it("handles emotional mismatch signal", async () => {
    let called = false;
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => { called = true; return "no shift"; },
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "We lost a dear friend.", emotionalValence: { grief: 0.9 } },
      conversationContext: "Today we celebrate the launch.",
      currentRegister: "celebration",
      relevanceScore: 0.9,
    });
    assert.strictEqual(result, null);
    assert.strictEqual(called, true, "LLM should be reached when emotional mismatch signal is present");
  });

  it("propagates triggerMemoryIds to provenance.triggerMemoryIds", async () => {
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({
        shiftType: "meaning",
        shiftDescription: "x",
        confidence: 0.9,
      }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "a" },
      conversationContext: "Since then, the meaning has shifted.",
      relevanceScore: 0.9,
      triggerMemoryIds: ["m1", "m2", "m3"],
    });
    assert.ok(result);
    assert.deepStrictEqual(result.provenance.triggerMemoryIds, ["m1", "m2", "m3"]);
  });

  it("truncates shiftDescription and triggerContext", async () => {
    const longDescription = "x".repeat(600);
    const longContext = "Since then, " + "y".repeat(700);
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => JSON.stringify({
        shiftType: "meaning",
        shiftDescription: longDescription,
        confidence: 0.9,
      }),
    });
    const result = await generator.generate({
      memory: { id: "m1", text: "a" },
      conversationContext: longContext,
      relevanceScore: 0.9,
    });
    assert.ok(result);
    assert.strictEqual(result.shiftDescription.length, 400);
    assert.strictEqual(result.triggerContext.length, 500);
  });
});
