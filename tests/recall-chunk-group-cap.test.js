/**
 * tests/recall-chunk-group-cap.test.js
 *
 * Sobald eine Nachricht in mehrere Vektoren aufgeteilt gespeichert wird
 * (lib/memory-chunking.js), passen auf eine Frage oft gleich mehrere
 * Teilstuecke derselben Nachricht. Ohne Deckel belegen sie drei der zwoelf
 * Plaetze mit zusammengehoerigem Inhalt und verdraengen genau die Vielfalt,
 * die die Aufteilung gewinnen soll.
 *
 * Der Deckel sitzt in dedupResults, weil diese Funktion an DREI Stellen der
 * Pipeline aufgerufen wird (Zeilen 553, 1545, 2064). Eine Regel an einer
 * Stelle — am 19.09.2026 ist gleich dreimal aufgefallen, was passiert, wenn
 * zwei Wege dasselbe meinen und Verschiedenes tun.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { DEFAULT_MAX_PER_GROUP, chunkGroupKey, dedupResults } from "../lib/recall-pipeline.js";

// Die Texte muessen sich WIRKLICH unterscheiden — sonst greift die
// Textentdopplung und der Test misst sie statt des Gruppendeckels.
const WOERTER = [
  "Blutzucker faellt rasch am Vormittag",
  "Katze schlief unter dem Kirschbaum",
  "Rechnung vom Klempner noch offen",
  "Zug nach Hannover faehrt verspaetet",
  "Neues Buch ueber Vulkane gekauft",
  "Nachbarin giesst die Tomaten weiter",
];
let n = 0;
const treffer = (group, text) => {
  n += 1;
  return {
    entry: { id: `id-${n}`, text: text ?? WOERTER[(n - 1) % WOERTER.length], summary: "", chunkGroupId: group },
    score: 1 / n,
  };
};

describe("Gruppenschluessel", () => {
  it("nimmt chunkGroupId, sonst sourceTurnId, sonst nichts", () => {
    assert.strictEqual(chunkGroupKey({ chunkGroupId: "g1", sourceTurnId: "t1" }), "g1");
    assert.strictEqual(chunkGroupKey({ sourceTurnId: "t1" }), "t1");
    assert.strictEqual(chunkGroupKey({}), null);
    assert.strictEqual(chunkGroupKey(null), null);
    assert.strictEqual(chunkGroupKey({ chunkGroupId: "" }), null);
  });
});

describe("Deckel je Herkunfts-Nachricht", () => {
  it("laesst bis zum Deckel durch", () => {
    const out = dedupResults([treffer("g1"), treffer("g1")], 10, 0.78);
    assert.strictEqual(out.length, 2);
  });

  it("verwirft das dritte Teilstueck derselben Nachricht", () => {
    const out = dedupResults([treffer("g1"), treffer("g1"), treffer("g1")], 10, 0.78);
    assert.strictEqual(out.length, DEFAULT_MAX_PER_GROUP);
  });

  it("behaelt die bestbewerteten Teilstuecke", () => {
    const a = treffer("g1"); const b = treffer("g1"); const c = treffer("g1");
    const out = dedupResults([a, b, c], 10, 0.78);
    assert.deepStrictEqual(out.map((r) => r.entry.id), [a.entry.id, b.entry.id]);
  });

  it("zaehlt je Gruppe getrennt", () => {
    const out = dedupResults([treffer("g1"), treffer("g1"), treffer("g2"), treffer("g2")], 10, 0.78);
    assert.strictEqual(out.length, 4);
  });

  // Der gewonnene Platz muss anderen Erinnerungen zugutekommen, sonst
  // verschenkt der Deckel ihn.
  it("gibt den frei gewordenen Platz an andere Nachrichten weiter", () => {
    const eingabe = [treffer("g1"), treffer("g1"), treffer("g1"), treffer("g2"), treffer("g3")];
    const out = dedupResults(eingabe, 4, 0.78);
    assert.strictEqual(out.length, 4);
    assert.deepStrictEqual([...new Set(out.map((r) => r.entry.chunkGroupId))].sort(), ["g1", "g2", "g3"]);
  });

  it("laesst Zeilen ohne Gruppe unberuehrt", () => {
    const ohne = [treffer(null), treffer(null), treffer(null), treffer(null)];
    assert.strictEqual(dedupResults(ohne, 10, 0.78).length, 4);
  });

  it("laesst sich abschalten", () => {
    const out = dedupResults([treffer("g1"), treffer("g1"), treffer("g1")], 10, 0.78, { maxPerGroup: Infinity });
    assert.strictEqual(out.length, 3);
  });

  it("entdoppelt weiterhin nach Text, auch innerhalb einer Gruppe", () => {
    const gleich = "Exakt derselbe Wortlaut in beiden Zeilen hier";
    const out = dedupResults([treffer("g1", gleich), treffer("g1", gleich)], 10, 0.78);
    assert.strictEqual(out.length, 1, "Textdubletten bleiben Dubletten");
  });
});
