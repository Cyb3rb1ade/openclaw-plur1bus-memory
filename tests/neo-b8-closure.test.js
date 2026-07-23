import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNeoStore,
  routeNeoRecall,
} from "../lib/neo-arch.js";
import { createNeoWorkerRuntime } from "../lib/neo-worker-runtime.js";

function root() {
  return mkdtempSync(join(tmpdir(), "plur1bus-neo-b8-"));
}

describe("Neo B8 closure", () => {
  it("filters every recall scope before scoring and fails closed without bindings", () => {
    const rows = [
      { id: "private-a", workspaceKey: "team", agentId: "agent-a", statement: "needle alpha", category: "project_fact", origin: { scope: "agent_private", trustLevel: "user_asserted" } },
      { id: "shared", workspaceKey: "team", statement: "needle shared", category: "project_fact", origin: { scope: "workspace_shared", trustLevel: "user_asserted" } },
      { id: "global-owner", workspaceKey: "other", ownerId: "owner-a", statement: "needle global", category: "project_fact", origin: { scope: "global_user", trustLevel: "user_asserted" } },
    ];
    const selected = routeNeoRecall(rows, "needle", { requesterAgentId: "agent-b", requesterWorkspaceKey: "team", requesterOwnerId: "owner-a", lanes: ["workspace_facts"], maxPerLane: 10 });
    assert.deepStrictEqual(selected.workspace_facts.map((row) => row.item.id).sort(), ["global-owner", "shared"]);
    assert.deepStrictEqual(routeNeoRecall(rows, "needle", { lanes: ["workspace_facts"], maxPerLane: 10 }).workspace_facts, []);
  });

  it("uses collision-resistant storage while reading mapped legacy data", () => {
    const stateRoot = root();
    const legacy = join(stateRoot, "workspaces", "tenant_a");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "memory-candidates.jsonl"), `${JSON.stringify({ id: "legacy", statement: "legacy", workspaceKey: "tenant/a" })}\n`);
    const slash = createNeoStore(stateRoot, "tenant/a");
    const underscore = createNeoStore(stateRoot, "tenant_a");
    assert.notEqual(slash.paths.workspaceDir, underscore.paths.workspaceDir);
    assert.equal(slash.readCandidates(10).some((record) => record.id === "legacy"), true);
  });

  it("persists a finite vector before reporting a fresh embedding and recalls lexical divergence semantically", () => {
    const store = createNeoStore(root(), "vectors");
    const candidate = { id: "vector-1", workspaceKey: "vectors", agentId: "agent-a", statement: "feline companion", sourceTurnIds: ["turn-1"], status: "active", embeddingStatus: "pending", origin: { scope: "agent_private", trustLevel: "user_asserted" } };
    store.appendCandidates([candidate]);
    store.appendEmbeddingQueue([candidate]);
    const deferred = store.drainEmbeddingQueue({ impact: "low" });
    assert.equal(deferred.processed, 0);
    assert.notEqual(store.readCandidates(10).at(-1).embeddingStatus, "fresh");
    const drained = store.drainEmbeddingQueue({ impact: "low", embedder: () => [0, 1], dimensions: 2 });
    assert.equal(drained.processed, 1);
    const fresh = store.readCandidates(10).at(-1);
    assert.deepStrictEqual(fresh.embedding, [0, 1]);
    assert.equal(fresh.embeddingStatus, "fresh");
    const recalled = routeNeoRecall([fresh], "cat", { requesterAgentId: "agent-a", requesterWorkspaceKey: "vectors", queryVector: [0, 1], lanes: ["workspace_facts"], minScore: 0.6 });
    assert.equal(recalled.workspace_facts[0].item.id, "vector-1");
  });

  it("rejects new work deterministically once worker admission is full", async () => {
    const runtime = createNeoWorkerRuntime({ maxQueue: 0 });
    try {
      await assert.rejects(runtime.runNeoAgentEnd({ messages: [] }, {}, { rootDir: root() }), /backpressure|queue/i);
    } finally {
      await runtime.close();
    }
  });
});
