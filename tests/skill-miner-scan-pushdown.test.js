/**
 * tests/skill-miner-scan-pushdown.test.js
 *
 * loadMemories holt `db.table.query().limit(5000)` OHNE where und filtert erst
 * danach auf `createdAt >= cutoff`. LanceDB liefert in Einfügereihenfolge, der
 * Präfix sind also die ÄLTESTEN Zeilen — bei Tabellen über dem Deckel liegen sie
 * sämtlich außerhalb des Rückschaufensters.
 *
 * Live gemessen (15.08.2026, read-only, OHNE Trust-Gate — nur Präfix, Status,
 * Kategorie, Zeitfenster):
 *
 *   bernhardine  erreichbar mit Präfix: 0   mit Pushdown: 589
 *   main         erreichbar mit Präfix: 0   mit Pushdown: 323
 *
 * Der Deckel verhungert die Pipeline, bevor das Epistemic-Gate aus #109 überhaupt
 * gefragt wird: selbst eine frisch als `trusted` markierte Erinnerung wäre auf
 * diesen beiden Agenten unsichtbar.
 *
 * Vierte Fundstelle desselben Musters (vgl. #104 Pending-Reviews, #106
 * Klassifizierer, #107 Compaction).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as lancedb from "@lancedb/lancedb";

import { loadMemories } from "../lib/jobs/skill-miner.js";

const TAG = 86_400_000;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "skill-miner-pushdown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Live-Form: viele ALTE Zeilen zuerst, die frischen dahinter. */
async function driftTable(dir, { alt, frisch, epistemicStatus = "trusted" }) {
  const jetzt = Date.now();
  const zeile = (i, ts, extra = {}) => ({
    id: uuidFor(i),
    text: `Erinnerung ${i} über Deployment und Rollback`,
    status: "active",
    category: "workspace_rule",
    origin: "dm",
    createdAt: ts,
    epistemicStatus,
    retrievalCount: 3,
    ...extra,
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

describe("skill-miner loadMemories — Deckel darf nicht die Auswahl treffen", () => {
  it("refreshes a reader opened before a scoped runtime commits new evidence", async (t) => {
    const dir = tempDir(t);
    const now = Date.now();
    const firstId = uuidFor(20_000);
    const laterId = uuidFor(20_001);
    const row = (id, text) => ({
      id,
      text,
      status: "active",
      category: "workspace_rule",
      origin: "dm",
      createdAt: now,
      epistemicStatus: "observed",
      sourceMessageRole: "user",
      retrievalCount: 0,
    });

    const writerDb = await lancedb.connect(dir);
    const writerTable = await writerDb.createTable("memories", [
      row(firstId, "Release checklist before package staging"),
    ]);
    const readerDb = await lancedb.connect(dir);
    const readerTable = await readerDb.openTable("memories");
    await readerTable.query().toArray();

    await writerTable.add([
      row(laterId, "Release checklist before deployment staging"),
    ]);

    const memories = await loadMemories({ table: readerTable }, 30);

    assert.deepEqual(
      memories.map((memory) => memory.id).sort(),
      [firstId, laterId].sort(),
      "the full runtime must see evidence committed by a scoped runtime",
    );
  });

  it("findet frische Evidenz hinter einem vollen Präfix alter Zeilen", async (t) => {
    const { table, frischeIds } = await driftTable(tempDir(t), { alt: 40, frisch: 5 });

    const memories = await loadMemories({ table }, 30, { scanLimit: 20 });

    const ids = memories.map((m) => m.id);
    for (const id of frischeIds) {
      assert.ok(ids.includes(id), `frische Evidenz ${id} fehlt — bekam ${ids.length} Kandidaten`);
    }
  });

  it("lässt Zeilen außerhalb des Rückschaufensters weiterhin draußen", async (t) => {
    const { table } = await driftTable(tempDir(t), { alt: 8, frisch: 3 });

    const memories = await loadMemories({ table }, 30, { scanLimit: 5000 });

    assert.equal(memories.length, 3, "nur die drei frischen Zeilen liegen im 30-Tage-Fenster");
  });

  it("hält das Epistemic-Gate für untrusted unverändert scharf", async (t) => {
    const { table } = await driftTable(tempDir(t), { alt: 8, frisch: 3, epistemicStatus: "untrusted" });

    const memories = await loadMemories({ table }, 30, { scanLimit: 5000 });

    assert.equal(memories.length, 0, "explizit untrusted bleibt draußen");
  });
});
