// 7.21.4: less synchronous work per agent_end on the main thread — the Neo
// embedding drain skips an unchanged queue and reads only appended lines,
// the graph dedupe uses an incremental existence index.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createNeoStore, EMBEDDING_DEFERRED_RETRY_MS, readJsonlRange, resetEmbeddingDrainCheckpoints } from "../lib/neo-arch.js";
import { graphEdgeDedupeKeys, graphEdgeExistenceIndex, resetGraphEdgeIndexes } from "../lib/graph-edge-index.js";
import { readBoundGraph } from "../lib/memory-graph.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const candidate = (id) => ({ id, workspaceKey: "ws", agentId: "agent-a", statement: `statement ${id}`, sourceTurnIds: [`turn-${id}`], status: "active", embeddingStatus: "pending", origin: { scope: "agent_private", trustLevel: "user_asserted" } });

function countingEmbedder(vector = [1, 0]) {
  const calls = [];
  return { calls, embed: async (text) => { calls.push(text); return vector; } };
}

afterEach(() => {
  resetEmbeddingDrainCheckpoints();
  resetGraphEdgeIndexes();
});

describe("7.21.4 embedding drain checkpoint", () => {
  it("skips an unchanged queue and reads only appended lines", async () => {
    const store = createNeoStore(makeTempDir("plur1bus-7214-drain-"), "ws");
    store.appendCandidates([candidate("a"), candidate("b")]);
    store.appendEmbeddingQueue([candidate("a"), candidate("b")]);
    const first = countingEmbedder();
    const drained = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: first.embed });
    assert.equal(drained.processed, 2);

    const second = countingEmbedder();
    const unchanged = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: second.embed });
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.processed, 0);
    assert.equal(second.calls.length, 0);

    store.appendCandidates([candidate("c")]);
    store.appendEmbeddingQueue([candidate("c")]);
    const third = countingEmbedder();
    const appended = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: third.embed });
    assert.equal(appended.processed, 1);
    assert.deepEqual(third.calls, ["statement c"]);
    assert.equal(store.readCandidates(10).filter((c) => c.id === "c").at(-1)?.embeddingStatus, "fresh");
  });

  it("retries an embedder failure only after the retry interval, a missing embedder at once", async () => {
    const store = createNeoStore(makeTempDir("plur1bus-7214-deferred-"), "ws");
    store.appendCandidates([candidate("d")]);
    store.appendEmbeddingQueue([candidate("d")]);
    const noEmbedder = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2 });
    assert.equal(noEmbedder.processed, 0);
    const failing = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: async () => { throw new Error("down"); } });
    assert.equal(failing.deferred, 1, "embedder_unavailable is retried as soon as an embedder is given");

    const working = countingEmbedder();
    const soon = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: working.embed });
    assert.equal(soon.unchanged, true);
    assert.equal(working.calls.length, 0);

    const later = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: working.embed, now: Date.now() + EMBEDDING_DEFERRED_RETRY_MS + 1_000 });
    assert.equal(later.processed, 1);
  });

  it("reads a rewritten queue in full", async () => {
    const store = createNeoStore(makeTempDir("plur1bus-7214-rewrite-"), "ws");
    store.appendCandidates([candidate("e"), candidate("f")]);
    store.appendEmbeddingQueue([candidate("e")]);
    await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: async () => [1, 0] });
    // A rewrite with a new inode (like retention) that adds an open entry.
    const queuePath = store.paths.embeddings;
    const fresh = `${queuePath}.new`;
    writeFileSync(fresh, readFileSync(queuePath, "utf8"));
    store.appendEmbeddingQueue([candidate("f")]);
    appendFileSync(fresh, readFileSync(queuePath, "utf8").split("\n").filter(Boolean).slice(-1).join("\n") + "\n");
    renameSync(fresh, queuePath);
    const embedder = countingEmbedder();
    const drained = await store.drainEmbeddingQueue({ impact: "low", dimensions: 2, embedder: embedder.embed });
    assert.equal(drained.processed, 1);
    assert.deepEqual(embedder.calls, ["statement f"]);
  });

  it("readJsonlRange stops at the last complete line", () => {
    const path = join(makeTempDir("plur1bus-7214-range-"), "q.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":');
    const size = readFileSync(path).length;
    const { records, nextOffset } = readJsonlRange(path, 0, size);
    assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
    assert.equal(nextOffset, 16);
  });
});

const owner = { schemaVersion: 1, scope: "agent-private", agentId: "agent-a", workspaceIdentity: "workspace:v1:ws", ownerUserId: "" };
const bound = (source, target, type = "semantic", directed = false) => ({ source, target, type, directed, strength: 0.7, ownershipStatus: "bound", sourceOwnership: owner, targetOwnership: owner, ownership: { source: owner, target: owner } });

function adjacencyHas(adjacency, source, target, type) {
  return Boolean(adjacency.get(source)?.find((e) => e.target === target && e.type === type));
}

describe("7.21.4 graph edge existence index", () => {
  it("matches readBoundGraph's adjacency, window included", () => {
    const store = createNeoStore(makeTempDir("plur1bus-7214-graph-"), "ws");
    const edges = [
      bound("m1", "m2"),
      bound("m2", "m3", "entity", true),
      { source: "m4", target: "m5", type: "semantic", strength: 0.9 }, // unbound
      bound("m6", "m7", "episode"),
      bound("m8", "m9"),
    ];
    store.appendGraphEdges(edges);
    for (const limit of [10_000, 3]) {
      resetGraphEdgeIndexes();
      const index = graphEdgeExistenceIndex(store, limit);
      const { adjacency } = readBoundGraph(store.readGraphEdges(limit));
      if (limit === 10_000) assert.ok(index.has("m1", "m2", "semantic"), "fixture edges are bound");
      const ids = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9"];
      for (const a of ids) for (const b of ids) for (const t of ["semantic", "entity", "episode"]) {
        assert.equal(index.has(a, b, t), adjacencyHas(adjacency, a, b, t), `limit=${limit} ${a}->${b} ${t}`);
      }
    }
  });

  it("sees appended edges and rebuilds after a rewrite", () => {
    const store = createNeoStore(makeTempDir("plur1bus-7214-graph-append-"), "ws");
    store.appendGraphEdges([bound("x1", "x2")]);
    assert.equal(graphEdgeExistenceIndex(store).has("x2", "x1", "semantic"), true);
    store.appendGraphEdges([bound("x3", "x4", "entity", true)]);
    const index = graphEdgeExistenceIndex(store);
    assert.equal(index.has("x3", "x4", "entity"), true);
    assert.equal(index.has("x4", "x3", "entity"), false, "directed edge only one way");
    writeFileSync(`${store.paths.graph}.new`, `${JSON.stringify(bound("y1", "y2"))}\n`);
    renameSync(`${store.paths.graph}.new`, store.paths.graph);
    const rebuilt = graphEdgeExistenceIndex(store);
    assert.equal(rebuilt.has("x1", "x2", "semantic"), false);
    assert.equal(rebuilt.has("y1", "y2", "semantic"), true);
  });

  it("only bound edges produce keys", () => {
    assert.deepEqual(graphEdgeDedupeKeys({ source: "a", target: "b", type: "semantic" }), []);
    assert.equal(graphEdgeDedupeKeys(bound("a", "b")).length, 2);
    assert.equal(graphEdgeDedupeKeys(bound("a", "b", "semantic", true)).length, 1);
  });
});
