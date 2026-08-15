/**
 * tests/query-hardening-k1-k2.test.js
 *
 * K1 — findUnconfirmedCritical: die where-Klausel deckt nur `createdAt <= X` ab,
 * der selektive Typfilter läuft erst in JS hinter `limit(200)`. Auf großen
 * Tabellen trifft die Zeitbedingung fast alles, der Präfix sind die ältesten
 * Zeilen. Aktuell maskiert (es gibt noch keine Critical-Typen), schlägt zu,
 * sobald der Klassifizierer welche schreibt. Fünfte Fundstelle des Musters.
 *
 * K2 — getRecentForGraph: die feste where-Klausel referenziert
 * `epistemicStatus`; fehlt die Spalte, wirft die Query und der `catch` liefert
 * stilles `[]`. `MemoryDB.init()` migriert normalerweise vorher — im
 * readOnly-Modus wird die Migration aber übersprungen (index.js:1466), dort ist
 * der Pfad also real erreichbar. Zusätzlich ist `!= 'invalidated'` in SQL
 * NULL-asymmetrisch.
 *
 * Wirkung von K2: `recentExisting` speist
 * `buildEdgesForSession(newMemories, [...recentExisting, ...newMemories], …)` —
 * ohne Bestand entstehen nur Kanten innerhalb einer Sitzung, nie zum Bestand.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as lancedb from "@lancedb/lancedb";

import { createDbAdapter } from "../lib/db-adapter.js";

const VECTOR_DIM = 8;
const AGENT = "hardening-agent";
const TAG = 86_400_000;
const FILLER = 40;

async function loadFreshPlugin() {
  return import(`../index.js?query-hardening=${Date.now()}-${Math.random()}`);
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "query-hardening-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

// ─── K1 ────────────────────────────────────────────────────────────────────

describe("K1 findUnconfirmedCritical — Deckel darf nicht die Auswahl treffen", () => {
  it("findet eine unbestätigte Critical-Karte hinter einem vollen Präfix (scanLimit kleiner als der Füllblock)", async (t) => {
    const baseDbPath = tempDir(t);
    const pluginModule = await loadFreshPlugin();
    const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
    const alt = Date.now() - 30 * TAG;
    const basis = {
      vector: Array(VECTOR_DIM).fill(0.1),
      category: "fact",
      storedBy: AGENT,
      origin: "dm",
      status: "active",
      createdAt: alt,
    };
    for (let i = 0; i < FILLER; i += 1) {
      await db.store({ ...basis, id: uuidFor(i), text: `Füller ${i}`, type: "note" });
    }
    const gesucht = uuidFor(FILLER);
    await db.store({ ...basis, id: gesucht, text: "Evas Blutdruckwerte", type: "gesundheit" });
    await db.shutdown();

    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const ids = (await adapter.findUnconfirmedCritical(AGENT, { olderThan: Date.now(), scanLimit: 20 })).map((c) => c.id);
      assert.ok(ids.includes(gesucht), `die Critical-Karte muss auffindbar sein, bekam ${ids.length} Treffer`);
    } finally {
      await adapter.shutdown();
    }
  });

  it("übergeht bestätigte Karten weiterhin", async (t) => {
    const baseDbPath = tempDir(t);
    const pluginModule = await loadFreshPlugin();
    const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
    const basis = {
      vector: Array(VECTOR_DIM).fill(0.1),
      category: "fact",
      storedBy: AGENT,
      origin: "dm",
      status: "active",
      createdAt: Date.now() - 30 * TAG,
    };
    await db.store({ ...basis, id: uuidFor(1), text: "offen", type: "person" });
    await db.store({ ...basis, id: uuidFor(2), text: "bestätigt", type: "person", confirmed: true });
    await db.shutdown();

    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const ids = (await adapter.findUnconfirmedCritical(AGENT, { olderThan: Date.now() })).map((c) => c.id);
      assert.deepEqual(ids, [uuidFor(1)]);
    } finally {
      await adapter.shutdown();
    }
  });
});

// ─── K2 ────────────────────────────────────────────────────────────────────

describe("K2 getRecentForGraph — Schema-Drift darf nicht still zu [] werden", () => {
  /** Rohe Tabelle OHNE epistemicStatus, wie die produktiven Tabellen heute. */
  async function driftTable(dir) {
    const jetzt = Date.now();
    const rows = [0, 1, 2].map((i) => ({
      id: uuidFor(i),
      text: `Erinnerung ${i}`,
      summary: "",
      vector: Array(VECTOR_DIM).fill(0.1),
      status: "active",
      memoryKind: "memory",
      category: "fact",
      createdAt: jetzt - i * 1000,
      sessionId: "",
      sourceTurnId: "",
      agentId: AGENT,
      workspaceId: "",
    }));
    const db = await lancedb.connect(dir);
    await db.createTable("memories", rows);
  }

  it("liefert Zeilen, wenn epistemicStatus fehlt (readOnly überspringt die Migration)", async (t) => {
    const dir = join(tempDir(t), AGENT);
    await driftTable(dir);
    const pluginModule = await loadFreshPlugin();
    const db = new pluginModule.MemoryDB(dir, VECTOR_DIM, null, { readOnly: true });
    await db.init();
    try {
      const rows = await db.getRecentForGraph({ limit: 10, includeGlobalRecent: true });
      assert.equal(rows.length, 3, "ohne Bestand entstehen nur Kanten innerhalb einer Sitzung");
    } finally {
      await db.shutdown();
    }
  });
});
