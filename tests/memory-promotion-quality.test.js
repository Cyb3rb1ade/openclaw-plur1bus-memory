import { describe, it } from "node:test";
import assert from "node:assert";
import { shouldPromoteMemory, computeMemoryImportance } from "../lib/memory-fact-quality.js";

describe("memory promotion quality guard", () => {
  it("shouldPromoteMemory blocks trivial filler", () => {
    const imp = computeMemoryImportance({ text: "ok", category: "conversation" });
    assert.strictEqual(shouldPromoteMemory("conversation", imp.importance, imp.factQuality), false);
  });

  it("shouldPromoteMemory blocks temporary status", () => {
    const imp = computeMemoryImportance({ text: "Today npm test passed", category: "conversation" });
    assert.strictEqual(shouldPromoteMemory("conversation", imp.importance, imp.factQuality), false);
  });

  it("shouldPromoteMemory allows explicit durable instruction in decision category", () => {
    const imp = computeMemoryImportance({ text: "Remember this: deploy only on Tuesdays", category: "decision" });
    assert.strictEqual(shouldPromoteMemory("decision", imp.importance, imp.factQuality), true);
  });

  it("shouldPromoteMemory allows correction", () => {
    const imp = computeMemoryImportance({ text: "Dreamdale is a festival, not a city", category: "decision" });
    assert.strictEqual(shouldPromoteMemory("decision", imp.importance, imp.factQuality), true);
  });

  it("shouldPromoteMemory allows concrete security fact", () => {
    const imp = computeMemoryImportance({ text: "Auth bypass in group chats was fixed", category: "decision" });
    assert.strictEqual(shouldPromoteMemory("decision", imp.importance, imp.factQuality), true);
  });

  it("shouldPromoteMemory blocks non-decision/fact categories", () => {
    const imp = computeMemoryImportance({ text: "User prefers concise answers", category: "preference" });
    assert.strictEqual(shouldPromoteMemory("preference", 0.95, imp.factQuality), false);
  });

  it("shouldPromoteMemory blocks low importance even in decision category", () => {
    const imp = computeMemoryImportance({ text: "Maybe we could decide later", category: "decision" });
    assert.strictEqual(shouldPromoteMemory("decision", imp.importance, imp.factQuality), false);
  });

  it("filler does not become a strong memory via computeMemoryImportance", () => {
    const imp = computeMemoryImportance({ text: "go on!!!!" });
    assert.ok(imp.importance <= 0.25, `got ${imp.importance}`);
    assert.strictEqual(imp.factQuality.shouldDownrank, true);
  });

  it("temporary status does not become a strong memory", () => {
    const imp = computeMemoryImportance({ text: "currently downloading the update" });
    assert.ok(imp.importance <= 0.5, `got ${imp.importance}`);
    assert.strictEqual(imp.factQuality.shouldPromote, false);
  });

  it("explicit durable instruction promotes and explains", () => {
    const imp = computeMemoryImportance({ text: "From now on, use German for repo prompts" });
    assert.ok(imp.importance >= 0.7, `got ${imp.importance}`);
    assert.strictEqual(imp.factQuality.shouldPromote, true);
    assert.ok(imp.importanceReason.includes("explicit instruction"), `reason: ${imp.importanceReason}`);
  });

  it("correction promotes with explanation", () => {
    const imp = computeMemoryImportance({ text: "Dreamdale is a festival, not a city" });
    assert.ok(imp.importance >= 0.7, `got ${imp.importance}`);
    assert.strictEqual(imp.factQuality.shouldPromote, true);
    assert.ok(
      imp.importanceReason.includes("correction") || imp.importanceReason.includes("contradiction"),
      `reason: ${imp.importanceReason}`
    );
  });
});
