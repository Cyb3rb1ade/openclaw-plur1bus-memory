import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJsonUpdate } from "../lib/atomic-json.js";
import { createObsidianBridgeService, syncWorkspace } from "../lib/obsidian-bridge.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";

function makeService(overrides = {}) {
  const calls = [];
  const service = createObsidianBridgeService(
    {
      enabled: true,
      watch: true,
      intervalMs: 10,
      workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: "/tmp" }],
      ...overrides.config,
    },
    {
      syncWorkspace: async (workspace, opts) => {
        calls.push({ workspace, opts });
        if (overrides.onSync) await overrides.onSync(workspace, opts);
        return { actions: [] };
      },
      logger: { info() {}, warn() {} },
      mutationPolicyForWorkspace(workspace) {
        return confirmedObsidianPolicy({
          baseDbPath: workspace.path,
          agentId: workspace.agentId,
          workspaceIdentity: `workspace:v1:${workspace.workspaceId}`,
          command: ["dashboards", "build"],
        });
      },
      ...overrides.options,
    },
  );
  return { service, calls };
}

function captureIntervals(t) {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const intervals = [];
  globalThis.setInterval = (callback, delay) => {
    const handle = { callback, delay, cleared: false };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    if (handle) handle.cleared = true;
  };
  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });
  return intervals;
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("a later stop intent wins over a start waiting on an already-settled stop", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-lifecycle-last-stop-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  for (const watch of [true, false]) {
    let syncCalls = 0;
    const { service } = makeService({
      config: {
        watch,
        workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }],
      },
      options: { loadLanceDbRecords: async () => [] },
      onSync: async () => { syncCalls += 1; },
    });
    await service.stop();
    const startPromise = service.start();
    const laterStopPromise = service.stop();
    await Promise.all([startPromise, laterStopPromise]);

    assert.equal(syncCalls, 0, `watch=${watch}: the superseded start must not run`);
  }
  assert.equal(
    intervals.filter((handle) => !handle.cleared).length,
    0,
    "the later stop must not leave live watch timers",
  );
});

test("duplicate watch-disabled starts join the same in-flight initialization", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "obs-lifecycle-joined-start-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseSync;
  let markSyncStarted;
  let syncCalls = 0;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const syncReleased = new Promise((resolve) => { releaseSync = resolve; });
  const { service } = makeService({
    config: {
      watch: false,
      workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }],
    },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      syncCalls += 1;
      markSyncStarted();
      await syncReleased;
    },
  });

  const firstStart = service.start();
  await syncStarted;
  const duplicateStart = service.start();
  const duplicateSettledBeforeRelease = await settlesWithin(duplicateStart, 100);
  releaseSync();
  await Promise.all([firstStart, duplicateStart]);
  await service.stop();

  assert.equal(duplicateSettledBeforeRelease, false, "duplicate start must await initialization completion");
  assert.equal(syncCalls, 1);
});

test("stop waits for an active host-managed watcher sync", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-stop-active-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseSync;
  let markSyncStarted;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const syncReleased = new Promise((resolve) => { releaseSync = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      markSyncStarted();
      await syncReleased;
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const watcher = intervals.find((handle) => handle.delay === 1_000);
  assert.ok(watcher, "watch mode must own a sync interval");
  watcher.callback();
  await syncStarted;

  let stopped = false;
  const stopPromise = service.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "host stop must not publish completion while its watcher sync is active");

  releaseSync();
  await stopPromise;
  assert.equal(stopped, true);
});

