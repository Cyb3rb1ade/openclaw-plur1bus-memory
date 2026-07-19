import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MultiNamespacePool } from "../lib/multi-namespace-pool.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TMP_BASE = join(homedir(), ".openclaw", "memory");

// FakeAgentDbPool — no real LanceDB, just path-tracking
class FakeAgentDbPool {
  constructor(basePath, _vectorDim) {
    this.basePath = basePath;
    this.isShutdown = false;
    this.active = new Map();
    this.events = [];
  }
  getDb(agentId) {
    if (this.isShutdown) throw new Error("FakeAgentDbPool is shutdown");
    return { dbPath: join(this.basePath, agentId) };
  }
  async withDb(agentId, fn) {
    if (this.isShutdown) throw new Error("FakeAgentDbPool is shutdown");
    this.active.set(agentId, (this.active.get(agentId) || 0) + 1);
    this.events.push({ event: "acquire", agentId, basePath: this.basePath });
    try {
      return await fn(this.getDb(agentId));
    } finally {
      const next = (this.active.get(agentId) || 1) - 1;
      if (next === 0) this.active.delete(agentId);
      else this.active.set(agentId, next);
      this.events.push({ event: "release", agentId, basePath: this.basePath });
    }
  }
  async shutdown() { this.isShutdown = true; }
}

