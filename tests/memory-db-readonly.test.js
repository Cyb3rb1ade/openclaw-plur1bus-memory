import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { AgentDbPool, MemoryDB } from "../index.js";
import { MultiNamespacePool } from "../lib/multi-namespace-pool.js";
import { resolveNamespaceLayout } from "../lib/namespace-config.js";

const VECTOR_DIM = 3;

describe("read-only MemoryDB", { concurrency: false }, () => {
  it("opens and queries a minimal existing memories table without changing its schema", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-readonly-existing-"));
    const agentPath = join(root, "agent-a");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixture = await lancedb.connect(agentPath);
    const table = await fixture.createTable("memories", [{
      id: "legacy-row", text: "legacy content", vector: [0.1, 0.2, 0.3], importance: 0.8,
    }], { mode: "overwrite" });
    const before = (await table.schema()).fields.map(({ name, type }) => [name, String(type)]);
    await table.close();
    await fixture.close();

    const db = new MemoryDB(agentPath, VECTOR_DIM, null, { readOnly: true });
    assert.equal(await db.init(), true);
    const after = (await db.table.schema()).fields.map(({ name, type }) => [name, String(type)]);
    assert.deepEqual(after, before);
    assert.deepEqual((await db.table.query().toArray()).map(({ id, text }) => ({ id, text })), [
      { id: "legacy-row", text: "legacy content" },
    ]);
    await db.shutdown();
  });

  it("returns false without creating a missing agent path", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-readonly-missing-"));
    const agentPath = join(root, "missing-agent");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const db = new MemoryDB(agentPath, VECTOR_DIM, null, { readOnly: true });
    assert.equal(await db.init(), false);
    assert.equal(db.table, null);
    assert.equal(existsSync(agentPath), false);
  });

  it("returns false without creating a table in an existing empty directory", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-readonly-empty-"));
    const agentPath = join(root, "agent-a");
    mkdirSync(agentPath);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const db = new MemoryDB(agentPath, VECTOR_DIM, null, { readOnly: true });
    assert.equal(await db.init(), false);
    assert.equal(db.table, null);
    const fixture = await lancedb.connect(agentPath);
    assert.deepEqual(await fixture.tableNames(), []);
    await fixture.close();
  });

  it("rejects every mutation entrypoint before invoking an underlying table mutation", async () => {
    const counters = { add: 0, delete: 0, update: 0, createIndex: 0, query: 0 };
    const db = new MemoryDB("/unused/read-only", VECTOR_DIM, null, { readOnly: true });
    db.initPromise = Promise.resolve(true);
    db.table = {
      add() { counters.add += 1; },
      delete() { counters.delete += 1; },
      update() { counters.update += 1; },
      createIndex() { counters.createIndex += 1; },
      query() { counters.query += 1; return { where() { return this; }, limit() { return this; }, toArray: async () => [] }; },
      countRows: async () => 1000,
    };
    const id = "123e4567-e89b-42d3-a456-426614174000";
    await assert.rejects(() => db.store({ text: "blocked" }), /read-only/i);
    await assert.rejects(() => db.delete(id), /read-only/i);
    await assert.rejects(() => db.update(id, { text: "blocked" }), /read-only/i);
    await assert.rejects(() => db.purgeExpired(), /read-only/i);
    await assert.rejects(() => db._maybeReindex(), /read-only/i);
    assert.throws(() => db.purgeExpiredThrottled(), /read-only/i);
    assert.deepEqual(counters, { add: 0, delete: 0, update: 0, createIndex: 0, query: 0 });
  });

  it("revalidates a cached initialized DB before any later read or write use", async () => {
    let trusted = true;
    const counters = { add: 0, countRows: 0 };
    const writable = new MemoryDB("/unused/cached-write", VECTOR_DIM, null, {
      pathGuard() {
        if (!trusted) throw new Error("trusted path changed");
      },
    });
    writable.initPromise = Promise.resolve(true);
    writable.table = {
      add() { counters.add += 1; return Promise.resolve(); },
      countRows() { counters.countRows += 1; return Promise.resolve(0); },
    };
    trusted = false;

    await assert.rejects(() => writable.init(), /trusted path changed/i);
    await assert.rejects(
      () => writable.store({ text: "blocked cached write", vector: [0.1, 0.2, 0.3] }),
      /trusted path changed/i,
    );
    await assert.rejects(
      () => writable.search([0.1, 0.2, 0.3]),
      /trusted path changed/i,
    );
    assert.deepEqual(counters, { add: 0, countRows: 0 });
  });

  it("validates agent IDs and never creates paths in a read-only AgentDbPool", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-readonly-pool-"));
    const missingBase = join(root, "legacy");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pool = new AgentDbPool(missingBase, VECTOR_DIM, null, { readOnly: true });
    assert.throws(() => pool.getDb("../escape"), /invalid agent/i);
    await assert.rejects(() => pool.withDb("bad/name", async () => {}), /invalid agent/i);
    const db = pool.getDb("agent-a");
    assert.equal(db.readOnly, true);
    assert.equal(await db.init(), false);
    assert.equal(existsSync(missingBase), false);
    await pool.shutdown();
  });

  it("rejects an active namespace swapped outside after MemoryDB caching and never writes there", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-open-guard-active-root-"));
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-open-guard-active-outside-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(root, "active"));
    const layout = resolveNamespaceLayout(root, { activeWriteNamespace: "active" }, { explicit: true });
    const pool = new MultiNamespacePool(layout, VECTOR_DIM, AgentDbPool);
    const db = pool.getWriteDb("agent-a");
    assert.equal(db.table, null, "fixture must cache without opening LanceDB");

    rmSync(join(root, "active"), { recursive: true });
    symlinkSync(outside, join(root, "active"));
    await assert.rejects(
      () => db.store({ text: "must never escape", vector: [0.1, 0.2, 0.3] }),
      /canonical|target|changed|traversal|outside/i,
    );
    assert.equal(existsSync(join(outside, "agent-a")), false, "native connect must not create an outside agent DB");
    assert.deepEqual(await lancedb.connect(outside).then(async (handle) => {
      const names = await handle.tableNames();
      await handle.close();
      return names;
    }), []);
    await pool.shutdown();
  });

  it("rejects a legacy namespace swapped outside after MemoryDB caching and never reads or mutates it", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-open-guard-legacy-root-"));
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-open-guard-legacy-outside-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(root, "active"));
    const legacyAgentPath = join(root, "legacy", "agent-a");
    const legacyFixture = await lancedb.connect(legacyAgentPath);
    const legacyTable = await legacyFixture.createTable("memories", [{
      id: "inside-row", text: "inside", vector: [0.1, 0.2, 0.3], importance: 0.5,
    }], { mode: "overwrite" });
    await legacyTable.close();
    await legacyFixture.close();
    const outsideAgentPath = join(outside, "agent-a");
    const outsideFixture = await lancedb.connect(outsideAgentPath);
    const outsideTable = await outsideFixture.createTable("memories", [{
      id: "outside-row", text: "outside sentinel", vector: [0.1, 0.2, 0.3], importance: 0.9,
    }], { mode: "overwrite" });
    const normalizeRows = (rows) => rows.map(({ id, text, vector, importance }) => ({
      id, text, vector: Array.from(vector), importance,
    }));
    const beforeRows = normalizeRows(await outsideTable.query().toArray());
    const beforeSchema = (await outsideTable.schema()).fields.map(({ name, type }) => [name, String(type)]);
    await outsideTable.close();
    await outsideFixture.close();

    const layout = resolveNamespaceLayout(root, {
      activeWriteNamespace: "active",
      activeRecallNamespaces: ["active"],
      legacyReadOnlyNamespaces: ["legacy"],
      crossNamespaceRecall: true,
    }, { explicit: true });
    const pool = new MultiNamespacePool(layout, VECTOR_DIM, AgentDbPool);
    const legacyDb = pool.getReadDbs("agent-a").find(({ namespace }) => namespace === "legacy").db;
    assert.equal(legacyDb.table, null, "fixture must cache without opening LanceDB");

    rmSync(join(root, "legacy"), { recursive: true });
    symlinkSync(outside, join(root, "legacy"));
    await assert.rejects(
      () => legacyDb.init(),
      /canonical|target|changed|traversal|outside/i,
    );

    const verify = await lancedb.connect(outsideAgentPath);
    const verifyTable = await verify.openTable("memories");
    assert.deepEqual(
      normalizeRows(await verifyTable.query().toArray()),
      beforeRows,
      "outside rows must not be read through or mutated",
    );
    assert.deepEqual(
      (await verifyTable.schema()).fields.map(({ name, type }) => [name, String(type)]),
      beforeSchema,
      "read-only open guard must not migrate outside schema",
    );
    await verifyTable.close();
    await verify.close();
    await pool.shutdown();
  });

  it("rejects an active agent path swapped outside after MemoryDB caching", async (t) => {
    const basePath = mkdtempSync(join(tmpdir(), "plur1bus-open-agent-active-base-"));
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-open-agent-active-outside-"));
    t.after(() => rmSync(basePath, { recursive: true, force: true }));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const pool = new AgentDbPool(basePath, VECTOR_DIM);
    const db = pool.getDb("agent-a");
    symlinkSync(outside, join(basePath, "agent-a"));

    await assert.rejects(
      () => db.store({ text: "must never escape", vector: [0.1, 0.2, 0.3] }),
      /canonical|target|changed|traversal|outside/i,
    );
    const outsideDb = await lancedb.connect(outside);
    assert.deepEqual(await outsideDb.tableNames(), []);
    await outsideDb.close();
    await pool.shutdown();
  });

  it("rejects a read-only agent path swapped outside after MemoryDB caching", async (t) => {
    const basePath = mkdtempSync(join(tmpdir(), "plur1bus-open-agent-readonly-base-"));
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-open-agent-readonly-outside-"));
    t.after(() => rmSync(basePath, { recursive: true, force: true }));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const insideAgent = join(basePath, "agent-a");
    const insideFixture = await lancedb.connect(insideAgent);
    const insideTable = await insideFixture.createTable("memories", [{
      id: "inside-row", text: "inside", vector: [0.1, 0.2, 0.3], importance: 0.5,
    }], { mode: "overwrite" });
    await insideTable.close();
    await insideFixture.close();
    const outsideFixture = await lancedb.connect(outside);
    const outsideTable = await outsideFixture.createTable("memories", [{
      id: "outside-row", text: "outside", vector: [0.1, 0.2, 0.3], importance: 0.9,
    }], { mode: "overwrite" });
    const before = (await outsideTable.query().toArray()).map(({ id, text }) => ({ id, text }));
    await outsideTable.close();
    await outsideFixture.close();
    const pool = new AgentDbPool(basePath, VECTOR_DIM, null, { readOnly: true });
    const db = pool.getDb("agent-a");

    rmSync(insideAgent, { recursive: true });
    symlinkSync(outside, insideAgent);
    await assert.rejects(() => db.init(), /canonical|target|changed|traversal|outside/i);
    const verify = await lancedb.connect(outside);
    const verifyTable = await verify.openTable("memories");
    assert.deepEqual(
      (await verifyTable.query().toArray()).map(({ id, text }) => ({ id, text })),
      before,
    );
    await verifyTable.close();
    await verify.close();
    await pool.shutdown();
  });
});
