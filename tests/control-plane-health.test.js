import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createControlPlaneHealthInspector,
  createControlPlaneHealthScan,
} from "../lib/control-plane-health.js";

describe("PLUR1BUS control-plane health inspector", () => {
  it("coalesces one scan and projects only aggregate health facts", async () => {
    let now = 1_000;
    let calls = 0;
    let release;
    const inspector = createControlPlaneHealthInspector({
      now: () => now,
      ttlMs: 1_000,
      scan: async () => {
        calls += 1;
        await new Promise((resolve) => { release = resolve; });
        return {
          status: "ready",
          namespaces: [{ id: "lancedb-namespaced", dimensions: 768, rows: 7, path: "/must-not-project" }],
          cards: {
            byAgent: [{ id: "agent-a", cards: 5, content: "memory-body-must-not-project" }],
            byWorkspace: [{ id: "workspace:v1:alpha", cards: 2 }],
            byUser: [{ id: "user:v1:alpha", cards: 1 }],
          },
          storage: { bytes: 1234, complete: true, path: "/must-not-project" },
          lastError: { component: "lancedb", code: "lancedb_count_failed", message: "sentinel-secret" },
        };
      },
    });

    const first = inspector.snapshot();
    const second = inspector.snapshot();
    assert.equal(calls, 1);
    release();
    const [left, right] = await Promise.all([first, second]);

    assert.strictEqual(left, right);
    assert.deepStrictEqual(left, {
      status: "ready",
      namespaces: [{ id: "lancedb-namespaced", dimensions: 768, rows: 7 }],
      cards: {
        byAgent: [{ id: "agent-a", cards: 5 }],
        byWorkspace: [{ id: "workspace:v1:alpha", cards: 2 }],
        byUser: [{ id: "user:v1:alpha", cards: 1 }],
      },
      storage: { bytes: 1234, complete: true },
      lastError: { component: "lancedb", code: "lancedb_count_failed" },
      observedAt: 1_000,
    });
    assert.doesNotMatch(JSON.stringify(left), /memory-body-must-not-project|must-not-project|sentinel-secret/);

    assert.strictEqual(await inspector.snapshot(), left);
    assert.equal(calls, 1, "fresh snapshots use the aggregate cache");

    now = 2_001;
    const third = inspector.snapshot();
    assert.equal(calls, 2, "expired snapshots start exactly one new scan");
    release();
    assert.notStrictEqual(await third, left);
  });

  const okScan = (marker) => ({
    status: "ready",
    namespaces: [],
    cards: { byAgent: [{ id: "agent-a", cards: marker }], byWorkspace: [], byUser: [] },
    storage: { bytes: 1, complete: true },
    lastError: null,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("serves the last snapshot at once past the TTL and refreshes behind it", async () => {
    let now = 1_000;
    let calls = 0;
    let release;
    const inspector = createControlPlaneHealthInspector({
      now: () => now,
      ttlMs: 1_000,
      staleWhileRevalidate: true,
      scan: async () => {
        calls += 1;
        await new Promise((resolve) => { release = resolve; });
        return okScan(calls);
      },
    });

    const first = inspector.snapshot();
    release();
    const warm = await first;
    assert.equal(calls, 1);

    now = 5_000;
    const stale = await inspector.snapshot();
    assert.strictEqual(stale, warm, "a stale read returns the cached snapshot without waiting");
    assert.equal(calls, 2, "a stale read starts exactly one background scan");
    assert.strictEqual(await inspector.snapshot(), warm);
    assert.equal(calls, 2, "readers during the scan share it");

    release();
    await settle();
    const fresh = await inspector.snapshot();
    assert.notStrictEqual(fresh, warm);
    assert.equal(fresh.cards.byAgent[0].cards, 2);
    assert.equal(fresh.observedAt, 5_000);
    assert.equal(calls, 2);
  });

  it("start() warms the cache without a caller and keeps it warm on the interval", async () => {
    let now = 0;
    let calls = 0;
    let cleared = 0;
    const timers = [];
    const inspector = createControlPlaneHealthInspector({
      now: () => now,
      ttlMs: 100,
      staleWhileRevalidate: true,
      refreshIntervalMs: 600,
      setTimer: (fn, delay) => {
        const timer = { fn, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => { cleared += 1; },
      scan: async () => {
        calls += 1;
        return okScan(calls);
      },
    });

    inspector.start();
    inspector.start();
    assert.equal(calls, 1, "start() runs one warm scan, idempotently");
    await settle();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 600, "the next scan is scheduled after the warm scan completes");

    now = 700;
    timers[0].fn();
    assert.equal(calls, 2, "the timer refreshes without a page request");
    await settle();
    assert.equal(timers.length, 2);
    const served = await inspector.snapshot();
    assert.equal(served.observedAt, 700);
    assert.equal(calls, 2, "the page reads the warm snapshot without scanning");

    inspector.stop();
    assert.equal(cleared, 1, "stop() clears the pending timer");
    now = 2_000;
    await inspector.snapshot();
    await settle();
    assert.equal(calls, 3, "a stale read still refreshes behind the page after stop()");
    assert.equal(timers.length, 2, "but nothing is scheduled any more");
  });

  it("retries a failed warm-up early instead of pinning it on the page", async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const timers = [];
    const inspector = createControlPlaneHealthInspector({
      now: () => now,
      ttlMs: 10_000,
      staleWhileRevalidate: true,
      refreshIntervalMs: 60_000,
      failedRetryMs: 1_000,
      setTimer: (fn, delay) => {
        const timer = { fn, delay };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
      scan: async () => {
        calls += 1;
        if (fail) throw new Error("cold store");
        return okScan(calls);
      },
    });

    inspector.start();
    await settle();
    assert.equal(calls, 1);
    assert.equal(timers[0].delay, 1_000, "a failed scan is retried after the short delay");

    now = 500;
    const early = await inspector.snapshot();
    assert.equal(early.status, "degraded");
    assert.equal(calls, 1, "inside the retry window the failure is served, not re-scanned");

    fail = false;
    now = 1_500;
    const real = await inspector.snapshot();
    assert.equal(real.status, "ready");
    assert.equal(calls, 2, "past the retry window a caller waits for a real scan rather than seeing the stale failure");
    await settle();
    assert.equal(timers.at(-1).delay, 60_000, "a good scan goes back to the normal interval");
  });

  it("contains scanner failures behind a stable health error code", async () => {
    const inspector = createControlPlaneHealthInspector({
      scan: async () => { throw new Error("sentinel-secret from lancedb"); },
      now: () => 99,
    });

    const snapshot = await inspector.snapshot();
    assert.deepStrictEqual(snapshot, {
      status: "degraded",
      namespaces: [],
      cards: { byAgent: [], byWorkspace: [], byUser: [] },
      storage: { bytes: null, complete: false },
      lastError: { component: "health", code: "health_scan_failed" },
      observedAt: 99,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /sentinel-secret/);
  });

  it("aggregates private and physically isolated shared partitions without reading a card", async () => {
    const seen = [];
    const scan = createControlPlaneHealthScan({
      namespaceRoots: [{ id: "lancedb-namespaced", path: "/not-projected/private", dimensions: 768 }],
      sharedRoots: {
        workspace: { path: "/not-projected/shared/workspaces", dimensions: 768 },
        user: { path: "/not-projected/shared/users", dimensions: 768 },
      },
      maxPartitions: 8,
      listPartitions: async ({ kind }) => ({
        agent: ["agent-a", "agent-b"],
        workspace: ["w-0123456789abcdef"],
        user: ["u-0123456789abcdef"],
      })[kind],
      inspectRows: async (input) => {
        seen.push(input);
        return ({
          "agent:agent-a": 3,
          "agent:agent-b": 5,
          "workspace:w-0123456789abcdef": 2,
          "user:u-0123456789abcdef": 1,
        })[`${input.kind}:${input.partitionId}`];
      },
      workspaceIdentityForKey: (key) => key === "w-0123456789abcdef" ? "workspace:v1:alpha" : null,
      measureStorage: async () => ({ bytes: 9_876, complete: true }),
    });

    assert.deepStrictEqual(await scan(), {
      status: "ready",
      namespaces: [
        { id: "lancedb-namespaced", dimensions: 768, rows: 8 },
        { id: "shared-workspaces", dimensions: 768, rows: 2 },
        { id: "shared-users", dimensions: 768, rows: 1 },
      ],
      cards: {
        byAgent: [{ id: "agent-a", cards: 3 }, { id: "agent-b", cards: 5 }],
        byWorkspace: [{ id: "workspace:v1:alpha", cards: 2 }],
        byUser: [{ id: "u-0123456789abcdef", cards: 1 }],
      },
      storage: { bytes: 9_876, complete: true },
      lastError: null,
    });
    assert.equal(seen.some((entry) => Object.hasOwn(entry, "card") || Object.hasOwn(entry, "text")), false);
  });

  it("fails closed to a redacted degradation when a partition count fails", async () => {
    const scan = createControlPlaneHealthScan({
      namespaceRoots: [{ id: "lancedb-namespaced", path: "/not-projected/private", dimensions: 768 }],
      listPartitions: async () => ["agent-a"],
      inspectRows: async () => { throw new Error("sentinel-secret from LanceDB"); },
      measureStorage: async () => ({ bytes: 0, complete: true }),
    });

    const snapshot = await scan();
    assert.equal(snapshot.status, "degraded");
    assert.deepStrictEqual(snapshot.namespaces, [{ id: "lancedb-namespaced", dimensions: 768, rows: 0 }]);
    assert.deepStrictEqual(snapshot.lastError, {
      component: "lancedb",
      code: "partition_count_failed",
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /sentinel-secret/);
  });

  it("preserves a bounded storage-scan failure as a redacted storage status", async () => {
    const scan = createControlPlaneHealthScan({
      namespaceRoots: [{ id: "lancedb-namespaced", path: "/not-projected/private", dimensions: 768 }],
      listPartitions: async () => [],
      inspectRows: async () => 0,
      measureStorage: async () => { throw new Error("sentinel-secret from disk inspection"); },
    });
    const inspector = createControlPlaneHealthInspector({ scan, now: () => 77 });

    assert.deepStrictEqual(await inspector.snapshot(), {
      status: "degraded",
      namespaces: [{ id: "lancedb-namespaced", dimensions: 768, rows: 0 }],
      cards: { byAgent: [], byWorkspace: [], byUser: [] },
      storage: { bytes: null, complete: false },
      lastError: { component: "storage", code: "storage_measure_failed" },
      observedAt: 77,
    });
  });

  it("drops only the unsupported partition id and still counts its siblings", async () => {
    // The directory filter admits "_internal" and "55736530"; the public-id
    // contract does not. One such name must not discard the whole root.
    const scan = createControlPlaneHealthScan({
      namespaceRoots: [{ id: "lancedb-namespaced", path: "/not-projected/private", dimensions: 768 }],
      sharedRoots: {
        user: { path: "/not-projected/shared/users", dimensions: 768 },
      },
      maxPartitions: 8,
      listPartitions: async ({ kind }) => ({
        agent: ["_internal", "agent-a", "agent-b"],
        user: ["55736530", "u-0123456789abcdef"],
      })[kind],
      inspectRows: async ({ kind, partitionId }) => ({
        "agent:agent-a": 3,
        "agent:agent-b": 5,
        "user:u-0123456789abcdef": 1,
      })[`${kind}:${partitionId}`] ?? 0,
      measureStorage: async () => ({ bytes: 9_876, complete: true }),
    });

    assert.deepStrictEqual(await scan(), {
      status: "degraded",
      namespaces: [
        { id: "lancedb-namespaced", dimensions: 768, rows: 8 },
        { id: "shared-users", dimensions: 768, rows: 1 },
      ],
      cards: {
        byAgent: [{ id: "agent-a", cards: 3 }, { id: "agent-b", cards: 5 }],
        byWorkspace: [],
        byUser: [{ id: "u-0123456789abcdef", cards: 1 }],
      },
      storage: { bytes: 9_876, complete: true },
      lastError: { component: "health", code: "partition_id_unsupported" },
    });
  });
});

describe("reserved store directories", () => {
  it("skips PLUR1BUS's own `_neo` directory without degrading the snapshot", async () => {
    const scan = createControlPlaneHealthScan({
      namespaceRoots: [{ id: "lancedb-namespaced", path: "/not-projected/private", dimensions: 768 }],
      listPartitions: async () => ["main", "_neo"],
      inspectRows: async ({ partitionId }) => (partitionId === "main" ? 4 : 0),
      measureStorage: async () => ({ bytes: 10, complete: true }),
    });
    const snapshot = await scan();
    assert.equal(snapshot.status, "ready");
    assert.deepStrictEqual(snapshot.cards.byAgent, [{ id: "main", cards: 4 }]);
    assert.equal(snapshot.lastError, null);
  });
});

describe("shared user pool labels in the scan", () => {
  it("names user partitions through the resolver and flags an invalid label", async () => {
    const scanFor = (resolver) => createControlPlaneHealthScan({
      namespaceRoots: [{ id: "lancedb-namespaced", path: "/not-projected/private", dimensions: 768 }],
      sharedRoots: { user: { path: "/not-projected/shared/users", dimensions: 768 } },
      listPartitions: async ({ kind }) => ({ agent: ["agent-a"], user: ["u-0123456789abcdef", "u-fedcba9876543210"] })[kind],
      inspectRows: async ({ kind, partitionId }) => ({ "agent:agent-a": 3, "user:u-0123456789abcdef": 0, "user:u-fedcba9876543210": 2 })[`${kind}:${partitionId}`] ?? 0,
      measureStorage: async () => ({ bytes: 1, complete: true }),
      userIdentityForKey: resolver,
    });
    const named = await scanFor((key) => (key === "u-0123456789abcdef" ? "main.telegram.default" : null))();
    assert.equal(named.status, "ready");
    assert.deepStrictEqual(named.cards.byUser, [{ id: "main.telegram.default", cards: 0 }, { id: "u-fedcba9876543210", cards: 2 }]);
    const invalid = await scanFor(() => "/root/private")();
    assert.equal(invalid.status, "degraded");
    assert.deepStrictEqual(invalid.lastError, { component: "health", code: "user_identity_invalid" });
    assert.deepStrictEqual(invalid.cards.byUser.map((entry) => entry.id), ["u-0123456789abcdef", "u-fedcba9876543210"]);
  });
});
