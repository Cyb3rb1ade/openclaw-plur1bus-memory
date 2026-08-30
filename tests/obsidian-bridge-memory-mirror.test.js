import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createObsidianBridgeService } from "../lib/obsidian-bridge.js";
import { parseObsidianCommandPlan } from "../lib/obsidian-mutation-policy.js";

function makeVault(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function memoryRecord(id, overrides = {}) {
  return {
    id,
    text: `Memory ${id}`,
    summary: `Summary ${id}`,
    category: "fact",
    importance: 0.8,
    createdAt: "2026-06-01T00:00:00.000Z",
    scope: "workspace",
    status: "active",
    ...overrides,
  };
}

function memoryFile(vault, id) {
  return join(vault, "plur1bus", "memories", `${id}.md`);
}

function createTestService(config, options = {}) {
  return createObsidianBridgeService(config, {
    ...options,
    mutationPolicyForWorkspace(workspace) {
      return parseObsidianCommandPlan(["dashboards", "build"], {
        memoryCtx: {
          agentId: workspace.agentId,
          workspaceIdentity: `workspace:v1:${workspace.workspaceId}`,
        },
        baseDbPath: workspace.path,
        mode: "apply",
        allowWrite: true,
        vaultConfirmed: true,
        actionConfirmed: true,
      }).mutationPolicy;
    },
  });
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

describe("obsidian bridge LanceDB memory mirror", () => {
  it("rebuildDashboards serializes overlapping manual requests without dropping one", async () => {
    const vault = makeVault("obs-mirror-reentrant-");
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return [memoryRecord("aaaaaaaa-1111-4111-8111-aaaaaaaaaaa9")];
      },
      logger: { info() {}, warn() {} },
    });

    await Promise.all([
      service.rebuildDashboards(),
      service.rebuildDashboards(),
      service.rebuildDashboards(),
    ]);

    assert.strictEqual(maxActive, 1, "only one dashboard rebuild should be active at a time");
    assert.strictEqual(calls, 3, "each manual rebuild request must retain its own payload and execution");
  });

  it("rebuildDashboards preserves distinct queued manual snapshots in FIFO order", async () => {
    const vault = makeVault("obs-mirror-manual-fifo-");
    const firstId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa6";
    const secondId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa7";
    const thirdId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa8";
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => {
        markFirstStarted();
        await firstReleased;
        return [memoryRecord(firstId)];
      },
      logger: { info() {}, warn() {} },
    });

    const first = service.rebuildDashboards();
    await firstStarted;
    const second = service.rebuildDashboards({ lancedbRecords: [memoryRecord(secondId)] });
    const third = service.rebuildDashboards({ lancedbRecords: [memoryRecord(thirdId)] });
    releaseFirst();
    await Promise.all([first, second, third]);
    await service.stop();

    assert.equal(existsSync(memoryFile(vault, firstId)), true);
    assert.equal(existsSync(memoryFile(vault, secondId)), true);
    assert.equal(existsSync(memoryFile(vault, thirdId)), true);
  });

  it("rejects once when the real memory-note writer reports a workspace write error", async () => {
    const vault = makeVault("obs-mirror-write-error-");
    const id = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa5";
    const warnings = [];
    // A directory at the exact managed note path lets the writer create its
    // atomic temp file but makes renameSync fail for this real record.
    mkdirSync(memoryFile(vault, id), { recursive: true });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      logger: { info() {}, warn(message) { warnings.push(String(message)); } },
    });

    await assert.rejects(
      service.rebuildDashboards({ lancedbRecords: [memoryRecord(id)] }),
      (error) => error instanceof AggregateError
        && error.errors.length === 1
        && error.message.includes("1 workspace"),
    );
    await service.stop();

    assert.equal(warnings.filter((message) => message.includes("writeMemoryNotes: 1 error")).length, 1);
    assert.equal(existsSync(memoryFile(vault, id)), true, "the failed target remains as forensic evidence");
  });

  it("rebuildDashboards loads LanceDB records per workspace and writes memory notes", async () => {
    const vault = makeVault("obs-mirror-main-");
    const id = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
    const calls = [];
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async ({ workspace, agentId, workspaceKey }) => {
        calls.push({ workspaceId: workspace.workspaceId, agentId, workspaceKey });
        return [memoryRecord(id)];
      },
      logger: { info() {}, warn() {} },
    });

    await service.rebuildDashboards();

    assert.deepStrictEqual(calls, [{ workspaceId: "main", agentId: "main", workspaceKey: "main" }]);
    assert.ok(existsSync(memoryFile(vault, id)), "memory note should be materialized");
    const content = readFileSync(memoryFile(vault, id), "utf8");
    assert.match(content, /plur1bus_type: memory/);
    assert.match(content, /memory_id: aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1/);
    assert.ok(!existsSync(join(vault, "memory", "cards", `${id}.md`)), "must not write to memory/cards");
  });

  it("rebuildDashboards filters generated records before materializing memory notes", async () => {
    const vault = makeVault("obs-mirror-filter-");
    const realId = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb1";
    const generatedIds = [
      "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb2",
      "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb3",
      "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb4",
      "bbbbbbbb-1111-4111-8111-bbbbbbbbbbb5",
    ];
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => [
        memoryRecord(realId),
        memoryRecord(generatedIds[0], { type: "duplicate_candidate" }),
        memoryRecord(generatedIds[1], { plur1bus_type: "provenance" }),
        memoryRecord(generatedIds[2], { type: "impact_analysis" }),
        memoryRecord(generatedIds[3], { type: "source" }),
      ],
      logger: { info() {}, warn() {} },
    });

    await service.rebuildDashboards();

    assert.ok(existsSync(memoryFile(vault, realId)), "real memory should be written");
    for (const id of generatedIds) {
      assert.ok(!existsSync(memoryFile(vault, id)), `generated record ${id} should not be written`);
    }
  });

  it("rebuildDashboards rejects explicit non-memory kinds while preserving legacy rows", async () => {
    const vault = makeVault("obs-mirror-kind-filter-");
    const legacyId = "ab11ab11-1111-4111-8111-ab11ab11ab11";
    const memoryId = "ab22ab22-2222-4222-8222-ab22ab22ab22";
    const reminderId = "ab33ab33-3333-4333-8333-ab33ab33ab33";
    const wikiId = "ab44ab44-4444-4444-8444-ab44ab44ab44";
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => [
        memoryRecord(legacyId),
        memoryRecord(memoryId, { memoryKind: "memory" }),
        memoryRecord(reminderId, { memoryKind: "reminder" }),
        memoryRecord(wikiId, { memoryKind: "wiki" }),
      ],
      logger: { info() {}, warn() {} },
    });

    const result = await service.rebuildDashboards();

    assert.ok(existsSync(memoryFile(vault, legacyId)), "legacy rows lacking memoryKind should still materialize");
    assert.ok(existsSync(memoryFile(vault, memoryId)), "explicit memory rows should materialize");
    assert.ok(!existsSync(memoryFile(vault, reminderId)), "reminder rows must not be materialized as memory notes");
    assert.ok(!existsSync(memoryFile(vault, wikiId)), "wiki rows must not be materialized as memory notes");
    assert.strictEqual(result.memoryMirror.loaded, 4);
    assert.strictEqual(result.memoryMirror.materialized, 2);
  });

  it("rebuildDashboards keeps workspace memory mirrors isolated", async () => {
    const mainVault = makeVault("obs-mirror-main-");
    const bernVault = makeVault("obs-mirror-bern-");
    const mainId = "cccccccc-1111-4111-8111-ccccccccccc1";
    const bernId = "dddddddd-1111-4111-8111-ddddddddddd1";
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [
        { workspace_id: "main", agent_id: "main", path: mainVault },
        { workspace_id: "bernhardine", agent_id: "bernhardine", path: bernVault },
      ],
    }, {
      loadLanceDbRecords: async ({ workspace }) => (
        workspace.workspaceId === "main" ? [memoryRecord(mainId)] : [memoryRecord(bernId)]
      ),
      logger: { info() {}, warn() {} },
    });

    await service.rebuildDashboards();

    assert.ok(existsSync(memoryFile(mainVault, mainId)), "main memory should be in main vault");
    assert.ok(!existsSync(memoryFile(mainVault, bernId)), "bernhardine memory must not be in main vault");
    assert.ok(existsSync(memoryFile(bernVault, bernId)), "bernhardine memory should be in bernhardine vault");
    assert.ok(!existsSync(memoryFile(bernVault, mainId)), "main memory must not be in bernhardine vault");
  });

  it("rebuildDashboards is idempotent on a second loader-backed run", async () => {
    const vault = makeVault("obs-mirror-idem-");
    const id = "eeeeeeee-1111-4111-8111-eeeeeeeeeee1";
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => [memoryRecord(id)],
      logger: { info() {}, warn() {} },
    });

    await service.rebuildDashboards();
    const before = statSync(memoryFile(vault, id)).mtimeMs;
    await service.rebuildDashboards();
    const after = statSync(memoryFile(vault, id)).mtimeMs;

    assert.strictEqual(after, before, "second run should not rewrite unchanged memory note");
  });

  it("rebuildDashboards materializes all loaded memories instead of the writer default batch cap", async () => {
    const vault = makeVault("obs-mirror-all-");
    const records = Array.from({ length: 205 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      return memoryRecord(`ffffffff-1111-4111-8111-${suffix}`);
    });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => records,
      logger: { info() {}, warn() {} },
    });

    const result = await service.rebuildDashboards();
    const files = readdirSync(join(vault, "plur1bus", "memories")).filter((file) => file.endsWith(".md"));

    assert.strictEqual(files.length, 205);
    assert.strictEqual(result.memoryMirror.loaded, 205);
    assert.strictEqual(result.memoryMirror.written, 205);
  });

  it("rebuildDashboards deduplicates duplicate memory ids before writing mirrors", async () => {
    const vault = makeVault("obs-mirror-dupe-");
    const id = "99999999-1111-4111-8111-999999999999";
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => [
        memoryRecord(id, { text: "older duplicate", summary: "older", createdAt: 1000 }),
        memoryRecord(id, { text: "newer duplicate", summary: "newer", createdAt: 2000 }),
      ],
      logger: { info() {}, warn() {} },
    });

    const first = await service.rebuildDashboards();
    const content = readFileSync(memoryFile(vault, id), "utf8");
    const second = await service.rebuildDashboards();

    assert.strictEqual(first.memoryMirror.loaded, 2);
    assert.strictEqual(first.memoryMirror.materialized, 1);
    assert.match(content, /newer duplicate/);
    assert.strictEqual(second.memoryMirror.written, 0);
    assert.strictEqual(second.memoryMirror.skipped, 1);
  });

  it("rebuildDashboards is stable when loader is missing or returns no records", async () => {
    const missingLoaderVault = makeVault("obs-mirror-no-loader-");
    const emptyLoaderVault = makeVault("obs-mirror-empty-loader-");
    const serviceWithoutLoader = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: missingLoaderVault }],
    }, {
      logger: { info() {}, warn() {} },
    });
    const serviceWithEmptyLoader = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: emptyLoaderVault }],
    }, {
      loadLanceDbRecords: async () => [],
      logger: { info() {}, warn() {} },
    });

    await serviceWithoutLoader.rebuildDashboards();
    await serviceWithEmptyLoader.rebuildDashboards();

    assert.ok(!existsSync(join(missingLoaderVault, "plur1bus", "memories")), "missing loader should not create memory mirror");
    assert.ok(!existsSync(join(emptyLoaderVault, "plur1bus", "memories")), "empty loader should not create memory mirror");
  });

  it("stop idempotently settles an immediate rebuild and prevents post-stop vault writes", async () => {
    const vault = makeVault("obs-mirror-stop-rebuild-");
    const id = "abab5555-5555-4555-8555-abab55555555";
    let releaseLoader;
    let loaderStartedResolve;
    const loaderStarted = new Promise((resolve) => { loaderStartedResolve = resolve; });
    const loaderReleased = new Promise((resolve) => { releaseLoader = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      syncWorkspace: async () => [],
      loadLanceDbRecords: async () => {
        loaderStartedResolve();
        await loaderReleased;
        return [memoryRecord(id)];
      },
      logger: { info() {}, warn() {} },
    });

    await service.start();
    await loaderStarted;
    const stopA = service.stop();
    const stopB = service.stop();
    releaseLoader();
    await Promise.all([stopA, stopB]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(!existsSync(memoryFile(vault, id)), "in-flight rebuild must not write after stop");
  });

  it("stop waits for the original scheduled rebuild when an overlap is coalesced", async (t) => {
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

    const vault = makeVault("obs-mirror-stop-overlap-");
    let releaseLoader;
    let loaderStartedResolve;
    const loaderStarted = new Promise((resolve) => { loaderStartedResolve = resolve; });
    const loaderReleased = new Promise((resolve) => { releaseLoader = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: true,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      syncWorkspace: async () => [],
      loadLanceDbRecords: async () => {
        loaderStartedResolve();
        await loaderReleased;
        return [memoryRecord("cdcd5555-5555-4555-8555-cdcd55555555")];
      },
      logger: { info() {}, warn() {} },
    });

    await service.start();
    await loaderStarted;
    const dashboardInterval = intervals.find((handle) => handle.delay >= 30_000);
    assert.ok(dashboardInterval, "watch mode should schedule dashboard rebuilds");
    dashboardInterval.callback();
    await new Promise((resolve) => setImmediate(resolve));

    let stopSettled = false;
    const stopPromise = service.stop().then(() => { stopSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    if (stopSettled) {
      releaseLoader();
      await stopPromise;
      assert.fail("stop settled before the original dashboard rebuild quiesced");
    }

    releaseLoader();
    await stopPromise;
    assert.equal(stopSettled, true);
  });

  it("waits fail-closed for a hung dashboard DB load and blocks restart until it quiesces", async () => {
    const vault = makeVault("obs-mirror-stop-budget-");
    const id = "eded5555-5555-4555-8555-eded55555555";
    let releaseLoader;
    let markLoaderStarted;
    let loadCalls = 0;
    const loaderStarted = new Promise((resolve) => { markLoaderStarted = resolve; });
    const loaderReleased = new Promise((resolve) => { releaseLoader = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: true,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      syncWorkspace: async () => [],
      loadLanceDbRecords: async () => {
        loadCalls += 1;
        if (loadCalls > 1) return [];
        markLoaderStarted();
        await loaderReleased;
        return [memoryRecord(id)];
      },
      logger: { info() {}, warn() {} },
    });

    await service.start();
    await loaderStarted;
    const stopPromise = service.stop();
    const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
    const restartPromise = service.start();
    const restartedBeforeRelease = await settlesWithin(restartPromise, 100);
    releaseLoader();
    await stopPromise;
    await restartPromise;
    await new Promise((resolve) => setImmediate(resolve));
    await service.stop();

    assert.equal(stoppedBeforeRelease, false, "stop must remain pending while the old dashboard can still write");
    assert.equal(restartedBeforeRelease, false, "restart must wait for the old service stop to settle");
    assert.equal(existsSync(memoryFile(vault, id)), false, "the stopped dashboard load must not write after service stop");
  });

  it("observes an active dashboard rejection before fail-closed stop settles", async (t) => {
    const vault = makeVault("obs-mirror-stop-rejection-");
    let rejectLoader;
    let markLoaderStarted;
    const loaderStarted = new Promise((resolve) => { markLoaderStarted = resolve; });
    const loaderReleased = new Promise((_, reject) => { rejectLoader = reject; });
    const unhandled = [];
    const onUnhandled = (error) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: true,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      syncWorkspace: async () => [],
      loadLanceDbRecords: async () => {
        markLoaderStarted();
        return loaderReleased;
      },
      logger: { info() {}, warn() {} },
    });

    await service.start();
    await loaderStarted;
    const stopPromise = service.stop();
    const stoppedBeforeRejection = await settlesWithin(stopPromise, 100);
    rejectLoader(new Error("detached dashboard loader rejected after stop"));
    await stopPromise;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(stoppedBeforeRejection, false, "stop must observe the active dashboard before publishing completion");
    assert.deepEqual(unhandled, []);
  });

  it("quiesces the stopped dashboard generation before the same service instance restarts", async () => {
    const vault = makeVault("obs-mirror-generation-restart-");
    const staleId = "eded6666-6666-4666-8666-eded66666666";
    const freshId = "eded7777-7777-4777-8777-eded77777777";
    let releaseFirst;
    let markFirstStarted;
    let markSecondCompleted;
    let loadCalls = 0;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
    const secondCompleted = new Promise((resolve) => { markSecondCompleted = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: true,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      syncWorkspace: async () => [],
      loadLanceDbRecords: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          markFirstStarted();
          await firstReleased;
          return [memoryRecord(staleId)];
        }
        return [memoryRecord(freshId)];
      },
      logger: {
        info(message) {
          if (loadCalls === 2 && String(message).includes("memory mirror")) markSecondCompleted();
        },
        warn() {},
      },
    });

    await service.start();
    await firstStarted;
    const stopPromise = service.stop();
    const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
    const restartPromise = service.start();
    const restartedBeforeRelease = await settlesWithin(restartPromise, 100);
    releaseFirst();
    await stopPromise;
    await restartPromise;
    assert.equal(await settlesWithin(secondCompleted, 1_500), true, "the restarted generation must complete its own dashboard run");
    await new Promise((resolve) => setImmediate(resolve));
    await service.stop();

    assert.equal(stoppedBeforeRelease, false);
    assert.equal(restartedBeforeRelease, false);
    assert.equal(loadCalls, 2);
    assert.equal(existsSync(memoryFile(vault, staleId)), false, "the stopped old generation must remain write-fenced");
    assert.equal(existsSync(memoryFile(vault, freshId)), true);
  });

  it("serializes a manual dashboard snapshot behind the active host dashboard run", async () => {
    const vault = makeVault("obs-mirror-manual-serialization-");
    const hostId = "eded8888-8888-4888-8888-eded88888888";
    const manualId = "eded9999-9999-4999-8999-eded99999999";
    let releaseHost;
    let markHostStarted;
    const hostStarted = new Promise((resolve) => { markHostStarted = resolve; });
    const hostReleased = new Promise((resolve) => { releaseHost = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: true,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      syncWorkspace: async () => [],
      loadLanceDbRecords: async () => {
        markHostStarted();
        await hostReleased;
        return [memoryRecord(hostId)];
      },
      logger: { info() {}, warn() {} },
    });

    await service.start();
    await hostStarted;
    const manualPromise = service.rebuildDashboards({ lancedbRecords: [memoryRecord(manualId)] });
    await new Promise((resolve) => setImmediate(resolve));
    const manualWroteBeforeRelease = existsSync(memoryFile(vault, manualId));
    releaseHost();
    await manualPromise;
    await service.stop();

    assert.equal(manualWroteBeforeRelease, false, "manual dashboard writes must queue behind the active host writer");
    assert.equal(existsSync(memoryFile(vault, hostId)), true);
    assert.equal(existsSync(memoryFile(vault, manualId)), true);
  });

  it("stop cancels a queued manual dashboard snapshot before restart", async () => {
    const vault = makeVault("obs-mirror-manual-queued-stop-");
    const staleHostId = "ededaaaa-aaaa-4aaa-8aaa-ededaaaaaaaa";
    const manualId = "ededbbbb-bbbb-4bbb-8bbb-ededbbbbbbbb";
    let releaseHost;
    let markHostStarted;
    let markRestartLoad;
    let loadCalls = 0;
    const hostStarted = new Promise((resolve) => { markHostStarted = resolve; });
    const hostReleased = new Promise((resolve) => { releaseHost = resolve; });
    const restartLoad = new Promise((resolve) => { markRestartLoad = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: true,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      syncWorkspace: async () => [],
      loadLanceDbRecords: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          markHostStarted();
          await hostReleased;
          return [memoryRecord(staleHostId)];
        }
        markRestartLoad();
        return [];
      },
      logger: { info() {}, warn() {} },
    });

    await service.start();
    await hostStarted;
    const manualPromise = service.rebuildDashboards({ lancedbRecords: [memoryRecord(manualId)] });
    const stopPromise = service.stop();
    const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
    const restartPromise = service.start();
    const restartedBeforeRelease = await settlesWithin(restartPromise, 100);
    releaseHost();
    await manualPromise;
    await stopPromise;
    await restartPromise;
    assert.equal(await settlesWithin(restartLoad, 1_500), true);
    await new Promise((resolve) => setImmediate(resolve));
    await service.stop();

    assert.equal(stoppedBeforeRelease, false);
    assert.equal(restartedBeforeRelease, false);
    assert.equal(existsSync(memoryFile(vault, staleHostId)), false);
    assert.equal(existsSync(memoryFile(vault, manualId)), false, "a queued manual snapshot must not write after stop/restart");
  });

  it("stop waits fail-closed for an already active manual dashboard before restart", async () => {
    const vault = makeVault("obs-mirror-manual-active-stop-");
    const manualId = "ededcccc-cccc-4ccc-8ccc-ededcccccccc";
    let releaseManual;
    let markManualStarted;
    let loadCalls = 0;
    const manualStarted = new Promise((resolve) => { markManualStarted = resolve; });
    const manualReleased = new Promise((resolve) => { releaseManual = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      watch: true,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      syncWorkspace: async () => [],
      loadLanceDbRecords: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          markManualStarted();
          await manualReleased;
          return [memoryRecord(manualId)];
        }
        return [];
      },
      logger: { info() {}, warn() {} },
    });

    const manualPromise = service.rebuildDashboards();
    await manualStarted;
    const stopPromise = service.stop();
    const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
    releaseManual();
    await manualPromise;
    await stopPromise;
    await service.start();
    await new Promise((resolve) => setImmediate(resolve));
    await service.stop();

    assert.equal(stoppedBeforeRelease, false, "stop must not detach an active manual dashboard writer");
    assert.equal(existsSync(memoryFile(vault, manualId)), true);
  });

  it("a public generationToken cannot spoof dashboard host ownership or escape stop draining", async () => {
    const vault = makeVault("obs-mirror-public-token-");
    let releaseLoader;
    let markLoaderStarted;
    const loaderStarted = new Promise((resolve) => { markLoaderStarted = resolve; });
    const loaderReleased = new Promise((resolve) => { releaseLoader = resolve; });
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => {
        markLoaderStarted();
        await loaderReleased;
        return [];
      },
      logger: { info() {}, warn() {} },
    });

    const request = service.rebuildDashboards({ generationToken: 1 });
    await loaderStarted;
    const stopPromise = service.stop();
    const stoppedBeforeRelease = await settlesWithin(stopPromise, 100);
    releaseLoader();
    await request;
    await stopPromise;

    assert.equal(stoppedBeforeRelease, false, "all public dashboard requests must be drained as manual work");
  });

  it("a public shouldContinue callback cannot orphan a queued manual dashboard request", async (t) => {
    const vault = makeVault("obs-mirror-public-predicate-");
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
    const unhandled = [];
    const onUnhandled = (error) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    t.after(() => process.off("unhandledRejection", onUnhandled));
    const service = createTestService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: vault }],
    }, {
      loadLanceDbRecords: async () => {
        markFirstStarted();
        await firstReleased;
        return [];
      },
      logger: { info() {}, warn() {} },
    });

    const first = service.rebuildDashboards();
    await firstStarted;
    const second = service.rebuildDashboards({
      lancedbRecords: [],
      shouldContinue() { throw new Error("public dashboard predicate exploded"); },
    });
    releaseFirst();
    await first;
    const secondSettled = await settlesWithin(second, 500);
    await service.stop();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(secondSettled, true, "the queued manual request must execute with lifecycle options stripped");
    assert.deepEqual(unhandled, []);
  });
});
