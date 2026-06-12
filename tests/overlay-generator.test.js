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

  it("does not call LLM when evidence threshold is not met", async () => {
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
    assert.strictEqual(called, false, "LLM must not be called for canonical memory");
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
});