test("stop suppresses a coalesced watcher follow-up after running becomes false", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-stop-pending-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseSync;
  let markSyncStarted;
  let syncCalls = 0;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const syncReleased = new Promise((resolve) => { releaseSync = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      syncCalls += 1;
      if (syncCalls === 1) {
        markSyncStarted();
        await syncReleased;
      }
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const watcher = intervals.find((handle) => handle.delay === 1_000);
  assert.ok(watcher, "watch mode must own a sync interval");
  watcher.callback();
  await syncStarted;
  watcher.callback();
  await new Promise((resolve) => setImmediate(resolve));

  const stopPromise = service.stop();
  releaseSync();
  await stopPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(syncCalls, 1, "a stopped service must not start its coalesced follow-up sync");
});

test("stop owns a watch-disabled startup sync and blocks replacement until it quiesces", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "obs-sync-start-stop-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const staleMarker = join(vault, "stale-startup-sync.txt");
  let releaseFirst;
  let markFirstStarted;
  let markFirstFinished;
  let calls = 0;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const firstFinished = new Promise((resolve) => { markFirstFinished = resolve; });
  const { service } = makeService({
    config: {
      watch: false,
      workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }],
    },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async (_workspace, options) => {
      calls += 1;
      if (calls !== 1) return;
      markFirstStarted();
      await firstReleased;
      if (options.shouldContinue?.() !== false) await writeFile(staleMarker, "stale\n", "utf8");
      markFirstFinished();
    },
  });

  const firstStartPromise = service.start();
  await firstStarted;
  const stopPromise = service.stop();
  const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
  const restartPromise = service.start();
  const restartedBeforeRelease = await settlesWithin(restartPromise, 100);
  releaseFirst();
  await firstFinished;
  await firstStartPromise;
  await stopPromise;
  await restartPromise;
  await service.stop();

  assert.equal(stoppedBeforeRelease, false, "stop must await the startup-owned sync request");
  assert.equal(restartedBeforeRelease, false, "replacement start must remain behind the old startup sync");
  assert.equal(calls, 2);
  await assert.rejects(access(staleMarker), { code: "ENOENT" });
});

test("stop waits fail-closed for a hung watcher sync and blocks restart until it quiesces", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-stop-budget-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const marker = join(vault, "late-write.txt");
  let releaseSync;
  let markSyncStarted;
  let markSyncFinished;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const syncReleased = new Promise((resolve) => { releaseSync = resolve; });
  const syncFinished = new Promise((resolve) => { markSyncFinished = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async (_workspace, options) => {
      markSyncStarted();
      await syncReleased;
      if (options.shouldContinue?.() !== false) await writeFile(marker, "late\n", "utf8");
      markSyncFinished();
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const watcher = intervals.find((handle) => handle.delay === 1_000);
  assert.ok(watcher, "watch mode must own a sync interval");
  watcher.callback();
  await syncStarted;

  const stopPromise = service.stop();
  const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
  const restartPromise = service.start();
  const restartedBeforeRelease = await settlesWithin(restartPromise, 100);
  releaseSync();
  await syncFinished;
  await stopPromise;
  await restartPromise;
  await service.stop();

  assert.equal(stoppedBeforeRelease, false, "stop must remain pending while the old watcher can still write");
  assert.equal(restartedBeforeRelease, false, "restart must wait for the old service stop to settle");
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("fail-closed watcher stop observes a rejection before it settles", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-stop-rejection-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let rejectSync;
  let markSyncStarted;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const syncReleased = new Promise((_, reject) => { rejectSync = reject; });
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      markSyncStarted();
      return syncReleased;
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const watcher = intervals.find((handle) => handle.delay === 1_000);
  assert.ok(watcher, "watch mode must own a sync interval");
  watcher.callback();
  await syncStarted;

  const stopPromise = service.stop();
  const stoppedBeforeRejection = await settlesWithin(stopPromise, 100);
  rejectSync(new Error("detached watcher sync rejected after stop"));
  await stopPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stoppedBeforeRejection, false, "stop must observe the active watcher before publishing completion");
  assert.deepEqual(unhandled, []);
});

test("stop immediately observes an active manual rejection while a host dashboard is still draining", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-manual-rejection-observer-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let rejectManual;
  let releaseDashboard;
  let markManualStarted;
  let markDashboardStarted;
  const manualStarted = new Promise((resolve) => { markManualStarted = resolve; });
  const manualReleased = new Promise((_, reject) => { rejectManual = reject; });
  const dashboardStarted = new Promise((resolve) => { markDashboardStarted = resolve; });
  const dashboardReleased = new Promise((resolve) => { releaseDashboard = resolve; });
  const unhandled = [];
  const warnings = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: {
      loadLanceDbRecords: async () => {
        markDashboardStarted();
        await dashboardReleased;
        return [];
      },
      logger: { info() {}, warn(message) { warnings.push(String(message)); } },
    },
    onSync: async () => {
      markManualStarted();
      await manualReleased;
    },
  });

  await service.start();
  await dashboardStarted;
  const manualPromise = service.syncOnce();
  await manualStarted;
  const stopPromise = service.stop();
  rejectManual(new Error("manual sync rejected during host drain"));
  await new Promise((resolve) => setImmediate(resolve));
  const stoppedBeforeHostRelease = await settlesWithin(stopPromise, 100);
  releaseDashboard();
  await assert.rejects(manualPromise, /manual sync rejected during host drain/);
  await stopPromise;

  assert.equal(stoppedBeforeHostRelease, false, "the active host dashboard must keep stop fail-closed");
  assert.deepEqual(unhandled, [], "stop must attach a rejection observer before awaiting host tasks");
  assert.ok(warnings.some((message) => message.includes("active manual task failed during stop")));
});

