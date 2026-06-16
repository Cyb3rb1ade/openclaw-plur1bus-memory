import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContradictionDetector } from "../lib/contradiction-detector.js";

describe("ContradictionDetector memory-text pairs", () => {
  it("detects contradiction between two memory texts when LLM says yes", async () => {
    let promptSeen = "";
    const detector = new ContradictionDetector({
      llm: async (messages) => {
        promptSeen = messages[messages.length - 1].content;
        return "yes";
      },
    });
    const a = { id: "m1", text: "We use Postgres." };
    const b = { id: "m2", text: "We use MySQL." };
    const result = await detector.detectMemoryTextContradiction(a, b);
    assert.strictEqual(result, true);
    assert.ok(promptSeen.includes("Postgres"));
    assert.ok(promptSeen.includes("MySQL"));
  });

  it("returns false when LLM says no", async () => {
    const detector = new ContradictionDetector({ llm: async () => "no" });
    const a = { id: "m1", text: "We use Postgres." };
    const b = { id: "m2", text: "We still use Postgres." };
    const result = await detector.detectMemoryTextContradiction(a, b);
    assert.strictEqual(result, false);
  });

  it("returns empty array for fewer than 2 memories", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const result = await detector.findMemoryTextContradictions([{ id: "m1", text: "x" }]);
    assert.deepStrictEqual(result, []);
  });

  it("limits pairwise checks to maxPairs", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const memories = [
      { id: "m1", text: "A." },
      { id: "m2", text: "B." },
      { id: "m3", text: "C." },
    ];
    const result = await detector.findMemoryTextContradictions(memories, { maxPairs: 1 });
    assert.strictEqual(result.length, 1);
  });

  it("emits records with memoryA, memoryB, descriptionA, descriptionB", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const memories = [
      { id: "m1", text: "Postgres." },
      { id: "m2", text: "MySQL." },
    ];
    const result = await detector.findMemoryTextContradictions(memories);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].memoryA, "m1");
    assert.strictEqual(result[0].memoryB, "m2");
    assert.strictEqual(result[0].descriptionA, "Postgres.");
    assert.strictEqual(result[0].descriptionB, "MySQL.");
  });

  it("returns false for same id", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const a = { id: "m1", text: "A." };
    const result = await detector.detectMemoryTextContradiction(a, a);
    assert.strictEqual(result, false);
  });

  it("returns false when missing text/summary", async () => {
    const detector = new ContradictionDetector({ llm: async () => "yes" });
    const a = { id: "m1" };
    const b = { id: "m2", text: "B." };
    const result = await detector.detectMemoryTextContradiction(a, b);
    assert.strictEqual(result, false);
  });
});
