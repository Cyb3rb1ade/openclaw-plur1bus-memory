/**
 * tests/engine-create-engine.test.js — step 9, part 2 (spec success criterion 1).
 *
 * createEngine(host, config) is the one construction path: it builds from a
 * stub host with no OpenClaw api anywhere, and index.js is the thin shell.
 * Also pins the MemoryDB.search() half-life fix that rides along: a row whose
 * halfLifeDays is null is resolved against the configured
 * recall.halfLifeDaysMap instead of throwing a ReferenceError.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { MemoryDB } from "../engine/store/memory-db.js";
import { AgentDbPool } from "../engine/store/agent-db-pool.js";
import { createStubHost } from "../lib/host-services.js";
import { runtimeSourcePath } from "./helpers/runtime-sources.js";
import { makeTempDir } from "./helpers/temp-dir.js";

function stubConfig(baseDbPath, overrides = {}) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    autoCapture: false, autoRecall: true,
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    ...overrides,
  };
}

describe("createEngine", () => {
  it("constructs from a stub host with no OpenClaw api anywhere", async () => {
    const baseDbPath = makeTempDir("plur1bus-create-engine-");
    const host = createStubHost({ stateDir: makeTempDir("plur1bus-create-engine-state-") });
    const engine = createEngine(host, stubConfig(baseDbPath));
    const internals = internalsOf(engine);
    assert.equal(typeof internals.pool.withDb, "function");
    assert.equal(typeof internals.runPlur1busCommand, "function", "the command runner is built without a registerCommand host");
    assert.equal(internals.jobs.list().length, 18);
    await engine.close({ budgetMs: 5_000 });
  });

  it("index.js is the thin shell", () => {
    const lines = readFileSync(runtimeSourcePath("index.js"), "utf8").split("\n").length;
    assert.ok(lines <= 220, `index.js has ${lines} lines`);
  });

  it("close() is idempotent", async () => {
    const engine = createEngine(createStubHost({ stateDir: makeTempDir("plur1bus-ce-state-") }), stubConfig(makeTempDir("plur1bus-ce-db-")));
    const first = engine.close({ budgetMs: 5_000 });
    const second = engine.close({ budgetMs: 5_000 });
    assert.equal(first, second, "the same promise");
    await first;
  });

  it("internalsOf rejects anything that is not an engine", () => {
    assert.throws(() => internalsOf({}), /not a PLUR1BUS engine/);
    assert.throws(() => internalsOf(null), /not a PLUR1BUS engine/);
  });

  it("every pool the engine opens carries the configured recall.halfLifeDaysMap", async () => {
    const halfLifeDaysMap = { transient: 7 };
    const engine = createEngine(
      createStubHost({ stateDir: makeTempDir("plur1bus-ce-hl-state-") }),
      stubConfig(makeTempDir("plur1bus-ce-hl-db-"), { recall: { halfLifeDaysMap } }),
    );
    const internals = internalsOf(engine);
    const probe = new internals.pool.AgentDbPool(makeTempDir("plur1bus-ce-hl-pool-"), 384);
    assert.ok(probe instanceof AgentDbPool);
    assert.equal(probe.halfLifeOverrides, internals.halfLifeOverrides, "the engine's own resolved map, not a copy");
    assert.equal(probe.halfLifeOverrides.transient, 7);
    await probe.shutdown();
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("MemoryDB.search() half-life resolution", () => {
  function stubbedDb(options) {
    const db = new MemoryDB(join(makeTempDir("plur1bus-hl-db-"), "agent"), 4, null, options);
    db.init = async () => true;
    db.table = { countRows: async () => 1 };
    db._read = (promise) => promise;
    db.vectorSearchActive = async () => [{
      id: "00000000-0000-4000-8000-00000000a001",
      text: "An invented fact row without a stored half-life.",
      category: "fact",
      memoryClass: "standard",
      halfLifeDays: null,
      _distance: 0,
    }];
    return db;
  }

  it("resolves a null halfLifeDays against the configured overrides instead of throwing", async () => {
    const [hit] = await stubbedDb({ halfLifeOverrides: { transient: 7 } }).search([0, 0, 0, 1], 5, 0);
    assert.equal(hit.entry.halfLifeDays, 7);
  });

  it("falls back to the built-in half-life map when no overrides are configured", async () => {
    const [hit] = await stubbedDb().search([0, 0, 0, 1], 5, 0);
    assert.equal(hit.entry.halfLifeDays, 60);
  });

  it("AgentDbPool.withOptions defaults the options but lets explicit ones win", async () => {
    const Bound = AgentDbPool.withOptions({ halfLifeOverrides: { transient: 7 } });
    const defaulted = new Bound(makeTempDir("plur1bus-hl-pool-"), 4);
    const explicit = new Bound(makeTempDir("plur1bus-hl-pool-"), 4, null, { halfLifeOverrides: { transient: 9 } });
    assert.deepEqual(defaulted.halfLifeOverrides, { transient: 7 });
    assert.deepEqual(explicit.halfLifeOverrides, { transient: 9 });
    await defaulted.shutdown();
    await explicit.shutdown();
  });
});
