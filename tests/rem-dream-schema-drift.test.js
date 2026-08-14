/**
 * tests/rem-dream-schema-drift.test.js
 *
 * loadCandidateMemories baute eine feste where-Klausel, die `epistemicStatus`
 * referenziert. Diese Spalte fehlt auf den produktiven Tabellen (live geprüft
 * 14.08.2026: bernhardine 13.700 Zeilen und main 9.375 Zeilen haben sie nicht).
 * Die Query wirft dann einen Schema-Error, der `catch (_)` fängt ihn und fällt
 * auf `query().limit(maxMemories)` zurück — einen KOMPLETT ungefilterten
 * Präfix-Scan. Da LanceDB in Einfügereihenfolge liefert, sind das die ältesten
 * Zeilen; der JS-Filter verlangt danach `ts >= weekStart` und verwirft alles.
 *
 * Live-Folge: `{"skipped":true,"reason":"too_few_memories","count":0}` für alle
 * drei Agenten — der Traum-Job lief nie.
 *
 * Ein `catch`, der eine präzise Query still in einen beliebigen Präfix
 * verwandelt, ist gefährlicher als ein zu kleiner Deckel.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as lancedb from "@lancedb/lancedb";

import { buildRemPartition, loadCandidateMemories } from "../lib/dreaming/rem-dream.js";

const TAG = 86_400_000;
const AGENT = "dream-agent";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "rem-dream-drift-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Baut eine Tabelle in der Form der Live-Daten: OHNE epistemicStatus-Spalte,
 * alte Zeilen zuerst, die frischen dahinter.
 */
async function driftTable(dir, { alt, frisch }) {
  const jetzt = Date.now();
  const zeile = (i, ts) => ({
    id: uuidFor(i),
    text: `Erinnerung ${i}`,
    summary: "",
    vector: Array(8).fill(0.1),
    status: "active",
    category: "project_fact",
    memoryClass: "standard",
    createdAt: ts,
    sourceTimestamp: ts,
    workspaceId: "",
    workspaceKey: "",
    agentId: AGENT,
    storedBy: AGENT,
    scope: "agent-private",
    ownerUserId: "",
  });
  const rows = [];
  for (let i = 0; i < alt; i += 1) rows.push(zeile(i, jetzt - 200 * TAG));
  const frischeIds = [];
  for (let i = 0; i < frisch; i += 1) {
    const id = uuidFor(10_000 + i);
    frischeIds.push(id);
    rows.push({ ...zeile(10_000 + i, jetzt - TAG), id });
  }
  const db = await lancedb.connect(dir);
  const table = await db.createTable("memories", rows);
  return { table, frischeIds };
}

const ctx = { agentId: AGENT, workspaceAliases: { aliases: [] } };

// sameRemBindings verlangt BEIDE Seiten — mit aclPartition: null filtert der Job
// alles weg, unabhängig vom Bug. Die Partition muss echt sein.
const partition = buildRemPartition(
  { scope: "agent-private", agentId: AGENT, workspaceIdentity: "", ownerUserId: "" },
  ctx,
);

describe("rem-dream — Schema-Drift darf die Filterung nicht verpuffen lassen", () => {
  it("findet frische Erinnerungen, wenn epistemicStatus fehlt", async (t) => {
    const { table, frischeIds } = await driftTable(tempDir(t), { alt: 40, frisch: 5 });

    const memories = await loadCandidateMemories({ table }, {
      weekStartMs: Date.now() - 7 * TAG,
      requestContext: ctx,
      aclPartition: partition,
      // Deckel kleiner als der alte Block: exakt die Live-Lage, in der der
      // Präfix komplett außerhalb des Wochenfensters liegt.
      maxMemories: 20,
    });

    const ids = memories.map((m) => m.id);
    for (const id of frischeIds) {
      assert.ok(ids.includes(id), `frische Erinnerung ${id} fehlt — bekam ${ids.length} Kandidaten`);
    }
  });

  it("hält Zeilen außerhalb des Wochenfensters weiterhin draußen", async (t) => {
    const { table } = await driftTable(tempDir(t), { alt: 6, frisch: 3 });

    const memories = await loadCandidateMemories({ table }, {
      weekStartMs: Date.now() - 7 * TAG,
      requestContext: ctx,
      aclPartition: partition,
      maxMemories: 5000,
    });

    assert.equal(memories.length, 3, "nur die drei frischen Zeilen liegen im Fenster");
  });

  it("verwirft keine Zeile mit leerem epistemicStatus", async (t) => {
    // `epistemicStatus != 'invalidated'` ist in SQL NULL-asymmetrisch: eine
    // Zeile ohne gesetzten Wert würde still verschwinden.
    const dir = tempDir(t);
    const jetzt = Date.now();
    const basis = {
      text: "mit Spalte", summary: "", vector: Array(8).fill(0.1), status: "active",
      category: "project_fact", memoryClass: "standard", createdAt: jetzt - TAG,
      sourceTimestamp: jetzt - TAG, workspaceId: "", workspaceKey: "",
      agentId: AGENT, storedBy: AGENT, scope: "agent-private", ownerUserId: "",
    };
    const db = await lancedb.connect(dir);
    const table = await db.createTable("memories", [
      { ...basis, id: uuidFor(1), epistemicStatus: "" },
      { ...basis, id: uuidFor(2), epistemicStatus: "invalidated" },
    ]);

    const ids = (await loadCandidateMemories({ table }, {
      weekStartMs: jetzt - 7 * TAG, requestContext: ctx, aclPartition: partition, maxMemories: 5000,
    })).map((m) => m.id);

    assert.deepEqual(ids, [uuidFor(1)], "leerer Status bleibt, invalidated fliegt raus");
  });
});