describe("MultiNamespacePool", () => {
  it("getWriteDb gives DB from activeWriteNamespace", () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local", activeRecallNamespaces: ["lancedb-local"] };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const db = pool.getWriteDb("default");
    assert.ok(db);
    assert.ok(db.dbPath.includes("lancedb-local"), `Expected lancedb-local in: ${db.dbPath}`);
  });

  it("getWriteDb does NOT return a legacyReadOnly namespace", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      legacyReadOnlyNamespaces: ["lancedb-old"],
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const db = pool.getWriteDb("default");
    assert.ok(!db.dbPath.includes("lancedb-old"), `Write-DB points to legacyReadOnly: ${db.dbPath}`);
  });

  it("getReadDbs returns active + legacy when crossNamespaceRecall=true", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const dbs = pool.getReadDbs("default");
    assert.strictEqual(dbs.length, 2);
    assert.ok(dbs.some(d => d.namespace === "lancedb-new"));
    assert.ok(dbs.some(d => d.namespace === "lancedb-old"));
  });

  it("getReadDbs returns only active when crossNamespaceRecall=false", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: false,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const dbs = pool.getReadDbs("default");
    assert.strictEqual(dbs.length, 1);
    assert.strictEqual(dbs[0].namespace, "lancedb-new");
  });

  it("getDb (backward-compat) delegates to getWriteDb", () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local" };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const a = pool.getDb("default");
    const b = pool.getWriteDb("default");
    assert.strictEqual(a.dbPath, b.dbPath);
  });

  it("withWriteDb holds only the active write namespace through callback settlement", async () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let callbackStarted;
    const started = new Promise((resolve) => { callbackStarted = resolve; });
    const operation = pool.withWriteDb("agent-a", async (db) => {
      assert.ok(db.dbPath.includes("lancedb-new"));
      const writePool = pool._pools.get("lancedb-new");
      assert.equal(writePool.active.get("agent-a"), 1);
      assert.equal(pool._pools.has("lancedb-old"), false, "write lease must not acquire read-only namespaces");
      callbackStarted();
      await gate;
      return "write-result";
    });

    await started;
    assert.equal(pool._pools.get("lancedb-new").active.get("agent-a"), 1);
    release();
    assert.equal(await operation, "write-result");
    assert.equal(pool._pools.get("lancedb-new").active.has("agent-a"), false);
  });

  it("withReadDbs preserves configured order and holds every namespace lease", async () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new", "lancedb-second"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);

    const result = await pool.withReadDbs("agent-a", async (dbs) => {
      assert.deepEqual(dbs.map((entry) => entry.namespace), ["lancedb-new", "lancedb-second", "lancedb-old"]);
      assert.deepEqual(
        dbs.map((entry) => entry.db.dbPath),
        [
          join(TMP_BASE, "lancedb-new", "agent-a"),
          join(TMP_BASE, "lancedb-second", "agent-a"),
          join(TMP_BASE, "lancedb-old", "agent-a"),
        ],
      );
      for (const { namespace } of dbs) {
        assert.equal(pool._pools.get(namespace).active.get("agent-a"), 1, `${namespace} must remain leased`);
      }
      return dbs.map((entry) => entry.namespace).join(",");
    });

    assert.equal(result, "lancedb-new,lancedb-second,lancedb-old");
    for (const namespace of ["lancedb-new", "lancedb-second", "lancedb-old"]) {
      assert.equal(pool._pools.get(namespace).active.has("agent-a"), false, `${namespace} must release after success`);
    }
  });

  it("releases every namespace lease when the callback rejects", async () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const failure = new Error("read callback failed");

    await assert.rejects(
      () => pool.withReadDbs("agent-a", async () => { throw failure; }),
      (err) => err === failure,
    );
    for (const namespace of ["lancedb-new", "lancedb-old"]) {
      assert.equal(pool._pools.get(namespace).active.has("agent-a"), false, `${namespace} must release after error`);
    }
  });

  it("withDb remains a backward-compatible lease alias for withWriteDb", async () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local" };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const result = await pool.withDb("agent-a", async (db) => db.dbPath);
    assert.equal(result, join(TMP_BASE, "lancedb-local", "agent-a"));
    assert.equal(pool._pools.get("lancedb-local").active.has("agent-a"), false);
  });

  it("shutdown destroys all pools", async () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    pool.getReadDbs("default"); // initialize pools
    await assert.doesNotReject(() => pool.shutdown());
  });

  it("aggregates namespace-contextual shutdown failures", async () => {
    const failures = new Map([
      ["lancedb-new", new Error("new namespace close failed")],
      ["lancedb-old", new Error("old namespace close failed")],
    ]);
    class FailingAgentDbPool extends FakeAgentDbPool {
      async shutdown() {
        this.isShutdown = true;
        const namespace = this.basePath.split(/[/\\]/).pop();
        throw failures.get(namespace);
      }
    }
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FailingAgentDbPool);
    pool.getReadDbs("agent-a");

    await assert.rejects(pool.shutdown(), (err) => {
      assert.ok(err instanceof AggregateError);
      assert.equal(err.errors.length, 2);
      assert.deepEqual(err.errors.map((failure) => failure.namespace), ["lancedb-new", "lancedb-old"]);
      assert.deepEqual(err.errors.map((failure) => failure.cause), [...failures.values()]);
      return true;
    });
    assert.equal(pool._pools.size, 0, "pool state clears even when namespace shutdown fails");
  });

  it("rejects child creation and leased work after terminal shutdown", async () => {
    const pool = new MultiNamespacePool(
      TMP_BASE,
      { activeWriteNamespace: "lancedb-new" },
      384,
      FakeAgentDbPool,
    );

    await pool.shutdown();
    await assert.rejects(
      () => pool.withWriteDb("agent-a", async () => "must-not-run"),
      /shutdown/i,
    );
    assert.throws(() => pool._getPool("lancedb-late"), /shutdown/i);
    assert.equal(pool._pools.size, 0, "post-shutdown calls must not create an untracked child pool");
    await assert.doesNotReject(() => pool.shutdown(), "terminal shutdown remains idempotent");
  });

  it("waits for an active namespace lease and coalesces concurrent shutdown", async () => {
    let releaseOperation;
    let markOperationStarted;
    const operationGate = new Promise((resolve) => { releaseOperation = resolve; });
    const operationStarted = new Promise((resolve) => { markOperationStarted = resolve; });

    class CountingShutdownPool extends FakeAgentDbPool {
      constructor(...args) {
        super(...args);
        this.shutdownCalls = 0;
      }

      async shutdown() {
        this.shutdownCalls++;
        this.isShutdown = true;
      }
    }

    const nsCfg = { activeWriteNamespace: "lancedb-new" };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, CountingShutdownPool);
    const operation = pool.withWriteDb("agent-a", async () => {
      markOperationStarted();
      await operationGate;
      return "operation-complete";
    });
    await operationStarted;
    const child = pool._pools.get("lancedb-new");

    const firstShutdown = pool.shutdown();
    const secondShutdown = pool.shutdown();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(child.shutdownCalls, 0, "shutdown must not close a child while its top-level lease is active");

      pool.nsCfg.activeWriteNamespace = "lancedb-late";
      await assert.rejects(
        () => pool.withWriteDb("agent-b", async () => "must-not-run"),
        /shutdown/i,
      );
      assert.equal(pool._pools.has("lancedb-late"), false, "concurrent shutdown must reject a late child");
    } finally {
      releaseOperation();
    }

    assert.equal(await operation, "operation-complete");
    await Promise.all([firstShutdown, secondShutdown]);
    assert.equal(child.shutdownCalls, 1, "concurrent shutdown calls must share one child-close pass");
    await pool.shutdown();
    assert.equal(child.shutdownCalls, 1, "repeated shutdown must remain idempotent");
  });
});
