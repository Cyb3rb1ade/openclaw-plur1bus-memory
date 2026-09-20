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

  it("verlängert Halbwertszeiten auf die Blitzlicht-Dauer", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now(), 0.70, 600);
    assert.ok(result, "Flashbulb sollte greifen (Score >= 0.70)");
    assert.strictEqual(result.halfLifeDays, 3650);
  });

  it("hebt kurze Halbwertszeiten auf mindestens 3650 Tage", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now(), 0.70, 60);
    assert.strictEqual(result.halfLifeDays, 3650);
  });

  it("Rückwärtskompatibilität: ohne Basis wird 3650", () => {
    const result = applyFlashbulbEncoding(flashbulbRow, Date.now());
    assert.strictEqual(result.halfLifeDays, 3650);
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
    // Bewusst unterhalb der Flashbulb-Schwelle: Flashbulb hebt die
    // Halbwertszeit vertraglich auf mindestens 3650 an (nur verlängern, nie
    // verkürzen) und würde eine explizite 42 damit legitim überschreiben.
    const entry = { id: "x", category: "project", emotionalIntensity: 0.3, importance: 0.5, halfLifeDays: 42 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0 });
    assert.strictEqual(out.halfLifeDays, 42);
  });

  it("eine Flashbulb-Erinnerung hebt eine kürzere explizite Halbwertszeit an (Flag an)", () => {
    const entry = { id: "x", category: "project", emotionalIntensity: 0.9, importance: 0.5, halfLifeDays: 42 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0, flashbulbEncodingEnabled: true });
    assert.strictEqual(out.memoryClass, "flashbulb");
    assert.strictEqual(out.halfLifeDays, 3650);
  });

  it("Flashbulb-Memories erhalten die Blitzlicht-Halbwertszeit (Flag an)", () => {
    // Score: 0.9*0.5 + 0.9*0.5 = 0.90 >= 0.70 → Flashbulb.
    // Kein Core (emotionalIntensity 0.9 < 0.95). Basis: 600 × (1 + 0.9) = 1140,
    // aber Flashbulb-Encoding nutzt max(1140, 3650) = 3650.
    const entry = { id: "x", category: "project", emotionalIntensity: 0.9, importance: 0.9 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0, flashbulbEncodingEnabled: true });
    assert.strictEqual(out.memoryClass, "flashbulb");
    assert.strictEqual(out.halfLifeDays, 3650);
  });

  // R16 (Abschluss-Review, Critical 1): ohne das Flag — und das ist der
  // Deploy-Default — feuert Flashbulb weiterhin (wie vor diesem Branch),
  // hebt eine kurze explizite Halbwertszeit aber nur auf den historischen
  // 90-Tage-Boden an, nicht auf die Zehnjahres-Dauer. Fällt der Default
  // versehentlich auf "an" um, wird hier 3650 statt 90 gemessen und der Test
  // schlägt fehl.
  it("Flashbulb-Memories bekommen ohne das Flag weiterhin nur den 90-Tage-Boden", () => {
    const entry = { id: "x", category: "project", emotionalIntensity: 0.9, importance: 0.5, halfLifeDays: 42 };
    const out = applyDynamicsDefaults(entry, Date.now(), {}, { intensityHalfLifeFactor: 1.0 });
    assert.strictEqual(out.memoryClass, "flashbulb");
    assert.strictEqual(out.halfLifeDays, 90);
  });

  it("ohne opts bleibt das bisherige Verhalten (Faktor 1.0 Default, Intensität 0)", () => {
    const entry = { id: "x", category: "fact", importance: 0.5 };
    const out = applyDynamicsDefaults(entry, Date.now(), {});
    assert.strictEqual(out.halfLifeDays, 60);
  });
});
