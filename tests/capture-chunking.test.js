/**
 * tests/capture-chunking.test.js
 *
 * Die Aufteilung mehrteiliger Nachrichten im Capture-Pfad (7.12.70).
 *
 * Der Capture-Hook selbst laesst sich ohne Gateway nicht aufrufen. Geprueft
 * wird deshalb zweierlei: das Verhalten der reinen Funktion, und dass der
 * Pfad in index.js sie an der richtigen Stelle benutzt — naemlich VOR der
 * Einbettung, weil die Aufteilung sonst wirkungslos waere.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expandForCapture, planChunks, findSentenceParts } from "../lib/memory-chunking.js";

const mehrteilig = [
  "- Erik hat seit Montag einen neuen Sensor",
  "- Die Messwerte schwanken morgens stark",
  "- Termin beim Arzt ist am 14.",
  "- Fiasp wurde auf 8 Einheiten reduziert",
].join("\n");

const einteilig = "Wir haben heute ueber den Sensor gesprochen.";

describe("expandForCapture", () => {
  it("teilt eine strukturierte Nachricht und behaelt die Ursprungszeile", () => {
    const { items, split, parts } = expandForCapture([{ it: { role: "user" }, text: mehrteilig }]);
    assert.equal(split, 1);
    // Seit 7.13.0 ist die Speicherweise "beides": Ganzes PLUS Teile.
    assert.equal(items.length, parts + 1);
    assert.ok(parts >= 4, `erwartet >= 4 Teile, bekommen ${parts}`);
    const ganze = items.filter((i) => i.text === mehrteilig);
    assert.equal(ganze.length, 1, "die Ursprungszeile muss genau einmal erhalten bleiben");
  });

  it("laesst die Ursprungszeile OHNE Gruppe — sonst greift der Gruppendeckel ueber alles", () => {
    const { items } = expandForCapture([{ it: {}, text: mehrteilig }], { makeGroupId: () => "G1" });
    const ganz = items.find((i) => i.text === mehrteilig);
    const teile = items.filter((i) => i.text !== mehrteilig);
    // chunkGroupKey faellt bei leerer Gruppe auf sourceTurnId zurueck. Traege
    // das Ganze dieselbe Gruppe wie die Teile, liesse DEFAULT_MAX_PER_GROUP = 2
    // hoechstens zwei Zeilen je Nachricht durch statt "Ganzes und zwei Teile".
    assert.equal(ganz.chunkGroupId, undefined);
    assert.deepEqual([...new Set(teile.map((i) => i.chunkGroupId))], ["G1"]);
  });

  it("vergibt je Ursprungsnachricht einen eigenen Schluessel", () => {
    let n = 0;
    const { items } = expandForCapture(
      [{ it: {}, text: mehrteilig }, { it: {}, text: mehrteilig }],
      { makeGroupId: () => `G${++n}` },
    );
    const gruppen = new Set(items.filter((i) => i.chunkGroupId).map((i) => i.chunkGroupId));
    assert.equal(gruppen.size, 2, "zwei Nachrichten duerfen nicht in eine Gruppe fallen");
  });

  it("kann die Ursprungszeile auf Wunsch weglassen (reines Aufteilen)", () => {
    const { items, parts } = expandForCapture([{ it: {}, text: mehrteilig }], { keepWhole: false });
    assert.equal(items.length, parts);
    assert.equal(items.filter((i) => i.text === mehrteilig).length, 0);
  });

  it("laesst die Teiltexte verschieden — sonst waere nichts gewonnen", () => {
    const { items } = expandForCapture([{ it: {}, text: mehrteilig }], { keepWhole: false });
    assert.equal(new Set(items.map((i) => i.text)).size, items.length);
  });

  it("verliert keinen Inhalt", () => {
    const { items } = expandForCapture([{ it: {}, text: mehrteilig }]);
    const zusammen = items.map((i) => i.text).join(" ");
    for (const brocken of ["neuen Sensor", "schwanken morgens", "am 14.", "8 Einheiten"]) {
      assert.ok(zusammen.includes(brocken), `fehlt: ${brocken}`);
    }
  });

  it("laesst kurze Nachrichten unberuehrt und ohne Gruppe", () => {
    const { items, split } = expandForCapture([{ it: {}, text: einteilig }]);
    assert.equal(split, 0);
    assert.equal(items.length, 1);
    assert.equal(items[0].chunkGroupId, undefined);
  });

  it("uebernimmt die uebrigen Felder des Eintrags", () => {
    const it = { role: "assistant", sourceUrl: "https://x", isUserUrl: false };
    const { items } = expandForCapture([{ it, text: mehrteilig, ok: true }]);
    for (const teil of items) {
      assert.equal(teil.it, it);
      assert.equal(teil.ok, true);
    }
  });

  it("teilt Fliesstext ohne Struktur satzweise auf", () => {
    // Bis 7.12.70 blieb dieser Fall ungeteilt und wartete auf ein Modell. An
    // 90 echten Zeilen gemessen fielen ALLE in diesen Zweig — die Aufteilung
    // war ausgeliefert, aber wirkungslos.
    const ohneStruktur = Array.from({ length: 9 }, (_, i) => `Satz Nummer ${i} ohne jede Struktur.`).join(" ");
    const { items, split, parts, needsLlm } = expandForCapture([{ it: {}, text: ohneStruktur }]);
    assert.equal(needsLlm, 1, "der Fall bleibt als Modellkandidat gekennzeichnet");
    assert.equal(split, 1);
    assert.equal(parts, 9);
    assert.equal(items.length, 10, "neun Saetze plus die Ursprungszeile");
  });

  it("laesst 4 bis 7 Saetze ohne Struktur bewusst ganz", () => {
    const fuenf = Array.from({ length: 5 }, (_, i) => `Satz Nummer ${i} ohne jede Struktur.`).join(" ");
    const { items, split } = expandForCapture([{ it: {}, text: fuenf }]);
    assert.equal(split, 0, "fuenf Saetze ueber EIN Thema zu zerschneiden ist schlechter");
    assert.equal(items.length, 1);
  });

  it("bricht Dezimalzahlen und Versionsnummern nicht auf", () => {
    const text = "Der Wert lag bei 3.5 mmol/l. " + Array.from({ length: 8 }, (_, i) => `Weiterer Satz ${i}.`).join(" ");
    const teile = findSentenceParts(text);
    assert.ok(teile.some((t) => t.includes("3.5 mmol/l")), "3.5 darf kein Satzende sein");
  });

  it("planChunks meldet den Satzmodus", () => {
    const neun = Array.from({ length: 9 }, (_, i) => `Satz Nummer ${i} ohne jede Struktur.`).join(" ");
    assert.equal(planChunks(neun).mode, "sentence");
    assert.equal(planChunks("Kurz. Und knapp.").mode, "whole");
  });

  it("ist abschaltbar", () => {
    const ein = [{ it: {}, text: mehrteilig }];
    const { items, split } = expandForCapture(ein, { enabled: false });
    assert.equal(split, 0);
    assert.equal(items, ein);
  });

  it("vertraegt leere und ungueltige Eingaben", () => {
    assert.deepEqual(expandForCapture([]).items, []);
    assert.deepEqual(expandForCapture(null).items, []);
    assert.equal(expandForCapture([{ it: {}, text: "" }]).items.length, 1);
  });
});

describe("Verdrahtung im Capture-Pfad", () => {
  // PR-03e (engine-extraction M1a) hat den agent_end-Capture-Rumpf aus
  // index.js nach engine/capture/capture-turn.js verschoben; index.js
  // registriert den Hook nur noch. Die Verdrahtungspruefungen folgen dem
  // Rumpf — unveraendert, nur an seinem neuen Ort.
  const quelle = readFileSync(new URL("../engine/capture/capture-turn.js", import.meta.url), "utf8");

  it("ruft die Aufteilung auf", () => {
    assert.match(quelle, /expandForCapture\(preppedOk/);
  });

  it("teilt VOR der Einbettung auf", () => {
    const aufteilung = quelle.indexOf("expandForCapture(preppedOk");
    const einbettung = quelle.indexOf("embeddings.embedBatch(batch");
    assert.ok(aufteilung > 0 && einbettung > 0);
    assert.ok(aufteilung < einbettung, "die Aufteilung muss vor dem Einbetten stehen");
  });

  it("reicht den Gruppenschluessel durch die Einbettungsphase durch", () => {
    // In 7.12.70 baute Phase 1c ein frisches Objekt aus nur
    // { it, text, vector, ok } und verlor dabei die chunkGroupId. Der
    // Zeilenbau las danach immer "" — das Merkmal war wirkungslos, und
    // Ganzes wie Teile fielen in dieselbe Dedup-Gruppe zurueck.
    const block = quelle.slice(
      quelle.indexOf("Phase 1c"),
      quelle.indexOf("// Phase 2: Dedup-Checks"),
    );
    assert.ok(block.length > 0, "Phase 1c nicht gefunden");
    const rueckgaben = block.match(/return \{ it: p\.it[^}]*\}/g) || [];
    assert.ok(rueckgaben.length >= 2, `erwartet >= 2 Rueckgaben, gefunden ${rueckgaben.length}`);
    for (const r of rueckgaben) {
      assert.match(r, /chunkGroupId/, `Rueckgabe ohne chunkGroupId: ${r}`);
    }
  });

  it("schreibt den Gruppenschluessel in die Zeile", () => {
    const block = quelle.slice(
      quelle.indexOf("const categoryResult = categorizeMemoryWithReason(p.text)"),
      quelle.indexOf("await db.store(row)"),
    );
    assert.match(block, /chunkGroupId: p\.chunkGroupId \|\| ""/);
  });

  it("verdrahtet die Speicherweise aus der Konfiguration", () => {
    // Ohne Eintrag im configSchema (additionalProperties: false) waere der
    // Schalter im Webinterface nicht erreichbar — siehe "Der Abschalter ist
    // wirklich erreichbar" weiter unten.
    assert.match(quelle, /keepWhole: cfg\.captureChunkingMode !== "geteilt"/);
  });

  it("laesst sich abschalten", () => {
    assert.match(quelle, /cfg\.captureChunking !== false/);
  });
});

describe("Schema-Erweiterung", () => {
  const adapter = readFileSync(new URL("../lib/db-adapter.js", import.meta.url), "utf8");

  it("legt die Spalte an", () => {
    assert.match(adapter, /name: "chunkGroupId"/);
  });

  it("laeuft beim Oeffnen jeder Agenten-Tabelle", () => {
    const kette = adapter.slice(adapter.indexOf("await ensureClassificationColumns(agent, table)"), adapter.indexOf("tableCache.set(safeAgent, table)"));
    assert.match(kette, /await ensureChunkColumns\(agent, table\)/);
  });
});

describe("Schreibpfade vertragen die neue Spalte", () => {
  const quelle = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const safeUpdate = readFileSync(new URL("../lib/safe-update.js", import.meta.url), "utf8");

  it("setzt den Standardwert zentral in store(), nicht je Zeilenbauer", () => {
    const storeBlock = quelle.slice(quelle.indexOf("async store(entry) {"), quelle.indexOf("const guard = assertCardWriteAllowed({"));
    assert.match(storeBlock, /entry\.chunkGroupId == null\) entry\.chunkGroupId = ""/);
  });

  it("traegt die Gruppe ueber eine neue Version hinweg weiter", () => {
    // Ein blosser Standardwert wuerde die Gruppe bei jeder Korrektur verlieren.
    assert.match(safeUpdate, /chunkGroupId: oldRow\.chunkGroupId \|\| ""/);
  });
});

describe("Der Abschalter ist wirklich erreichbar", () => {
  it("steht im Konfigurationsschema des Plugins", async () => {
    // additionalProperties ist false — ein Schalter, der hier fehlt, wird vom
    // Host abgelehnt, und der Code dahinter waere nie erreichbar.
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    assert.equal(manifest.configSchema.additionalProperties, false);
    assert.equal(manifest.configSchema.properties.captureChunking?.type, "boolean");
    assert.equal(manifest.configSchema.properties.captureChunking?.default, true);
  });

  it("bietet die drei Speicherweisen an", () => {
    const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
    const modus = manifest.configSchema.properties.captureChunkingMode;
    // ganz = captureChunking:false, beides/geteilt = dieser Schluessel.
    assert.equal(modus?.type, "string");
    assert.deepEqual(modus?.enum, ["beides", "geteilt"]);
    assert.equal(modus?.default, "beides", "die gemessen beste Variante ist die Vorgabe");
  });
});
