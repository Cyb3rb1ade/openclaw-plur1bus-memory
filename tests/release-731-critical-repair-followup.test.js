/**
 * 7.3.1 Sol follow-up regressions:
 * - legacy critical scans must enforce the stale createdAt boundary in JS;
 * - confirmed eligibility must be pushed before the pending-review limit;
 * - schema-free pending scans must page and normalize confirmation values;
 * - every explicit repair source error must fail before any registry write.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createDbAdapter } from "../lib/db-adapter.js";

const REPAIR_SCRIPT = fileURLToPath(new URL("../scripts/repair-tombstones.mjs", import.meta.url));
const AGENT = "release731-followup-agent";

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function cardRow(id, fields = {}) {
  return {
    id,
    text: "critical follow-up card",
    summary: "",
    origin: "dm",
    status: "active",
    ...fields,
  };
}

function isConfirmedValueForTest(value) {
  if (value === true || value === 1 || value === 1n) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

/**
 * Query-builder double covering both schema-aware pushdown and legacy paging.
 */
function makeQueryTable(rows, {
  schemaFields = null,
  withWhere = true,
  maxRowsPerQuery = Infinity,
} = {}) {
  const calls = [];
  const table = {
    query() {
      let predicate = "";
      let limit = rows.length;
      let offset = 0;
      const builder = {
        limit(value) {
          calls.push({ method: "limit", value });
          limit = value;
          return builder;
        },
        offset(value) {
          calls.push({ method: "offset", value });
          offset = value;
          return builder;
        },
        select(value) {
          calls.push({ method: "select", value });
          return builder;
        },
        async toArray() {
          let selected = rows;
          if (predicate.includes("confirmed")) {
            selected = selected.filter((row) => !isConfirmedValueForTest(row.confirmed));
          }
          const pageLimit = Math.min(limit, maxRowsPerQuery);
          return selected.slice(offset, offset + pageLimit);
        },
      };
      if (withWhere) {
        builder.where = (value) => {
          calls.push({ method: "where", value });
          predicate = value;
          return builder;
        };
      }
      return builder;
    },
  };
  if (schemaFields) {
    table.schema = async () => ({ fields: schemaFields.map((name) => ({ name })) });
  }
  return { table, calls };
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runRepair(args) {
  const result = spawnSync(process.execPath, [REPAIR_SCRIPT, ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });
  let report = {};
  try {
    report = JSON.parse(result.stdout || "{}");
  } catch {
    report = {};
  }
  return { ...result, report };
}

function snapshotBytes(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else files.push([relative(root, full), readFileSync(full)]);
    }
  };
  visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function validRegistryLine(agentId, memoryId) {
  return `${JSON.stringify({
    schemaVersion: 1,
    tombstoneId: uuidFor(900),
    memoryId,
    canonicalOriginId: memoryId,
    agentId,
    scope: "agent-private",
    status: "committed",
    contentFingerprint: "a".repeat(64),
  })}\n`;
}

function seedVisibleRepairSource(root, memoryId = uuidFor(1)) {
  const workspace = join(root, "workspace");
  const archiveDir = join(root, "archive");
  const archivePath = join(archiveDir, AGENT, `${memoryId}.json`);
  const baseDbPath = join(root, "lancedb-namespaced");
  mkdirSync(join(workspace, ".adaptive-learning"), { recursive: true });
  mkdirSync(join(archiveDir, AGENT), { recursive: true });
  writeFileSync(archivePath, JSON.stringify({
    id: memoryId,
    text: "repairable follow-up card",
    scope: "agent-private",
  }), "utf8");
  writeFileSync(
    join(workspace, ".adaptive-learning", "destructive-ops.jsonl"),
    `${JSON.stringify({
      event: "memory.deleted",
      result: "committed",
      memoryId,
      agentId: AGENT,
      archivePath,
    })}\n`,
    "utf8",
  );
  return { workspace, archiveDir, archivePath, baseDbPath };
}

function seedExistingRegistry(root) {
  const registryDir = join(root, "_tombstones");
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    join(registryDir, "preexisting.jsonl"),
    validRegistryLine("preexisting", uuidFor(2)),
    "utf8",
  );
  return registryDir;
}

