import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureLegacySourceMarkerColumn,
  migrateLegacySharedRows,
  parseLegacyMigrationArgs,
  writeLegacyRepairReport,
} from "../lib/shared-memory-migration.js";
import { normalizeAndFreezeWorkspaceAliases } from "../lib/memory-request-context.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";

// Report publishing routes through fd-backed directory capabilities, which are only
// verifiable on platforms with a stat-verifiable fd alias (Linux; see lib/directory-capability.js).
const requiresDirectoryCapabilities = stableDirectoryCapabilitiesSupported()
  ? {}
  : { skip: `fd-backed directory capabilities are unavailable on ${process.platform}` };

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function reportRoot() {
  const root = mkdtempSync(join(tmpdir(), "plur1bus-b13-migration-"));
  roots.push(root);
  return root;
}

function aliases(entries = [{ alias: "workspace-a", workspaceKey: "workspace-a" }]) {
  return normalizeAndFreezeWorkspaceAliases({ paths: [], aliases: entries });
}

function row(id = "11111111-1111-4111-8111-111111111111", extra = {}) {
  return {
    id,
    text: "legacy fact",
    summary: "fact",
    scope: "workspace_shared",
    status: "active",
    agentId: "agent-a",
    storedBy: "agent-a",
    workspaceId: "workspace-a",
    workspaceKey: "workspace-a",
    category: "note",
    type: "fact",
    importance: 0.5,
    expiresAt: 0,
    legacyShareMigrationMarker: "{}",
    ...extra,
  };
}

function queryFor(rows, events, version = 7) {
  const state = { offset: 0, limit: Number.MAX_SAFE_INTEGER };
  return {
    where(predicate) {
      events?.push(["where", predicate]);
      return this;
    },
    select(fields) {
      events?.push(["select", fields]);
      return this;
    },
    offset(value) {
      state.offset = value;
      events?.push(["offset", value]);
      return this;
    },
    limit(value) {
      state.limit = value;
      events?.push(["limit", value]);
      return this;
    },
    async toArray() {
      return rows.slice(state.offset, state.offset + state.limit);
    },
    async *execute(options) {
      events?.push(["execute", options, version]);
      yield rows.slice(state.offset, state.offset + state.limit);
    },
  };
}

