import { describe, it } from "node:test";
import assert from "node:assert";
import { buildRefinePatch } from "../lib/encoding-llm.js";
import { IMPORTANCE_STATUS } from "../lib/importance-status.js";
import { FLASHBULB_HALF_LIFE_DAYS } from "../lib/memory-dynamics.js";

const now = Date.UTC(2026, 8, 19);

describe("refine patch", () => {
  it("writes importance, emotion, reason and both statuses", () => {
    const patch = buildRefinePatch({ id: "a", memoryStrength: 0.8, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "trust", emotionalIntensity: 0.3 }, reason: "Projektfakt" }, now);
    assert.strictEqual(patch.importance, 0.8);
    assert.strictEqual(patch.emotionalDominant, "trust");
    assert.strictEqual(patch.importanceStatus, IMPORTANCE_STATUS.FINAL);
    assert.strictEqual(patch.emotionStatus, "final");
    assert.match(patch.coreMemoryReason, /Projektfakt/);
    assert.strictEqual(patch.halfLifeDays, 600);
  });

  it("burns in an intense single event", () => {
    const patch = buildRefinePatch({ id: "b", memoryStrength: 0.9, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "fear", emotionalIntensity: 0.95 }, reason: "" }, now);
    assert.strictEqual(patch.halfLifeDays, FLASHBULB_HALF_LIFE_DAYS);
    assert.strictEqual(patch.memoryStrength, 0.95);
  });

  it("never lowers an existing strength", () => {
    const patch = buildRefinePatch({ id: "c", memoryStrength: 1.0, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "fear", emotionalIntensity: 0.95 }, reason: "" }, now);
    assert.strictEqual(patch.memoryStrength, 1.0);
  });

  it("returns null when the model failed", () => {
    assert.strictEqual(buildRefinePatch({ id: "d" }, { ok: false }, now), null);
  });

  it("never overwrites importance or halfLifeDays in the agent's own band", () => {
    const patch = buildRefinePatch(
      { id: "e", memoryStrength: 0.9, halfLifeDays: 36500, importance: 0.97, importanceStatus: "pending" },
      { ok: true, importance: 0.3, emotion: { emotionalDominant: "neutral", emotionalIntensity: 0.1 }, reason: "Kein Grund" },
      now,
    );
    assert.strictEqual("importance" in patch, false);
    assert.strictEqual("halfLifeDays" in patch, false);
    assert.strictEqual(patch.importanceStatus, IMPORTANCE_STATUS.FINAL);
    assert.strictEqual(patch.emotionStatus, "final");
  });

  it("still writes importance and halfLifeDays just below the agent band", () => {
    const patch = buildRefinePatch(
      { id: "f", memoryStrength: 0.9, halfLifeDays: 180, importance: 0.94, importanceStatus: "pending" },
      { ok: true, importance: 0.3, emotion: { emotionalDominant: "neutral", emotionalIntensity: 0.1 }, reason: "" },
      now,
    );
    assert.strictEqual(patch.importance, 0.3);
    assert.strictEqual(patch.halfLifeDays, 30);
  });
});
