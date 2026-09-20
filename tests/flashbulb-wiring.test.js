import { describe, it } from "node:test";
import assert from "node:assert";
import { applyFlashbulbEncoding, FLASHBULB_HALF_LIFE_DAYS } from "../lib/memory-dynamics.js";

describe("flashbulb encoding", () => {
  const now = Date.UTC(2026, 8, 19);

  it("burns in a single intense event for ten years", () => {
    const patch = applyFlashbulbEncoding({ emotionalIntensity: 0.9, importance: 0.8 }, now, 0.7, 180);
    assert.ok(patch, "expected a patch above the threshold");
    assert.strictEqual(patch.halfLifeDays, FLASHBULB_HALF_LIFE_DAYS);
    assert.strictEqual(patch.memoryStrength, 0.95);
  });

  it("never touches importance", () => {
    const patch = applyFlashbulbEncoding({ emotionalIntensity: 1.0, importance: 0.8 }, now, 0.7, 180);
    assert.strictEqual(Object.hasOwn(patch, "importance"), false);
  });

  it("stays silent below the threshold", () => {
    assert.strictEqual(applyFlashbulbEncoding({ emotionalIntensity: 0.2, importance: 0.5 }, now, 0.7, 180), null);
  });

  it("never shortens an existing longer half-life", () => {
    const patch = applyFlashbulbEncoding({ emotionalIntensity: 0.9, importance: 0.8 }, now, 0.7, 36500);
    assert.strictEqual(patch.halfLifeDays, 36500);
  });
});