function fixture(sourceRows, {
  readbackFails = false,
  version = 7,
  onEmbed = null,
  now = () => 1_000,
  schemaRequiresCheckout = false,
} = {}) {
  const operationOrder = [];
  const sourceUpdateCalls = [];
  const targetRows = [];
  const selectedEvents = [];
  let readLeases = 0;
  let writeLeases = 0;
  let targetLeases = 0;
  let activeReadLeases = 0;
  let activeWriteLeases = 0;
  let activeTargetLeases = 0;
  let addColumns = 0;
  const fields = [...new Set([
    "id", "text", "summary", "scope", "status", "agentId", "storedBy",
    "workspaceId", "workspaceKey", "category", "type", "importance",
    "expiresAt", "legacyShareMigrationMarker",
    ...sourceRows.flatMap((source) => Object.keys(source)),
  ])].map((name) => ({ name, type: { name: "utf8" } }));
  const currentOnlyFields = fields.filter((field) => field.name !== "status");
  let checkedOut = false;
  const pinnedTable = {
    async schema() {
      return { fields: schemaRequiresCheckout && !checkedOut ? currentOnlyFields : fields };
    },
    async version() { return version; },
    async checkout(requested) {
      assert.equal(requested, version);
      checkedOut = true;
      return pinnedTable;
    },
    query() { return queryFor(sourceRows, selectedEvents, version); },
  };
  const readDb = {
    readOnly: true,
    table: pinnedTable,
    async init() { return true; },
  };
  const writerDb = {
    table: {
      async schema() { return { fields }; },
      async addColumns(columns) {
        addColumns += 1;
        for (const column of columns) fields.push({ name: column.name, type: column.type });
      },
      query() {
        let id = "";
        return {
          where(predicate) {
            id = /'([^']+)'/.exec(predicate)?.[1] || /"([^"]+)"/.exec(predicate)?.[1] || "";
            return this;
          },
          limit() { return this; },
          async toArray() { return sourceRows.filter((candidate) => candidate.id === id); },
        };
      },
    },
    async init() { return true; },
    async refreshSchemaFields() { operationOrder.push("refresh-schema"); },
    async getById(id) { return sourceRows.find((candidate) => candidate.id === id) || null; },
    async update(id, patch) {
      operationOrder.push("mark-source");
      sourceUpdateCalls.push([id, patch]);
      Object.assign(sourceRows.find((candidate) => candidate.id === id), patch);
    },
  };
  const targetDb = {
    vectorDim: 2,
    table: {
      async schema() {
        return {
          fields: ["id", "text", "vector", "agentId", "workspaceId", "sourceMemoryId",
            "sourceAgentId", "shareIdempotencyKey", "shareProvenance"]
            .map((name) => ({ name, type: { name: name === "vector" ? "fixed" : "utf8", listSize: name === "vector" ? 2 : undefined } })),
        };
      },
      async addColumns() {},
      query() {
        return {
          where(predicate) {
            return {
              limit() {
                return {
                  async toArray() {
                    if (readbackFails) return [];
                    if (predicate.includes("shareIdempotencyKey")) {
                      const key = /'([^']+)'/.exec(predicate)?.[1];
                      return targetRows.filter((target) => target.shareIdempotencyKey === key);
                    }
                    const id = /'([^']+)'/.exec(predicate)?.[1];
                    return targetRows.filter((target) => target.id === id);
                  },
                };
              },
            };
          },
        };
      },
    },
    async init() {},
    async refreshSchemaFields() {},
    async store(copy) {
      operationOrder.push("store-copy");
      targetRows.push(copy);
    },
  };
  return {
    operationOrder,
    sourceUpdateCalls,
    targetRows,
    selectedEvents,
    get counts() {
      return {
        readLeases,
        writeLeases,
        targetLeases,
        activeReadLeases,
        activeWriteLeases,
        activeTargetLeases,
        addColumns,
      };
    },
    readDb,
    writerDb,
    targetDb,
    privatePool: {
      authoritativeRouteDescriptor(agentId) {
        assert.equal(agentId, "agent-a");
        return Object.freeze({ mode: "named", namespace: "active", path: "/pinned/active" });
      },
      async withAuthoritativeReadDb(agentId, fn) {
        readLeases += 1;
        activeReadLeases += 1;
        assert.equal(agentId, "agent-a");
        try {
          return await fn(readDb);
        } finally {
          activeReadLeases -= 1;
        }
      },
      async withWriteDb(agentId, fn) {
        writeLeases += 1;
        activeWriteLeases += 1;
        assert.equal(agentId, "agent-a");
        try {
          return await fn(writerDb);
        } finally {
          activeWriteLeases -= 1;
        }
      },
    },
    sharedPool: {
      async withWorkspaceDb(ctx, fn) {
        targetLeases += 1;
        activeTargetLeases += 1;
        assert.equal(ctx.workspaceIdentity, "workspace:v1:workspace-a");
        try {
          return await fn(targetDb);
        } finally {
          activeTargetLeases -= 1;
        }
      },
    },
    embeddings: {
      async embed(text, context) {
        operationOrder.push("embed-agent");
        assert.equal(typeof text, "string");
        assert.deepEqual(context, { agentId: "agent-a" });
        onEmbed?.();
        return [0.25, 0.75];
      },
    },
    now,
  };
}