describe("7.3.1 Sol follow-up critical and repair security", () => {
  it("legacy critical fallback never treats a too-young card as stale", async () => {
    const olderThan = 1_000;
    const oldPendingId = uuidFor(10);
    const youngPendingId = uuidFor(11);
    const { table, calls } = makeQueryTable([
      cardRow(oldPendingId, { type: "person", confirmed: "false", createdAt: 900 }),
      cardRow(youngPendingId, { type: "person", confirmed: "false", createdAt: 1_001 }),
      cardRow(uuidFor(12), { type: "person", confirmed: "TRUE", createdAt: 800 }),
    ], { withWhere: false, maxRowsPerQuery: 1 });
    const adapter = createDbAdapter({
      getTable: async () => table,
      logger: { info() {}, warn() {} },
    });

    try {
      const cards = await adapter.findUnconfirmedCritical(AGENT, { olderThan, scanLimit: 10 });
      assert.deepEqual(cards.map((card) => card.id), [oldPendingId]);
      assert.ok(calls.some((call) => call.method === "offset" && call.value > 0));
    } finally {
      await adapter.shutdown();
    }
  });

  it("pushes confirmed eligibility before the pending-review limit when schema supports it", async () => {
    const confirmedPrefix = Array.from({ length: 501 }, (_, index) => cardRow(uuidFor(index), {
      type: "person",
      confirmed: 1n,
      createdAt: index + 1,
    }));
    const pendingId = uuidFor(501);
    const { table, calls } = makeQueryTable([
      ...confirmedPrefix,
      cardRow(pendingId, { type: "person", confirmed: "false", createdAt: 600 }),
    ], {
      schemaFields: ["id", "text", "summary", "origin", "status", "createdAt", "type", "confirmed"],
      withWhere: true,
    });
    const adapter = createDbAdapter({
      getTable: async () => table,
      logger: { info() {}, warn() {} },
    });

    try {
      const cards = await adapter.findPendingCriticalReviews(AGENT);
      assert.deepEqual(cards.map((card) => card.id), [pendingId]);
      assert.ok(
        calls.some((call) => call.method === "where" && /confirmed/.test(call.value)),
        "confirmed eligibility must be pushed before limit",
      );
      assert.ok(
        calls.some((call) => call.method === "limit" && call.value === 500),
        "the pending output limit must remain bounded",
      );
    } finally {
      await adapter.shutdown();
    }
  });

  it("schema-free pending fallback pages deterministically and uses normalized confirmation values", async () => {
    const confirmedPrefix = Array.from({ length: 501 }, (_, index) => cardRow(uuidFor(index), {
      type: "gesundheit",
      confirmed: index % 2 === 0 ? "TRUE" : "1",
      createdAt: index + 1,
    }));
    const pendingId = uuidFor(501);
    const { table, calls } = makeQueryTable([
      ...confirmedPrefix,
      cardRow(pendingId, { type: "gesundheit", confirmed: "false", createdAt: 600 }),
    ], { withWhere: false, maxRowsPerQuery: 125 });
    const adapter = createDbAdapter({
      getTable: async () => table,
      logger: { info() {}, warn() {} },
    });

    try {
      const cards = await adapter.findPendingCriticalReviews(AGENT);
      assert.deepEqual(cards.map((card) => card.id), [pendingId]);
      assert.equal(calls.some((call) => call.method === "where"), false);
      assert.ok(calls.some((call) => call.method === "offset" && call.value > 0));
    } finally {
      await adapter.shutdown();
    }
  });

  it("preserves every registry byte when a mixed explicit workspace source is unreadable", (t) => {
    const root = tempDir(t, "release-731-followup-workspace-");
    const { workspace, archiveDir, baseDbPath } = seedVisibleRepairSource(root);
    const unreadableWorkspace = join(root, "missing-workspace");
    const registryDir = seedExistingRegistry(root);
    const before = snapshotBytes(registryDir);

    const result = runRepair([
      "--apply",
      "--workspace", workspace,
      "--workspace", unreadableWorkspace,
      "--base-db-path", baseDbPath,
      "--archive-dir", archiveDir,
    ]);

    assert.notEqual(result.status, 0);
    assert.ok(
      result.report.sourceErrors?.some((entry) => JSON.stringify(entry).includes(unreadableWorkspace)),
      "the unreadable explicit workspace must be reported",
    );
    assert.equal(result.report.reconstructed, 0);
    assert.deepEqual(snapshotBytes(registryDir), before);
  });

  it("preserves every registry byte when an explicit archive root cannot be read", (t) => {
    const root = tempDir(t, "release-731-followup-archive-");
    const { workspace, archivePath, baseDbPath } = seedVisibleRepairSource(root);
    const unreadableArchiveRoot = join(root, "archive-root-file");
    writeFileSync(unreadableArchiveRoot, "not a directory", "utf8");
    const registryDir = seedExistingRegistry(root);
    const before = snapshotBytes(registryDir);

    const result = runRepair([
      "--apply",
      "--workspace", workspace,
      "--base-db-path", baseDbPath,
      "--archive-dir", unreadableArchiveRoot,
    ]);

    assert.notEqual(result.status, 0);
    assert.ok(
      result.report.sourceErrors?.some((entry) => JSON.stringify(entry).includes(unreadableArchiveRoot)),
      "the unreadable explicit archive root must be reported",
    );
    assert.equal(result.report.reconstructed, 0);
    assert.deepEqual(snapshotBytes(registryDir), before);
    assert.ok(existsSync(archivePath), "the visible archive source must remain available for the mixed-source case");
  });
});
