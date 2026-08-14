/**
 * tests/compaction-candidate-scan.test.js
 *
 * loadCompactionCandidates holte `table.query().limit(5000)` OHNE where und
 * filterte erst danach auf `createdAt >= cutoff`. LanceDB liefert in
 * Einfügereihenfolge, der Präfix sind also die ÄLTESTEN Zeilen — bei Tabellen
 * über dem Deckel liegen sie sämtlich außerhalb des Rückschaufensters.
 *
 * Live gemessen (14.08.2026): bernhardine 13.700 Zeilen → Job sah 0 Kandidaten,
 * tatsächlich 1.965; main 9.375 → 0 statt 1.071. Beide Jobs meldeten
 * `"candidates":0,"note":"too_few_candidates"`.
 *
 * Dasselbe Muster wie beim Pending-Review-Ledger und beim Klassifizierer: ein
 * Cap ohne Pushdown, bei dem der Deckel entscheidet, welche Zeilen überhaupt
 * betrachtet werden.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadCompactionCandidates } from "../lib/jobs/memory-compaction.js";

const VECTOR_DIM = 8;
const AGENT = "compaction-scan-agent";
const TAG = 86_400_000;

async function loadFreshPlugin() {
  return import(`../index.js?compaction-scan=${Date.now()}-${Math.random()}`);
}

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "compaction-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Baut die Live-Form nach: viele ALTE Zeilen zuerst, danach wenige frische.
 * Der Deckel wird klein gehalten, damit der Test gegen echtes LanceDB laufen
 * kann statt gegen ein Mock — dieselbe Bauart hat bei B2 den DataFusion-
 * AND-Vorbehalt entschieden.
 */
async function seed(pluginModule, baseDbPath, { alt, frisch }) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
  const base = {
    vector: Array(VECTOR_DIM).fill(0.1),
    category: "fact",
    storedBy: AGENT,
    origin: "dm",
    trustLevel: "untrusted",
    status: "active",
  };
  const jetzt = Date.now();
  for (let i = 0; i < alt; i += 1) {
    await db.store({ ...base, id: uuidFor(i), text: `alt ${i}`, createdAt: jetzt - 200 * TAG });
  }
  const frischeIds = [];
  for (let i = 0; i < frisch; i += 1) {
    const id = uuidFor(10_000 + i);
    frischeIds.push(id);
    await db.store({ ...base, id, text: `frisch ${i}`, createdAt: jetzt - TAG });
  }
  await db.shutdown();
  return frischeIds;
}

describe("loadCompactionCandidates — Deckel darf nicht die Auswahl treffen", () => {
  it("findet frische Kandidaten hinter einem vollen Präfix alter Zeilen", async (t) => {
    const baseDbPath = tempBase(t);
    const pluginModule = await loadFreshPlugin();
    const frischeIds = await seed(pluginModule, baseDbPath, { alt: 40, frisch: 5 });

    const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
    await db.init();
    try {
      // scanLimit kleiner als die Zahl der alten Zeilen: exakt die Live-Lage,
      // in der der Präfix komplett außerhalb des Fensters liegt.
      const kandidaten = await loadCompactionCandidates(db.table, 30, { scanLimit: 20 });
      const ids = kandidaten.map((c) => c.id);
      for (const id of frischeIds) {
        assert.ok(ids.includes(id), `frische Karte ${id} muss Kandidat sein, bekam: ${ids.length} Kandidaten`);
      }
    } finally {
      await db.shutdown();
    }
  });

  it("lässt Zeilen außerhalb des Rückschaufensters weiterhin draußen", async (t) => {
    const baseDbPath = tempBase(t);
    const pluginModule = await loadFreshPlugin();
    await seed(pluginModule, baseDbPath, { alt: 10, frisch: 3 });

    const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
    await db.init();
    try {
      const kandidaten = await loadCompactionCandidates(db.table, 30, { scanLimit: 5000 });
      assert.equal(kandidaten.length, 3, "nur die drei frischen Zeilen liegen im 30-Tage-Fenster");
    } finally {
      await db.shutdown();
    }
  });

  it("hält getombsteinte und überholte Zeilen aus der Compaction heraus", async (t) => {
    const baseDbPath = tempBase(t);
    const pluginModule = await loadFreshPlugin();
    const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
    const jetzt = Date.now();
    const base = {
      vector: Array(VECTOR_DIM).fill(0.1),
      category: "fact",
      storedBy: AGENT,
      origin: "dm",
      trustLevel: "untrusted",
      createdAt: jetzt - TAG,
    };
    await db.store({ ...base, id: uuidFor(1), text: "aktiv", status: "active" });
    await db.store({ ...base, id: uuidFor(2), text: "vergessen", status: "deleted", epistemicStatus: "invalidated" });
    await db.store({ ...base, id: uuidFor(3), text: "alte Fassung", status: "superseded" });
    await db.init();
    try {
      const ids = (await loadCompactionCandidates(db.table, 30, { scanLimit: 5000 })).map((c) => c.id);
      assert.deepEqual(ids, [uuidFor(1)], "ein zurückgezogener Fakt darf nie in eine Merge-Kandidatur geraten");
    } finally {
      await db.shutdown();
    }
  });
});
