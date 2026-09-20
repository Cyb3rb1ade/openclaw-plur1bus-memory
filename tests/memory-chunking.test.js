/**
 * tests/memory-chunking.test.js
 *
 * Eine Erinnerung wird als EIN Vektor gespeichert. Enthaelt sie mehrere
 * unabhaengige Aussagen, ist dieser Vektor deren Schwerpunkt — und liegt
 * damit von jeder einzelnen Aussage weiter entfernt als noetig. Die Suche
 * findet die Zeile dann nicht, obwohl die Information darin steht.
 *
 * Gemessen am 19.09.2026 im Produktivbestand (main, 9.379 aktive Zeilen):
 * Median 5 Saetze je Zeile, 75. Perzentil 14, 90. Perzentil 31, Maximum 334
 * Saetze in 15.000 Zeichen. Zugleich sind 99,7 % der im LOCOMO-Benchmark
 * gesuchten Belege als Zeile vorhanden — es fehlt also nichts, es wird nur
 * nicht gefunden.
 *
 * Die Aufteilung entscheidet nach zwei Signalen, die beide ohne Modellaufruf
 * zu haben sind: Laenge und Struktur. Verteilung im Bestand:
 *   < 4 Saetze                      32-37 %  gar nicht teilen
 *   >= 4 Saetze mit Struktur        46-50 %  Regelwerk, kostenlos
 *   4-7 Saetze ohne Struktur        10-17 %  ganz lassen (s. u.)
 *   >= 8 Saetze ohne Struktur        1-6 %   Modell fragen
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  CHUNK_MIN_SENTENCES,
  CHUNK_LLM_MIN_SENTENCES,
  CHUNK_MAX_PARTS,
  countSentences,
  findStructuralParts,
  planChunks,
} from "../lib/memory-chunking.js";

describe("Saetze zaehlen", () => {
  it("zaehlt Satzenden, nicht Punkte in Zahlen oder Abkuerzungen", () => {
    assert.strictEqual(countSentences("Ein Satz."), 1);
    assert.strictEqual(countSentences("Erster Satz. Zweiter Satz."), 2);
    assert.strictEqual(countSentences("Der BZ lag bei 3.5 mmol/l."), 1);
    assert.strictEqual(countSentences("Frage? Antwort! Ende."), 3);
  });

  it("wertet Absatzumbrueche als Grenze", () => {
    assert.strictEqual(countSentences("Ohne Punkt\n\nZweiter Absatz"), 2);
  });

  it("vertraegt leere und kaputte Eingaben", () => {
    assert.strictEqual(countSentences(""), 0);
    assert.strictEqual(countSentences(null), 0);
    assert.strictEqual(countSentences("   "), 0);
  });
});

describe("Struktur erkennen", () => {
  it("teilt an Aufzaehlungspunkten", () => {
    const parts = findStructuralParts("Status:\n- PID 2186469\n- Modus Fast\n- Status laeuft");
    assert.ok(parts);
    assert.strictEqual(parts.length, 3);
    assert.ok(parts[0].includes("PID"));
    assert.ok(parts[2].includes("laeuft"));
  });

  it("teilt an nummerierten Listen", () => {
    const parts = findStructuralParts("1. KE-Faktor pruefen\n2. Basaldosis klaeren\n3. Rezept holen");
    assert.strictEqual(parts?.length, 3);
  });

  it("teilt an Absaetzen", () => {
    const parts = findStructuralParts("Erster Gedanke dazu.\n\nZweiter, davon unabhaengig.");
    assert.strictEqual(parts?.length, 2);
  });

  it("liefert null ohne Struktur", () => {
    assert.strictEqual(findStructuralParts("Ein Fliesstext ohne jede Gliederung, aber mit mehreren Saetzen. Noch einer."), null);
  });

  // Ein einzelner Aufzaehlungspunkt ist keine Liste, und ein Schnitt, der ein
  // Fragment von drei Woertern erzeugt, macht den Vektor nicht schaerfer.
  it("teilt nicht in Fragmente", () => {
    assert.strictEqual(findStructuralParts("- nur ein Punkt"), null);
    assert.strictEqual(findStructuralParts("Text\n\nok"), null);
  });
});

describe("Aufteilung planen", () => {
  it("laesst kurze Erinnerungen unangetastet", () => {
    const plan = planChunks("Die Nutzerin mag Tee. Ihr Partner nicht.");
    assert.strictEqual(plan.mode, "whole");
    assert.deepStrictEqual(plan.parts.length, 1);
    assert.strictEqual(plan.needsLlm, false);
  });

  it("teilt strukturierte Erinnerungen ohne Modellaufruf", () => {
    const text = "Lagebericht:\n- PID 2186469 gestartet\n- Modus ist Fast\n- Ziel sind 10.000 Dokumente\n- Status laeuft";
    const plan = planChunks(text);
    assert.strictEqual(plan.mode, "structural");
    assert.strictEqual(plan.needsLlm, false);
    assert.strictEqual(plan.parts.length, 4);
  });

  // Fuenf Saetze ueber EIN Thema zu zerschneiden ist schlechter als sie
  // zusammenzulassen, und ohne Modell laesst sich das nicht unterscheiden.
  it("laesst mittellange Fliesstexte ganz", () => {
    const text = Array.from({ length: 6 }, (_, i) => `Satz Nummer ${i} mit etwas Inhalt.`).join(" ");
    const plan = planChunks(text);
    assert.strictEqual(plan.mode, "whole");
    assert.strictEqual(plan.needsLlm, false);
  });

  it("verlangt das Modell nur bei langem Fliesstext", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Aussage ${i} ueber ein jeweils anderes Thema.`).join(" ");
    const plan = planChunks(text);
    assert.strictEqual(plan.mode, "llm");
    assert.strictEqual(plan.needsLlm, true);
    // Bis das Modell geantwortet hat, bleibt der Text vollstaendig — eine
    // Aufteilung wird nie geraten.
    assert.deepStrictEqual(plan.parts, [text]);
  });

  it("haelt die Schwellen konsistent", () => {
    assert.ok(CHUNK_LLM_MIN_SENTENCES > CHUNK_MIN_SENTENCES);
    assert.strictEqual(CHUNK_MIN_SENTENCES, 4);
    assert.strictEqual(CHUNK_LLM_MIN_SENTENCES, 8);
  });

  it("verliert beim Teilen keinen Inhalt", () => {
    const text = "Kopf:\n- eins zwei drei\n- vier fuenf sechs\n- sieben acht neun";
    const plan = planChunks(text);
    const zusammen = plan.parts.join(" ").replace(/\s+/g, " ");
    for (const wort of ["eins", "vier", "sieben", "neun"]) {
      assert.ok(zusammen.includes(wort), `"${wort}" fehlt nach dem Teilen`);
    }
  });
});


/**
 * Am Produktivbestand gemessen (19.09.2026): das Regelwerk teilt 43-47 % der
 * Zeilen und erzeugt dabei im Extremfall 87 bzw. 100 Teilstuecke aus EINER
 * Zeile — das sind eingespielte Dokumente, nicht Nachrichten. Ohne Deckel
 * verdreifacht sich der Bestand (9.379 -> 32.066 bei main), und jede Zeile
 * kostet im stuendlichen Cron und in jedem Backfill erneut.
 *
 * Der Deckel buendelt statt abzuschneiden: Inhalt geht nie verloren.
 */
describe("Deckel fuer die Zahl der Teilstuecke", () => {
  const liste = (n) => Array.from({ length: n }, (_, i) => `- Punkt ${i} mit etwas Inhalt darin`).join("\n");

  it("buendelt, statt mehr als CHUNK_MAX_PARTS Stuecke zu erzeugen", () => {
    const plan = planChunks(liste(100));
    assert.strictEqual(plan.mode, "structural");
    assert.ok(plan.parts.length <= CHUNK_MAX_PARTS, `${plan.parts.length} Teile ueber dem Deckel`);
  });

  it("verliert beim Buendeln keinen Inhalt", () => {
    const plan = planChunks(liste(100));
    const zusammen = plan.parts.join(" ");
    for (const i of [0, 37, 99]) assert.ok(zusammen.includes(`Punkt ${i} `), `Punkt ${i} fehlt`);
  });

  it("laesst kleine Listen unveraendert", () => {
    const plan = planChunks(liste(5));
    assert.strictEqual(plan.parts.length, 5);
  });
});

