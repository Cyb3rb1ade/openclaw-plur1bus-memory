import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTombstoneToRegistry, buildTombstone } from "../lib/tombstone.js";
import { assertCardWriteAllowed } from "../lib/tombstone-write-guard.js";
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
});
