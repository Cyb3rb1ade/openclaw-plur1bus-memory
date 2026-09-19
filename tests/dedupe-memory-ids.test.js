/**
 * tests/dedupe-memory-ids.test.js
 *
 * Der alte, nicht-atomare Legacy-Pfad in MemoryDB.update() (delete, dann
 * add mit best-effort-Restore bei Fehlschlag) hinterließ Zeilenpaare mit
 * derselben id. Dieser Test deckt die reine Auswahlregel (inkl. Unentschieden),
 * die Gruppierung/Anomalie-Erkennung und — mit einer echten Wegwerf-LanceDB-
 * Tabelle — den eigentlichen Schreibpfad samt seiner Verifikation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  SELECTION_FIELD_ORDER,
  selectSurvivingRow,
  findDuplicateGroups,
  findNonPairGroupIds,
  findStrayNonActiveIds,
  buildDedupePlan,
  verifyRepair,
  repairGroup,
  toJsonSafeRow,
  buildExportLines,
  buildExportPath,
  writeExport,
} from "../scripts/dedupe-memory-ids.mjs";

describe("selectSurvivingRow — reine Auswahlregel", () => {
  const base = { lastDynamicsAt: 0, lastStrengthenedAt: 0, updatedAt: 0, createdAt: 0, retrievalCount: 0 };

  it("entscheidet nach lastDynamicsAt, wenn es sich unterscheidet — auch gegen ein späteres createdAt", () => {
    const a = { ...base, id: "x", lastDynamicsAt: 5, createdAt: 100 };
    const b = { ...base, id: "x", lastDynamicsAt: 10, createdAt: 50 };
    const result = selectSurvivingRow(a, b);
    assert.equal(result.decidedBy, "lastDynamicsAt");
    assert.equal(result.arbitrary, false);
    assert.equal(result.survivor, b);
    assert.equal(result.discarded, a);
  });

  it("fällt auf lastStrengthenedAt zurück, wenn lastDynamicsAt gleich ist", () => {
    const a = { ...base, id: "x", lastDynamicsAt: 5, lastStrengthenedAt: 1 };
    const b = { ...base, id: "x", lastDynamicsAt: 5, lastStrengthenedAt: 2 };
    const result = selectSurvivingRow(a, b);
    assert.equal(result.decidedBy, "lastStrengthenedAt");
    assert.equal(result.survivor, b);
  });

  it("fällt auf updatedAt, dann createdAt, dann retrievalCount zurück — in dieser Reihenfolge", () => {
    const tie = { lastDynamicsAt: 5, lastStrengthenedAt: 5 };
    assert.equal(
      selectSurvivingRow({ ...tie, id: "x", updatedAt: 1, createdAt: 999, retrievalCount: 999 }, { ...tie, id: "x", updatedAt: 2, createdAt: 0, retrievalCount: 0 }).decidedBy,
      "updatedAt",
    );
    const tie2 = { ...tie, updatedAt: 3 };
    assert.equal(
      selectSurvivingRow({ ...tie2, id: "x", createdAt: 10, retrievalCount: 999 }, { ...tie2, id: "x", createdAt: 20, retrievalCount: 0 }).decidedBy,
      "createdAt",
    );
    const tie3 = { ...tie2, createdAt: 10 };
    assert.equal(
      selectSurvivingRow({ ...tie3, id: "x", retrievalCount: 1 }, { ...tie3, id: "x", retrievalCount: 4 }).decidedBy,
      "retrievalCount",
    );
  });

  it("Unentschieden: sind alle fünf Felder gleich, gewinnt deterministisch die erste Zeile, als arbitrary markiert", () => {
    const a = { ...base, id: "x", text: "A" };
    const b = { ...base, id: "x", text: "B" };
    const result = selectSurvivingRow(a, b);
    assert.equal(result.arbitrary, true);
    assert.equal(result.decidedBy, null);
    assert.equal(result.survivor, a);
    assert.equal(result.discarded, b);
    // Deterministisch: derselbe Aufruf liefert immer dasselbe Ergebnis.
    assert.equal(selectSurvivingRow(a, b).survivor, a);
  });

  it("fehlende Felder zählen als 0 (Schema-Default in index.js), kein Werfen bei undefined", () => {
    const a = { id: "x" };
    const b = { id: "x", lastDynamicsAt: 1 };
    const result = selectSurvivingRow(a, b);
    assert.equal(result.decidedBy, "lastDynamicsAt");
    assert.equal(result.survivor, b);
  });

  it("SELECTION_FIELD_ORDER hat die verbindliche Reihenfolge", () => {
    assert.deepEqual(SELECTION_FIELD_ORDER, [
      "lastDynamicsAt", "lastStrengthenedAt", "updatedAt", "createdAt", "retrievalCount",
    ]);
  });
});

describe("findDuplicateGroups / Anomalie-Erkennung", () => {
  it("gruppiert nur aktive Zeilen mit derselben id, lässt Solo-Zeilen aus", () => {
    const rows = [
      { id: "a", status: "active" },
      { id: "b", status: "active" },
      { id: "a", status: "active" },
    ];
    const groups = findDuplicateGroups(rows);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((r) => r.id), ["a", "a"]);
  });

  it("ignoriert gelöschte Zeilen bei der Gruppierung", () => {
    const rows = [
      { id: "a", status: "active" },
      { id: "a", status: "deleted" },
    ];
    assert.equal(findDuplicateGroups(rows).length, 0);
  });

  it("findNonPairGroupIds meldet Gruppen mit mehr oder weniger als zwei Zeilen", () => {
    const groups = [
      [{ id: "pair" }, { id: "pair" }],
      [{ id: "triple" }, { id: "triple" }, { id: "triple" }],
    ];
    assert.deepEqual(findNonPairGroupIds(groups), ["triple"]);
  });

  it("findStrayNonActiveIds findet eine nicht-aktive Zeile, die dieselbe id wie ein Duplikat-Paar trägt", () => {
    const rows = [
      { id: "a", status: "active" },
      { id: "a", status: "active" },
      { id: "a", status: "deleted" },
      { id: "b", status: "active" },
      { id: "b", status: "active" },
    ];
    const groups = findDuplicateGroups(rows);
    assert.deepEqual(findStrayNonActiveIds(rows, groups), ["a"]);
  });

  it("buildDedupePlan schließt Anomalien von den Entscheidungen aus, zählt sie aber", () => {
    const rows = [
      { id: "clean", status: "active", createdAt: 1 },
      { id: "clean", status: "active", createdAt: 2 },
      { id: "triple", status: "active", createdAt: 1 },
      { id: "triple", status: "active", createdAt: 2 },
      { id: "triple", status: "active", createdAt: 3 },
      { id: "stray", status: "active", createdAt: 1 },
      { id: "stray", status: "active", createdAt: 2 },
      { id: "stray", status: "deleted", createdAt: 0 },
    ];
    const plan = buildDedupePlan(rows);
    assert.equal(plan.groupCount, 3);
    assert.deepEqual(plan.decisions.map((d) => d.id), ["clean"]);
    assert.deepEqual([...plan.anomalyIds].sort(), ["stray", "triple"]);
  });

  it("buildDedupePlan liefert keine Entscheidungen und keine Anomalien für einen sauberen Store", () => {
    const rows = [{ id: "solo", status: "active" }];
    const plan = buildDedupePlan(rows);
    assert.equal(plan.groupCount, 0);
    assert.deepEqual(plan.decisions, []);
    assert.deepEqual(plan.anomalyIds, []);
  });
});

function closeVectors(actual, expected, tolerance = 1e-6) {
  const a = Array.from(actual);
  const b = Array.from(expected);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) {
    assert.ok(Math.abs(a[i] - b[i]) <= tolerance, `vector[${i}]: ${a[i]} vs ${b[i]}`);
  }
}

describe("repairGroup / verifyRepair — echte Wegwerf-LanceDB-Tabelle (RED→GREEN für den Schreibpfad)", () => {
  it("repariert ein echtes Duplikat-Paar: löscht beide Zwillinge, schreibt nur die Überlebende zurück", async () => {
    const dir = makeTempDir("dedupe-real-");
    const db = await lancedb.connect(dir);
    const id = "real-pair-0001";
    const rows = [
      { id, text: "alter Text", vector: [0.1, 0.1, 0.1], lastDynamicsAt: 0, lastStrengthenedAt: 0, updatedAt: 0, createdAt: 1000, retrievalCount: 2, status: "active" },
      { id, text: "neuer Text", vector: [0.2, 0.2, 0.2], lastDynamicsAt: 0, lastStrengthenedAt: 0, updatedAt: 0, createdAt: 2000, retrievalCount: 1, status: "active" },
    ];
    const table = await db.createTable("memories", rows);

    const result = await repairGroup(table, id);
    assert.equal(result.decidedBy, "createdAt");
    assert.equal(result.arbitrary, false);

    const after = await table.query().where(`id = '${id}'`).toArray();
    assert.equal(after.length, 1, "beide Zwillinge gelöscht, nur die Überlebende zurückgeschrieben");
    assert.equal(after[0].text, "neuer Text");
    closeVectors(after[0].vector, [0.2, 0.2, 0.2]);
    assert.equal(await table.countRows(), 1, "keine Waisen-Zeile übrig");
  });

  it("verifyRepair erkennt eine korrekt geschriebene Zeile als ok", async () => {
    const dir = makeTempDir("dedupe-verify-ok-");
    const db = await lancedb.connect(dir);
    const id = "verify-ok-0001";
    const table = await db.createTable("memories", [
      { id, text: "richtig", vector: [0.3, 0.4], status: "active" },
    ]);
    const result = await verifyRepair(table, id, { text: "richtig", vector: [0.3, 0.4] });
    assert.equal(result.ok, true);
  });

  it("bricht mit einer lauten Fehlermeldung ab, wenn der Schreibpfad absichtlich kaputt gemacht wird (falscher Inhalt trotz erfolgreichem add)", async () => {
    // Genau das Szenario, vor dem die Verifikation schützen muss: table.add()
    // wirft keine Exception, schreibt aber nicht das, was beabsichtigt war —
    // simuliert einen Client, der einen Timeout für einen Fehlschlag hält,
    // obwohl der Schreibzugriff (mit falschem Inhalt) durchkam.
    const dir = makeTempDir("dedupe-badwrite-");
    const db = await lancedb.connect(dir);
    const id = "bad-write-0001";
    const rows = [
      { id, text: "richtiger Text", vector: [0.1, 0.2, 0.3], lastDynamicsAt: 5, lastStrengthenedAt: 0, updatedAt: 0, createdAt: 100, retrievalCount: 0, status: "active" },
      { id, text: "verlierer", vector: [0.4, 0.5, 0.6], lastDynamicsAt: 1, lastStrengthenedAt: 0, updatedAt: 0, createdAt: 90, retrievalCount: 0, status: "active" },
    ];
    const table = await db.createTable("memories", rows);

    const realAdd = table.add.bind(table);
    table.add = async (newRows) => realAdd(newRows.map((r) => ({ ...r, text: "FALSCHER TEXT" })));

    await assert.rejects(
      () => repairGroup(table, id),
      /Verifikation nach dem Schreiben fehlgeschlagen/,
    );

    // Kein zweiter Versuch: die Tabelle bleibt im sichtbar kaputten Zustand
    // stehen, statt dass das Skript stillschweigend nachbessert.
    const after = await table.query().where(`id = '${id}'`).toArray();
    assert.equal(after.length, 1);
    assert.equal(after[0].text, "FALSCHER TEXT");
  });

  it("bricht ab, wenn der frische Lesezugriff vor dem Schreiben nicht mehr zwei aktive Zeilen zeigt", async () => {
    // Deckt die "vor dem ersten Schreiben frisch lesen"-Vorgabe ab: wäre die
    // Gruppe zwischen Dry-Run und --apply schon anders geworden, darf die
    // Reparatur nicht blind auf der alten Momentaufnahme weiterlaufen.
    const dir = makeTempDir("dedupe-stale-");
    const db = await lancedb.connect(dir);
    const id = "stale-0001";
    const table = await db.createTable("memories", [
      { id, text: "einzelne Zeile", vector: [0.1], status: "active" },
    ]);
    await assert.rejects(() => repairGroup(table, id), /zeigt 1 aktive Zeile\(n\) statt 2/);
    // Nichts geschrieben — die einzelne Zeile ist unangetastet.
    assert.equal(await table.countRows(), 1);
  });

  it("bricht ab, wenn eine nicht-aktive Zeile dieselbe id trägt (delete würde sie mitlöschen)", async () => {
    const dir = makeTempDir("dedupe-stray-");
    const db = await lancedb.connect(dir);
    const id = "stray-0001";
    const table = await db.createTable("memories", [
      { id, text: "aktiv 1", vector: [0.1], createdAt: 1, status: "active" },
      { id, text: "aktiv 2", vector: [0.2], createdAt: 2, status: "active" },
      { id, text: "getombstoned", vector: [0.3], createdAt: 0, status: "deleted" },
    ]);
    await assert.rejects(() => repairGroup(table, id), /zusätzliche nicht-aktive Zeile/);
    assert.equal(await table.countRows(), 3, "nichts wurde geschrieben");
  });

  it("Unentschieden auf echten Daten: gewinnt deterministisch die erste Zeile in Tabellenreihenfolge", async () => {
    const dir = makeTempDir("dedupe-tie-");
    const db = await lancedb.connect(dir);
    const id = "tie-0001";
    const table = await db.createTable("memories", [
      { id, text: "zuerst", vector: [0.1], lastDynamicsAt: 0, lastStrengthenedAt: 0, updatedAt: 0, createdAt: 0, retrievalCount: 0, status: "active" },
      { id, text: "danach", vector: [0.2], lastDynamicsAt: 0, lastStrengthenedAt: 0, updatedAt: 0, createdAt: 0, retrievalCount: 0, status: "active" },
    ]);
    const result = await repairGroup(table, id);
    assert.equal(result.arbitrary, true);
    assert.equal(result.decidedBy, null);
    const after = await table.query().where(`id = '${id}'`).toArray();
    assert.equal(after[0].text, "zuerst");
  });
});

describe("Export vor --apply: JSONL, BigInt- und Vector-Rundtrip", () => {
  it("toJsonSafeRow wandelt BigInt-Spalten in Dezimal-Strings, die exakt zu BigInt zurückkonvertierbar sind", () => {
    // Reale Int64-Spalten aus dem main-Schema (2026-09-19), live geprüft:
    // LanceDB liefert sie aus toArray() als JS BigInt zurück.
    const row = { id: "x", lastDynamicsAt: 1788364069566n, halfLifeDays: 78n, retrievalCount: 0n };
    const safe = toJsonSafeRow(row);
    assert.equal(typeof safe.lastDynamicsAt, "string");
    assert.equal(safe.lastDynamicsAt, "1788364069566");
    assert.equal(safe.halfLifeDays, "78");
    assert.equal(safe.retrievalCount, "0");
    // Rundtrip über JSON UND zurück zu BigInt — nicht nur über den String.
    const roundTripped = JSON.parse(JSON.stringify(safe));
    assert.equal(BigInt(roundTripped.lastDynamicsAt), 1788364069566n);
    assert.equal(BigInt(roundTripped.halfLifeDays), 78n);
    assert.equal(BigInt(roundTripped.retrievalCount), 0n);
  });

  it("JSON.stringify wirft auf einer rohen Zeile mit BigInt-Spalte — toJsonSafeRow ist deshalb zwingend", () => {
    const row = { id: "x", lastDynamicsAt: 5n };
    assert.throws(() => JSON.stringify(row), /BigInt/);
    assert.doesNotThrow(() => JSON.stringify(toJsonSafeRow(row)));
  });

  it("ein echter 3072-dimensionaler Float32-Vektor übersteht den JSON-Rundtrip elementweise exakt", () => {
    // Zufällige, auf Float32-Präzision "eingerastete" Werte (Math.fround) —
    // nicht nur Wiederholungen von 0.1 — wie sie aus einer echten
    // FixedSizeList[3072]<Float32>-Spalte kommen (main-Schema, 2026-09-19).
    const dim = 3072;
    const vector = Array.from({ length: dim }, () => Math.fround(Math.random() * 2 - 1));
    const safe = toJsonSafeRow({ id: "vec-test", vector });
    const parsed = JSON.parse(JSON.stringify(safe));
    assert.equal(parsed.vector.length, dim);
    for (let i = 0; i < dim; i += 1) {
      assert.equal(parsed.vector[i], vector[i], `vector[${i}] weicht ab: ${parsed.vector[i]} vs ${vector[i]}`);
    }
  });

  it("verpackt ein Arrow-artiges iterierbares Vector-Objekt korrekt (wie es table.query() zurückliefert)", () => {
    const arrowLike = {
      [Symbol.iterator]: function* () { yield Math.fround(0.123456); yield Math.fround(-0.987654); },
    };
    const safe = toJsonSafeRow({ id: "x", vector: arrowLike });
    assert.deepEqual(safe.vector, [Math.fround(0.123456), Math.fround(-0.987654)]);
  });

  it("lässt normale Werte (string, number, null) unverändert", () => {
    const row = { id: "x", text: "hallo", importance: 0.7, mergedFrom: null };
    assert.deepEqual(toJsonSafeRow(row), row);
  });

  it("buildExportLines schreibt genau zwei Zeilen je Gruppe (survivor + discarded), je eine valide JSON-Zeile", () => {
    const decisions = [
      { id: "g1", survivor: { id: "g1", text: "neu" }, discarded: { id: "g1", text: "alt" }, decidedBy: "createdAt", arbitrary: false },
      { id: "g2", survivor: { id: "g2", text: "a" }, discarded: { id: "g2", text: "b" }, decidedBy: null, arbitrary: true },
    ];
    const lines = buildExportLines(decisions);
    assert.equal(lines.length, 4);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    const objs = lines.map((l) => JSON.parse(l));
    assert.equal(objs[0].meta.id, "g1");
    assert.equal(objs[0].meta.role, "survivor");
    assert.equal(objs[0].meta.decidedBy, "createdAt");
    assert.equal(objs[0].row.text, "neu");
    assert.equal(objs[1].meta.role, "discarded");
    assert.equal(objs[1].row.text, "alt");
    assert.equal(objs[2].meta.arbitrary, true);
  });

  it("buildExportPath ist dateisystemsicher (keine Doppelpunkte/Punkte) und deterministisch aus dem übergebenen Zeitpunkt", () => {
    const p = buildExportPath({ exportDir: "/tmp/x", agentId: "main", now: new Date("2026-09-19T15:30:00.123Z") });
    assert.equal(p.includes(":"), false);
    assert.match(p, /main-2026-09-19T15-30-00-123Z\.jsonl$/);
  });

  it("writeExport schreibt eine echte JSONL-Datei mit BigInt- und Vector-Feldern, lesbar per JSON.parse Zeile für Zeile", () => {
    const dir = makeTempDir("dedupe-export-");
    const decisions = [
      {
        id: "g1",
        survivor: { id: "g1", text: "neu", vector: [0.1, 0.2, 0.3], lastDynamicsAt: 5n, createdAt: 200 },
        discarded: { id: "g1", text: "alt", vector: [0.4, 0.5, 0.6], lastDynamicsAt: 1n, createdAt: 100 },
        decidedBy: "lastDynamicsAt",
        arbitrary: false,
      },
    ];
    const path = writeExport({ exportDir: dir, agentId: "testagent", decisions, now: new Date("2026-09-19T15:30:00.000Z") });
    assert.equal(path, join(dir, "testagent-2026-09-19T15-30-00-000Z.jsonl"));
    assert.ok(existsSync(path));
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.row.lastDynamicsAt, "5", "BigInt als Dezimal-String exportiert");
    assert.deepEqual(first.row.vector, [0.1, 0.2, 0.3]);
  });

  it("writeExport verweigert, eine bestehende Export-Datei zu überschreiben", () => {
    const dir = makeTempDir("dedupe-export-overwrite-");
    const decisions = [
      { id: "g1", survivor: { id: "g1", text: "neu" }, discarded: { id: "g1", text: "alt" }, decidedBy: "createdAt", arbitrary: false },
    ];
    const now = new Date("2026-09-19T15:30:00.000Z");
    const firstPath = writeExport({ exportDir: dir, agentId: "testagent", decisions, now });
    const before = readFileSync(firstPath, "utf8");
    assert.throws(
      () => writeExport({ exportDir: dir, agentId: "testagent", decisions, now }),
      /Export-Datei existiert bereits/,
    );
    // Die Datei des ersten Laufs wurde nicht stillschweigend ersetzt.
    assert.equal(readFileSync(firstPath, "utf8"), before);
  });

  it("writeExport legt das Export-Verzeichnis bei Bedarf an", () => {
    const parent = makeTempDir("dedupe-export-mkdir-");
    const dir = join(parent, "nested", "export-dir");
    assert.equal(existsSync(dir), false);
    const decisions = [
      { id: "g1", survivor: { id: "g1", text: "neu" }, discarded: { id: "g1", text: "alt" }, decidedBy: "createdAt", arbitrary: false },
    ];
    const path = writeExport({ exportDir: dir, agentId: "testagent", decisions, now: new Date("2026-09-19T15:30:00.000Z") });
    assert.ok(existsSync(path));
  });
});