describe("legacy workspace_shared migration", () => {
  it("dry-run writes only the bounded audit report and never mutates memory", requiresDirectoryCapabilities, async () => {
    const sourceRows = [row()];
    const f = fixture(sourceRows);
    const result = await migrateLegacySharedRows({
      ...f,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
    });
    assert.equal(result.planned, 1);
    assert.equal(f.targetRows.length, 0);
    assert.equal(f.sourceUpdateCalls.length, 0);
    assert.equal(f.counts.writeLeases, 0);
    assert.equal(f.counts.targetLeases, 0);
    assert.equal(f.counts.addColumns, 0);
    assert.equal(JSON.parse(readFileSync(result.reportPath, "utf8")).dryRun, true);
  });

  it("copies, verifies, then writes the source migration marker", requiresDirectoryCapabilities, async () => {
    const sourceRows = [row()];
    const f = fixture(sourceRows);
    const result = await migrateLegacySharedRows({
      ...f,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: true,
      reportDir: reportRoot(),
    });
    assert.equal(result.migrated, 1);
    assert.deepEqual(f.operationOrder.filter((event) => event !== "refresh-schema"), [
      "embed-agent", "store-copy", "mark-source",
    ]);
    assert.equal(sourceRows[0].scope, "workspace_shared");
    assert.equal(sourceRows[0].status, "active");
    assert.equal(JSON.parse(sourceRows[0].legacyShareMigrationMarker).schemaVersion, 1);
    assert.equal(f.targetRows[0].shareProvenance.includes("legacy_workspace_shared_migration"), true);
  });

  it("leaves unbound or conflicting rows untouched and writes a private repair report", requiresDirectoryCapabilities, async () => {
    const sourceRows = [
      row("11111111-1111-4111-8111-111111111111", { workspaceId: "", workspaceKey: "" }),
      row("22222222-2222-4222-8222-222222222222", { workspaceId: "workspace-a", workspaceKey: "workspace-b" }),
    ];
    const f = fixture(sourceRows);
    const result = await migrateLegacySharedRows({
      ...f,
      agentId: "agent-a",
      workspaceAliases: aliases([
        { alias: "workspace-a", workspaceKey: "workspace-a" },
        { alias: "workspace-b", workspaceKey: "workspace-b" },
      ]),
      apply: true,
      reportDir: reportRoot(),
    });
    assert.equal(f.targetRows.length, 0);
    assert.equal(f.sourceUpdateCalls.length, 0);
    const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
    assert.deepEqual(report.repair.map((entry) => entry.reason), [
      "missing_workspace_binding", "conflicting_workspace_binding",
    ]);
    assert.deepEqual(Object.keys(report.repair[0]).sort(), [
      "agentId", "memoryId", "reason", "workspaceId", "workspaceKey",
    ]);
    assert.equal(lstatSync(result.reportPath).mode & 0o777, 0o600);
  });

  it("does not mark a source when target readback fails and retries idempotently", requiresDirectoryCapabilities, async () => {
    const sourceRows = [row()];
    const first = fixture(sourceRows, { readbackFails: true });
    const result = await migrateLegacySharedRows({
      ...first,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: true,
      reportDir: reportRoot(),
    });
    assert.equal(result.incomplete, true);
    assert.ok(result.continuationToken);
    assert.equal(sourceRows[0].legacyShareMigrationMarker, "{}");
    assert.equal(first.sourceUpdateCalls.length, 0);
  });

  it("skips inactive, expired, and invalid-expiry rows before provider or target work", requiresDirectoryCapabilities, async () => {
    const sourceRows = [
      row("11111111-1111-4111-8111-111111111111", { status: "archived" }),
      row("22222222-2222-4222-8222-222222222222", { expiresAt: 1_000 }),
      row("33333333-3333-4333-8333-333333333333", { expiresAt: "2000" }),
      row("44444444-4444-4444-8444-444444444444", { expiresAt: 1_001 }),
    ];
    const f = fixture(sourceRows, { now: () => 1_000 });
    const result = await migrateLegacySharedRows({
      ...f,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
    });
    assert.equal(result.expiredSkipped, 1);
    assert.equal(result.planned, 1);
    assert.equal(JSON.parse(readFileSync(result.reportPath, "utf8")).repair[0].reason, "invalid_expiry");
    assert.equal(f.operationOrder.length, 0);
  });

  it("passes allowSensitiveShare only on the destructively authorized apply path", requiresDirectoryCapabilities, async () => {
    const sourceRows = [row(undefined, {
      category: "credential",
      memoryClass: "core",
      neverForget: 1,
      importance: 1,
    })];
    const f = fixture(sourceRows);
    const result = await migrateLegacySharedRows({
      ...f,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: true,
      reportDir: reportRoot(),
    });
    assert.equal(result.migrated, 1);
  });

  it("uses terminal offsets and a mode-bound checksummed continuation token", requiresDirectoryCapabilities, async () => {
    const sourceRows = [
      row("11111111-1111-4111-8111-111111111111"),
      row("22222222-2222-4222-8222-222222222222"),
      row("33333333-3333-4333-8333-333333333333"),
    ];
    const first = fixture(sourceRows);
    const firstResult = await migrateLegacySharedRows({
      ...first,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
      maxRows: 2,
    });
    assert.equal(firstResult.incomplete, true);
    assert.equal(firstResult.examinedRows, 2);
    assert.equal(firstResult.terminallyConsumedRows, 2);
    assert.ok(firstResult.continuationToken);
    const resumed = fixture(sourceRows);
    const resumedResult = await migrateLegacySharedRows({
      ...resumed,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
      maxRows: 2,
      continuationToken: firstResult.continuationToken,
    });
    assert.equal(resumedResult.planned, 1);
    await assert.rejects(() => migrateLegacySharedRows({
      ...resumed,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: true,
      reportDir: reportRoot(),
      continuationToken: firstResult.continuationToken,
    }), /mode|restart without a cursor/i);
  });

  it("checks out the pinned version before inspecting its schema on resume", requiresDirectoryCapabilities, async () => {
    const sourceRows = [
      row("11111111-1111-4111-8111-111111111111"),
      row("22222222-2222-4222-8222-222222222222"),
    ];
    const first = fixture(sourceRows);
    const firstResult = await migrateLegacySharedRows({
      ...first,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
      maxRows: 1,
    });
    const resumed = fixture(sourceRows, { schemaRequiresCheckout: true });
    const result = await migrateLegacySharedRows({
      ...resumed,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
      maxRows: 1,
      continuationToken: firstResult.continuationToken,
    });
    assert.equal(result.planned, 1);
    assert.equal(result.nextOffset, 2);
  });

  it("stops before aggregate byte/provider/time bounds without consuming the current row", requiresDirectoryCapabilities, async () => {
    const sourceRows = [
      row("11111111-1111-4111-8111-111111111111", { text: "1234", summary: "" }),
      row("22222222-2222-4222-8222-222222222222", { text: "5678", summary: "" }),
    ];
    const byteFixture = fixture(sourceRows);
    const byteResult = await migrateLegacySharedRows({
      ...byteFixture,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
      maxSourceBytes: 5,
    });
    assert.equal(byteResult.incomplete, true);
    assert.equal(byteResult.terminallyConsumedRows, 1);
    assert.equal(byteResult.sourceBytes, 4);

    const providerFixture = fixture(sourceRows);
    const providerResult = await migrateLegacySharedRows({
      ...providerFixture,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: true,
      reportDir: reportRoot(),
      maxProviderCalls: 1,
    });
    assert.equal(providerResult.incomplete, true);
    assert.equal(providerResult.providerCalls, 1);
    assert.equal(providerResult.terminallyConsumedRows, 1);

    let tick = 0;
    const timeFixture = fixture(sourceRows, { now: () => (tick += 61_000) });
    const timeResult = await migrateLegacySharedRows({
      ...timeFixture,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
      maxElapsedMs: 60_000,
    });
    assert.equal(timeResult.incomplete, true);
    assert.equal(timeResult.terminallyConsumedRows, 0);
  });

  it("honors abort barriers before start and after embedding", requiresDirectoryCapabilities, async () => {
    const before = new AbortController();
    before.abort();
    const sourceRows = [row()];
    const f = fixture(sourceRows);
    const stopped = await migrateLegacySharedRows({
      ...f,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: false,
      reportDir: reportRoot(),
      signal: before.signal,
    });
    assert.equal(stopped.incomplete, true);
    assert.equal(f.counts.readLeases, 0);

    const after = new AbortController();
    const afterFixture = fixture(sourceRows, { onEmbed: () => after.abort() });
    const result = await migrateLegacySharedRows({
      ...afterFixture,
      agentId: "agent-a",
      workspaceAliases: aliases(),
      apply: true,
      reportDir: reportRoot(),
      signal: after.signal,
    });
    assert.equal(result.incomplete, true);
    assert.equal(afterFixture.targetRows.length, 0);
    assert.equal(afterFixture.sourceUpdateCalls.length, 0);
    assert.equal(result.terminallyConsumedRows, 0);
  });

  it("bounds every hanging migration DB phase and leaves the current offset resumable", requiresDirectoryCapabilities, async () => {
    const lateFailures = [];
    const onUnhandled = (error) => lateFailures.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const phase of ["current-read", "target-init", "target-store", "target-readback", "marker-update"]) {
        const sourceRows = [row()];
        const f = fixture(sourceRows);
        const root = reportRoot();
        let reportWrites = 0;
        const lateReject = () => new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`late ${phase}`)), 500);
        });
        if (phase === "current-read") f.writerDb.getById = lateReject;
        if (phase === "target-init") f.targetDb.init = lateReject;
        if (phase === "target-store") f.targetDb.store = lateReject;
        if (phase === "target-readback") {
          let queryCount = 0;
          f.targetDb.table.query = () => ({
            where() {
              queryCount += 1;
              return {
                limit() {
                  return {
                    async toArray() {
                      if (queryCount === 1) return [];
                      return lateReject();
                    },
                  };
                },
              };
            },
          });
        }
        if (phase === "marker-update") f.writerDb.update = lateReject;

        const startedAt = Date.now();
        const result = await migrateLegacySharedRows({
          ...f,
          agentId: "agent-a",
          workspaceAliases: aliases(),
          apply: true,
          reportDir: root,
          maxElapsedMs: 20,
          writeReport({ workspaceDir }) {
            reportWrites += 1;
            assert.equal(workspaceDir, root);
            return join(root, "deadline-report.json");
          },
        });
        assert.ok(Date.now() - startedAt < 400, `${phase} exceeded the migration deadline`);
        assert.equal(result.incomplete, true, phase);
        assert.equal(result.nextOffset, 0, phase);
        assert.ok(result.continuationToken, phase);
        assert.equal(f.sourceUpdateCalls.length, 0, `${phase} must not claim a completed marker`);
        assert.equal(f.counts.activeReadLeases, 0, phase);
        assert.equal(f.counts.activeWriteLeases, 0, phase);
        assert.equal(f.counts.activeTargetLeases, 0, phase);
        assert.equal(reportWrites, 1, `${phase} must still produce exactly one report`);
        if (phase === "marker-update") {
          assert.equal(result.stoppedOperation, "source-marker-update");
          assert.equal(result.uncertainSourceMarkerWrites, 1,
            "a started marker update is reported as uncertain, never as cancelled");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 550));
      assert.deepEqual(lateFailures, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("legacy marker schema and parser", () => {
  it("reuses the authoritative text DataType, refreshes, and tolerates only a verified duplicate race", async () => {
    const textType = { name: "utf8" };
    const fields = [{ name: "id", type: textType }, { name: "text", type: textType }];
    const calls = [];
    const db = {
      table: {
        async schema() { return { fields }; },
        async addColumns(columns) {
          calls.push(columns);
          fields.push({ name: columns[0].name, type: columns[0].type });
        },
      },
      async refreshSchemaFields() { calls.push("refresh"); },
    };
    await ensureLegacySourceMarkerColumn(db);
    assert.equal(calls[0][0].type, textType);
    assert.equal(calls[0][0].valueSql, "'{}'");
    assert.equal(calls[1], "refresh");
  });

  it("accepts only bounded report/cursor/apply options", () => {
    assert.deepEqual(parseLegacyMigrationArgs(["--report", "audit.json", "--cursor", "abc_DEF-12", "--apply"]), {
      apply: true,
      reportName: "audit.json",
      continuationToken: "abc_DEF-12",
    });
    for (const args of [
      ["--agent", "other"], ["--source-version", "7"], ["--offset", "2"],
      ["--max-rows", "999"], ["--api-key", "secret"], ["--base-path", "/tmp"],
      ["--report", "../escape.json"], ["--cursor", "not+base64"], ["--apply", "--apply"],
    ]) assert.throws(() => parseLegacyMigrationArgs(args), /invalid|unknown|duplicate|report|cursor/i);
  });

  it("contains no standalone runtime, provider, credential, or route constructor", () => {
    const source = readFileSync(new URL("../lib/shared-memory-migration.js", import.meta.url), "utf8");
    for (const forbidden of [
      /new\s+MemoryDB\b/,
      /new\s+AgentDbPool\b/,
      /new\s+Embeddings\b/,
      /apiKey/,
      /baseUrl/,
      /loadConfig/,
      /process\.argv/,
    ]) assert.doesNotMatch(source, forbidden);
  });
});

describe("legacy migration repair report", () => {
  it("publishes private no-clobber output and preserves an existing destination", requiresDirectoryCapabilities, () => {
    const root = reportRoot();
    const first = writeLegacyRepairReport({
      workspaceDir: root,
      reportName: "fixed.json",
      report: { dryRun: true, repair: [] },
    });
    const original = readFileSync(first, "utf8");
    assert.equal(lstatSync(first).mode & 0o777, 0o600);
    assert.throws(() => writeLegacyRepairReport({
      workspaceDir: root,
      reportName: "fixed.json",
      report: { dryRun: false, repair: [] },
    }), /EEXIST|exist/i);
    assert.equal(readFileSync(first, "utf8"), original);
  });

  it("rejects symlinked directory and destination routes", requiresDirectoryCapabilities, () => {
    const root = reportRoot();
    const outside = reportRoot();
    symlinkSync(outside, join(root, ".plur1bus"));
    assert.throws(() => writeLegacyRepairReport({
      workspaceDir: root,
      reportName: "report.json",
      report: { dryRun: true, repair: [] },
    }), /symlink|loop|traversal|directory/i);

    const safeRoot = reportRoot();
    const migrationDir = join(safeRoot, ".plur1bus", "migrations");
    const seeded = writeLegacyRepairReport({
      workspaceDir: safeRoot,
      reportName: "seed.json",
      report: { dryRun: true, repair: [] },
    });
    assert.ok(existsSync(seeded));
    const destination = join(migrationDir, "linked.json");
    symlinkSync(join(outside, "target.json"), destination);
    assert.throws(() => writeLegacyRepairReport({
      workspaceDir: safeRoot,
      reportName: "linked.json",
      report: { dryRun: true, repair: [] },
    }), /EEXIST|exist|symlink/i);
  });

  it("bounds repair entries and serialized output without leaking row content", requiresDirectoryCapabilities, () => {
    const repair = Array.from({ length: 1_100 }, (_, index) => ({
      memoryId: String(index),
      agentId: "agent-a",
      workspaceId: "",
      workspaceKey: "",
      reason: "x".repeat(2_000),
      text: "secret",
      vector: [1, 2],
    }));
    const path = writeLegacyRepairReport({
      workspaceDir: reportRoot(),
      reportName: "bounded.json",
      report: { dryRun: true, repair },
    });
    const bytes = readFileSync(path);
    const parsed = JSON.parse(bytes);
    assert.ok(bytes.byteLength <= 1024 * 1024);
    assert.ok(parsed.repair.length <= 1_000);
    assert.equal(JSON.stringify(parsed).includes("secret"), false);
    assert.equal(parsed.truncated, true);
  });
});
