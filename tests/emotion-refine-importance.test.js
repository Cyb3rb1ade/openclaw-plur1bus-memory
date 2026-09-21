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
    // Koordinator-Korrektur zum Abschluss-Review, Important 5b:
    // updateSource/updateEvidence sind der Rollback-Kanal des
    // Phase-2-Backfills (importance-v2 protokolliert dort den vorherigen
    // Wert) — ein Cron, der sie routinemäßig überschreibt, zerstört diese
    // Provenienz. Das Freitext-Urteil des Modells landet deshalb in
    // coreMemoryReason.
    assert.match(patch.coreMemoryReason, /Projektfakt/);
    assert.strictEqual(Object.hasOwn(patch, "updateSource"), false);
    assert.strictEqual(Object.hasOwn(patch, "updateEvidence"), false);
    assert.strictEqual(patch.halfLifeDays, 600);
  });

  // 7.15.3: Hier faellt die Blitzlicht-Entscheidung, und hier faellt sie genau
  // einmal — der Cron liest nur Zeilen mit pending-Status und setzt sie danach
  // auf final. 7.15.2 hatte das Einbrennen hier entfernt, in der falschen
  // Annahme, der Cron laufe stuendlich ueber den ganzen Bestand; gemessen am
  // 21.09. standen 15 von 24.509 Zeilen in der Warteschlange (0,06 %). Ohne
  // diesen Pfad brennt gar nichts mehr ein: Der Capture-Pfad hat nur die
  // Tier-2-Heuristik (Maximum 0,60) und erreicht die Schwelle 0,80 nie.
  it("brennt bei hoher Intensität ein (Flag an), Wert 0,875 >= 0,80", () => {
    const patch = buildRefinePatch({ id: "b", memoryStrength: 0.9, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "fear", emotionalIntensity: 0.95 }, reason: "" },
      now, { flashbulbEncodingEnabled: true });
    assert.strictEqual(patch.halfLifeDays, FLASHBULB_HALF_LIFE_DAYS);
    assert.strictEqual(patch.memoryStrength, 0.95);
    assert.strictEqual(patch.memoryClass, "flashbulb");
  });

  it("brennt unterhalb der Schwelle nicht ein (Flag an), Wert 0,75 < 0,80", () => {
    // Genau die vier Zeilen, die in der Nacht zum 21.09. unter 0,70 noch
    // gebrannt haetten: 0,5*0,7 + 0,5*0,8 = 0,75.
    const patch = buildRefinePatch({ id: "b3", memoryStrength: 0.9, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "joy", emotionalIntensity: 0.7 }, reason: "" },
      now, { flashbulbEncodingEnabled: true });
    assert.strictEqual(patch.halfLifeDays, 600, "Halbwertszeit aus dem Importance-Band");
    assert.strictEqual(Object.hasOwn(patch, "memoryClass"), false);
    assert.strictEqual(Object.hasOwn(patch, "memoryStrength"), false);
  });

  it("senkt eine vorhandene Stärke nie (Flag an)", () => {
    const patch = buildRefinePatch({ id: "c", memoryStrength: 1.0, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "fear", emotionalIntensity: 0.95 }, reason: "Vorfall" },
      now, { flashbulbEncodingEnabled: true });
    assert.strictEqual(patch.memoryStrength, 1.0);
    assert.match(patch.coreMemoryReason, /Vorfall/);
  });

  // R16 (Abschluss-Review, Critical 1): ohne das Flag — der Deploy-Default —
  // wendet der Refine-Pfad gar kein Blitzlicht an, selbst bei derselben
  // hochintensiven Eingabe wie oben. Fällt der Default versehentlich auf
  // "an" um, bekommt memoryStrength hier einen Wert (0.95) statt undefined
  // zu bleiben, und der Test schlägt fehl.
  it("applies no flashbulb at all without the flag (deploy default)", () => {
    const patch = buildRefinePatch({ id: "b2", memoryStrength: 0.9, halfLifeDays: 180 },
      { ok: true, importance: 0.8, emotion: { emotionalDominant: "fear", emotionalIntensity: 0.95 }, reason: "" }, now);
    assert.strictEqual(Object.hasOwn(patch, "memoryStrength"), false);
    assert.strictEqual(Object.hasOwn(patch, "memoryClass"), false);
    // Ohne Blitzlicht kommt die Halbwertszeit rein aus dem Band (0.7–0.94 → 600),
    // nicht aus FLASHBULB_HALF_LIFE_DAYS.
    assert.strictEqual(patch.halfLifeDays, 600);
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
    // Abschluss-Review, Important 5b: eine Agentenband-Zeile darf auch ihr
    // coreMemoryReason (Provenienz-Marker) nicht verlieren, und das
    // automatische Freitext-Urteil darf hier gar nicht erst geschrieben
    // werden — sonst wird eine bewusste Setzung des Agenten stillschweigend
    // mit einer automatischen Begründung überschrieben.
    assert.strictEqual(Object.hasOwn(patch, "coreMemoryReason"), false);
    assert.strictEqual(Object.hasOwn(patch, "updateSource"), false);
    assert.strictEqual(Object.hasOwn(patch, "updateEvidence"), false);
  });

  it("never touches an agent-band core memory's provenance marker", () => {
    // Genau der beschriebene Fehler: eine Agentenband-Core-Memory, deren
    // coreMemoryReason ein Provenienz-Marker ist (nicht Freitext), darf ihn
    // durch diesen Cron nicht verlieren.
    const patch = buildRefinePatch(
      {
        id: "g", memoryStrength: 1.0, halfLifeDays: 36500, importance: 1.0,
        memoryClass: "core", coreMemoryReason: "manual_importance_marker",
      },
      { ok: true, importance: 0.4, emotion: { emotionalDominant: "joy", emotionalIntensity: 0.6 }, reason: "Automatische Begründung" },
      now,
    );
    assert.strictEqual(Object.hasOwn(patch, "coreMemoryReason"), false);
  });

  it("still writes importance and halfLifeDays just below the agent band", () => {
    const patch = buildRefinePatch(
      { id: "f", memoryStrength: 0.9, halfLifeDays: 180, importance: 0.94, importanceStatus: "pending" },
      { ok: true, importance: 0.3, emotion: { emotionalDominant: "neutral", emotionalIntensity: 0.1 }, reason: "" },
      now,
    );
    assert.strictEqual(patch.importance, 0.3);
    assert.strictEqual(patch.halfLifeDays, 30);
    assert.strictEqual(patch.coreMemoryReason, "");
  });
});
