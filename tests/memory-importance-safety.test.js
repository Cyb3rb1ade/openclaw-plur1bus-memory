import { describe, it } from "node:test";
import assert from "node:assert";
import { computeMemoryImportance } from "../lib/memory-fact-quality.js";

describe("memory importance safety", () => {
  it("returns a structured result", () => {
    const result = computeMemoryImportance({ text: "User prefers concise answers" });
    assert.strictEqual(typeof result.importance, "number");
    assert.ok(result.importance >= 0 && result.importance <= 1);
    assert.ok(typeof result.importanceReason === "string" && result.importanceReason.length > 0);
    assert.strictEqual(typeof result.factQuality, "object");
  });

  it("trivial filler is low importance", () => {
    for (const text of ["ok", "yes", "go on!!!!", "weiter"]) {
      const result = computeMemoryImportance({ text });
      assert.ok(result.importance <= 0.25, `${text} should be low, got ${result.importance}`);
    }
  });

  it("temporary status is low importance without explicit remember", () => {
    for (const text of ["Today npm test passed", "currently downloading the update", "test run finished"]) {
      const result = computeMemoryImportance({ text });
      assert.ok(result.importance <= 0.5, `${text} should be low/medium, got ${result.importance}`);
    }
  });

  it("durable preference is medium/high", () => {
    const result = computeMemoryImportance({ text: "User prefers concise answers" });
    assert.ok(result.importance >= 0.55, `got ${result.importance}`);
  });

  it("project architecture is medium/high", () => {
    const result = computeMemoryImportance({ text: "Deployment läuft auf Node 22" });
    assert.ok(result.importance >= 0.65, `got ${result.importance}`);
  });

  it("security/deploy concrete fact is high", () => {
    const result = computeMemoryImportance({ text: "Auth bypass in group chats was fixed" });
    assert.ok(result.importance >= 0.7, `got ${result.importance}`);
  });

  it("emotion-only text is not high importance", () => {
    const result = computeMemoryImportance({ text: "I am so angry and frustrated" });
    assert.ok(result.importance < 0.7, `got ${result.importance}`);
  });

  it("explicit remember instruction is high", () => {
    const result = computeMemoryImportance({ text: "From now on, use German for repo prompts" });
    assert.ok(result.importance >= 0.7, `got ${result.importance}`);
  });

  it("correction/superseding update is high enough", () => {
    const result = computeMemoryImportance({ text: "Dreamdale is a festival, not a city" });
    assert.ok(result.importance >= 0.7, `got ${result.importance}`);
  });

  it("preserves explicit caller importance when it is higher than computed floor", () => {
    const result = computeMemoryImportance({ text: "User prefers concise answers", explicitImportance: 0.95 });
    assert.strictEqual(result.importance, 0.95);
  });

  it("clamps out-of-range explicit importance", () => {
    assert.strictEqual(computeMemoryImportance({ text: "A fact", explicitImportance: 1.5 }).importance, 1);
    assert.strictEqual(computeMemoryImportance({ text: "A fact", explicitImportance: -0.3 }).importance, 0);
  });

  it("does not let generic technical words alone create high importance", () => {
    const result = computeMemoryImportance({ text: "node react postgres" });
    assert.ok(result.importance < 0.65, `got ${result.importance}`);
  });
});
