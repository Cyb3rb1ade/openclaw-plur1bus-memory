/**
 * db-adapter: Sichtbarkeit von Zeilen, die nach dem Öffnen des Adapter-Handles
 * über eine andere Verbindung geschrieben werden.
 *
 * Der Adapter hält pro Agent ein Tabellenobjekt im Cache, Captures schreibt
 * MemoryDB über eine eigene Verbindung. Ohne Konsistenzintervall blieb das
 * Adapter-Handle auf seiner Öffnungsversion: classify-recent sah zwischen zwei
 * Gateway-Neustarts keine neuen Karten, nach dem Neustart kamen alle Pushes
 * der letzten 24 h auf einmal, ältere wurden nie klassifiziert (10.11.2026).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryDB } from "../index.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const DIM = 8;
const AGENT = "lab-alpha";
const vector = (seed) => Array.from({ length: DIM }, (_, i) => Math.sin(seed + i));
const row = (id, seed) => ({
  id,
  type: "memory",
  memoryKind: "memory",
  text: `adapter cross-handle visibility ${id}`,
  vector: vector(seed),
  category: "fact",
  importance: 0.5,
  scope: "agent-private",
  agentId: AGENT,
  storedBy: AGENT,
  workspaceId: "",
  workspaceKey: "",
  epistemicStatus: "untrusted",
  status: "active",
});

describe("db-adapter: rows written through MemoryDB after the adapter opened its table", () => {
  const dir = makeTempDir("plur1bus-adapter-cross-handle-");
  const handles = [];
  after(async () => {
    for (const db of handles) await db.shutdown().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("findRecentUnclassified sees a card stored after the first scan", async () => {
    const writer = new MemoryDB(join(dir, AGENT), DIM);
    handles.push(writer);
    await writer.init();
    await writer.store(row("first", 1));

    const adapter = createDbAdapter({ basePath: dir, logger: {} });
    const before = await adapter.findRecentUnclassified(AGENT);
    assert.deepEqual(before.map((c) => c.id), ["first"]);

    // Der Adapter hat beim Öffnen Spalten ergänzt. Im Betrieb kennt der
    // Capture-Schreiber sie längst; ein frisch geöffneter Schreiber bildet das ab.
    const capture = new MemoryDB(join(dir, AGENT), DIM);
    handles.push(capture);
    await capture.init();
    await capture.store(row("second", 2));
    const afterScan = await adapter.findRecentUnclassified(AGENT);
    assert.deepEqual(afterScan.map((c) => c.id).sort(), ["first", "second"],
      "the cached adapter table must not stay on the version it was opened with");
  });
});