test("host watcher does not queue an async metrics write that can outlive stop", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-stop-metrics-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const runStatePath = join(vault, "run-state.json");
  let releaseQueue;
  let markQueueHeld;
  const queueHeld = new Promise((resolve) => { markQueueHeld = resolve; });
  const queueReleased = new Promise((resolve) => { releaseQueue = resolve; });
  const predecessor = atomicJsonUpdate(runStatePath, async () => {
    markQueueHeld();
    await queueReleased;
    return { testQueue: "released" };
  });
  await queueHeld;

  let markSyncStarted;
  let markSyncFinished;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const syncFinished = new Promise((resolve) => { markSyncFinished = resolve; });
  const service = createObsidianBridgeService({
    enabled: true,
    dryRun: false,
    watch: true,
    intervalMs: 10,
    workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }],
  }, {
    syncWorkspace: async (workspace, options) => {
      markSyncStarted();
      try {
        return await syncWorkspace(workspace, options);
      } finally {
        markSyncFinished();
      }
    },
    loadLanceDbRecords: async () => [],
    logger: { info() {}, warn() {} },
    mutationPolicyForWorkspace(workspace) {
      return confirmedObsidianPolicy({
        baseDbPath: workspace.path,
        agentId: workspace.agentId,
        workspaceIdentity: `workspace:v1:${workspace.workspaceId}`,
        command: ["dashboards", "build"],
      });
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const watcher = intervals.find((handle) => handle.delay === 1_000);
  assert.ok(watcher, "watch mode must own a sync interval");
  watcher.callback();
  await syncStarted;

  const stopPromise = service.stop();
  assert.equal(await settlesWithin(stopPromise, 1_500), true);
  releaseQueue();
  await predecessor;
  await syncFinished;
  await stopPromise;

  const runState = JSON.parse(await readFile(runStatePath, "utf8"));
  assert.equal(runState.testQueue, "released");
  assert.equal(runState.metrics?.obsidianSync, undefined, "a stopped watcher must not write queued metrics after stop");
});

