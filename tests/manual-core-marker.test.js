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
  AGENT_BAND_MIN,
  CORE_MEMORY_HALF_LIFE_DAYS,
  CORE_MEMORY_THRESHOLD,
  MANUAL_CORE_IMPORTANCE,
  applyCoreMemoryEncoding,
  applyDynamicsDefaults,
  computeCoreMemoryScore,
  computeFlashbulbScore,
  isCoreMemory,
  isManualCoreMarker,
} from "../lib/memory-dynamics.js";
import { AUTOMATIC_IMPORTANCE_MAX } from "../lib/memory-fact-quality.js";

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

  // Task 10 (19.09.2026) hat die Grenze von 1.0 auf 0.95 gesenkt; 0.95 und
  // 0.99 liegen seither IM geschuetzten Band und werden weiter unten geprueft.
  // Die Absicht dieses Tests bleibt unveraendert: unterhalb des Bands darf
  // nichts Core werden — insbesondere nicht 0.94, der Deckel fuer alles
  // Automatische (AUTOMATIC_IMPORTANCE_MAX).
  it("lässt alles unterhalb des Agentenbands unberührt", () => {
    for (const importance of [0.7, 0.85, 0.9, 0.94]) {
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

/**
 * Task 10 (19.09.2026): Bis hierher stand die Schwelle auf 1.0 — das Band
 * 0.95 bis 1.00 war damit eine Verabredung ohne Wirkung. Live gemessen am
 * 19.09.2026 bei bernhardine: 51 Zeilen im Band, alle origin=dm (also im
 * Gespräch gesetzt), davon 43 auf genau 0.95 — und die trugen eine
 * Halbwertszeit von 30 Tagen. Der Wendepunkt vom 09.04.2026 ("absolut nicht
 * austauschbar") stand bei Gedächtnisstärke 0.023, war also faktisch
 * vergessen, obwohl ihn jemand ausdrücklich markiert hatte.
 *
 * Voraussetzung für diese Senkung war Phase 1: sie hat die 320 Altlasten aus
 * der MEMORY.md-Migration vom Band heruntergedrückt. Ohne sie wäre mit dieser
 * Änderung ein Stapel Blutzucker-Statusberichte unsterblich geworden.
 */
describe("Agentenband ab 0.95 traegt den Kern-Schutz", () => {
  it("setzt die Schwelle auf die Untergrenze des Agentenbands", () => {
    assert.strictEqual(MANUAL_CORE_IMPORTANCE, 0.95);
    assert.strictEqual(MANUAL_CORE_IMPORTANCE, AGENT_BAND_MIN,
      "Schwelle und Bandgrenze muessen dieselbe Zahl sein, sonst entsteht eine stille Luecke");
  });

  it("erkennt das ganze Band als bewusste Markierung", () => {
    assert.strictEqual(isManualCoreMarker({ importance: 0.95 }), true);
    assert.strictEqual(isManualCoreMarker({ importance: 0.97 }), true);
    assert.strictEqual(isManualCoreMarker({ importance: 1.0 }), true);
    assert.strictEqual(isManualCoreMarker({ importance: 0.94 }), false);
  });

  // Der Deckel fuer Automatismen liegt bei 0.94 (AUTOMATIC_IMPORTANCE_MAX).
  // Waere die Schwelle darunter gerutscht, koennte ein automatisch bewerteter
  // Eintrag sich selbst unsterblich machen.
  it("bleibt ueber dem Deckel fuer automatische Werte", () => {
    assert.ok(MANUAL_CORE_IMPORTANCE > AUTOMATIC_IMPORTANCE_MAX,
      `${MANUAL_CORE_IMPORTANCE} muss ueber ${AUTOMATIC_IMPORTANCE_MAX} liegen`);
  });

  it("gibt einer Zeile im Band Kern-Halbwertszeit und volle Staerke", () => {
    const core = applyCoreMemoryEncoding({ importance: 0.95, emotionalIntensity: 0 });
    assert.ok(core, "0.95 muss den Kern-Schutz ausloesen");
    assert.strictEqual(core.halfLifeDays, CORE_MEMORY_HALF_LIFE_DAYS);
    assert.strictEqual(core.neverForget, 1);
    assert.strictEqual(core.memoryClass, "core");
    assert.strictEqual(core.memoryStrength, 1.0);
    assert.strictEqual(core.coreMemoryReason, "manual_importance_marker");
  });

  it("laesst 0.94 unberuehrt", () => {
    assert.strictEqual(applyCoreMemoryEncoding({ importance: 0.94, emotionalIntensity: 0 }), null);
  });
});
