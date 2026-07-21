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
import { TimeoutError } from "../lib/with-timeout.js";

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

async function settleCleanup(promise, label) {
  try {
    await promise;
  } catch (error) {
    console.warn(`[test-cleanup:${label}] ${error?.message || String(error)}`);
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

function closeTrackingProxy(handle, onClose) {
  const rawClose = typeof handle?.close === "function" ? handle.close.bind(handle) : null;
  return new Proxy(handle, {
    get(target, property) {
      if (property === "close" && rawClose) {
        return async () => {
          onClose();
          return rawClose();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

function errorTreeIncludes(error, expected) {
  if (error === expected) return true;
  return Array.isArray(error?.errors)
    && error.errors.some((nested) => errorTreeIncludes(nested, expected));
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
      await settleCleanup(db.shutdown(), "failed-init-retry-shutdown");
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

  it("closes a late connect handle once and blocks retry until its raw settlement", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-connect-timeout-");
    const db = new MemoryDB(join(root, "agent-a"), VECTOR_DIM);
    const release = deferred();
    const rawResolved = deferred();
    const originalWrite = db._write.bind(db);
    let injected = false;
    let lateConnection;
    let lateCloseCalls = 0;
    let firstInit;
    let retryInit;

    db._write = (promise, label) => {
      if (!injected && label === "MemoryDB.connect") {
        injected = true;
        const settlement = Promise.resolve(promise).then(async (connection) => {
          lateConnection = closeTrackingProxy(connection, () => { lateCloseCalls++; });
          rawResolved.resolve();
          await release.promise;
          return lateConnection;
        });
        return Promise.reject(new TimeoutError(label, 1, settlement));
      }
      return originalWrite(promise, label);
    };

    t.after(async () => {
      release.resolve();
      await Promise.allSettled([firstInit, retryInit].filter(Boolean));
      db._write = originalWrite;
      if (lateConnection && lateCloseCalls === 0) {
        await settleCleanup(lateConnection.close(), "late-connect-handle");
      }
      await settleCleanup(db.shutdown(), "late-connect-shutdown");
    });

    let firstResult;
    firstInit = db.init().then(
      () => { firstResult = { ok: true }; },
      (error) => { firstResult = { ok: false, error }; },
    );
    await rawResolved.promise;
    await nextTurn();
    assert.equal(firstResult?.error?.code, "ETIMEOUT", "the caller still receives the timeout promptly");
    assert.equal(lateCloseCalls, 0, "the late connection cannot close before its raw settlement");

    let retrySettled = false;
    retryInit = db.init().finally(() => { retrySettled = true; });
    await nextTurn();
    assert.equal(retrySettled, false, "retry must wait for the timed-out connect cleanup");

    release.resolve();
    await firstResult.error.settlement;
    assert.equal(lateCloseCalls, 1, "the late connection is closed exactly once");
    await retryInit;
    assert.ok(db.table, "retry starts a fresh initialization only after late cleanup");
    await db.shutdown();
  });

  it("keeps shutdown and its directory capability behind a timed-out tableNames read", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-table-names-timeout-");
    const dbPath = join(root, "agent-a");
    const release = deferred();
    const rawResolved = deferred();
    const originalRead = MemoryDB.prototype._read.bind(null);
    const originalWrite = MemoryDB.prototype._write.bind(null);
    let connectionCloseCalls = 0;
    let capabilityCloseCalls = 0;
    let injected = false;
    let firstInit;
    let shutdown;
    const capability = {
      path: dbPath,
      assertOpen() {},
      close() { capabilityCloseCalls++; },
    };
    const db = new MemoryDB(dbPath, VECTOR_DIM, null, {
      directoryCapability: capability,
      secureDirectoryRequired: true,
    });

    db._write = async (promise, label) => {
      const value = await originalWrite(promise, label);
      return label === "MemoryDB.connect"
        ? closeTrackingProxy(value, () => { connectionCloseCalls++; })
        : value;
    };
    db._read = (promise, label) => {
      if (!injected && label === "MemoryDB.tableNames") {
        injected = true;
        const settlement = Promise.resolve(promise).then(async (value) => {
          rawResolved.resolve();
          await release.promise;
          return value;
        });
        return Promise.reject(new TimeoutError(label, 1, settlement));
      }
      return originalRead(promise, label);
    };

    t.after(async () => {
      release.resolve();
      await Promise.allSettled([firstInit, shutdown].filter(Boolean));
      await settleCleanup(db.shutdown(), "table-names-shutdown");
    });

    let timeoutError;
    firstInit = db.init().catch((error) => { timeoutError = error; });
    await rawResolved.promise;
    await firstInit;
    assert.equal(timeoutError?.code, "ETIMEOUT");
    assert.equal(connectionCloseCalls, 0, "the connection stays open for its raw tableNames read");

    let shutdownSettled = false;
    shutdown = db.shutdown().finally(() => { shutdownSettled = true; });
    await nextTurn();
    assert.equal(shutdownSettled, false, "shutdown must wait for raw tableNames settlement");
    assert.equal(capabilityCloseCalls, 0, "the directory capability stays held through raw settlement");

    release.resolve();
    await timeoutError.settlement;
    await shutdown;
    assert.equal(connectionCloseCalls, 1);
    assert.equal(capabilityCloseCalls, 1);
  });

  it("continues timeout cleanup and capability close when lifecycle debug logging throws", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-throwing-debug-logger-");
    const dbPath = join(root, "agent-a");
    const release = deferred();
    const timeoutInjected = deferred();
    const loggerError = new Error("injected debug logger failure");
    const originalRead = MemoryDB.prototype._read.bind(null);
    const originalWrite = MemoryDB.prototype._write.bind(null);
    let connectionCloseCalls = 0;
    let capabilityCloseCalls = 0;
    let injected = false;
    const capability = {
      path: dbPath,
      assertOpen() {},
      close() { capabilityCloseCalls++; },
    };
    const logger = { debug() { throw loggerError; } };
    const db = new MemoryDB(dbPath, VECTOR_DIM, logger, {
      directoryCapability: capability,
      secureDirectoryRequired: true,
    });

    db._write = async (promise, label) => {
      const value = await originalWrite(promise, label);
      return label === "MemoryDB.connect"
        ? closeTrackingProxy(value, () => { connectionCloseCalls++; })
        : value;
    };
    db._read = (promise, label) => {
      if (!injected && label === "MemoryDB.tableNames") {
        injected = true;
        const settlement = Promise.resolve(promise).then(async (value) => {
          await release.promise;
          return value;
        });
        timeoutInjected.resolve();
        return Promise.reject(new TimeoutError(label, 1, settlement));
      }
      return originalRead(promise, label);
    };

    t.after(() => release.resolve());

    let timeoutError;
    const init = db.init().catch((error) => { timeoutError = error; });
    await timeoutInjected.promise;
    let shutdownError;
    const shutdown = db.shutdown().catch((error) => { shutdownError = error; });
    await nextTurn();
    assert.equal(capabilityCloseCalls, 0);
    assert.equal(connectionCloseCalls, 0);

    release.resolve();
    await init;
    await timeoutError.settlement;
    await shutdown;
    assert.ok(errorTreeIncludes(shutdownError, loggerError), "logger failure remains observable after cleanup");
    assert.equal(connectionCloseCalls, 1, "raw operation handle closes despite the logger failure");
    assert.equal(capabilityCloseCalls, 1, "capability closes after raw settlement despite the logger failure");
    assert.equal(db.isShutdown, true);
  });

  it("closes late openTable and connection handles only after raw settlement", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-open-table-timeout-");
    const dbPath = join(root, "agent-a");
    const seed = new MemoryDB(dbPath, VECTOR_DIM);
    await seed.init();
    await seed.shutdown();

    const db = new MemoryDB(dbPath, VECTOR_DIM);
    const release = deferred();
    const rawResolved = deferred();
    const originalWrite = MemoryDB.prototype._write.bind(null);
    let connectionCloseCalls = 0;
    let tableCloseCalls = 0;
    let injected = false;
    let lateTable;
    let firstInit;
    let retryInit;

    db._write = async (promise, label) => {
      if (!injected && label === "MemoryDB.openTable") {
        injected = true;
        const settlement = Promise.resolve(promise).then(async (table) => {
          lateTable = closeTrackingProxy(table, () => { tableCloseCalls++; });
          rawResolved.resolve();
          await release.promise;
          return lateTable;
        });
        throw new TimeoutError(label, 1, settlement);
      }
      const value = await originalWrite(promise, label);
      return label === "MemoryDB.connect"
        ? closeTrackingProxy(value, () => { connectionCloseCalls++; })
        : value;
    };

    t.after(async () => {
      release.resolve();
      await Promise.allSettled([firstInit, retryInit].filter(Boolean));
      if (lateTable && tableCloseCalls === 0) {
        await settleCleanup(lateTable.close(), "late-open-table-handle");
      }
      await settleCleanup(db.shutdown(), "late-open-table-shutdown");
    });

    let timeoutError;
    firstInit = db.init().catch((error) => { timeoutError = error; });
    await rawResolved.promise;
    await firstInit;
    assert.equal(timeoutError?.code, "ETIMEOUT");
    assert.deepEqual(
      { tableCloseCalls, connectionCloseCalls },
      { tableCloseCalls: 0, connectionCloseCalls: 0 },
      "neither handle may close while openTable is still settling",
    );

    let retrySettled = false;
    retryInit = db.init().finally(() => { retrySettled = true; });
    await nextTurn();
    assert.equal(retrySettled, false);
    release.resolve();
    await timeoutError.settlement;
    assert.deepEqual({ tableCloseCalls, connectionCloseCalls }, { tableCloseCalls: 1, connectionCloseCalls: 1 });
    await retryInit;
    await db.shutdown();
  });

  it("does not swallow or overtake a timed-out schema read during initialization", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-schema-timeout-");
    const dbPath = join(root, "agent-a");
    const seed = new MemoryDB(dbPath, VECTOR_DIM);
    await seed.init();
    await seed.shutdown();

    const db = new MemoryDB(dbPath, VECTOR_DIM);
    const release = deferred();
    const rawResolved = deferred();
    const originalRead = db._read.bind(db);
    const labelsAfterTimeout = [];
    let injected = false;
    let firstInit;

    db._read = (promise, label) => {
      if (!injected && label === "MemoryDB.schema") {
        injected = true;
        const settlement = Promise.resolve(promise).then(async (value) => {
          rawResolved.resolve();
          await release.promise;
          return value;
        });
        return Promise.reject(new TimeoutError(label, 1, settlement));
      }
      if (injected) labelsAfterTimeout.push(label);
      return originalRead(promise, label);
    };

    t.after(async () => {
      release.resolve();
      await Promise.allSettled([firstInit].filter(Boolean));
      db._read = originalRead;
      await settleCleanup(db.shutdown(), "schema-timeout-shutdown");
    });

    let initResult;
    firstInit = db.init().then(
      () => { initResult = { ok: true }; },
      (error) => { initResult = { ok: false, error }; },
    );
    await rawResolved.promise;
    await nextTurn();
    assert.equal(initResult?.error?.code, "ETIMEOUT", "schema timeout must fail the generation promptly");
    assert.deepEqual(labelsAfterTimeout, [], "no later init read may overtake the raw schema settlement");

    release.resolve();
    await initResult.error.settlement;
    db._read = originalRead;
    await db.init();
    await db.shutdown();
  });

  it("does not swallow or overtake a timed-out schema migration write", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-migration-timeout-");
    const dbPath = join(root, "agent-a");
    const lancedb = await import("@lancedb/lancedb");
    const fixture = await lancedb.connect(dbPath);
    const legacyTable = await fixture.createTable("memories", [{
      id: "__legacy__",
      text: "legacy",
      vector: Array(VECTOR_DIM).fill(0),
      importance: 0,
      category: "other",
      createdAt: 0,
    }]);
    await legacyTable.close();
    await fixture.close();

    const db = new MemoryDB(dbPath, VECTOR_DIM);
    const release = deferred();
    const rawResolved = deferred();
    const originalWrite = db._write.bind(db);
    const labelsAfterTimeout = [];
    let injected = false;
    let firstInit;

    db._write = (promise, label) => {
      if (!injected && label.startsWith("MemoryDB.addColumns:")) {
        injected = true;
        const settlement = Promise.resolve(promise).then(async (value) => {
          rawResolved.resolve();
          await release.promise;
          return value;
        });
        return Promise.reject(new TimeoutError(label, 1, settlement));
      }
      if (injected) labelsAfterTimeout.push(label);
      return originalWrite(promise, label);
    };

    t.after(async () => {
      release.resolve();
      await Promise.allSettled([firstInit].filter(Boolean));
      db._write = originalWrite;
      await settleCleanup(db.shutdown(), "migration-timeout-shutdown");
    });

    let initResult;
    firstInit = db.init().then(
      () => { initResult = { ok: true }; },
      (error) => { initResult = { ok: false, error }; },
    );
    await rawResolved.promise;
    await nextTurn();
    assert.equal(initResult?.error?.code, "ETIMEOUT", "migration timeout must fail the generation promptly");
    assert.deepEqual(labelsAfterTimeout, [], "later migration writes may not overtake raw addColumns settlement");

    release.resolve();
    await initResult.error.settlement;
    db._write = originalWrite;
    await db.init();
    await db.shutdown();
  });

  it("cleans a late-created table and its schema sentinel before retry", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-create-table-timeout-");
    const dbPath = join(root, "agent-a");
    const db = new MemoryDB(dbPath, VECTOR_DIM);
    const release = deferred();
    const rawResolved = deferred();
    const originalWrite = MemoryDB.prototype._write.bind(null);
    let connectionCloseCalls = 0;
    let tableCloseCalls = 0;
    let injected = false;
    let lateTable;
    let firstInit;
    let retryInit;

    db._write = async (promise, label) => {
      if (!injected && label === "MemoryDB.createTable") {
        injected = true;
        const settlement = Promise.resolve(promise).then(async (table) => {
          lateTable = closeTrackingProxy(table, () => { tableCloseCalls++; });
          rawResolved.resolve();
          await release.promise;
          return lateTable;
        });
        throw new TimeoutError(label, 1, settlement);
      }
      const value = await originalWrite(promise, label);
      return label === "MemoryDB.connect"
        ? closeTrackingProxy(value, () => { connectionCloseCalls++; })
        : value;
    };

    t.after(async () => {
      release.resolve();
      await Promise.allSettled([firstInit, retryInit].filter(Boolean));
      if (lateTable && tableCloseCalls === 0) {
        await settleCleanup(lateTable.close(), "late-created-table-handle");
      }
      await settleCleanup(db.shutdown(), "late-create-shutdown");
    });

    let timeoutError;
    firstInit = db.init().catch((error) => { timeoutError = error; });
    await rawResolved.promise;
    await firstInit;
    assert.equal(timeoutError?.code, "ETIMEOUT");
    assert.deepEqual(
      { tableCloseCalls, connectionCloseCalls },
      { tableCloseCalls: 0, connectionCloseCalls: 0 },
      "createTable cleanup must wait for the raw mutation",
    );

    let retrySettled = false;
    retryInit = db.init().finally(() => { retrySettled = true; });
    await nextTurn();
    assert.equal(retrySettled, false);
    release.resolve();
    await timeoutError.settlement;
    assert.deepEqual({ tableCloseCalls, connectionCloseCalls }, { tableCloseCalls: 1, connectionCloseCalls: 1 });
    await retryInit;
    assert.equal(await db.table.countRows(), 0, "late create cleanup must remove the schema sentinel");
    await db.shutdown();
  });

  it("repairs a table when late createTable settlement rejects after mutation", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-create-table-late-reject-");
    const dbPath = join(root, "agent-a");
    const db = new MemoryDB(dbPath, VECTOR_DIM);
    const release = deferred();
    const rawMutated = deferred();
    const lateCreateError = new Error("injected post-mutation create failure");
    const originalWrite = MemoryDB.prototype._write.bind(null);
    let injected = false;

    db._write = async (promise, label) => {
      if (!injected && label === "MemoryDB.createTable") {
        injected = true;
        const settlement = Promise.resolve(promise).then(async () => {
          rawMutated.resolve();
          await release.promise;
          throw lateCreateError;
        });
        throw new TimeoutError(label, 1, settlement);
      }
      return originalWrite(promise, label);
    };

    t.after(async () => {
      release.resolve();
      await settleCleanup(db.shutdown(), "late-create-reject-shutdown");
    });

    let timeoutError;
    await db.init().catch((error) => { timeoutError = error; });
    await rawMutated.promise;
    assert.equal(timeoutError?.code, "ETIMEOUT");
    release.resolve();
    await assert.rejects(timeoutError.settlement, (error) => error === lateCreateError);

    await db.init();
    assert.equal(await db.table.countRows(), 0, "late-rejection recovery removes the bootstrap sentinel");
    await db.shutdown();
  });

  it("keeps a timed-out schema-row delete serialized through settlement and retry", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-schema-delete-timeout-");
    const dbPath = join(root, "agent-a");
    const db = new MemoryDB(dbPath, VECTOR_DIM);
    const release = deferred();
    const rawResolved = deferred();
    const originalWrite = MemoryDB.prototype._write.bind(null);
    let connectionCloseCalls = 0;
    let tableCloseCalls = 0;
    let injected = false;
    let firstInit;
    let retryInit;

    db._write = async (promise, label) => {
      if (!injected && label === "MemoryDB.deleteSchemaRow") {
        injected = true;
        const settlement = Promise.resolve(promise).then(async (value) => {
          rawResolved.resolve();
          await release.promise;
          return value;
        });
        throw new TimeoutError(label, 1, settlement);
      }
      const value = await originalWrite(promise, label);
      if (label === "MemoryDB.connect") {
        return closeTrackingProxy(value, () => { connectionCloseCalls++; });
      }
      if (label === "MemoryDB.createTable") {
        return closeTrackingProxy(value, () => { tableCloseCalls++; });
      }
      return value;
    };

    t.after(async () => {
      release.resolve();
      await Promise.allSettled([firstInit, retryInit].filter(Boolean));
      await settleCleanup(db.shutdown(), "schema-delete-shutdown");
    });

    let timeoutError;
    firstInit = db.init().catch((error) => { timeoutError = error; });
    await rawResolved.promise;
    await firstInit;
    assert.equal(timeoutError?.code, "ETIMEOUT");
    assert.deepEqual({ tableCloseCalls, connectionCloseCalls }, { tableCloseCalls: 0, connectionCloseCalls: 0 });

    let retrySettled = false;
    retryInit = db.init().finally(() => { retrySettled = true; });
    await nextTurn();
    assert.equal(retrySettled, false, "retry cannot overtake the raw schema-row deletion");
    release.resolve();
    await timeoutError.settlement;
    assert.deepEqual({ tableCloseCalls, connectionCloseCalls }, { tableCloseCalls: 1, connectionCloseCalls: 1 });
    await retryInit;
    assert.equal(await db.table.countRows(), 0);
    await db.shutdown();
  });

  it("serializes the final schema refresh timeout before handle cleanup", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-final-schema-timeout-");
    const dbPath = join(root, "agent-a");
    const seed = new MemoryDB(dbPath, VECTOR_DIM);
    await seed.init();
    await seed.shutdown();

    const db = new MemoryDB(dbPath, VECTOR_DIM);
    const release = deferred();
    const rawResolved = deferred();
    const originalRead = MemoryDB.prototype._read.bind(null);
    const originalWrite = MemoryDB.prototype._write.bind(null);
    let schemaCalls = 0;
    let connectionCloseCalls = 0;
    let tableCloseCalls = 0;
    let firstInit;
    let retryInit;

    db._write = async (promise, label) => {
      const value = await originalWrite(promise, label);
      if (label === "MemoryDB.connect") {
        return closeTrackingProxy(value, () => { connectionCloseCalls++; });
      }
      if (label === "MemoryDB.openTable") {
        return closeTrackingProxy(value, () => { tableCloseCalls++; });
      }
      return value;
    };
    db._read = (promise, label) => {
      if (label === "MemoryDB.schema" && ++schemaCalls === 2) {
        const settlement = Promise.resolve(promise).then(async (value) => {
          rawResolved.resolve();
          await release.promise;
          return value;
        });
        return Promise.reject(new TimeoutError(label, 1, settlement));
      }
      return originalRead(promise, label);
    };

    t.after(async () => {
      release.resolve();
      await Promise.allSettled([firstInit, retryInit].filter(Boolean));
      await settleCleanup(db.shutdown(), "final-schema-shutdown");
    });

    let timeoutError;
    firstInit = db.init().catch((error) => { timeoutError = error; });
    await rawResolved.promise;
    await firstInit;
    assert.equal(timeoutError?.code, "ETIMEOUT");
    assert.deepEqual({ tableCloseCalls, connectionCloseCalls }, { tableCloseCalls: 0, connectionCloseCalls: 0 });

    let retrySettled = false;
    retryInit = db.init().finally(() => { retrySettled = true; });
    await nextTurn();
    assert.equal(retrySettled, false);
    release.resolve();
    await timeoutError.settlement;
    assert.deepEqual({ tableCloseCalls, connectionCloseCalls }, { tableCloseCalls: 1, connectionCloseCalls: 1 });
    await retryInit;
    await db.shutdown();
  });

  it("surfaces a late handle-close failure with agent context and still closes the capability", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-late-close-error-");
    const dbPath = join(root, "agent-a");
    const closeError = new Error("injected late connection close failure");
    const originalWrite = MemoryDB.prototype._write.bind(null);
    let rawConnection;
    let capabilityCloseCalls = 0;
    let injected = false;
    const capability = {
      path: dbPath,
      assertOpen() {},
      close() { capabilityCloseCalls++; },
    };
    const db = new MemoryDB(dbPath, VECTOR_DIM, null, {
      directoryCapability: capability,
      secureDirectoryRequired: true,
    });

    db._write = async (promise, label) => {
      if (!injected && label === "MemoryDB.connect") {
        injected = true;
        const settlement = Promise.resolve(promise).then((connection) => {
          rawConnection = connection;
          return new Proxy(connection, {
            get(target, property) {
              if (property === "close") return async () => { throw closeError; };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });
        throw new TimeoutError(label, 1, settlement);
      }
      return originalWrite(promise, label);
    };

    t.after(async () => {
      if (rawConnection) {
        try {
          await rawConnection.close();
        } catch (error) {
          assert.fail(`raw fixture connection cleanup failed: ${error.message}`);
        }
      }
      await settleCleanup(db.shutdown(), "late-close-error-shutdown");
    });

    let timeoutError;
    await db.init().catch((error) => { timeoutError = error; });
    assert.equal(timeoutError?.code, "ETIMEOUT");
    await assert.rejects(timeoutError.settlement, (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(errorTreeIncludes(error, closeError));
      assert.match(error.message, /agent-a/);
      return true;
    });
    await assert.rejects(() => db.init(), (error) => {
      assert.ok(errorTreeIncludes(error, closeError), "retry reports the retained cleanup failure");
      assert.match(error.message, /agent-a/);
      return true;
    });
    await assert.rejects(() => db.shutdown(), (error) => {
      assert.ok(errorTreeIncludes(error, closeError), "shutdown reports the retained cleanup failure");
      return true;
    });
    assert.equal(capabilityCloseCalls, 1, "terminal shutdown releases the directory capability after reporting cleanup");
  });

  it("removes a bootstrap schema sentinel left by an earlier writable initialization", async (t) => {
    const root = makeTempDir(t, "plur1bus-b12-schema-sentinel-recovery-");
    const dbPath = join(root, "agent-a");
    const seed = new MemoryDB(dbPath, VECTOR_DIM);
    await seed.init();
    await seed.table.add([seed.normalizeEntryForTable({
      id: "__schema__",
      text: "",
      summary: "",
      vector: Array(VECTOR_DIM).fill(0),
      importance: 0,
      category: "other",
      createdAt: 0,
    })]);
    assert.equal(await seed.table.countRows(), 1);
    await seed.shutdown();

    const recovered = new MemoryDB(dbPath, VECTOR_DIM);
    await recovered.init();
    assert.equal(await recovered.table.countRows(), 0, "writable init repairs a leftover bootstrap row idempotently");
    await recovered.shutdown();
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
    await assert.rejects(
      () => db.init(),
      /shutting down/i,
      "a retained direct reference cannot start initialization during shutdown",
    );

    closeGate.resolve();
    await shutdown;
    const closeResults = await Promise.all(backgroundCloseSettlements);
    assert.ok(closeResults.every((result) => result.status === "fulfilled"));
    assert.deepEqual(shutdownResult, { ok: true });
    assert.equal(connectionCloseCalls, 1);
    assert.equal(db.isShutdown, true);
  });
});
