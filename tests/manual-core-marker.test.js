/**
 * tests/manual-core-marker.test.js
 *
 * `importance = 1.0` ist dem Agenten vorbehalten: er markiert damit im Gespräch
 * eine Erinnerung, die er subjektiv nicht vergessen will. Der automatische
 * Scorer kann den Wert nicht erreichen — `computeMemoryImportance` startet ohne
 * expliziten Wert bei 0.5, hebt über Floors auf höchstens 0.7 und deckelt
 * Triviales auf 0.45/0.2. 1.0 entsteht also nur durch eine bewusste Setzung.
 *
 * Bis 7.3.3 verpuffte diese Geste: `computeCoreMemoryScore` verlangte
 * zusätzlich `emotionalIntensity >= 0.95`, und das kann der Agent gar nicht
 * setzen — der Wert kommt aus `inferEmotionalValenceAsync(text)`. Live gemessen
 * (15.08.2026): bernhardine hatte genau zwei Zeilen mit `importance == 1.0`,
 * beide medizinische Sicherheitsnotizen, beide mit `emotionalIntensity = 0`,
 * beide ungeschützt (`neverForget = 0`, `memoryClass = "standard"`).
 *
 * Zweiter Defekt derselben Stelle: `novelty` und `userCorrection` wurden
 * verrechnet, existieren aber als Spalten nicht und werden von keiner Stelle
 * geschrieben. Sie trugen 10 % des Core- und 30 % des Flashbulb-Scores — Core
 * war damit bei max. 0.90 gegen Schwelle 0.95 rechnerisch unerreichbar.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CORE_MEMORY_THRESHOLD,
  applyCoreMemoryEncoding,
  applyDynamicsDefaults,
  computeCoreMemoryScore,
  computeFlashbulbScore,
  isCoreMemory,
} from "../lib/memory-dynamics.js";

/** Eine reale Zeile aus dem Live-Bestand: sachlich, dringend, emotionslos. */
const sicherheitsnotiz = {
  text: "SCHWERER FEHLER von mir: Bei BZ 106 fallend habe ich 2 IE Fiasp empfohlen.",
  category: "fact",
  importance: 1.0,
  emotionalIntensity: 0,
};

describe("importance = 1.0 als manueller Core-Marker", () => {
  it("erkennt die bewusste Setzung als Core, ohne emotionales Tor", () => {
    assert.equal(computeCoreMemoryScore(sicherheitsnotiz), 1.0);
  });

  it("kodiert sie als unvergesslich", () => {
    const core = applyCoreMemoryEncoding(sicherheitsnotiz);
    assert.ok(core, "eine mit 1.0 markierte Erinnerung muss Core werden");
    assert.equal(core.memoryClass, "core");
    assert.equal(core.neverForget, 1);
  });

  it("nennt den Grund unterscheidbar vom automatischen Pfad", () => {
    assert.equal(applyCoreMemoryEncoding(sicherheitsnotiz).coreMemoryReason, "manual_importance_marker");
  });

  it("landet über applyDynamicsDefaults durabel auf der Zeile", () => {
    const row = applyDynamicsDefaults({ ...sicherheitsnotiz });
    assert.equal(row.memoryClass, "core");
    assert.equal(row.neverForget, 1);
    assert.ok(isCoreMemory(row), "die Schutzprüfungen von GC und Compaction müssen greifen");
  });

  it("lässt alles unterhalb von 1.0 unberührt", () => {
    // 0.95 ist der höchste Wert, den der Agent unterhalb der Reservierung
    // vergibt; 0.7 die Obergrenze des automatischen Scorers.
    for (const importance of [0.7, 0.85, 0.95, 0.99]) {
      const row = applyDynamicsDefaults({ ...sicherheitsnotiz, importance });
      assert.notEqual(row.memoryClass, "core", `importance ${importance} darf keine Core-Memory erzeugen`);
      assert.equal(row.neverForget, 0);
    }
  });
});

describe("Core- und Flashbulb-Score ohne Phantomfelder", () => {
  it("erreicht die Core-Schwelle bei perfekten vorhandenen Merkmalen", () => {
    // Vorher: 0.45 + 0.45 = 0.90 < 0.95 — die fehlenden 10 % waren `novelty`,
    // eine Spalte, die es nicht gibt. Der Schwellwert war unerreichbar.
    const score = computeCoreMemoryScore({ emotionalIntensity: 1.0, importance: 0.99 });
    assert.ok(
      score >= CORE_MEMORY_THRESHOLD,
      `perfekte Emotion und nahezu perfekte Wichtigkeit müssen die Schwelle erreichen — bekam ${score}`,
    );
  });

  it("erreicht die Flashbulb-Schwelle nicht nur im singulären Punkt 1.0/1.0", () => {
    // Vorher: 0.35 + 0.35 = 0.70 bei Schwelle 0.70 — nur exakte Gleichheit ging.
    assert.ok(computeFlashbulbScore({ emotionalIntensity: 0.9, importance: 0.8 }) >= 0.70);
  });

  it("ignoriert die nie geschriebenen Felder novelty und userCorrection", () => {
    const ohne = computeFlashbulbScore({ emotionalIntensity: 0.6, importance: 0.6 });
    const mit = computeFlashbulbScore({ emotionalIntensity: 0.6, importance: 0.6, novelty: 1, userCorrection: 1 });
    assert.equal(mit, ohne, "Felder ohne Spalte dürfen den Score nicht mitbestimmen");
  });

  it("bleibt für gewöhnliche Erinnerungen unterhalb beider Schwellen", () => {
    const row = applyDynamicsDefaults({ text: "Notiz", category: "fact", importance: 0.5, emotionalIntensity: 0 });
    assert.equal(row.memoryClass, "standard");
    assert.equal(row.neverForget, 0);
  });
});
