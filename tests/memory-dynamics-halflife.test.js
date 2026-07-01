/**
 * tests/memory-dynamics-halflife.test.js — Emotionale Intensität moduliert
 * die Halbwertszeit: je intensiver, desto langsamer das Vergessen.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  modulateHalfLifeDays,
  applyFlashbulbEncoding,
  applyDynamicsDefaults,
} from "../lib/memory-dynamics.js";

describe("modulateHalfLifeDays", () => {
  it("verlängert die Halbwertszeit proportional zur Intensität", () => {
    assert.strictEqual(modulateHalfLifeDays(600, 0.8, 1.0), 1080);
  });

  it("lässt emotionslose Memories unverändert", () => {
    assert.strictEqual(modulateHalfLifeDays(60, 0, 1.0), 60);
  });

  it("clampt Intensität auf [0,1]", () => {
    assert.strictEqual(modulateHalfLifeDays(100, 5, 1.0), 200);
  });

  it("factor 0 deaktiviert die Modulation", () => {
    assert.strictEqual(modulateHalfLifeDays(600, 1.0, 0), 600);
  });

  it("gibt ungültige Basis unverändert zurück", () => {
    assert.strictEqual(modulateHalfLifeDays(undefined, 0.5, 1.0), undefined);
  });
});

describe("applyFlashbulbEncoding mit Basis-Halbwertszeit", () => {
  const flashbulbRow = { emotionalIntensity: 0.9, importance: 0.9, novelty: 0.5, userCorrection: 0 };

  it("verkürzt lange Halbwertszeiten nicht mehr", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now(), 0.70, 600);
    assert.ok(result, "Flashbulb sollte greifen (Score >= 0.70)");
    assert.strictEqual(result.halfLifeDays, 600);
  });

  it("hebt kurze Halbwertszeiten auf mindestens 90 Tage", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now(), 0.70, 60);
    assert.strictEqual(result.halfLifeDays, 90);
  });

  it("Rückwärtskompatibilität: ohne Basis bleibt 90", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now());
    assert.strictEqual(result.halfLifeDays, 90);
  });
});

describe("applyDynamicsDefaults mit Intensitäts-Modulation", () => {
  it("moduliert die Halbwertszeit neuer Memories mit der Intensität", () => {
    // project → Basis 600d; Intensität 0.5 × Faktor 1.0 → 900d.
    // Flashbulb-Score: 0.5*0.35 + 0.5*0.35 = 0.35 < 0.70 → Standard-Zweig.
    const entry = { id: "x", category: "project", emotionalIntensity: 0.5, importance: 0.5 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0 });
    assert.strictEqual(out.halfLifeDays, 900);
  });

  it("respektiert explizit gesetzte halfLifeDays", () => {
    const entry = { id: "x", category: "project", emotionalIntensity: 0.9, importance: 0.5, halfLifeDays: 42 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0 });
    assert.strictEqual(out.halfLifeDays, 42);
  });

  it("Flashbulb-Memories erben die modulierte Basis statt fixer 90 Tage", () => {
    // Score: 0.9*0.35 + 0.9*0.35 = 0.63 + novelty 0.5*0.15 = 0.705 >= 0.70 → Flashbulb.
    // Kein Core (emotionalIntensity 0.9 < 0.95). Basis: 600 × (1 + 0.9) = 1140.
    const entry = { id: "x", category: "project", emotionalIntensity: 0.9, importance: 0.9, novelty: 0.5 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0 });
    assert.strictEqual(out.memoryClass, "flashbulb");
    assert.strictEqual(out.halfLifeDays, 1140);
  });

  it("ohne opts bleibt das bisherige Verhalten (Faktor 1.0 Default, Intensität 0)", () => {
    const entry = { id: "x", category: "fact", importance: 0.5 };
    const out = applyDynamicsDefaults(entry, Date.now(), {});
    assert.strictEqual(out.halfLifeDays, 60);
  });
});
