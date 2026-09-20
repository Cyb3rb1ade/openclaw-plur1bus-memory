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
import { expandForCapture } from "../lib/memory-chunking.js";

const mehrteilig = [
  "- Erik hat seit Montag einen neuen Sensor",
  "- Die Messwerte schwanken morgens stark",
  "- Termin beim Arzt ist am 14.",
  "- Fiasp wurde auf 8 Einheiten reduziert",
].join("\n");

const einteilig = "Wir haben heute ueber den Sensor gesprochen.";

describe("expandForCapture", () => {
  it("teilt eine strukturierte Nachricht in mehrere Eintraege", () => {
    const { items, split, parts } = expandForCapture([{ it: { role: "user" }, text: mehrteilig }]);
    assert.equal(split, 1);
    assert.equal(parts, items.length);
    assert.ok(items.length >= 4, `erwartet >= 4 Teile, bekommen ${items.length}`);
  });

  it("gibt allen Teilen denselben Gruppenschluessel", () => {
    const { items } = expandForCapture([{ it: {}, text: mehrteilig }], { makeGroupId: () => "G1" });
    assert.deepEqual([...new Set(items.map((i) => i.chunkGroupId))], ["G1"]);
  });

  it("vergibt je Ursprungsnachricht einen eigenen Schluessel", () => {
    let n = 0;
    const { items } = expandForCapture(
      [{ it: {}, text: mehrteilig }, { it: {}, text: mehrteilig }],
      { makeGroupId: () => `G${++n}` },
    );
    const gruppen = new Set(items.map((i) => i.chunkGroupId));
    assert.equal(gruppen.size, 2, "zwei Nachrichten duerfen nicht in eine Gruppe fallen");
  });

  it("laesst die Teiltexte verschieden — sonst waere nichts gewonnen", () => {
    const { items } = expandForCapture([{ it: {}, text: mehrteilig }]);
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

  it("zaehlt Modellfaelle, teilt sie aber nicht auf Verdacht", () => {
    const ohneStruktur = Array.from({ length: 9 }, (_, i) => `Satz Nummer ${i} ohne jede Struktur.`).join(" ");
    const { items, split, needsLlm } = expandForCapture([{ it: {}, text: ohneStruktur }]);
    assert.equal(needsLlm, 1);
    assert.equal(split, 0);
    assert.equal(items.length, 1);
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
  const quelle = readFileSync(new URL("../index.js", import.meta.url), "utf8");

  it("ruft die Aufteilung auf", () => {
    assert.match(quelle, /expandForCapture\(preppedOk/);
  });

  it("teilt VOR der Einbettung auf", () => {
    const aufteilung = quelle.indexOf("expandForCapture(preppedOk");
    const einbettung = quelle.indexOf("embeddings.embedBatch(batch");
    assert.ok(aufteilung > 0 && einbettung > 0);
    assert.ok(aufteilung < einbettung, "die Aufteilung muss vor dem Einbetten stehen");
  });

  it("schreibt den Gruppenschluessel in die Zeile", () => {
    const block = quelle.slice(
      quelle.indexOf("const categoryResult = categorizeMemoryWithReason(p.text)"),
      quelle.indexOf("await db.store(row)"),
    );
    assert.match(block, /chunkGroupId: p\.chunkGroupId \|\| ""/);
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
});