test("periodic watcher remains queue-only when an approved note could start a non-cancellable production store", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-stop-store-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const cardsDir = join(vault, "memory", "cards");
  await mkdir(cardsDir, { recursive: true });
  await writeFile(join(cardsDir, "approved.md"), [
    "---",
    "plur1bus_type: memory_card",
    "workspace_id: ws1",
    "agent_id: a1",
    "category: fact",
    "importance: 0.7",
    "scope: workspace",
    "source_kind: obsidian",
    "sync_status: validated",
    "content_hash: 565662a959d2675f559b8d72f29c989f0ec73e551792b85612410614c681e1e7",
    "---",
    "",
    "Approved watcher memory.",
  ].join("\n"), "utf8");

  let releaseStore;
  let markStoreStarted;
  let markSyncFinished;
  let syncResult;
  let storeCalls = 0;
  let durableCommits = 0;
  const storeStarted = new Promise((resolve) => { markStoreStarted = resolve; });
  const storeReleased = new Promise((resolve) => { releaseStore = resolve; });
  const syncFinished = new Promise((resolve) => { markSyncFinished = resolve; });
  const productionLikeStore = async () => {
    storeCalls += 1;
    markStoreStarted();
    await storeReleased;
    durableCommits += 1;
    return { details: { id: "late-store-id" } };
  };
  const service = createObsidianBridgeService({
    enabled: true,
    dryRun: false,
    watch: true,
    intervalMs: 10,
    workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }],
  }, {
    syncWorkspace: async (workspace, options) => {
      try {
        // Closely derived drift fixture: even if a future config path injects
        // approval, the periodic service itself must enforce queue-only mode.
        syncResult = await syncWorkspace(workspace, {
          ...options,
          applyApproved: true,
          approvedPaths: "all",
        });
        return syncResult;
      } finally {
        markSyncFinished();
      }
    },
    memoryStore: productionLikeStore,
    loadLanceDbRecords: async () => [],
    logger: { info() {}, warn() {} },
    mutationPolicyForWorkspace(workspace) {
      return confirmedObsidianPolicy({
        baseDbPath: workspace.path,
        agentId: workspace.agentId,
        workspaceIdentity: `workspace:v1:${workspace.workspaceId}`,
        command: ["review", "apply"],
      });
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const watcher = intervals.find((handle) => handle.delay === 1_000);
  assert.ok(watcher, "watch mode must own a sync interval");
  watcher.callback();
  const firstOutcome = await Promise.race([
    storeStarted.then(() => "store_started"),
    syncFinished.then(() => "sync_finished"),
  ]);

  const stopPromise = service.stop();
  assert.equal(await settlesWithin(stopPromise, 1_500), true);
  assert.equal(durableCommits, 0, "the store must not commit before its artificial release");
  releaseStore();
  await syncFinished;
  await stopPromise;

  assert.equal(syncResult?.scan?.files?.length, 1, JSON.stringify(syncResult));
  assert.equal(firstOutcome, "sync_finished", "a periodic watcher must never enter the approved store path");
  assert.equal(storeCalls, 0);
  assert.equal(durableCommits, 0, "no durable store may commit after watcher stop");
});

