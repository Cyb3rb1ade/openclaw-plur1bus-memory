import { describe, it } from "node:test";
import assert from "node:assert";
import { computeMemoryImportance, AUTOMATIC_IMPORTANCE_MAX, capAutomaticImportance } from "../lib/memory-fact-quality.js";

describe("capAutomaticImportance", () => {
  it("caps automatic values at 0.94", () => {
    assert.strictEqual(capAutomaticImportance(0.99, false), 0.94);
  });

  it("caps at band boundary 0.95", () => {
    assert.strictEqual(capAutomaticImportance(0.95, false), 0.94);
  });

  it("lets explicit values through unchanged", () => {
    assert.strictEqual(capAutomaticImportance(0.99, true), 0.99);
  });

  it("does not touch values below the cap", () => {
    assert.strictEqual(capAutomaticImportance(0.5, false), 0.5);
  });
});

describe("automatic importance cap", () => {
  it("never exceeds 0.94 without an explicit value", () => {
    assert.strictEqual(AUTOMATIC_IMPORTANCE_MAX, 0.94);
    const texts = [
      "Merke dir: der Geburtstag der Nutzerin ist am 3. Maerz.",
      "Ab jetzt bitte immer kuerzer antworten.",
      "Korrektur: der Port ist nicht 8080, sondern 18789.",
    ];
    for (const text of texts) {
      const result = computeMemoryImportance({ text, category: "fact", origin: "dm" });
      assert.ok(result.importance <= AUTOMATIC_IMPORTANCE_MAX, `${text} -> ${result.importance}`);
    }
  });

  it("lets the agent through into the reserved band", () => {
    const result = computeMemoryImportance({
      text: "Der Zielbereich des Patienten liegt zwischen 80 und 100.",
      category: "fact",
      origin: "dm",
      explicitImportance: 0.97,
    });
    assert.strictEqual(result.importance, 0.97);
  });

  it("does not include cap fragment for explicit values", () => {
    const result = computeMemoryImportance({
      text: "Any text",
      category: "fact",
      origin: "dm",
      explicitImportance: 0.99,
    });
    assert.ok(!result.importanceReason.includes("automatic cap"), `reason should not mention cap: ${result.importanceReason}`);
  });
});
