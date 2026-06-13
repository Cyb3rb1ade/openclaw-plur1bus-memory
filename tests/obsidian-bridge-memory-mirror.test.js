import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createObsidianBridgeService } from "../lib/obsidian-bridge.js";

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

describe("obsidian bridge LanceDB memory mirror", () => {
  it("rebuildDashboards loads LanceDB records per workspace and writes memory notes", async () => {
    const vault = makeVault("obs-mirror-main-");
    const id = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1";
    const calls = [];
    const service = createObsidianBridgeService({
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
    const service = createObsidianBridgeService({
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

  it("rebuildDashboards keeps workspace memory mirrors isolated", async () => {
    const mainVault = makeVault("obs-mirror-main-");
    const bernVault = makeVault("obs-mirror-bern-");
    const mainId = "cccccccc-1111-4111-8111-ccccccccccc1";
    const bernId = "dddddddd-1111-4111-8111-ddddddddddd1";
    const service = createObsidianBridgeService({
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
    const service = createObsidianBridgeService({
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
    const service = createObsidianBridgeService({
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
    const service = createObsidianBridgeService({
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
    const serviceWithoutLoader = createObsidianBridgeService({
      enabled: true,
      dryRun: false,
      reviewRoot: "plur1bus",
      workspaces: [{ workspace_id: "main", agent_id: "main", path: missingLoaderVault }],
    }, {
      logger: { info() {}, warn() {} },
    });
    const serviceWithEmptyLoader = createObsidianBridgeService({
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
});