test("stop quiesces the old watcher generation before restart can run the next generation", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-generation-restart-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const staleMarker = join(vault, "stale-generation.txt");
  const freshMarker = join(vault, "fresh-generation.txt");
  let releaseFirst;
  let markFirstStarted;
  let markFirstFinished;
  let markSecondFinished;
  let calls = 0;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const firstFinished = new Promise((resolve) => { markFirstFinished = resolve; });
  const secondFinished = new Promise((resolve) => { markSecondFinished = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async (_workspace, options) => {
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        await firstReleased;
        if (options.shouldContinue?.() !== false) await writeFile(staleMarker, "stale\n", "utf8");
        markFirstFinished();
        return;
      }
      if (options.shouldContinue?.() !== false) await writeFile(freshMarker, "fresh\n", "utf8");
      markSecondFinished();
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  intervals.filter((handle) => handle.delay === 1_000).at(-1).callback();
  await firstStarted;
  const stopPromise = service.stop();
  const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
  const restartPromise = service.start();
  const restartedBeforeRelease = await settlesWithin(restartPromise, 100);
  releaseFirst();
  await firstFinished;
  await stopPromise;
  await restartPromise;
  await new Promise((resolve) => setImmediate(resolve));
  intervals.filter((handle) => handle.delay === 1_000).at(-1).callback();
  assert.equal(await settlesWithin(secondFinished, 1_500), true, "the restarted generation must run independently");
  await service.stop();

  assert.equal(stoppedBeforeRelease, false);
  assert.equal(restartedBeforeRelease, false);
  await assert.rejects(access(staleMarker), { code: "ENOENT" });
  await access(freshMarker);
  assert.equal(calls, 2);
});

test("restart never revives a pending follow-up from the stopped watcher generation", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-generation-pending-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseFirst;
  let markFirstStarted;
  let markFirstFinished;
  let calls = 0;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const firstFinished = new Promise((resolve) => { markFirstFinished = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        await firstReleased;
        markFirstFinished();
      }
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const oldWatcher = intervals.filter((handle) => handle.delay === 1_000).at(-1);
  oldWatcher.callback();
  await firstStarted;
  oldWatcher.callback();
  await new Promise((resolve) => setImmediate(resolve));
  const stopPromise = service.stop();
  const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
  const restartPromise = service.start();
  const restartedBeforeRelease = await settlesWithin(restartPromise, 100);
  releaseFirst();
  await firstFinished;
  await stopPromise;
  await restartPromise;
  await new Promise((resolve) => setImmediate(resolve));
  await service.stop();

  assert.equal(stoppedBeforeRelease, false);
  assert.equal(restartedBeforeRelease, false);
  assert.equal(calls, 1, "the stopped generation must discard its pending follow-up permanently");
});

test("manual sync stays serialized behind an active host generation and retains manual mode", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-manual-serialization-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseHost;
  let markHostStarted;
  let active = 0;
  let maxActive = 0;
  const modes = [];
  const hostStarted = new Promise((resolve) => { markHostStarted = resolve; });
  const hostReleased = new Promise((resolve) => { releaseHost = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async (_workspace, options) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      modes.push(options.queueOnly === true ? "host" : "manual");
      if (modes.length === 1) {
        markHostStarted();
        await hostReleased;
      }
      active -= 1;
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  intervals.filter((handle) => handle.delay === 1_000).at(-1).callback();
  await hostStarted;
  const manualPromise = service.syncOnce();
  await new Promise((resolve) => setImmediate(resolve));
  const manualStartedBeforeRelease = modes.includes("manual");
  releaseHost();
  await manualPromise;
  await service.stop();

  assert.equal(manualStartedBeforeRelease, false, "manual sync must queue behind the active host writer");
  assert.equal(maxActive, 1);
  assert.deepEqual(modes, ["host", "manual"], "the queued manual request must not inherit queueOnly");
});

test("distinct overlapping manual sync requests preserve every request's options in FIFO order", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-manual-options-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const modes = [];
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async (_workspace, options) => {
      modes.push(options.queueOnly === true ? "queue-only" : "apply-capable");
      if (modes.length === 1) {
        markFirstStarted();
        await firstReleased;
      }
    },
  });

  const first = service.syncOnce({ queueOnly: true });
  await firstStarted;
  const second = service.syncOnce({ queueOnly: false });
  const third = service.syncOnce({ queueOnly: true });
  releaseFirst();
  await Promise.all([first, second, third]);
  await service.stop();

  assert.deepEqual(modes, ["queue-only", "apply-capable", "queue-only"]);
});

