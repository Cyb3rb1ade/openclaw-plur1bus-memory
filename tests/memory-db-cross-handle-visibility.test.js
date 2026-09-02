/**
 * LanceDB-Sichtbarkeit zwischen zwei Tabellen-Handles desselben Prozesses.
 *
 * Im 2026.8.2-Labor sah der Gateway-interne rem-dream-Leser drei per
 * memory_store committete Zeilen über zwei Minuten nicht, während ein frischer
 * Prozess sie nach 1,3 s sah. Ohne Konsistenzintervall frischt LanceDB ein
 * einmal geöffnetes Tabellenobjekt nicht auf; Schreibvorgänge über ein anderes
 * Handle bleiben unsichtbar, bis das Objekt neu geöffnet wird.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../index.js";

const DIM = 8;
const vector = (seed) => Array.from({ length: DIM }, (_, i) => Math.sin(seed + i));
const row = (id, seed) => ({
  id,
  type: "memory",
  memoryKind: "memory",
  text: `cross-handle visibility ${id}`,
  vector: vector(seed),
  category: "fact",
  importance: 0.5,
  scope: "agent-private",
  agentId: "lab-alpha",
  storedBy: "lab-alpha",
  workspaceId: "",
  workspaceKey: "",
  epistemicStatus: "untrusted",
  status: "active",
});

describe("MemoryDB: writes through one handle are visible to another open handle", () => {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-cross-handle-"));
  const handles = [];
  after(async () => {
    for (const db of handles) await db.shutdown().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("a reader opened before a later write still sees that write", async () => {
    const writer = new MemoryDB(join(dir, "lab-alpha"), DIM);
    handles.push(writer);
    await writer.init();
    await writer.store(row("first", 1));

    const reader = new MemoryDB(join(dir, "lab-alpha"), DIM);
    handles.push(reader);
    await reader.init();
    const before = await reader.table.query().where("id != '__schema__'").limit(10).toArray();
    assert.deepEqual(before.map((r) => r.id), ["first"]);

    await writer.store(row("second", 2));
    const after = await reader.table.query().where("id != '__schema__'").limit(10).toArray();
    assert.deepEqual(after.map((r) => r.id).sort(), ["first", "second"],
      "the reader handle must not stay on the table version it was opened with");
  });
});
