import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MultiNamespacePool } from "../lib/multi-namespace-pool.js";
import { resolveNamespaceLayout } from "../lib/namespace-config.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_BASE = mkdtempSync(join(tmpdir(), "plur1bus-multi-ns-"));
after(() => rmSync(TMP_BASE, { recursive: true, force: true }));

function namedLayout(nsCfg) {
  return resolveNamespaceLayout(TMP_BASE, nsCfg, { explicit: true });
}

function legacyLayout(baseDbPath = TMP_BASE) {
  return resolveNamespaceLayout(baseDbPath, {}, { explicit: false });
}

function forgedFrozenLayout(overrides = {}) {
  const freezeArray = (value) => Object.freeze([...(value || [])]);
  return Object.freeze({
    mode: "named",
    baseDir: TMP_BASE,
    baseDbPath: TMP_BASE,
    activeWriteNamespace: "active",
    activeRecallNamespaces: freezeArray(overrides.activeRecallNamespaces ?? ["active"]),
    legacyReadOnlyNamespaces: freezeArray(overrides.legacyReadOnlyNamespaces ?? ["legacy"]),
    recallReadNamespaces: freezeArray(overrides.recallReadNamespaces ?? ["active", "legacy"]),
    crossNamespaceRecall: overrides.crossNamespaceRecall ?? true,
    ...overrides,
  });
}

// FakeAgentDbPool — no real LanceDB, just path-tracking
class FakeAgentDbPool {
  static constructed = [];

  constructor(basePath, _vectorDim, _logger, options) {
    this.basePath = basePath;
    this.options = options;
    this.isShutdown = false;
    this.active = new Map();
    this.events = [];
    this.getCalls = [];
    FakeAgentDbPool.constructed.push(this);
  }
  getDb(agentId) {
    if (this.isShutdown) throw new Error("FakeAgentDbPool is shutdown");
    this.getCalls.push(agentId);
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
  it("routes legacy-flat agents directly below the exact base path", () => {
    const customBase = join(TMP_BASE, "custom-flat");
    mkdirSync(customBase, { recursive: true });
    const pool = new MultiNamespacePool(legacyLayout(customBase), 384, FakeAgentDbPool);
    assert.equal(pool.getWriteDb("agent-a").dbPath, join(customBase, "agent-a"));
    assert.deepEqual(pool.getReadDbs("agent-a").map(({ namespace }) => namespace), [null]);
  });

  it("getWriteDb gives DB from activeWriteNamespace", () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local", activeRecallNamespaces: ["lancedb-local"] };
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
    const db = pool.getWriteDb("default");
    assert.ok(db);
    assert.ok(db.dbPath.includes("lancedb-local"), `Expected lancedb-local in: ${db.dbPath}`);
  });

