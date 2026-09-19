/**
 * tests/memory-behaviour-scenarios.test.js — die Abnahme des Vorhabens
 * "Importance aus Kodierung und Gebrauch" (Task 12).
 *
 * Drei Fragen, an denen sich menschenähnliches Gedächtnis messen lässt:
 * Vergisst es das Frühstück von vorgestern? Behält es das eine einschneidende
 * Ereignis über Jahre, ohne dass es je wieder abgerufen wurde? Hält Gebrauch
 * eine für sich genommen langweilige Tatsache am Leben?
 *
 * ── Warum hier nicht gegen eine Auffindbarkeits-Schwelle geprüft wird ──
 *
 * Der Implementierungsplan schlug vor, "auffindbar" als
 * `0.6 + (strength - 1) >= 0.15` zu modellieren, also die Stärke gegen
 * `recallMinScore` zu halten. Das entspricht nicht dem Code: alle drei
 * Schwellen in lib/recall-pipeline.js (Zeilen 911, 1595, 1647) prüfen den
 * ROHEN Kosinus-Score, und der Stärke-Term kommt erst danach dazu
 * (Zeile 1833: `score += memoryStrength - 1.0`). Er wird nie erneut gegen
 * eine Schwelle gefiltert, und `isRecallEntryLive` liest die Stärke gar nicht.
 *
 * Die Stärke entscheidet also nicht über Auffindbarkeit, sondern über den
 * PLATZ im Wettbewerb um die besten Treffer. Zwei Kandidaten mit gleicher
 * Ähnlichkeit unterscheiden sich im Endergebnis um genau die Differenz ihrer
 * Stärken. Deshalb wird hier auf der Stärke-Achse geprüft — das IST die
 * Score-Achse nach Zeile 1833 — und zwar mit absoluten Abständen, nicht nur
 * relativ: ein reiner Vergleich "genutzt > ungenutzt" würde unter fast jeder
 * Parameterwahl bestehen und könnte keine Regression fangen.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  applyFlashbulbEncoding,
  applyRetrievalReinforcement,
  computeDecayedStrength,
  resolveHalfLifeFromEncoding,
} from "../lib/memory-dynamics.js";

const DAY = 86400000;
const now = Date.UTC(2026, 8, 19);

/** Stärke einer frisch angelegten Erinnerung — der Maßstab des Wettbewerbs. */
const FRISCH = 1.0;

describe("memory behaves like memory", () => {
  it("vergisst das Frühstück von vorgestern", () => {
    // Beiläufig kodiert (Importance 0.2 -> 30 Tage), zusätzlich durch dreizehn
    // ähnliche Notizen geschwächt: dreizehnmal frühstücken heißt dreizehnmal
    // retroaktive Interferenz auf dieselbe Spur.
    let strength = 1.0;
    for (let i = 0; i < 13; i += 1) strength *= 0.9;
    const decayed = computeDecayedStrength(
      { memoryStrength: strength, halfLifeDays: resolveHalfLifeFromEncoding(0.2), lastDynamicsAt: now - 14 * DAY },
      now,
    );
    assert.ok(decayed <= 0.25, `Frühstück zu stark bei ${decayed.toFixed(4)}`);
    // Eine frische Erinnerung schlägt sie im Score um mindestens 0.75.
    assert.ok(FRISCH - decayed >= 0.75, `Abstand zur frischen Erinnerung nur ${(FRISCH - decayed).toFixed(4)}`);
  });

  /**
   * ACHTUNG, Geltungsbereich: dieser Test ruft `applyFlashbulbEncoding`
   * direkt auf. Im Produktivbetrieb steht `memoryDynamics.flashbulbEncoding`
   * auf aus (Default seit 7.12.63), und der Capture-Pfad benutzt dann
   * FLASHBULB_HALF_LIFE_LEGACY_DAYS statt der zehn Jahre. Geprüft wird hier
   * also die Kodierungsfunktion, nicht der ausgelieferte Pfad.
   */
  it("behält ein einzelnes einschneidendes Ereignis zehn Jahre ohne einen einzigen Abruf", () => {
    const flash = applyFlashbulbEncoding(
      { emotionalIntensity: 0.95, importance: 0.85 },
      now,
      0.7,
      resolveHalfLifeFromEncoding(0.85),
    );
    assert.ok(flash, "Blitzlicht-Kodierung muss auslösen — sonst ist die Schwelle verrutscht");

    const nachZehnJahren = (row) => computeDecayedStrength(row, now + 3650 * DAY);
    const blitz = nachZehnJahren({ memoryStrength: flash.memoryStrength, halfLifeDays: flash.halfLifeDays, lastDynamicsAt: now });
    const gewoehnlich = nachZehnJahren({ memoryStrength: 1.0, halfLifeDays: resolveHalfLifeFromEncoding(0.85), lastDynamicsAt: now });

    // Absoluter Boden: nach zehn Jahren noch mindestens das halbe
    // Score-Gewicht einer frischen Erinnerung.
    assert.ok(blitz >= 0.4, `Blitzlicht nach zehn Jahren nur ${blitz.toFixed(4)}`);
    // Und deutlich vor einer gewöhnlichen Erinnerung desselben Alters.
    assert.ok(blitz - gewoehnlich >= 0.4, `Abstand zur gewöhnlichen Erinnerung nur ${(blitz - gewoehnlich).toFixed(4)}`);
  });

  /**
   * Der Plan ließ hier zwanzig Abrufe im selben Augenblick geschehen und
   * danach ein Jahr Stille — das ist nicht "durch Gebrauch am Leben
   * gehalten", sondern ein einzelner Lernmoment mit anschließendem
   * Vergessen. Gebrauch heißt: über das Jahr verteilt.
   *
   * OFFENER BEFUND: Das Gleichgewicht liegt niedrig. Eine Tatsache mit
   * 30 Tagen Halbwertszeit, alle achtzehn Tage abgerufen, pendelt sich bei
   * rund 0.11 ein — sie überlebt, aber schwach. Der Grund ist, dass ein
   * Abruf die Stärke anhebt (`0.15 / (1 + log1p(count))`, mit der Zahl der
   * Abrufe fallend), die Halbwertszeit aber NICHT verlängert. Menschen
   * dehnen durch Wiederholung die Behaltensdauer, nicht nur die momentane
   * Verfügbarkeit. Die Schwelle unten ist deshalb ein Boden gegen
   * Regression, kein Zielwert.
   */
  it("hält eine langweilige Tatsache durch Gebrauch am Leben", () => {
    const halfLifeDays = resolveHalfLifeFromEncoding(0.3);
    let genutzt = { memoryStrength: 0.5, halfLifeDays, retrievalCount: 0, lastDynamicsAt: now };
    for (let i = 1; i <= 20; i += 1) {
      const zeitpunkt = now + Math.round((i * 365) / 20) * DAY;
      genutzt = { ...genutzt, ...applyRetrievalReinforcement(genutzt, zeitpunkt) };
    }
    const ungenutzt = computeDecayedStrength(
      { memoryStrength: 0.5, halfLifeDays, lastDynamicsAt: now },
      now + 365 * DAY,
    );

    assert.ok(genutzt.memoryStrength >= 0.10, `genutzte Tatsache nach einem Jahr nur ${genutzt.memoryStrength.toFixed(4)}`);
    assert.ok(genutzt.memoryStrength >= 10 * ungenutzt, `Gebrauch trägt zu wenig: ${genutzt.memoryStrength.toFixed(4)} gegen ${ungenutzt.toFixed(4)}`);
  });
});
