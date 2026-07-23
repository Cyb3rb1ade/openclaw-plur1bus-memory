import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { SharedMemoryPool } from "../lib/shared-memory-pool.js";
import { safeAgentId } from "../lib/sql-safety.js";
import { workspacePoolKey } from "../lib/memory-request-context.js";
import { AgentDbPool } from "../index.js";

class FakeAgentDbPool {
  constructor(path, _dim, _logger, options = {}) { this.path = path; this.options = options; this.calls = []; }
  async withDb(id, fn) { this.calls.push(id); return fn({ path: join(this.path, id), dbPath: join(this.path, id) }); }
  async shutdown() { this.shutdownCalls = (this.shutdownCalls || 0) + 1; }
}

const workspaceA = { workspaceIdentity: "workspace:v1:alpha" };
const workspaceB = { workspaceIdentity: "workspace:v1:beta" };
const userA = { userPrincipal: "user:v1:telegram:one" };

describe("B13 shared memory pool", () => {
  it("routes workspaces and users to separate hashed physical roots", async () => {
    const base = mkdtempSync("/tmp/b13-shared-");
    try {
      const pool = new SharedMemoryPool(base, 4, FakeAgentDbPool);
      let workspacePath;
      await pool.withWorkspaceDb(workspaceA, async (db) => { workspacePath = db.path; assert.match(db.path, /\.plur1bus-shared\/workspaces\/w-[a-f0-9]{62}$/); });
      await pool.withWorkspaceDb(workspaceB, async (db) => assert.notEqual(db.path, workspacePath));
      await pool.withUserDb(userA, async (db) => { assert.match(db.path, /\.plur1bus-shared\/users\/u-[a-f0-9]{62}$/); assert.notEqual(db.path, workspacePath); });
      for (const key of [...pool.workspaceWritePool.calls, ...pool.userWritePool.calls]) {
        assert.equal(safeAgentId(key), key); assert.ok(key.length <= 64);
      }
      await pool.shutdown();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("fails closed for missing bindings and keeps raw identities out of paths", async () => {
    const base = mkdtempSync("/tmp/b13-shared-");
    try {
      const pool = new SharedMemoryPool(base, 4, FakeAgentDbPool);
      await assert.rejects(pool.withWorkspaceDb({}, async () => {}), /bound workspace/);
      await assert.rejects(pool.withUserDb({}, async () => {}), /authenticated user principal/);
      await pool.withWorkspaceDb({ workspaceIdentity: "../victim" }, async (db) => assert.equal(db.path.includes("../victim"), false));
      await pool.shutdown();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("does not create optional shared read routes and shutdown is permanent", async () => {
    const parent = mkdtempSync("/tmp/b13-shared-"); const base = join(parent, "missing", "base");
    try {
      const pool = new SharedMemoryPool(base, 4, FakeAgentDbPool);
      await pool.withWorkspaceReadDb(workspaceA, async (db) => assert.equal(db, null));
      assert.equal(existsSync(base), false);
      await pool.shutdown();
      await assert.rejects(async () => pool.withWorkspaceReadDb(workspaceA, async () => {}), /shutdown/);
      assert.equal(existsSync(base), false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("uses the real AgentDbPool lazily without opening LanceDB", async () => {
    const base = mkdtempSync("/tmp/b13-shared-");
    try {
      const pool = new SharedMemoryPool(base, 4, AgentDbPool);
      await pool.withWorkspaceReadDb(workspaceA, async (db) => assert.equal(db, null));
      assert.equal(existsSync(join(base, ".plur1bus-shared")), false);
      await pool.withWorkspaceDb(workspaceA, async (db) => {
        assert.match(db.dbPath, /\.plur1bus-shared\/workspaces\/w-[a-f0-9]{62}$/);
      });
      await pool.shutdown();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("returns absent without creating a missing shared kind or key route", async () => {
    const base = mkdtempSync("/tmp/b13-shared-");
    try {
      mkdirSync(join(base, ".plur1bus-shared"));
      const pool = new SharedMemoryPool(base, 4, FakeAgentDbPool);
      await pool.withWorkspaceReadDb(workspaceA, async (db) => assert.equal(db, null));
      await pool.withUserReadDb(userA, async (db) => assert.equal(db, null));
      assert.equal(existsSync(join(base, ".plur1bus-shared", "workspaces")), false);
      assert.equal(existsSync(join(base, ".plur1bus-shared", "users")), false);
      mkdirSync(join(base, ".plur1bus-shared", "workspaces", workspacePoolKey(workspaceA.workspaceIdentity)), { recursive: true });
      await pool.withWorkspaceReadDb(workspaceA, async (db) => assert.ok(db));
      await pool.withWorkspaceReadDb(workspaceB, async (db) => assert.equal(db, null));
      assert.equal(existsSync(join(base, ".plur1bus-shared", "workspaces", workspacePoolKey(workspaceB.workspaceIdentity))), false);
      assert.deepEqual(pool.workspaceReadPool.calls, [workspacePoolKey(workspaceA.workspaceIdentity)]);
      await pool.shutdown();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("keeps callback leases alive until settlement before shutdown", async () => {
    const base = mkdtempSync("/tmp/b13-shared-");
    try {
      const pool = new SharedMemoryPool(base, 4, FakeAgentDbPool);
      let release; const gate = new Promise((resolve) => { release = resolve; });
      const running = pool.withWorkspaceDb(workspaceA, async () => gate);
      await new Promise((resolve) => setImmediate(resolve));
      let settled = false; const stopping = pool.shutdown().then(() => { settled = true; });
      await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
      release(); await running; await stopping; assert.equal(settled, true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
