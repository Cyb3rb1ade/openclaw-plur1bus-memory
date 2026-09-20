import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { applyDynamicsDefaults, applyFlashbulbEncoding, FLASHBULB_HALF_LIFE_DAYS, FLASHBULB_THRESHOLD } from "../lib/memory-dynamics.js";

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

describe("Blitzlicht-Schwelle (Phase 3)", () => {
  it("steht auf 0,80 und wird als Vorgabe benutzt, nicht als Zahl im Aufruf", () => {
    assert.strictEqual(FLASHBULB_THRESHOLD, 0.80);
    const now = Date.now();
    // Genau an der Schwelle feuert es, knapp darunter nicht.
    assert.ok(applyFlashbulbEncoding({ emotionalIntensity: 0.9, importance: 0.7 }, now, undefined, 180));
    assert.strictEqual(applyFlashbulbEncoding({ emotionalIntensity: 0.9, importance: 0.69 }, now, undefined, 180), null);
    // Der Capture-Pfad nimmt dieselbe Konstante: 0,70 feuerte frueher, jetzt nicht mehr.
    const unter = applyDynamicsDefaults({ id: "u", category: "project", emotionalIntensity: 0.9, importance: 0.5 }, now, {}, { flashbulbEncodingEnabled: true });
    assert.notStrictEqual(unter.memoryClass, "flashbulb");
    const drueber = applyDynamicsDefaults({ id: "d", category: "project", emotionalIntensity: 0.9, importance: 0.7 }, now, {}, { flashbulbEncodingEnabled: true });
    assert.strictEqual(drueber.memoryClass, "flashbulb");
  });

  it("das Schema nennt Schwelle und Herkunft", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const text = manifest.configSchema.properties.memoryDynamics.properties.flashbulbEncoding.description;
    assert.match(text, /0,80/);
    assert.match(text, /Phase-3-Pilotlauf/);
    assert.match(text, /ausschließlich beim Erfassen/);
  });
});