test("five coalesced watcher ticks count one failed sync request and do not suspend the watcher", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-coalesced-failure-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseFirst;
  let markFirstStarted;
  let markSecondAttempted;
  let markThirdFinished;
  let calls = 0;
  const warnings = [];
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const secondAttempted = new Promise((resolve) => { markSecondAttempted = resolve; });
  const thirdFinished = new Promise((resolve) => { markThirdFinished = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: {
      loadLanceDbRecords: async () => [],
      logger: { info() {}, warn(message) { warnings.push(String(message)); } },
    },
    onSync: async () => {
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        await firstReleased;
        return;
      }
      if (calls === 2) {
        markSecondAttempted();
        throw new Error("one coalesced sync failure");
      }
      markThirdFinished();
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const watcher = intervals.find((handle) => handle.delay === 1_000);
  watcher.callback();
  await firstStarted;
  for (let i = 0; i < 5; i++) watcher.callback();
  releaseFirst();
  await secondAttempted;
  await new Promise((resolve) => setImmediate(resolve));
  watcher.callback();
  const thirdRan = await settlesWithin(thirdFinished, 1_500);
  await service.stop();

  assert.equal(thirdRan, true, "one actual failed request must not suspend the watcher");
  assert.equal(calls, 3);
  assert.equal(warnings.filter((message) => message.includes("watch sync failed (")).length, 1);
  assert.equal(warnings.some((message) => message.includes("sync suspended")), false);
});

test("five coalesced dashboard ticks count one failed rebuild and do not suspend dashboards", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-dashboard-coalesced-failure-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseFirst;
  let markFirstStarted;
  let markThirdFinished;
  let loadCalls = 0;
  const warnings = [];
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const thirdFinished = new Promise((resolve) => { markThirdFinished = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: {
      loadLanceDbRecords: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          markFirstStarted();
          await firstReleased;
          return [];
        }
        if (loadCalls === 2) {
          throw new Error("one real coalesced dashboard loader failure");
        }
        markThirdFinished();
        return [];
      },
      logger: {
        info() {},
        warn(message) { warnings.push(String(message)); },
      },
    },
  });

  await service.start();
  await firstStarted;
  const dashboardTimer = intervals.find((handle) => handle.delay >= 30_000);
  for (let i = 0; i < 5; i++) dashboardTimer.callback();
  releaseFirst();
  while (loadCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  dashboardTimer.callback();
  const thirdRan = await settlesWithin(thirdFinished, 1_500);
  await service.stop();

  assert.equal(thirdRan, true, "one actual failed rebuild must not suspend dashboard scheduling");
  assert.equal(loadCalls, 3);
  assert.equal(warnings.filter((message) => message.includes("dashboard rebuild failed (")).length, 1);
});

test("the fifth failed watcher request drops a queued host tick but preserves manual recovery", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-failure-threshold-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseFifth;
  let markFifthStarted;
  let calls = 0;
  const modes = [];
  const warnings = [];
  const fifthStarted = new Promise((resolve) => { markFifthStarted = resolve; });
  const fifthReleased = new Promise((resolve) => { releaseFifth = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: {
      loadLanceDbRecords: async () => [],
      logger: { info() {}, warn(message) { warnings.push(String(message)); } },
    },
    onSync: async (_workspace, options) => {
      calls += 1;
      modes.push(options.queueOnly === true ? "host" : "manual");
      if (calls < 5) throw new Error(`serial sync failure ${calls}`);
      if (calls === 5) {
        markFifthStarted();
        await fifthReleased;
        throw new Error("serial sync failure 5");
      }
    },
  });
  const failureCount = () => warnings.filter((message) => message.includes("watch sync failed (")).length;
  const waitForFailures = async (expected) => {
    const deadline = Date.now() + 1_500;
    while (failureCount() < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(failureCount(), expected);
  };

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  const watcher = intervals.find((handle) => handle.delay === 1_000);
  for (let expected = 1; expected <= 4; expected++) {
    watcher.callback();
    await waitForFailures(expected);
  }
  watcher.callback();
  await fifthStarted;
  watcher.callback();
  const manualRecovery = service.syncOnce();
  releaseFifth();
  await manualRecovery;
  await waitForFailures(5);
  await service.stop();

  assert.deepEqual(modes, ["host", "host", "host", "host", "host", "manual"]);
  assert.equal(calls, 6, "the queued sixth host tick must be dropped at the threshold");
  assert.equal(warnings.filter((message) => message.includes("sync suspended")).length, 1);
});

