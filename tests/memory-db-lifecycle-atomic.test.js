import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryDB } from "../index.js";

const VECTOR_DIM = 3;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (error) {
    return { status: "rejected", reason: error };
  }
}

function makeTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEntry(id, overrides = {}) {
  return {
    id,
    text: "original memory text",
    summary: "original summary",
    vector: [0.1, 0.2, 0.3],
    importance: 0.7,
    category: "fact",
    createdAt: 1_700_000_000_000,
    storedBy: "b7-agent",
    ...overrides,
  };
}

describe("MemoryDB lifecycle and atomic updates", { concurrency: false }, () => {
  it("cleans a failed initialization generation and retries on the same instance", async (t) => {
    const root = makeTempDir(t, "plur1bus-b7-init-retry-");
    const blockedParent = join(root, "blocked-parent");
    const dbPath = join(blockedParent, "agent-a");
    writeFileSync(blockedParent, "not a directory", "utf8");

    const sameInstance = new MemoryDB(dbPath, VECTOR_DIM);
    await assert.rejects(() => sameInstance.init(), /not a directory|Not a directory|os error 20/i);

    assert.equal(sameInstance.initPromise, null, "a rejected generation must not poison future init calls");
    assert.equal(sameInstance.table, null, "a failed generation must clear a partial table handle");
    assert.equal(sameInstance.db, null, "a failed generation must clear a partial connection handle");
    assert.equal(sameInstance.schemaFieldNames, null, "a failed generation must clear cached schema state");

    unlinkSync(blockedParent);
    mkdirSync(blockedParent);

    await sameInstance.init();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await sameInstance.store(makeEntry(id));
    assert.equal((await sameInstance.getById(id))?.text, "original memory text");

    const freshInstance = new MemoryDB(dbPath, VECTOR_DIM);
    await freshInstance.init();
    assert.equal((await freshInstance.getById(id))?.id, id, "a fresh instance remains a positive control");

    await freshInstance.shutdown();
    await sameInstance.shutdown();
  });

  it("coalesces concurrent callers into one successful initialization generation", async (t) => {
    const root = makeTempDir(t, "plur1bus-b7-init-coalesce-");
    const db = new MemoryDB(join(root, "agent-a"), VECTOR_DIM);
    const originalRefresh = db.refreshSchemaFields.bind(db);
    let refreshCalls = 0;
    let releaseRefresh;
    let markRefreshStarted;
    const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });

    db.refreshSchemaFields = async () => {
      refreshCalls++;
      markRefreshStarted();
      await refreshGate;
      return originalRefresh();
    };

    const first = db.init();
    const second = db.init();
    await refreshStarted;
    assert.equal(refreshCalls, 1, "concurrent callers must share the active generation");

    releaseRefresh();
    await Promise.all([first, second]);
    await db.init();
    assert.equal(refreshCalls, 1, "a successful generation remains cached and idempotent");
    await db.shutdown();
  });

  it("keeps failed-init cleanup and retry pending until raw close settlement", async (t) => {
    const root = makeTempDir(t, "plur1bus-b7-init-close-settlement-");
    const db = new MemoryDB(join(root, "agent-a"), VECTOR_DIM);
    const closeGate = deferred();
    const closeStarted = deferred();
    const initFailure = new Error("injected refresh failure");
    const simulatedCloseTimeout = new Error("simulated non-abortable close timeout");
    const originalRefresh = db.refreshSchemaFields.bind(db);
    const originalWrite = db._write.bind(db);
    const backgroundCloseSettlements = [];
    let refreshCalls = 0;
    let firstInit;
    let retryInit;

    db.refreshSchemaFields = async function refreshWithDeferredCleanup() {
      refreshCalls++;
      if (refreshCalls !== 1) return originalRefresh();

      const table = this.table;
      const connection = this.db;
      const rawTableClose = typeof table?.close === "function" ? table.close.bind(table) : () => {};
      const rawConnectionClose = typeof connection?.close === "function" ? connection.close.bind(connection) : () => {};
      Object.defineProperty(table, "close", {
        configurable: true,
        value: async () => {
          closeStarted.resolve();
          await closeGate.promise;
          return rawTableClose();
        },
      });
      Object.defineProperty(connection, "close", {
        configurable: true,
        value: async () => {
          await closeGate.promise;
          return rawConnectionClose();
        },
      });
      throw initFailure;
    };
    db._write = (promise, label) => {
      if (String(label).includes(".close:failed-init")) {
        backgroundCloseSettlements.push(settle(promise));
        return Promise.reject(simulatedCloseTimeout);
      }
      return originalWrite(promise, label);
    };

    t.after(async () => {
      closeGate.resolve();
      await Promise.allSettled([firstInit, retryInit].filter(Boolean));
      db._write = originalWrite;
      db.refreshSchemaFields = originalRefresh;
      await db.shutdown().catch(() => {});
    });

    let firstResult;
    firstInit = db.init().then(
      () => { firstResult = { ok: true }; },
      (error) => { firstResult = { ok: false, error }; },
    );
    await closeStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstResult, undefined, "failed init must not settle before its raw close promise");
    assert.notEqual(db.initPromise, null, "retry generation must remain blocked during close settlement");

    let retryResult;
    retryInit = db.init().then(
      () => { retryResult = { ok: true }; },
      (error) => { retryResult = { ok: false, error }; },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshCalls, 1, "retry during cleanup must share the failing generation");
    assert.equal(retryResult, undefined, "retry must stay pending with failed-init cleanup");

    closeGate.resolve();
    await Promise.all([firstInit, retryInit]);
    const closeResults = await Promise.all(backgroundCloseSettlements);
    assert.ok(closeResults.every((result) => result.status === "fulfilled"));
    assert.equal(firstResult?.error, initFailure);
    assert.equal(retryResult?.error, initFailure);
    assert.equal(db.initPromise, null);

    db._write = originalWrite;
    db.refreshSchemaFields = originalRefresh;
    await db.init();
    assert.ok(db.table, "same instance can create a new generation after raw cleanup settles");
    await db.shutdown();
  });

  it("uses supported table.update without delete/add and preserves immutable and untouched fields", async (t) => {
    const root = makeTempDir(t, "plur1bus-b7-update-");
    const db = new MemoryDB(join(root, "agent-a"), VECTOR_DIM);
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.store(makeEntry(id));

    const calls = { update: 0, delete: 0, add: 0 };
    const originalUpdate = db.table.update.bind(db.table);
    const originalDelete = db.table.delete.bind(db.table);
    const originalAdd = db.table.add.bind(db.table);
    db.table.update = async (...args) => {
      calls.update++;
      return originalUpdate(...args);
    };
    db.table.delete = async (...args) => {
      calls.delete++;
      return originalDelete(...args);
    };
    db.table.add = async (...args) => {
      calls.add++;
      return originalAdd(...args);
    };

    await db.update(id, {
      id: otherId,
      summary: "updated summary",
      vector: new Float32Array([0.9, 0.8, 0.7]),
      unknownFutureColumn: "must be ignored",
    });

    assert.deepEqual(calls, { update: 1, delete: 0, add: 0 });
    const updated = await db.getById(id);
    assert.equal(updated?.id, id, "id is immutable");
    assert.equal(await db.getById(otherId), null, "an id patch must not create or move a row");
    assert.equal(updated?.summary, "updated summary");
    assert.equal(updated?.text, "original memory text", "untouched fields must remain unchanged");
    assert.equal(updated?.category, "fact", "untouched metadata must remain unchanged");
    assert.deepEqual(
      Array.from(updated?.vector || [], (value) => Number(value.toFixed(6))),
      [0.9, 0.8, 0.7],
    );
    assert.equal("unknownFutureColumn" in updated, false);
    await db.shutdown();
  });

  it("does not downgrade an operational table.update failure into replacement", async (t) => {
    const root = makeTempDir(t, "plur1bus-b7-update-error-");
    const db = new MemoryDB(join(root, "agent-a"), VECTOR_DIM);
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.store(makeEntry(id));

    const updateError = new Error("injected in-place update failure");
    let deletes = 0;
    let adds = 0;
    db.table.update = async () => { throw updateError; };
    db.table.delete = async () => { deletes++; };
    db.table.add = async () => { adds++; };

    await assert.rejects(() => db.update(id, { summary: "never applied" }), (err) => err === updateError);
    assert.equal(deletes, 0, "supported update failures must not enter delete/add compatibility mode");
    assert.equal(adds, 0, "supported update failures must not enter delete/add compatibility mode");
    await db.shutdown();
  });

  it("surfaces replacement and restore failures together when update is unavailable", async (t) => {
    const root = makeTempDir(t, "plur1bus-b7-update-fallback-");
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args.map(String).join(" ")) };
    const db = new MemoryDB(join(root, "agent-a"), VECTOR_DIM, logger);
    const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await db.store(makeEntry(id));

    const replacementError = new Error("injected replacement failure");
    const restoreError = new Error("injected restore failure");
    Object.defineProperty(db.table, "update", { configurable: true, value: undefined });
    let addCalls = 0;
    db.table.add = async () => {
      addCalls++;
      throw addCalls === 1 ? replacementError : restoreError;
    };

    await assert.rejects(
      () => db.update(id, { summary: "replacement path" }),
      (err) => {
        assert.ok(err instanceof AggregateError);
        assert.deepEqual(err.errors, [replacementError, restoreError]);
        assert.match(err.message, new RegExp(id));
        return true;
      },
    );
    assert.equal(addCalls, 2, "the compatibility path must attempt one explicit restore");
    assert.ok(
      warnings.some((line) => line.includes(db.dbPath) && line.includes(id) && line.includes("restore")),
      `expected contextual recovery warning, got: ${JSON.stringify(warnings)}`,
    );
    await db.shutdown();
  });

  it("clears shutdown state and aggregates table and connection close failures", async () => {
    const db = new MemoryDB("/tmp/plur1bus-b7-shutdown-fixture", VECTOR_DIM);
    const tableError = new Error("table close failed");
    const connectionError = new Error("connection close failed");
    db.table = { close: async () => { throw tableError; } };
    db.db = { close: async () => { throw connectionError; } };
    db.schemaFieldNames = new Set(["id"]);
    db.initPromise = Promise.resolve();

    await assert.rejects(db.shutdown(), (err) => {
      assert.ok(err instanceof AggregateError);
      assert.deepEqual(err.errors, [tableError, connectionError]);
      return true;
    });
    assert.equal(db.table, null);
    assert.equal(db.db, null);
    assert.equal(db.schemaFieldNames, null);
    assert.equal(db.initPromise, null);
    assert.equal(db.isShutdown, true);
    await assert.doesNotReject(() => db.shutdown(), "shutdown remains idempotent after a failed close");
  });

  it("keeps shutdown pending until a deferred raw close settles", async (t) => {
    const db = new MemoryDB("/tmp/plur1bus-b7-deferred-shutdown-fixture", VECTOR_DIM);
    const closeGate = deferred();
    const closeStarted = deferred();
    const simulatedCloseTimeout = new Error("simulated non-abortable shutdown timeout");
    const originalWrite = db._write.bind(db);
    const backgroundCloseSettlements = [];
    let connectionCloseCalls = 0;

    db.table = {
      close: async () => {
        closeStarted.resolve();
        await closeGate.promise;
      },
    };
    db.db = { close: async () => { connectionCloseCalls++; } };
    db._write = (promise, label) => {
      if (String(label).includes(".close:shutdown")) {
        backgroundCloseSettlements.push(settle(promise));
        return Promise.reject(simulatedCloseTimeout);
      }
      return originalWrite(promise, label);
    };
    t.after(() => closeGate.resolve());

    let shutdownResult;
    const shutdown = db.shutdown().then(
      () => { shutdownResult = { ok: true }; },
      (error) => { shutdownResult = { ok: false, error }; },
    );
    await closeStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownResult, undefined, "shutdown must not settle at an operational timeout boundary");
    assert.equal(db.isShutdown, false, "terminal state is set only after raw close settlement");

    closeGate.resolve();
    await shutdown;
    const closeResults = await Promise.all(backgroundCloseSettlements);
    assert.ok(closeResults.every((result) => result.status === "fulfilled"));
    assert.deepEqual(shutdownResult, { ok: true });
    assert.equal(connectionCloseCalls, 1);
    assert.equal(db.isShutdown, true);
  });
});
