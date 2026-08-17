import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTombstoneToRegistry, buildTombstone } from "../lib/tombstone.js";
import { assertCardWriteAllowed } from "../lib/tombstone-write-guard.js";
import { executeCompactionMergeAction } from "../lib/jobs/memory-compaction.js";
import { selectCaptureRowsToAdd } from "../scripts/auto-capture-lancedb.mjs";
import { replaceLightDreamRow, strengthenMemory } from "../lib/dreaming/light-dream.js";
import { MemoryDB } from "../index.js";

const UUID = "00000000-0000-4000-8000-0000000000aa";

function forgotten(baseDbPath, text) {
  const tombstone = buildTombstone({
    card: { id: UUID, text, scope: "agent-private" },
    agentId: "agent-a",
    actor: "user",
    sourceOp: "forget",
  });
  appendTombstoneToRegistry(baseDbPath, "agent-a", { ...tombstone, status: "committed" });
}

function base() {
  const root = mkdtempSync(join(tmpdir(), "tomb-bulk-"));
  const baseDbPath = join(root, "lancedb-namespaced");
  mkdirSync(baseDbPath, { recursive: true });
  return { root, baseDbPath };
}

describe("tombstone bulk writers", () => {
  it("blocks compaction-shaped merge text", () => {
    const { root, baseDbPath } = base();
    forgotten(baseDbPath, "forgotten merge text");
    const guard = assertCardWriteAllowed({
      baseDbPath, agentId: "agent-a", text: "forgotten merge text", scope: "agent-private",
    });
    assert.equal(guard.allowed, false);
    assert.equal(guard.action, "tombstone_blocked");
    rmSync(root, { recursive: true, force: true });
  });

  it("blocks auto-capture-shaped row text", () => {
    const { root, baseDbPath } = base();
    forgotten(baseDbPath, "session capture of a forgotten fact");
    const guard = assertCardWriteAllowed({
      baseDbPath, agentId: "agent-a", text: "session capture of a forgotten fact", scope: "agent-private",
    });
    assert.equal(guard.allowed, false);
    rmSync(root, { recursive: true, force: true });
  });

  it("compaction merge does not table.add forgotten text and keeps both sources", async () => {
    const { root, baseDbPath } = base();
    forgotten(baseDbPath, "forgotten merge text");
    const idA = "00000000-0000-4000-8000-0000000000a1";
    const idB = "00000000-0000-4000-8000-0000000000a2";
    const statuses = { [idA]: "active", [idB]: "active" };
    let adds = 0;
    const table = {
      add: async () => { adds += 1; },
      update: async ({ where, values }) => {
        const id = String(where).match(/[0-9a-f-]{36}/i)?.[0];
        if (id) statuses[id] = values.status;
      },
    };
    const out = await executeCompactionMergeAction(
      table,
      { type: "merge", id: idA, targetId: idB, mergedText: "forgotten merge text" },
      new Map([
        [idA, { id: idA, text: "keep", scope: "agent-private", agentId: "agent-a", storedBy: "agent-a", vector: [0, 1] }],
        [idB, { id: idB, text: "other", scope: "agent-private", agentId: "agent-a", storedBy: "agent-a", vector: [0, 1] }],
      ]),
      { warn() {}, info() {} },
      join(root, "out"),
      null,
      { baseDbPath, agentId: "agent-a" },
    );
    assert.equal(out.error, "tombstone_blocked");
    assert.equal(out.added, false);
    assert.equal(adds, 0);
    assert.equal(statuses[idA], "active");
    assert.equal(statuses[idB], "active");
    rmSync(root, { recursive: true, force: true });
  });

  it("auto-capture does not table.add forgotten text or ack the checkpoint", async () => {
    const { root, baseDbPath } = base();
    forgotten(baseDbPath, "session capture of a forgotten fact");
    const record = { acknowledged: false };
    let adds = 0;
    const table = { add: async () => { adds += 1; } };
    const selected = selectCaptureRowsToAdd([{
      id: UUID,
      trimmed: "session capture of a forgotten fact",
      it: { _record: record },
    }], { baseDbPath, agentId: "agent-a" });
    assert.equal(selected.rowsToAdd.length, 0);
    assert.equal(selected.blocked.length, 1);
    if (selected.rowsToAdd.length > 0) await table.add(selected.rowsToAdd);
    assert.equal(adds, 0);
    assert.equal(record.acknowledged, false);
    rmSync(root, { recursive: true, force: true });
  });

  it("MemoryDB.store does not table.add forgotten text", async () => {
    const { root, baseDbPath } = base();
    forgotten(baseDbPath, "forgotten store text");
    const db = new MemoryDB(join(baseDbPath, "agent-a"), 4);
    db.init = async () => true;
    let adds = 0;
    db.table = { add: async () => { adds += 1; } };
    await assert.rejects(
      () => db.store({ id: UUID, text: "forgotten store text", agentId: "agent-a", storedBy: "agent-a", scope: "agent-private" }),
      /tombstone_blocked/,
    );
    assert.equal(adds, 0);
    rmSync(root, { recursive: true, force: true });
  });

  it("blocks light-dream content rewrite but not same-text replay", () => {
    const { root, baseDbPath } = base();
    forgotten(baseDbPath, "rewritten dream text");
    const rewrite = assertCardWriteAllowed({
      baseDbPath, agentId: "agent-a", text: "rewritten dream text", scope: "agent-private",
    });
    assert.equal(rewrite.allowed, false);
    const replay = assertCardWriteAllowed({
      baseDbPath, agentId: "agent-a", text: "unrelated replay bump", scope: "agent-private",
    });
    assert.equal(replay.allowed, true);
    rmSync(root, { recursive: true, force: true });
  });

  it("light-dream rewrite does not table.add forgotten text and keeps the source", async () => {
    const { root, baseDbPath } = base();
    forgotten(baseDbPath, "rewritten dream text");
    let adds = 0;
    let deleted = false;
    const row = {
      id: UUID, text: "original dream text", summary: "original dream text",
      scope: "agent-private", agentId: "agent-a", storedBy: "agent-a", vector: [0, 1],
    };
    const db = {
      dbPath: join(baseDbPath, "agent-a"),
      table: {
        delete: async () => { deleted = true; },
        add: async () => { adds += 1; },
      },
    };
    const out = await replaceLightDreamRow(db, row, { ...row, text: "rewritten dream text", summary: "rewritten dream text" });
    assert.equal(out.blocked, true);
    assert.equal(out.added, false);
    assert.equal(adds, 0);
    assert.equal(deleted, false);
    rmSync(root, { recursive: true, force: true });
  });

  it("light-dream same-text replay still table.adds", async () => {
    const { root, baseDbPath } = base();
    forgotten(baseDbPath, "rewritten dream text");
    let adds = 0;
    const row = {
      id: UUID, text: "unrelated replay bump", replayCount: 0, vector: [0, 1],
      scope: "agent-private", agentId: "agent-a", storedBy: "agent-a",
    };
    const db = {
      dbPath: join(baseDbPath, "agent-a"),
      table: {
        query: () => ({ where: () => ({ limit: () => ({ toArray: async () => [{ ...row }] }) }) }),
        update: async () => { throw new Error("update() not supported"); },
        delete: async () => {},
        add: async () => { adds += 1; },
      },
    };
    const ok = await strengthenMemory(db, UUID);
    assert.equal(ok, true);
    assert.equal(adds, 1);
    rmSync(root, { recursive: true, force: true });
  });
});
