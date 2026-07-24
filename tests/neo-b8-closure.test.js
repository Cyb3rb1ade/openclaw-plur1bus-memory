import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import {
  createNeoStore,
  migrateNeoWorkspaces,
  routeNeoRecall,
  workspaceKeyFromContext,
} from "../lib/neo-arch.js";
import { createNeoWorkerRuntime } from "../lib/neo-worker-runtime.js";

function root() {
  return mkdtempSync(join(tmpdir(), "plur1bus-neo-b8-"));
}

function startMutationWorker(moduleUrl, workerData) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { createNeoStore } = await import(workerData.moduleUrl);
      const store = createNeoStore(workerData.stateRoot, workerData.workspaceKey);
      parentPort.postMessage({ type: "attempting" });
      if (workerData.mutation === "candidate") {
        store.appendCandidates([workerData.record]);
      } else {
        store.markRunCompleted(workerData.runKey, workerData.meta);
      }
      parentPort.postMessage({ type: "done" });
    })().catch((error) => {
      parentPort.postMessage({ type: "error", error: error?.stack || String(error) });
    });
  `, { eval: true, workerData: { moduleUrl, ...workerData } });
  let resolveAttempting;
  let resolveDone;
  let rejectAttempting;
  let rejectDone;
  const attempting = new Promise((resolve, reject) => {
    resolveAttempting = resolve;
    rejectAttempting = reject;
  });
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  worker.on("message", (message) => {
    if (message?.type === "attempting") resolveAttempting();
    if (message?.type === "done") resolveDone();
    if (message?.type === "error") {
      const error = new Error(message.error);
      rejectAttempting(error);
      rejectDone(error);
    }
  });
  worker.on("error", (error) => {
    rejectAttempting(error);
    rejectDone(error);
  });
  return { worker, attempting, done };
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

  it("uses collision-resistant storage after an explicit legacy migration", () => {
    const stateRoot = root();
    const legacy = join(stateRoot, "workspaces", "tenant_a");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "memory-candidates.jsonl"), `${JSON.stringify({ id: "legacy", statement: "legacy", workspaceKey: "tenant/a" })}\n`);
    const slash = createNeoStore(stateRoot, "tenant/a");
    const underscore = createNeoStore(stateRoot, "tenant_a");
    assert.notEqual(slash.paths.workspaceDir, underscore.paths.workspaceDir);
    assert.equal(slash.readCandidates(10).length, 0);
    const migration = migrateNeoWorkspaces(stateRoot, { dryRun: false, requireBackup: false, mappings: [{ legacyKey: "tenant_a", workspaceKey: "tenant/a" }] });
    assert.equal(migration.ok, true);
    assert.equal(slash.readCandidates(10).some((record) => record.id === "legacy"), true);
    const ambiguous = migrateNeoWorkspaces(stateRoot, { mappings: [{ legacyKey: "tenant_a", workspaceKey: "tenant/a" }, { legacyKey: "tenant_a", workspaceKey: "tenant:a" }] });
    assert.equal(ambiguous.ok, false);
  });

  it("preserves workspace identity beyond the readable path prefix", () => {
    const sharedPrefix = "workspace-".padEnd(240, "x");
    const firstKey = `${sharedPrefix}-first`;
    const secondKey = `${sharedPrefix}-second`;
    const firstRouted = workspaceKeyFromContext({ workspaceKey: firstKey });
    const secondRouted = workspaceKeyFromContext({ workspaceKey: secondKey });
    assert.equal(firstRouted, firstKey);
    assert.equal(secondRouted, secondKey);
    const stateRoot = root();
    assert.notEqual(
      createNeoStore(stateRoot, firstRouted).paths.workspaceDir,
      createNeoStore(stateRoot, secondRouted).paths.workspaceDir,
    );
  });

  it("migrates an explicit same-name legacy mapping into canonical storage", () => {
    const stateRoot = root();
    const legacy = join(stateRoot, "workspaces", "foo");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "memory-candidates.jsonl"), `${JSON.stringify({
      id: "same-name-legacy",
      workspaceKey: "foo",
      statement: "same-name legacy record",
    })}\n`);
    const canonical = createNeoStore(stateRoot, "foo");
    assert.notEqual(canonical.paths.workspaceDir, legacy);
    const migration = migrateNeoWorkspaces(stateRoot, {
      dryRun: false,
      requireBackup: false,
      mappings: [{ legacyKey: "foo", workspaceKey: "foo" }],
    });
    assert.equal(migration.ok, true);
    assert.equal(migration.mappings.length, 1);
    assert.deepStrictEqual(canonical.readCandidates(10).map((record) => record.id), ["same-name-legacy"]);
  });

  it("merges nested JSON state without overwriting canonical collisions", () => {
    const stateRoot = root();
    const workspaceKey = "nested-state";
    const legacyKey = "nested_state";
    const legacy = join(stateRoot, "workspaces", legacyKey);
    const canonical = createNeoStore(stateRoot, workspaceKey);
    mkdirSync(legacy, { recursive: true });
    mkdirSync(canonical.paths.workspaceDir, { recursive: true });

    writeFileSync(join(legacy, "run-state.json"), JSON.stringify({
      completed: {
        legacyRun: { source: "legacy" },
        sharedRun: { source: "legacy", legacyDetail: true },
      },
    }));
    writeFileSync(canonical.paths.runs, JSON.stringify({
      completed: {
        canonicalRun: { source: "canonical" },
        sharedRun: { source: "canonical", canonicalDetail: true },
      },
    }));
    writeFileSync(join(legacy, "hook-state.json"), JSON.stringify({
      legacyHook: { count: 1 },
      sharedHook: { count: 1, legacyWatermark: "legacy", mode: "legacy" },
    }));
    writeFileSync(canonical.paths.hooks, JSON.stringify({
      canonicalHook: { count: 2 },
      sharedHook: { count: 3, canonicalWatermark: "canonical", mode: "canonical" },
    }));
    writeFileSync(join(legacy, "record-index.json"), JSON.stringify({
      version: 1,
      ids: {
        turns: ["shared-turn", "legacy-turn"],
        candidateContent: ["legacy-content"],
      },
      embeddingQueue: {
        statuses: { legacyEmbedding: "done", sharedEmbedding: "pending" },
      },
    }));
    writeFileSync(canonical.paths.index, JSON.stringify({
      version: 2,
      ids: {
        turns: ["canonical-turn", "shared-turn"],
        candidateContent: ["canonical-content"],
      },
      embeddingQueue: {
        statuses: { canonicalEmbedding: "done", sharedEmbedding: "done" },
      },
    }));

    const migration = migrateNeoWorkspaces(stateRoot, {
      dryRun: false,
      requireBackup: false,
      mappings: [{ legacyKey, workspaceKey }],
    });
    assert.equal(migration.ok, true);

    const runState = JSON.parse(readFileSync(canonical.paths.runs, "utf8"));
    assert.deepStrictEqual(runState.completed, {
      legacyRun: { source: "legacy" },
      canonicalRun: { source: "canonical" },
      sharedRun: {
        source: "canonical",
        legacyDetail: true,
        canonicalDetail: true,
      },
    });

    const hooks = JSON.parse(readFileSync(canonical.paths.hooks, "utf8"));
    assert.deepStrictEqual(hooks, {
      legacyHook: { count: 1 },
      canonicalHook: { count: 2 },
      sharedHook: {
        count: 3,
        legacyWatermark: "legacy",
        mode: "canonical",
        canonicalWatermark: "canonical",
      },
    });

    const index = JSON.parse(readFileSync(canonical.paths.index, "utf8"));
    assert.equal(index.version, 2);
    assert.deepStrictEqual(index.ids.turns, ["canonical-turn", "shared-turn", "legacy-turn"]);
    assert.deepStrictEqual(index.ids.candidateContent, ["canonical-content", "legacy-content"]);
    assert.deepStrictEqual(index.embeddingQueue.statuses, {
      legacyEmbedding: "done",
      sharedEmbedding: "done",
      canonicalEmbedding: "done",
    });
  });

  it("serializes migration snapshots with normal JSONL and JSON state writers", { timeout: 10_000 }, async () => {
    const stateRoot = root();
    const workspaceKey = "migration-race";
    const legacyKey = "migration_race";
    const legacy = join(stateRoot, "workspaces", legacyKey);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "memory-candidates.jsonl"), `${JSON.stringify({
      id: "legacy-candidate",
      workspaceKey,
      statement: "legacy candidate",
    })}\n`);
    writeFileSync(join(legacy, "run-state.json"), JSON.stringify({
      completed: { legacyRun: { source: "legacy" } },
    }));

    const moduleUrl = new URL("../lib/neo-arch.js", import.meta.url).href;
    const canonical = createNeoStore(stateRoot, workspaceKey);
    const gates = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const migrationWorker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { migrateNeoWorkspaces } = await import(workerData.moduleUrl);
        const gates = new Int32Array(workerData.gates);
        const gateByFile = new Map([
          ["memory-candidates.jsonl", 0],
          ["run-state.json", 1],
        ]);
        const result = migrateNeoWorkspaces(workerData.stateRoot, {
          dryRun: false,
          requireBackup: false,
          mappings: [{ legacyKey: workerData.legacyKey, workspaceKey: workerData.workspaceKey }],
          onMigrationTargetRead({ file }) {
            const gate = gateByFile.get(file);
            if (gate === undefined) return;
            Atomics.store(gates, gate, 1);
            parentPort.postMessage({ type: "target-read", file });
            Atomics.wait(gates, gate, 1);
          },
        });
        parentPort.postMessage({ type: "done", result });
      })().catch((error) => {
        parentPort.postMessage({ type: "error", error: error?.stack || String(error) });
      });
    `, {
      eval: true,
      workerData: { moduleUrl, stateRoot, workspaceKey, legacyKey, gates },
    });
    const targetReads = new Map();
    let resolveMigration;
    let rejectMigration;
    const migrationDone = new Promise((resolve, reject) => {
      resolveMigration = resolve;
      rejectMigration = reject;
    });
    const targetRead = (file) => {
      if (!targetReads.has(file)) {
        let resolveRead;
        const promise = new Promise((resolve) => { resolveRead = resolve; });
        targetReads.set(file, { promise, resolve: resolveRead });
      }
      return targetReads.get(file);
    };
    targetRead("memory-candidates.jsonl");
    targetRead("run-state.json");
    migrationWorker.on("message", (message) => {
      if (message?.type === "target-read") targetRead(message.file).resolve();
      if (message?.type === "done") resolveMigration(message.result);
      if (message?.type === "error") rejectMigration(new Error(message.error));
    });
    migrationWorker.on("error", rejectMigration);

    await targetRead("memory-candidates.jsonl").promise;
    const candidateWriter = startMutationWorker(moduleUrl, {
      stateRoot,
      workspaceKey,
      mutation: "candidate",
      record: { id: "live-candidate", workspaceKey, statement: "live candidate" },
    });
    await candidateWriter.attempting;
    const lockPath = join(canonical.paths.workspaceDir, ".neo-write.lock");
    if (!existsSync(lockPath)) await candidateWriter.done;
    Atomics.store(new Int32Array(gates), 0, 2);
    Atomics.notify(new Int32Array(gates), 0);

    await targetRead("run-state.json").promise;
    const stateWriter = startMutationWorker(moduleUrl, {
      stateRoot,
      workspaceKey,
      mutation: "state",
      runKey: "liveRun",
      meta: { source: "normal-writer" },
    });
    await stateWriter.attempting;
    if (!existsSync(lockPath)) await stateWriter.done;
    Atomics.store(new Int32Array(gates), 1, 2);
    Atomics.notify(new Int32Array(gates), 1);

    const [migration] = await Promise.all([
      migrationDone,
      candidateWriter.done,
      stateWriter.done,
    ]);
    assert.equal(migration.ok, true);
    const candidateIds = readFileSync(canonical.paths.candidates, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).id)
      .sort();
    assert.deepStrictEqual(candidateIds, ["legacy-candidate", "live-candidate"]);
    const runState = JSON.parse(readFileSync(canonical.paths.runs, "utf8"));
    assert.equal(runState.completed.legacyRun.source, "legacy");
    assert.equal(runState.completed.liveRun.source, "normal-writer");
  });

  it("persists a finite vector before reporting a fresh embedding and recalls lexical divergence semantically", async () => {
    const store = createNeoStore(root(), "vectors");
    const candidate = { id: "vector-1", workspaceKey: "vectors", agentId: "agent-a", statement: "feline companion", sourceTurnIds: ["turn-1"], status: "active", embeddingStatus: "pending", origin: { scope: "agent_private", trustLevel: "user_asserted" } };
    store.appendCandidates([candidate]);
    store.appendEmbeddingQueue([candidate]);
    const deferred = await store.drainEmbeddingQueue({ impact: "low" });
    assert.equal(deferred.processed, 0);
    assert.notEqual(store.readCandidates(10).at(-1).embeddingStatus, "fresh");
    const drained = await store.drainEmbeddingQueue({ impact: "low", embedder: () => [0, 1], dimensions: 2 });
    assert.equal(drained.processed, 1);
    const fresh = store.readCandidates(10).at(-1);
    assert.deepStrictEqual(fresh.embedding, [0, 1]);
    assert.equal(fresh.embeddingStatus, "fresh");
    const recalled = routeNeoRecall([fresh], "cat", { requesterAgentId: "agent-a", requesterWorkspaceKey: "vectors", queryVector: [0, 1], lanes: ["workspace_facts"], minScore: 0.6 });
    assert.equal(recalled.workspace_facts[0].item.id, "vector-1");
  });

  it("awaits a production-style async embedder before making a divergent query recallable", async () => {
    const store = createNeoStore(root(), "runtime-vectors");
    const candidate = { id: "runtime-vector", workspaceKey: "runtime-vectors", agentId: "agent-a", statement: "canine companion", sourceTurnIds: ["turn-1"], status: "active", embeddingStatus: "pending", origin: { scope: "agent_private", trustLevel: "untrusted" } };
    store.appendCandidates([candidate]);
    store.appendEmbeddingQueue([candidate]);
    const drained = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: async () => [1, 0] });
    assert.equal(drained.processed, 1);
    const stored = store.readCandidates(10).at(-1);
    assert.deepStrictEqual(stored.embedding, [1, 0]);
    assert.equal(routeNeoRecall([stored], "dog", { requesterAgentId: "agent-a", requesterWorkspaceKey: "runtime-vectors", queryVector: [1, 0], lanes: ["workspace_facts"], minScore: 0.6 }).workspace_facts[0].item.id, "runtime-vector");
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
