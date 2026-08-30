import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
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

describe("obsidian bridge LanceDB memory mirror", () => {
  it("rebuildDashboards coalesces overlapping rebuilds", async () => {
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
    assert.strictEqual(calls, 2, "overlapping rebuilds should collapse into one pending follow-up");
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
});
