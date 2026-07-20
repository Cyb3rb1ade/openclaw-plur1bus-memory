import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { AgentDbPool, MemoryDB } from "../index.js";

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
});
