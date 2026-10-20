/**
 * tests/consolidate-daily-graph-prune.test.js — engine-jobs audit F2.
 *
 * consolidate-daily read the graph edges, awaited a LanceDB scan, then replaced
 * the whole edge file with the stale kept-list. An edge that capture appended
 * during the await was lost. The prune now removes only the edges it judged,
 * reading the current file and writing it back under ONE workspace lock (the
 * pattern of removeGraphEdgesTouching / memory.unimport).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

import { createInternalJobBodies } from "../engine/jobs/internal-job-bodies.js";
import { createStubHost } from "../lib/host-services.js";
import { createNeoStore } from "../lib/neo-arch.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const NOW = Date.now();
const edge = (source, target, extra = {}) => ({ source, target, type: "temporal", strength: 0.6, directed: false, createdAt: new Date(NOW - 86_400_000).toISOString(), observations: 2, ...extra });
const key = (e) => `${e.source}>${e.target}`;

function setup({ duringScan } = {}) {
  const store = createNeoStore(makeTempDir("graph-prune-"), "ws");
  store.appendGraphEdges([edge("m1", "m2"), edge("m1", "gone"), edge("m2", "m3")]);
  const liveRows = [{ id: "m1", status: "active" }, { id: "m2", status: "active" }, { id: "m3", status: "active" }];
  const pool = {
    withDb: async (_agent, fn) => fn({
      table: {
        query: () => ({
          select() { return this; },
          limit() { return this; },
          toArray: async () => {
            // The scan takes a while; capture keeps writing meanwhile.
            if (duringScan) await duringScan(store);
            return liveRows;
          },
        }),
      },
    }),
  };
  const run = createInternalJobBodies({
    host: createStubHost(),
    cfg: {},
    pool,
    formatJsonCommandResult: (value) => JSON.stringify(value),
  });
  const execute = () => run("consolidate-daily", {
    input: { commandCtx: { agentId: "a" }, memoryCtx: {}, commandStore: store, cronInternal: true },
    skip: (_r, out) => out,
    incomplete: (_r, out) => out,
  });
  return { store, execute };
}

const graphKeys = (store) => store.readGraphEdges(1000).map(key).sort();

describe("consolidate-daily graph prune (F2)", () => {
  it("keeps an edge that capture appended while the scan was running", async () => {
    const { store, execute } = setup({
      duringScan: async (s) => { s.appendGraphEdges([edge("m1", "m-new"), edge("m3", "m1")]); },
    });
    const result = JSON.parse(await execute());
    assert.equal(result.graphPrune?.error, undefined, JSON.stringify(result.graphPrune));
    assert.deepEqual(graphKeys(store), ["m1>m-new", "m1>m2", "m2>m3", "m3>m1"], "dangling edge gone, concurrent appends kept (also the one to a memory the scan never saw)");
    assert.equal(result.graphPrune.removedMissing, 1);
  });

  it("still removes the dangling edge and keeps the live ones when nothing runs concurrently", async () => {
    const { store, execute } = setup();
    const result = JSON.parse(await execute());
    assert.deepEqual(graphKeys(store), ["m1>m2", "m2>m3"]);
    assert.equal(result.graphPrune.before, 3);
    assert.equal(result.graphPrune.after, 2);
  });

  it("does not rewrite the file when there is nothing to prune", async () => {
    const { store, execute } = setup();
    store.rewriteGraphEdges([edge("m1", "m2")]);
    const before = statSync(store.paths.graph).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await execute();
    assert.equal(statSync(store.paths.graph).mtimeMs, before);
  });
});

describe("neo store updateGraphEdges", () => {
  it("reads and writes under one lock: the transform sees the current records", () => {
    const store = createNeoStore(makeTempDir("graph-update-"), "ws");
    store.appendGraphEdges([edge("a", "b"), edge("b", "c")]);
    const seen = [];
    store.updateGraphEdges((records) => { seen.push(records.map(key)); return records.filter((r) => r.source !== "a"); });
    assert.deepEqual(seen, [["a>b", "b>c"]]);
    assert.deepEqual(graphKeys(store), ["b>c"]);
  });

  it("leaves the file untouched when the transform returns null", () => {
    const store = createNeoStore(makeTempDir("graph-update-"), "ws");
    store.appendGraphEdges([edge("a", "b")]);
    const bytes = readFileSync(store.paths.graph, "utf8");
    store.updateGraphEdges(() => null);
    assert.equal(readFileSync(store.paths.graph, "utf8"), bytes);
  });
});
