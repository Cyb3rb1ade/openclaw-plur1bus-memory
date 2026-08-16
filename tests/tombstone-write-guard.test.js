import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTombstoneToRegistry, buildTombstone } from "../lib/tombstone.js";
import { assertCardWriteAllowed, isContentChangingUpdate } from "../lib/tombstone-write-guard.js";

const UUID = "00000000-0000-4000-8000-000000000001";

describe("tombstone write guard", () => {
  it("blocks same-scope forgotten text and allows a foreign agent", () => {
    const root = mkdtempSync(join(tmpdir(), "tomb-guard-"));
    const baseDbPath = join(root, "lancedb-namespaced");
    mkdirSync(baseDbPath, { recursive: true });
    const tombstone = buildTombstone({
      card: { id: UUID, text: "secret address berlin", scope: "agent-private" },
      agentId: "agent-a",
      actor: "user",
      sourceOp: "forget",
    });
    appendTombstoneToRegistry(baseDbPath, "agent-a", { ...tombstone, status: "committed" });
    const blocked = assertCardWriteAllowed({
      baseDbPath,
      agentId: "agent-a",
      text: "Secret Address Berlin",
      scope: "agent-private",
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.action, "tombstone_blocked");
    const foreign = assertCardWriteAllowed({
      baseDbPath,
      agentId: "agent-b",
      text: "Secret Address Berlin",
      scope: "agent-private",
    });
    assert.equal(foreign.allowed, true);
    rmSync(root, { recursive: true, force: true });
  });

  it("treats metadata-only patches as non-content", () => {
    assert.equal(isContentChangingUpdate({ text: "a", summary: "s" }, { replayCount: 2 }), false);
    assert.equal(isContentChangingUpdate({ text: "a" }, { text: "a" }), false);
    assert.equal(isContentChangingUpdate({ text: "a" }, { text: "b" }), true);
  });

  it("blocks when the registry cannot be read", () => {
    const blocked = assertCardWriteAllowed({
      baseDbPath: "/tmp/this-path-should-not-exist-plur1bus-tombstones-xyz",
      agentId: "agent-a",
      text: "anything",
      scope: "agent-private",
    });
    // Missing registry is empty (no tombstones), not corrupt. Corrupt is fail-closed.
    assert.equal(blocked.allowed, true);
  });
});
