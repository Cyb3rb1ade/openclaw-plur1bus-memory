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
});
