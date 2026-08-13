/**
 * tests/critical-pending-scan.test.js
 *
 * B2: `findPendingCriticalReviews` holte 200 beliebige Zeilen OHNE where-Klausel
 * und filterte erst danach in JS. Auf einer produktiven Tabelle liegen die
 * unbestätigten Critical-Karten damit außerhalb des Ausschnitts — die Liste ist
 * leer und die Kurzreferenz nicht auflösbar.
 *
 * Läuft bewusst gegen echtes LanceDB: der Pushdown muss mit der realen
 * Query-Engine funktionieren (siehe DataFusion-AND-Workaround in db-adapter.js).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createDbAdapter } from "../lib/db-adapter.js";

const VECTOR_DIM = 8;
const AGENT = "pending-scan-agent";
const FILLER_COUNT = 260;

async function loadFreshPlugin() {
  return import(`../index.js?critical-pending-scan=${Date.now()}-${Math.random()}`);
}

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "critical-pending-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uuidFor(n) {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Seedet `FILLER_COUNT` unkritische Karten und DANACH die interessanten —
 * genau die Reihenfolge, in der der Klassifizierer real arbeitet.
 */
async function seedTable(pluginModule, baseDbPath, extras) {
  const db = new pluginModule.MemoryDB(join(baseDbPath, AGENT), VECTOR_DIM);
  const base = {
    vector: Array(VECTOR_DIM).fill(0.1),
    category: "fact",
    storedBy: AGENT,
    origin: "dm",
    trustLevel: "untrusted",
    status: "active",
    sourceMessageRole: "user",
  };
  for (let i = 0; i < FILLER_COUNT; i += 1) {
    await db.store({ ...base, id: uuidFor(i), text: `Füller ${i}`, type: "note", createdAt: Date.now() + i });
  }
  for (const [offset, extra] of extras.entries()) {
    await db.store({ ...base, id: uuidFor(FILLER_COUNT + offset), createdAt: Date.now() + FILLER_COUNT + offset, ...extra });
  }
  await db.shutdown();
}

describe("B2 findPendingCriticalReviews", () => {
  it("findet eine Critical-Karte auch jenseits der ersten 200 Zeilen", async (t) => {
    const baseDbPath = tempBase(t);
    const pluginModule = await loadFreshPlugin();
    const wantedId = uuidFor(FILLER_COUNT);
    await seedTable(pluginModule, baseDbPath, [
      { id: wantedId, text: "Blutdruckwerte von Eva", type: "gesundheit" },
    ]);

    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const pending = await adapter.findPendingCriticalReviews(AGENT);
      assert.deepEqual(pending.map((c) => c.id), [wantedId]);
    } finally {
      await adapter.shutdown();
    }
  });

  it("übergeht bestätigte und getombsteinte Karten", async (t) => {
    const baseDbPath = tempBase(t);
    const pluginModule = await loadFreshPlugin();
    const openId = uuidFor(FILLER_COUNT);
    const confirmedId = uuidFor(FILLER_COUNT + 1);
    const forgottenId = uuidFor(FILLER_COUNT + 2);
    await seedTable(pluginModule, baseDbPath, [
      { id: openId, text: "offen", type: "person" },
      { id: confirmedId, text: "schon bestätigt", type: "person", confirmed: true },
      { id: forgottenId, text: "vergessen", type: "zugang_passwort", status: "deleted", epistemicStatus: "invalidated" },
    ]);

    const adapter = createDbAdapter({ basePath: baseDbPath, logger: { info() {}, warn() {} } });
    try {
      const ids = (await adapter.findPendingCriticalReviews(AGENT)).map((c) => c.id);
      assert.ok(ids.includes(openId), "die offene Critical-Karte muss auftauchen");
      assert.equal(ids.includes(confirmedId), false, "bestätigte Karten gehören nicht in den Review-Stapel");
      assert.equal(ids.includes(forgottenId), false, "getombsteinte Karten dürfen nicht wieder auftauchen");
    } finally {
      await adapter.shutdown();
    }
  });
});
