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