test("the fifth failed dashboard request drops a queued host rebuild but preserves manual recovery", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-dashboard-failure-threshold-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseFifth;
  let markFifthStarted;
  let markHostRecoveryFinished;
  let loadCalls = 0;
  const warnings = [];
  const fifthStarted = new Promise((resolve) => { markFifthStarted = resolve; });
  const fifthReleased = new Promise((resolve) => { releaseFifth = resolve; });
  const hostRecoveryFinished = new Promise((resolve) => { markHostRecoveryFinished = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: {
      loadLanceDbRecords: async () => {
        loadCalls += 1;
        if (loadCalls < 5) throw new Error(`serial dashboard loader failure ${loadCalls}`);
        if (loadCalls === 5) {
          markFifthStarted();
          await fifthReleased;
          throw new Error("serial dashboard loader failure 5");
        }
        markHostRecoveryFinished();
        return [];
      },
      logger: { info() {}, warn(message) { warnings.push(String(message)); } },
    },
  });
  const failureCount = () => warnings.filter((message) => message.includes("dashboard rebuild failed (")).length;
  const waitForFailures = async (expected) => {
    const deadline = Date.now() + 1_500;
    while (failureCount() < expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(failureCount(), expected);
  };

  await service.start();
  const dashboardTimer = intervals.find((handle) => handle.delay >= 30_000);
  await waitForFailures(1);
  for (let expected = 2; expected <= 4; expected++) {
    dashboardTimer.callback();
    await waitForFailures(expected);
  }
  dashboardTimer.callback();
  await fifthStarted;
  dashboardTimer.callback();
  const manualRecovery = service.rebuildDashboards({ lancedbRecords: [] });
  releaseFifth();
  await manualRecovery;
  await waitForFailures(5);
  const loadsBeforeRecoveryTick = loadCalls;
  dashboardTimer.callback();
  const hostResumed = await settlesWithin(hostRecoveryFinished, 1_500);
  await service.stop();

  assert.equal(loadsBeforeRecoveryTick, 5, "the queued sixth host rebuild must be dropped at the threshold");
  assert.equal(hostResumed, true, "a successful manual rebuild must resume dashboard scheduling");
  assert.equal(loadCalls, 6);
});

test("stop cancels a queued manual sync so restart cannot run it", async (t) => {
  const intervals = captureIntervals(t);
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-manual-queued-stop-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const manualMarker = join(vault, "queued-manual.txt");
  let releaseHost;
  let markHostStarted;
  let markHostFinished;
  let calls = 0;
  const hostStarted = new Promise((resolve) => { markHostStarted = resolve; });
  const hostReleased = new Promise((resolve) => { releaseHost = resolve; });
  const hostFinished = new Promise((resolve) => { markHostFinished = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      calls += 1;
      if (calls === 1) {
        markHostStarted();
        await hostReleased;
        markHostFinished();
        return;
      }
      await writeFile(manualMarker, "manual\n", "utf8");
    },
  });

  await service.start();
  await new Promise((resolve) => setImmediate(resolve));
  intervals.filter((handle) => handle.delay === 1_000).at(-1).callback();
  await hostStarted;
  const manualPromise = service.syncOnce();
  const stopPromise = service.stop();
  const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
  const restartPromise = service.start();
  const restartedBeforeRelease = await settlesWithin(restartPromise, 100);
  releaseHost();
  await hostFinished;
  await stopPromise;
  await restartPromise;
  await manualPromise;
  await new Promise((resolve) => setImmediate(resolve));
  await service.stop();

  assert.equal(stoppedBeforeRelease, false);
  assert.equal(restartedBeforeRelease, false);
  assert.equal(calls, 1, "a manual request queued before stop must be cancelled, not revived");
  await assert.rejects(access(manualMarker), { code: "ENOENT" });
});

test("stop waits fail-closed for an already active manual sync before restart", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-manual-active-stop-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const manualMarker = join(vault, "active-manual.txt");
  let releaseManual;
  let markManualStarted;
  const manualStarted = new Promise((resolve) => { markManualStarted = resolve; });
  const manualReleased = new Promise((resolve) => { releaseManual = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      markManualStarted();
      await manualReleased;
      await writeFile(manualMarker, "manual\n", "utf8");
    },
  });

  const manualPromise = service.syncOnce();
  await manualStarted;
  const stopPromise = service.stop();
  const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
  releaseManual();
  await manualPromise;
  await stopPromise;
  await service.start();
  await service.stop();

  assert.equal(stoppedBeforeRelease, false, "stop must not detach an active manual writer");
  await access(manualMarker);
});

