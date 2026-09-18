import { describe, it } from "node:test";
import assert from "node:assert";
import { computeMemoryImportance, AUTOMATIC_IMPORTANCE_MAX } from "../lib/memory-fact-quality.js";

describe("automatic importance cap", () => {
  it("never exceeds 0.94 without an explicit value", () => {
    assert.strictEqual(AUTOMATIC_IMPORTANCE_MAX, 0.94);
    const texts = [
      "Merke dir: Evas Geburtstag ist am 3. Maerz.",
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
      text: "Eriks Blutzucker-Zielbereich ist 80 bis 100.",
      category: "fact",
      origin: "dm",
      explicitImportance: 0.97,
    });
    assert.strictEqual(result.importance, 0.97);
  });
});
