/**
 * tests/gc-superseded-scan.test.js
 *
 * B3: Der Active-Scan wurde auf eine Positiv-Whitelist umgestellt und schließt
 * seither `superseded` aus. Das ist für Recall, Shared Search und Vault richtig —
 * der GC verliert dadurch aber seine Kandidaten: `garbage-collector.js` zählt
 * alles außer `archived`/`deleted` als sammelbar, bezieht seine Eingabe aber
 * ausschließlich aus dem Active-Scan. Zusammen mit dem entfallenen Hard-Delete
 * wächst die Tabelle dann nur noch.
 *
 * Der GC bekommt deshalb einen eigenen, ausdrücklich benannten Scan-Pfad.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { collectActiveMemories } from "../lib/jobs/gc-job.js";
import { archiveMemories, selectCandidatesForGc } from "../lib/garbage-collector.js";

const VECTOR_DIM = 8;
const AGENT = "gc-scan-agent";

async function loadFreshPlugin() {
  return import(`../index.js?gc-superseded-scan=${Date.now()}-${Math.random()}`);
}

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "gc-superseded-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ACTIVE_ID = "00000000-0000-4000-8000-00000000a001";
const SUPERSEDED_ID = "00000000-0000-4000-8000-00000000a002";
const DELETED_ID = "00000000-0000-4000-8000-00000000a003";
const ARCHIVED_ID = "00000000-0000-4000-8000-00000000a004";

async function seededDb(pluginModule, baseDbPath) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
  const base = {
    vector: Array(VECTOR_DIM).fill(0.1),
    category: "fact",
    storedBy: AGENT,
    origin: "dm",
    trustLevel: "untrusted",
    createdAt: Date.now(),
  };
  await db.store({ ...base, id: ACTIVE_ID, text: "aktuell", status: "active" });
  await db.store({ ...base, id: SUPERSEDED_ID, text: "alte Fassung", status: "superseded" });
  await db.store({ ...base, id: DELETED_ID, text: "vergessen", status: "deleted" });
  await db.store({ ...base, id: ARCHIVED_ID, text: "archiviert", status: "archived" });
  return db;
}

describe("B3 GC-Scan vs. Active-Scan", () => {
  it("hält superseded aus dem Active-Scan heraus", async (t) => {
    const pluginModule = await loadFreshPlugin();
    const db = await seededDb(pluginModule, tempBase(t));
    try {
      const ids = (await db.scanActive()).map((r) => r.id);
      assert.deepEqual(ids, [ACTIVE_ID], "Recall/Shared Search/Vault dürfen keine alten Fassungen sehen");
    } finally {
      await db.shutdown();
    }
  });

  it("liefert dem GC superseded als Kandidat", async (t) => {
    const pluginModule = await loadFreshPlugin();
    const db = await seededDb(pluginModule, tempBase(t));
    try {
      const ids = (await db.scanCollectable()).map((r) => r.id).sort();
      assert.deepEqual(ids, [ACTIVE_ID, SUPERSEDED_ID].sort());
    } finally {
      await db.shutdown();
    }
  });

  it("führt den GC-Job über den Collectable-Pfad", async (t) => {
    const pluginModule = await loadFreshPlugin();
    const db = await seededDb(pluginModule, tempBase(t));
    try {
      const ids = (await collectActiveMemories(db)).map((r) => r.id).sort();
      assert.deepEqual(
        ids,
        [ACTIVE_ID, SUPERSEDED_ID].sort(),
        "der GC muss alte Fassungen wieder als Archivkandidaten sehen",
      );
    } finally {
      await db.shutdown();
    }
  });

  it("archiviert eine superseded Zeile tatsächlich (Scan → Auswahl → Archiv)", async (t) => {
    const pluginModule = await loadFreshPlugin();
    const baseDbPath = tempBase(t);
    const db = await seededDb(pluginModule, baseDbPath);
    try {
      const memories = await collectActiveMemories(db);
      // maxMemoryCount: 0 ⇒ alles Sammelbare wird Kandidat; damit hängt der Test
      // nicht an der Prioritätssortierung.
      const candidates = selectCandidatesForGc(memories, { maxMemoryCount: 0 });
      assert.ok(candidates.includes(SUPERSEDED_ID), "die alte Fassung muss Kandidat werden");

      await archiveMemories(db, candidates, join(baseDbPath, "archive"));

      const row = await db.getById(SUPERSEDED_ID);
      assert.equal(row.status, "archived", "der GC muss die alte Fassung wirklich archivieren, nicht nur sehen");
    } finally {
      await db.shutdown();
    }
  });

  it("fällt für DB-Objekte ohne Collectable-Pfad auf den Active-Scan zurück", async () => {
    const legacyDb = {
      async scanActive() {
        return [{ id: ACTIVE_ID }];
      },
    };
    assert.deepEqual((await collectActiveMemories(legacyDb)).map((r) => r.id), [ACTIVE_ID]);
  });
});
