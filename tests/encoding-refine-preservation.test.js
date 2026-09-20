import assert from "node:assert/strict";
import test from "node:test";
import { buildRefinePatch } from "../lib/encoding-llm.js";
import { computeDecayedStrength, isCoreMemory } from "../lib/memory-dynamics.js";

const DAY = 86_400_000;
const judgment = { ok: true, importance: 0.2, emotion: { emotionalIntensity: 0, emotionalDominant: "neutral" } };

test("ordinary refinement does not reset unaccounted elapsed decay", () => {
  const row = { importance: 0.5, halfLifeDays: 30, memoryStrength: 0.8, lastDynamicsAt: DAY };
  const now = 31 * DAY;
  const updated = { ...row, ...buildRefinePatch(row, judgment, now) };
  assert.equal(computeDecayedStrength(updated, now), 0.4);
});

test("opt-in flashbulb refinement preserves explicit agent core classification", () => {
  const row = { importance: 0.97, memoryClass: "core", halfLifeDays: 36500, memoryStrength: 1,
    coreMemoryReason: "manual_importance_marker", lastStrengthenedAt: DAY };
  const encoding = { ok: true, importance: 0.8, emotion: { emotionalIntensity: 0.9 } };
  const patch = buildRefinePatch(row, encoding, 2 * DAY, { flashbulbEncodingEnabled: true });
  const updated = { ...row, ...patch };
  assert.equal(updated.memoryClass, "core");
  assert.equal(isCoreMemory(updated), true);
  assert.equal(updated.lastStrengthenedAt, DAY);
  assert.equal(updated.importanceStatus, "final");
});