  it("getWriteDb does NOT return a legacyReadOnly namespace", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      legacyReadOnlyNamespaces: ["lancedb-old"],
    };
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
    const dbs = pool.getReadDbs("default");
    assert.strictEqual(dbs.length, 1);
    assert.strictEqual(dbs[0].namespace, "lancedb-new");
  });

  it("getDb (backward-compat) delegates to getWriteDb", () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local" };
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);

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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FakeAgentDbPool);
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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, FailingAgentDbPool);
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
    const pool = new MultiNamespacePool(namedLayout({ activeWriteNamespace: "lancedb-new" }), 384, FakeAgentDbPool);

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
    const pool = new MultiNamespacePool(namedLayout(nsCfg), 384, CountingShutdownPool);
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

  it("validates malicious agent IDs through every public alias before child use", async () => {
    const pool = new MultiNamespacePool(namedLayout({ activeWriteNamespace: "active" }), 384, FakeAgentDbPool);
    const invalidIds = ["../escape", "bad/name", "bad\\name", ".", 7, { id: "agent" }];
    for (const agentId of invalidIds) {
      assert.throws(() => pool.getWriteDb(agentId), /invalid agent/i);
      assert.throws(() => pool.getReadDbs(agentId), /invalid agent/i);
      assert.throws(() => pool.getDb(agentId), /invalid agent/i);
      await assert.rejects(() => pool.withWriteDb(agentId, async () => {}), /invalid agent/i);
      await assert.rejects(() => pool.withReadDbs(agentId, async () => {}), /invalid agent/i);
      await assert.rejects(() => pool.withDb(agentId, async () => {}), /invalid agent/i);
    }
    assert.equal(pool._pools.size, 0);
  });

  it("rejects an outside symlink and canonical route collision before creating a child", () => {
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-outside-"));
    const symlinkRoot = mkdtempSync(join(tmpdir(), "plur1bus-route-root-"));
    try {
      symlinkSync(outside, join(symlinkRoot, "outside"));
      const outsideLayout = resolveNamespaceLayout(symlinkRoot, {
        activeWriteNamespace: "outside",
      }, { explicit: true });
      FakeAgentDbPool.constructed.length = 0;
      assert.throws(() => new MultiNamespacePool(outsideLayout, 384, FakeAgentDbPool), /traversal|outside/i);
      assert.equal(FakeAgentDbPool.constructed.length, 0);

      mkdirSync(join(symlinkRoot, "shared"));
      symlinkSync(join(symlinkRoot, "shared"), join(symlinkRoot, "alias-a"));
      symlinkSync(join(symlinkRoot, "shared"), join(symlinkRoot, "alias-b"));
      const collisionLayout = resolveNamespaceLayout(symlinkRoot, {
        activeWriteNamespace: "alias-a",
        activeRecallNamespaces: ["alias-a", "alias-b"],
      }, { explicit: true });
      FakeAgentDbPool.constructed.length = 0;
      assert.throws(() => new MultiNamespacePool(collisionLayout, 384, FakeAgentDbPool), /collision|same canonical/i);
      assert.equal(FakeAgentDbPool.constructed.length, 0);
    } finally {
      rmSync(symlinkRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("revalidates all routes before creating each late child", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-late-route-root-"));
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-late-route-outside-"));
    try {
      mkdirSync(join(root, "active"));
      mkdirSync(join(root, "legacy"));
      const layout = resolveNamespaceLayout(root, {
        activeWriteNamespace: "active",
        activeRecallNamespaces: ["active"],
        legacyReadOnlyNamespaces: ["legacy"],
        crossNamespaceRecall: true,
      }, { explicit: true });
      const pool = new MultiNamespacePool(layout, 384, FakeAgentDbPool);
      pool.getWriteDb("agent-a");
      assert.equal(pool._pools.has("active"), true);
      assert.equal(pool._pools.has("legacy"), false);

      rmSync(join(root, "legacy"), { recursive: true });
      symlinkSync(outside, join(root, "legacy"));
      assert.throws(() => pool.getReadDbs("agent-a"), /traversal|outside/i);
      assert.equal(pool._pools.has("legacy"), false, "late invalid route must not create a child");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a cached legacy read route swapped to an outside symlink before reuse", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-cached-legacy-root-"));
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-cached-legacy-outside-"));
    try {
      mkdirSync(join(root, "active"));
      mkdirSync(join(root, "legacy"));
      const layout = resolveNamespaceLayout(root, {
        activeWriteNamespace: "active",
        activeRecallNamespaces: ["active"],
        legacyReadOnlyNamespaces: ["legacy"],
        crossNamespaceRecall: true,
      }, { explicit: true });
      const pool = new MultiNamespacePool(layout, 384, FakeAgentDbPool);
      pool.getReadDbs("first");
      const activeChild = pool._pools.get("active");
      const legacyChild = pool._pools.get("legacy");
      assert.equal(activeChild.getCalls.length, 1);
      assert.equal(legacyChild.getCalls.length, 1);

      rmSync(join(root, "legacy"), { recursive: true });
      symlinkSync(outside, join(root, "legacy"));
      assert.throws(() => pool.getReadDbs("second"), /traversal|outside/i);
      assert.equal(activeChild.getCalls.length, 1, "full validation must reject before any cached read child use");
      assert.equal(legacyChild.getCalls.length, 1, "cached legacy child must not be reused after route swap");
      assert.equal(existsSync(join(outside, "second")), false, "outside agent path must remain untouched");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a cached active writer route swapped to an outside symlink before reuse", () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-cached-writer-root-"));
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-cached-writer-outside-"));
    try {
      mkdirSync(join(root, "active"));
      const layout = resolveNamespaceLayout(root, {
        activeWriteNamespace: "active",
      }, { explicit: true });
      const pool = new MultiNamespacePool(layout, 384, FakeAgentDbPool);
      pool.getWriteDb("first");
      const activeChild = pool._pools.get("active");
      assert.equal(activeChild.getCalls.length, 1);

      rmSync(join(root, "active"), { recursive: true });
      symlinkSync(outside, join(root, "active"));
      assert.throws(() => pool.getWriteDb("second"), /traversal|outside/i);
      assert.equal(activeChild.getCalls.length, 1, "cached writer must not be reused after route swap");
      assert.equal(existsSync(join(outside, "second")), false, "outside writer path must remain untouched");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects whole named-root substitution before the first child is created", () => {
    const parent = mkdtempSync(join(tmpdir(), "plur1bus-root-swap-parent-"));
    const root = join(parent, "named-root");
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-root-swap-outside-"));
    try {
      mkdirSync(join(root, "active"), { recursive: true });
      mkdirSync(join(outside, "active"));
      const layout = resolveNamespaceLayout(root, { activeWriteNamespace: "active" }, { explicit: true });
      const pool = new MultiNamespacePool(layout, 384, FakeAgentDbPool);
      rmSync(root, { recursive: true });
      symlinkSync(outside, root);

      assert.throws(() => pool.getWriteDb("agent-a"), /root|canonical|changed|outside|traversal/i);
      assert.equal(pool._pools.size, 0, "root substitution must reject before child creation");
      assert.equal(existsSync(join(outside, "active", "agent-a")), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects whole named-root substitution before reusing a cached writer", () => {
    const parent = mkdtempSync(join(tmpdir(), "plur1bus-cached-root-swap-parent-"));
    const root = join(parent, "named-root");
    const outside = mkdtempSync(join(tmpdir(), "plur1bus-cached-root-swap-outside-"));
    try {
      mkdirSync(join(root, "active"), { recursive: true });
      mkdirSync(join(outside, "active"));
      const layout = resolveNamespaceLayout(root, { activeWriteNamespace: "active" }, { explicit: true });
      const pool = new MultiNamespacePool(layout, 384, FakeAgentDbPool);
      pool.getWriteDb("first");
      const child = pool._pools.get("active");
      assert.equal(child.getCalls.length, 1);

      rmSync(root, { recursive: true });
      symlinkSync(outside, root);
      assert.throws(() => pool.getWriteDb("second"), /root|canonical|changed|outside|traversal/i);
      assert.equal(child.getCalls.length, 1, "cached writer must not be used through a substituted root");
      assert.equal(existsSync(join(outside, "active", "second")), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects mutable and internally inconsistent forged layouts", () => {
    assert.throws(() => new MultiNamespacePool({
      mode: "legacy-flat",
      baseDir: TMP_BASE,
      baseDbPath: TMP_BASE,
      activeRecallNamespaces: [],
      legacyReadOnlyNamespaces: [],
      recallReadNamespaces: [],
    }, 384, FakeAgentDbPool), /frozen/i);
    assert.throws(() => new MultiNamespacePool(Object.freeze({
      mode: "named",
      baseDir: TMP_BASE,
      baseDbPath: TMP_BASE,
      activeWriteNamespace: "active",
      activeRecallNamespaces: ["active"],
      legacyReadOnlyNamespaces: ["legacy"],
      recallReadNamespaces: ["active", "legacy"],
      crossNamespaceRecall: true,
    }), 384, FakeAgentDbPool), /frozen array/i);

    const invalidNamedLayouts = [
      forgedFrozenLayout({ activeWriteNamespace: "." }),
      forgedFrozenLayout({ activeWriteNamespace: "bad/name", activeRecallNamespaces: Object.freeze(["bad/name"]) }),
      forgedFrozenLayout({ activeWriteNamespace: "bad\\name", activeRecallNamespaces: Object.freeze(["bad\\name"]) }),
      forgedFrozenLayout({ activeRecallNamespaces: Object.freeze(["other"]), recallReadNamespaces: Object.freeze(["other", "legacy"]) }),
      forgedFrozenLayout({ legacyReadOnlyNamespaces: Object.freeze(["active"]), recallReadNamespaces: Object.freeze(["active"]) }),
      forgedFrozenLayout({ recallReadNamespaces: Object.freeze(["legacy", "active"]) }),
      forgedFrozenLayout({ crossNamespaceRecall: false, recallReadNamespaces: Object.freeze(["active", "legacy"]) }),
      forgedFrozenLayout({ crossNamespaceRecall: true, recallReadNamespaces: Object.freeze(["active"]) }),
    ];
    for (const layout of invalidNamedLayouts) {
      assert.throws(() => new MultiNamespacePool(layout, 384, FakeAgentDbPool), /invalid|namespace|layout|order|recall|overlap/i);
    }

    const empty = Object.freeze([]);
    for (const layout of [
      Object.freeze({
        mode: "legacy-flat", baseDir: TMP_BASE, baseDbPath: join(TMP_BASE, "other"),
        activeWriteNamespace: null, activeRecallNamespaces: empty,
        legacyReadOnlyNamespaces: empty, recallReadNamespaces: empty, crossNamespaceRecall: false,
      }),
      Object.freeze({
        mode: "legacy-flat", baseDir: TMP_BASE, baseDbPath: TMP_BASE,
        activeWriteNamespace: "active", activeRecallNamespaces: empty,
        legacyReadOnlyNamespaces: empty, recallReadNamespaces: empty, crossNamespaceRecall: false,
      }),
    ]) {
      assert.throws(() => new MultiNamespacePool(layout, 384, FakeAgentDbPool), /legacy-flat|layout|invalid/i);
    }
  });

  it("clones and freezes routes, marks only legacy children read-only, and never writes legacy", () => {
    const source = {
      activeWriteNamespace: "active",
      activeRecallNamespaces: ["active"],
      legacyReadOnlyNamespaces: ["legacy"],
      crossNamespaceRecall: true,
    };
    const layout = resolveNamespaceLayout(TMP_BASE, source, { explicit: true });
    FakeAgentDbPool.constructed.length = 0;
    const pool = new MultiNamespacePool(layout, 384, FakeAgentDbPool);
    source.activeWriteNamespace = "legacy";
    source.activeRecallNamespaces.reverse();
    source.legacyReadOnlyNamespaces.push("later");
    const reads = pool.getReadDbs("agent-a");
    assert.deepEqual(reads.map(({ namespace }) => namespace), ["active", "legacy"]);
    assert.equal(Object.isFrozen(pool.layout), true);
    assert.equal(Object.isFrozen(pool.layout.recallReadNamespaces), true);
    const activeChild = pool._pools.get("active");
    const legacyChild = pool._pools.get("legacy");
    assert.equal(activeChild.options, undefined);
    assert.deepEqual(legacyChild.options, { readOnly: true });
    assert.equal(pool.getWriteDb("agent-a").dbPath, join(TMP_BASE, "active", "agent-a"));
  });
});