test("a public generationToken cannot spoof host ownership or escape stop draining", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-public-token-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseSync;
  let markSyncStarted;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const syncReleased = new Promise((resolve) => { releaseSync = resolve; });
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      markSyncStarted();
      await syncReleased;
    },
  });

  const request = service.syncOnce({ generationToken: 1 });
  await syncStarted;
  const stopPromise = service.stop();
  const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
  releaseSync();
  await request;
  await stopPromise;

  assert.equal(stoppedBeforeRelease, false, "all public sync requests must be drained as manual work");
});

test("a public shouldContinue callback cannot orphan a queued manual sync request", async (t) => {
  const vault = await mkdtemp(join(tmpdir(), "obs-watch-public-predicate-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  let releaseFirst;
  let markFirstStarted;
  let calls = 0;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { service } = makeService({
    config: { workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: vault }] },
    options: { loadLanceDbRecords: async () => [] },
    onSync: async () => {
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        await firstReleased;
      }
    },
  });

  const first = service.syncOnce();
  await firstStarted;
  const second = service.syncOnce({
    shouldContinue() { throw new Error("public sync predicate exploded"); },
  });
  releaseFirst();
  await first;
  const secondSettled = await settlesWithin(second, 500);
  await service.stop();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(secondSettled, true, "the queued manual request must execute with lifecycle options stripped");
  assert.equal(calls, 2);
  assert.deepEqual(unhandled, []);
});

test("overlapping interval calls start only one active sync", async () => {
  let active = 0;
  let maxActive = 0;

  const { service } = makeService({
    onSync: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    },
  });

  const p1 = service.syncOnce();
  const p2 = service.syncOnce();
  const p3 = service.syncOnce();
  await Promise.all([p1, p2, p3]);

  assert.ok(maxActive === 1, "only one sync should be active at a time");
});

test("overlapping manual sync requests each complete after the active sync finishes", async () => {
  const { service, calls } = makeService({
    onSync: async () => {
      await new Promise((r) => setTimeout(r, 10));
    },
  });

  const p1 = service.syncOnce();
  const p2 = service.syncOnce();
  const p3 = service.syncOnce();
  await Promise.all([p1, p2, p3]);

  assert.strictEqual(calls.length, 3, "manual requests must not lose distinct operator intent");
});

test("sync error resets syncRunning so the next tick can run", async () => {
  let calls = 0;
  const { service } = makeService({
    onSync: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    },
  });

  let firstError = null;
  try {
    await service.syncOnce();
  } catch (e) {
    firstError = e;
  }
  assert.ok(firstError, "first sync should throw");

  const second = await service.syncOnce();
  assert.ok(second, "second sync should run after error reset");
  assert.strictEqual(calls, 2, "two sync calls should have executed");
});

test("pending sync does not swallow the active sync error", async () => {
  let calls = 0;
  const { service } = makeService({
    onSync: async () => {
      calls++;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("boom");
      }
    },
  });

  const first = service.syncOnce();
  const pending = service.syncOnce();

  await pending;
  await assert.rejects(first, /boom/, "first sync must reject even when a pending sync runs afterward");
  assert.strictEqual(calls, 2, "failed active sync plus one pending follow-up should run");
});

test("manual successful sync resumes watch loop after failure suspension", async () => {
  let calls = 0;
  let fail = true;
  const { service } = makeService({
    onSync: async () => {
      calls++;
      if (fail) throw new Error("boom");
    },
  });

  await service.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 5600));
    const suspendedAt = calls;
    assert.ok(suspendedAt >= 5, `expected watch to hit failure suspension, got ${suspendedAt} calls`);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.strictEqual(calls, suspendedAt, "watch should be suspended after repeated failures");

    fail = false;
    await service.syncOnce();
    const afterManual = calls;
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.ok(calls > afterManual, "manual successful sync should resume future watch ticks");
  } finally {
    await service.stop();
  }
});
