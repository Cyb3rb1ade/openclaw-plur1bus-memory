/**
 * tests/importance-usage-recall-weighting.test.js
 *
 * Das Zusammenspiel, nicht die Einzelteile: Bedeutung → Halbwertszeit →
 * Zerfall → Gebrauch → Platz im Recall.
 *
 * Die Kette im Produktivcode:
 *   1. `resolveHalfLifeFromEncoding(importance)` macht aus der Bedeutung eine
 *      Behaltensdauer (30 / 180 / 600 Tage, darüber Blitzlicht und Kern).
 *   2. `computeDecayedStrength` lässt die Stärke entlang dieser Dauer sinken.
 *   3. `applyRetrievalReinforcement` hebt bei Gebrauch die Stärke UND dehnt
 *      die Dauer.
 *   4. lib/recall-pipeline.js:1833 addiert `memoryStrength - 1.0` auf den
 *      Score. Bei gleicher Ähnlichkeit entscheidet also allein die Stärke
 *      über die Reihenfolge — die Bedeutung selbst steht seit 7.12.63 NICHT
 *      mehr im Ranking (Zeile 927: importanceBoost ohne Wirkung). Sie wirkt
 *      ausschließlich über die Halbwertszeit.
 *
 * Genau diese Umleitung ist die These des Umbaus: Bedeutung entscheidet, wie
 * lange etwas hält; Gebrauch entscheidet, was heute obenauf liegt.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  AGENT_BAND_MIN,
  applyRetrievalReinforcement,
  computeDecayedStrength,
  isCoreMemory,
  resolveHalfLifeFromEncoding,
} from "../lib/memory-dynamics.js";

const DAY = 86400000;
const now = Date.UTC(2026, 8, 19);

/** Eine frisch kodierte Zeile, wie der Capture-Pfad sie anlegt. */
const kodiere = (importance, extra = {}) => ({
  importance,
  halfLifeDays: resolveHalfLifeFromEncoding(importance),
  memoryStrength: 1.0,
  retrievalCount: 0,
  lastDynamicsAt: now,
  ...extra,
});

/** Abrufe im Abstand von `abstandTage`, insgesamt über `tage`. */
const gebrauche = (row, abstandTage, tage) => {
  let out = { ...row };
  for (let t = abstandTage; t <= tage; t += abstandTage) {
    out = { ...out, ...applyRetrievalReinforcement(out, now + t * DAY) };
  }
  return out;
};

/**
 * Der Score-Beitrag einer Zeile bei gleicher Ähnlichkeit — exakt die Form aus
 * lib/recall-pipeline.js:1833.
 */
const scoreBeitrag = (row, zeitpunkt) => computeDecayedStrength(row, zeitpunkt) - 1.0;

describe("Bedeutung, Gebrauch und Recall-Gewichtung greifen ineinander", () => {
  it("Bedeutung wirkt ueber die Behaltensdauer, nicht ueber das Ranking", () => {
    // Gleich alt, gleich oft gebraucht (naemlich nie) — nur die Bedeutung
    // unterscheidet sie.
    const wichtig = kodiere(0.8);
    const beilaeufig = kodiere(0.2);
    assert.strictEqual(wichtig.halfLifeDays, 600);
    assert.strictEqual(beilaeufig.halfLifeDays, 30);

    // Am Tag der Kodierung sind beide gleichauf: die Bedeutung selbst zaehlt
    // im Ranking nicht.
    assert.strictEqual(scoreBeitrag(wichtig, now), scoreBeitrag(beilaeufig, now));

    // Ein halbes Jahr spaeter hat die Bedeutung ueber die Dauer gewirkt.
    const spaeter = now + 180 * DAY;
    assert.ok(scoreBeitrag(wichtig, spaeter) > scoreBeitrag(beilaeufig, spaeter) + 0.4,
      `Abstand nur ${(scoreBeitrag(wichtig, spaeter) - scoreBeitrag(beilaeufig, spaeter)).toFixed(4)}`);
  });

  /**
   * Der Kern der These: eine für sich genommen belanglose Erinnerung, die
   * gebraucht wird, liegt im Recall vor einer bedeutsamen, an die niemand
   * denkt. So verhält sich menschliches Gedächtnis — die Telefonnummer, die
   * man täglich wählt, ist präsenter als der wichtige Termin in acht Monaten.
   */
  it("Gebrauch schlaegt Bedeutung, wenn die bedeutsame Zeile brachliegt", () => {
    const spaeter = now + 365 * DAY;
    const belanglosAberGenutzt = gebrauche(kodiere(0.2), 14, 365);
    const bedeutsamAberBrach = kodiere(0.8);

    assert.ok(scoreBeitrag(belanglosAberGenutzt, spaeter) > scoreBeitrag(bedeutsamAberBrach, spaeter),
      `genutzt ${scoreBeitrag(belanglosAberGenutzt, spaeter).toFixed(4)} gegen brach ${scoreBeitrag(bedeutsamAberBrach, spaeter).toFixed(4)}`);
  });

  it("bei gleichem Gebrauch entscheidet wieder die Bedeutung", () => {
    const spaeter = now + 365 * DAY;
    const wichtigGenutzt = gebrauche(kodiere(0.8), 60, 365);
    const beilaeufigGenutzt = gebrauche(kodiere(0.2), 60, 365);
    assert.ok(scoreBeitrag(wichtigGenutzt, spaeter) > scoreBeitrag(beilaeufigGenutzt, spaeter),
      `${scoreBeitrag(wichtigGenutzt, spaeter).toFixed(4)} muss ueber ${scoreBeitrag(beilaeufigGenutzt, spaeter).toFixed(4)} liegen`);
  });

  it("vergangene Abrufe wirken kumulativ, nicht nur der letzte", () => {
    const spaeter = now + 365 * DAY;
    const oft = gebrauche(kodiere(0.3), 30, 365);
    // Dieselbe Zeile, aber nur ein einziger Abruf — zum selben letzten
    // Zeitpunkt, damit sich nicht bloss die Frische unterscheidet.
    const einmal = applyRetrievalReinforcement(kodiere(0.3), now + 360 * DAY);
    assert.ok(Number(oft.halfLifeDays) > Number(einmal.halfLifeDays),
      `Historie muss die Dauer dehnen: ${oft.halfLifeDays} gegen ${einmal.halfLifeDays}`);
    assert.ok(scoreBeitrag(oft, spaeter) > scoreBeitrag({ ...kodiere(0.3), ...einmal }, spaeter),
      "die Zeile mit Abruf-Historie muss vorn liegen");
  });

  /**
   * Das Agentenband ist die Ausnahme von allem: was der Agent im Gespraech
   * als unvergesslich markiert hat, steht seit 7.12.65 dauerhaft ganz oben —
   * unabhaengig von Zerfall und Gebrauch.
   */
  it("eine Kern-Erinnerung bleibt unabhaengig von Zeit und Gebrauch obenauf", () => {
    const kern = {
      ...kodiere(AGENT_BAND_MIN),
      memoryClass: "core",
      neverForget: 1,
      halfLifeDays: 36500,
    };
    assert.ok(isCoreMemory(kern));
    assert.strictEqual(scoreBeitrag(kern, now + 3650 * DAY), 0,
      "eine Kern-Erinnerung verliert nie Score-Gewicht");
    const genutzt = gebrauche(kodiere(0.2), 7, 365);
    assert.ok(scoreBeitrag(kern, now + 3650 * DAY) >= scoreBeitrag(genutzt, now + 365 * DAY));
  });
});
