/**
 * 7.20.6: Entitaetskanten ueber Capture-Laeufe hinweg.
 *
 * Bis 7.20.5 entstanden Entitaetskanten nur innerhalb eines Laufs: topics und
 * entities werden nicht in LanceDB gespeichert, die Bestandszeilen kamen ohne
 * sie (und ohne Text) in buildEdgesForSession an. Zudem las getRecentForGraph
 * die ersten Zeilen in Speicherreihenfolge — die aeltesten — statt der neuesten.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as lancedb from "@lancedb/lancedb";

import { buildEdgesForSession, withGraphSignals } from "../lib/memory-graph.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const table = (rows) => ({ vectorSearch: () => ({ limit: () => ({ toArray: async () => rows }) }) });

describe("withGraphSignals", () => {
  it("leitet topics und entities aus dem Text ab, wenn sie fehlen", () => {
    const row = withGraphSignals({ id: "a", text: "Andrew took Toby to the Riverside Park on Sunday." });
    assert.ok(row.topics.includes("andrew"));
    assert.ok(row.topics.includes("toby"));
    assert.equal(row.graphSignalsDerived, true);
  });

  it("laesst vorhandene Signale und Zeilen ohne Text unveraendert", () => {
    const own = { id: "b", text: "Andrew and Toby", topics: ["x", "y"] };
    assert.equal(withGraphSignals(own), own);
    const bare = { id: "c" };
    assert.equal(withGraphSignals(bare), bare);
  });
});

describe("buildEdgesForSession ueber Laufgrenzen", () => {
  const older = {
    id: "old-1",
    text: "Andrew adopted Toby from the Riverside Shelter.",
    emotionalDominant: "joy",
    emotionalIntensity: 0.8,
    createdAt: iso(NOW - 40 * 86_400_000),
  };
  const fresh = {
    id: "new-1",
    topics: ["andrew", "toby", "riverside shelter"],
    entities: ["Andrew", "Toby", "Riverside Shelter"],
    emotionalDominant: "joy",
    emotionalIntensity: 0.8,
    createdAt: iso(NOW),
  };

  it("verbindet eine neue Zeile mit einer Bestandszeile ohne gespeicherte Themen", async () => {
    const edges = await buildEdgesForSession([fresh], [older, fresh], table([]), null);
    const entity = edges.filter((e) => e.type === "entity");
    assert.equal(entity.length, 1);
    assert.deepEqual([entity[0].source, entity[0].target].sort(), ["new-1", "old-1"]);
  });

  it("abgeleitete Themen erzeugen keine emotionalen Kanten", async () => {
    const edges = await buildEdgesForSession([fresh], [older, fresh], table([]), null);
    assert.equal(edges.filter((e) => e.type === "emotional").length, 0);
  });

  it("eigene Themen beider Seiten erzeugen weiterhin emotionale Kanten", async () => {
    const withOwn = { ...older, topics: ["andrew", "toby"] };
    const edges = await buildEdgesForSession([fresh], [withOwn, fresh], table([]), null);
    assert.ok(edges.some((e) => e.type === "emotional"));
  });
});

describe("MemoryDB.getRecentForGraph", () => {
  const DIM = 4;
  const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

  async function makeTable(dir, ages) {
    // Aelteste zuerst eingefuegt: Speicherreihenfolge = aufsteigendes Alter.
    const rows = ages.map((ageDays, i) => ({
      id: uuid(i),
      text: `Erinnerung ${i}`,
      summary: "",
      vector: Array(DIM).fill(0.1),
      status: "active",
      memoryKind: "memory",
      category: "fact",
      createdAt: NOW - ageDays * 86_400_000,
      sessionId: "",
      sourceTurnId: "",
      agentId: "graph-agent",
      workspaceId: "",
    }));
    const db = await lancedb.connect(dir);
    await db.createTable("memories", rows);
  }

  async function open(dir) {
    const plugin = await import(`../index.js?graph-recent=${NOW}-${Math.random()}`);
    const db = new plugin.MemoryDB(dir, DIM, null, { readOnly: true });
    await db.init();
    return db;
  }

  it("liefert die neuesten Zeilen, nicht die zuerst gespeicherten", async (t) => {
    const dir = join(makeTempDir("graph-recent-"), "graph-agent");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // 300 Zeilen, aelteste zuerst: Alter 299 … 0 Tage.
    await makeTable(dir, Array.from({ length: 300 }, (_, i) => 299 - i));
    const db = await open(dir);
    try {
      const rows = await db.getRecentForGraph({ limit: 10, now: NOW, fields: ["id", "createdAt", "text"] });
      assert.equal(rows.length, 10);
      assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 10 }, (_, i) => uuid(299 - i)));
      assert.equal(rows[0].text, "Erinnerung 299", "der Text kommt fuer die Themenableitung mit");
    } finally {
      await db.shutdown();
    }
  });

  it("erweitert das Zeitfenster, wenn die letzten Tage zu wenig Zeilen haben", async (t) => {
    const dir = join(makeTempDir("graph-recent-old-"), "graph-agent");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await makeTable(dir, [400, 300, 200, 100, 50]);
    const db = await open(dir);
    try {
      const rows = await db.getRecentForGraph({ limit: 3, now: NOW });
      assert.deepEqual(rows.map((r) => r.id), [uuid(4), uuid(3), uuid(2)]);
    } finally {
      await db.shutdown();
    }
  });
});
