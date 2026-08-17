import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createNeoStore, isDerivedRecordAccessible, stampDerivedVisibility } from "../lib/neo-arch.js";

describe("derived record ACL", () => {
  it("denies a foreign agent when visibility is missing", () => {
    assert.equal(isDerivedRecordAccessible(
      { agentId: "a" },
      { agentId: "b" },
    ), false);
  });

  it("allows the owning agent on a legacy unscoped row", () => {
    assert.equal(isDerivedRecordAccessible(
      { agentId: "a" },
      { agentId: "a" },
    ), true);
  });

  it("stamps visibility from agent and binding", () => {
    const stamped = stampDerivedVisibility(
      { id: "p1", agentId: "agent-a" },
      { scope: "agent-private", workspaceIdentity: "ws-a" },
    );
    assert.equal(stamped.visibility.agentId, "agent-a");
    assert.ok(stamped.visibility.scope);
    assert.equal(stamped.visibility.workspaceIdentity, "ws-a");
  });

  it("appendPatterns stamps visibility and hides the row from a foreign requester", () => {
    const root = mkdtempSync(join(tmpdir(), "derived-scope-"));
    try {
      const store = createNeoStore(root, "workspace-a");
      store.appendPatterns([{ id: "p1", agentId: "agent-a", patternKey: "k" }]);
      const own = store.readPatterns(10);
      assert.equal(own[0].visibility.agentId, "agent-a");
      assert.ok(own[0].visibility.scope);
      const foreign = store.readPatterns(10, { requesterAgentId: "agent-b" });
      assert.equal(foreign.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the owning agent read a legacy unstamped pattern", () => {
    const root = mkdtempSync(join(tmpdir(), "derived-legacy-"));
    try {
      const store = createNeoStore(root, "workspace-a");
      mkdirSync(dirname(store.paths.patterns), { recursive: true });
      writeFileSync(store.paths.patterns, `${JSON.stringify({ id: "legacy", agentId: "agent-a", patternKey: "old" })}\n`);
      const own = store.readPatterns(10, { requesterAgentId: "agent-a" });
      assert.equal(own.length, 1);
      const foreign = store.readPatterns(10, { requesterAgentId: "agent-b" });
      assert.equal(foreign.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
