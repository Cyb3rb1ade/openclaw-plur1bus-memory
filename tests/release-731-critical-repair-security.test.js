/**
 * 7.3.1 security regressions:
 * - critical review selection must not let confirmed rows consume the limit;
 * - legacy query builders without `where()` must still be usable and bounded;
 * - repair apply must validate every input before touching a registry;
 * - a clean repair apply must remain idempotent.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { createDbAdapter } from "../lib/db-adapter.js";

const REPAIR_SCRIPT = fileURLToPath(new URL("../scripts/repair-tombstones.mjs", import.meta.url));
const AGENT = "release731-agent";

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function cardRow(id, fields = {}) {
  return {
    id,
    text: "critical test card",
    summary: "",
    createdAt: 1,
    origin: "dm",
    status: "active",
    ...fields,
  };
}

/**
 * Build a small query-builder double that preserves the adapter boundary.
 * `maxRowsPerQuery` models an older backend that returns bounded pages even
 * when a larger limit is requested, so the fallback must use offset paging.
 */
function makeQueryTable(rows, { withWhere = true, maxRowsPerQuery = Infinity } = {}) {
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
        async toArray() {
          let selected = rows;
          if (predicate.includes("confirmed")) {
            selected = selected.filter((row) => row.confirmed !== true && row.confirmed !== 1);
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
  });
  let report = null;
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

function seedRepairInputs(root, { corrupt = false } = {}) {
  const workspace = join(root, "workspace");
  const baseDbPath = join(root, "lancedb-namespaced");
  const archiveDir = join(root, "archive");
  const archivePath = join(archiveDir, AGENT, `${uuidFor(1)}.json`);
  mkdirSync(join(workspace, ".adaptive-learning"), { recursive: true });
  mkdirSync(join(archiveDir, AGENT), { recursive: true });
  writeFileSync(archivePath, JSON.stringify({
    id: uuidFor(1),
    text: "repairable card",
    scope: "agent-private",
  }), "utf8");
  const event = JSON.stringify({
    event: "memory.deleted",
    result: "committed",
    memoryId: uuidFor(1),
    agentId: AGENT,
    archivePath,
  });
  writeFileSync(
    join(workspace, ".adaptive-learning", "destructive-ops.jsonl"),
    corrupt ? `${event}\nNOT JSON\n` : `${event}\n`,
    "utf8",
  );
  return { workspace, baseDbPath, archiveDir };
}

describe("7.3.1 critical selection and tombstone repair security", () => {
  it("does not let a confirmed critical prefix hide a later unconfirmed critical", async () => {
    const confirmedId = uuidFor(10);
    const pendingId = uuidFor(11);
    const { table, calls } = makeQueryTable([
      cardRow(confirmedId, { type: "person", confirmed: true }),
      cardRow(pendingId, { type: "person", confirmed: null }),
    ]);
    const adapter = createDbAdapter({
      getTable: async () => table,
      logger: { info() {}, warn() {} },
    });

    try {
      const cards = await adapter.findUnconfirmedCritical(AGENT, {
        olderThan: Date.now(),
        scanLimit: 1,
      });
      assert.deepEqual(cards.map((card) => card.id), [pendingId]);
      assert.ok(
        calls.some((call) => call.method === "where" && /confirmed/.test(call.value)),
        "confirmed eligibility must be pushed before the limit",
      );
    } finally {
      await adapter.shutdown();
    }
  });

  it("uses a real bounded no-where fallback for legacy query builders", async () => {
    const confirmedId = uuidFor(20);
    const pendingId = uuidFor(21);
    const { table, calls } = makeQueryTable([
      cardRow(confirmedId, { type: "gesundheit", confirmed: 1 }),
      cardRow(pendingId, { type: "gesundheit", confirmed: undefined }),
    ], { withWhere: false, maxRowsPerQuery: 1 });
    const adapter = createDbAdapter({
      getTable: async () => table,
      logger: { info() {}, warn() {} },
    });

    try {
      const cards = await adapter.findUnconfirmedCritical(AGENT, {
        olderThan: Date.now(),
        scanLimit: 1,
      });
      assert.deepEqual(cards.map((card) => card.id), [pendingId]);
      assert.equal(calls.some((call) => call.method === "where"), false);
      assert.ok(calls.some((call) => call.method === "offset" && call.value > 0));
    } finally {
      await adapter.shutdown();
    }
  });

  it("does not change any registry bytes when apply sees valid and corrupt input together", (t) => {
    const root = tempDir(t, "release-731-repair-corrupt-");
    const { workspace, baseDbPath, archiveDir } = seedRepairInputs(root, { corrupt: true });
    const registryDir = join(root, "_tombstones");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, "preexisting.jsonl"), validRegistryLine("preexisting", uuidFor(2)), "utf8");
    const before = snapshotBytes(registryDir);

    const result = runRepair([
      "--apply",
      "--workspace", workspace,
      "--base-db-path", baseDbPath,
      "--archive-dir", archiveDir,
    ]);

    assert.notEqual(result.status, 0);
    assert.ok(result.report.corruptLines > 0);
    assert.deepEqual(snapshotBytes(registryDir), before);
  });

  it("keeps a clean apply idempotent", (t) => {
    const root = tempDir(t, "release-731-repair-idempotent-");
    const { workspace, baseDbPath, archiveDir } = seedRepairInputs(root);
    const args = [
      "--apply",
      "--workspace", workspace,
      "--base-db-path", baseDbPath,
      "--archive-dir", archiveDir,
    ];

    const first = runRepair(args);
    assert.equal(first.status, 0);
    assert.equal(first.report.reconstructed, 1);
    const afterFirst = snapshotBytes(join(root, "_tombstones"));

    const second = runRepair(args);
    assert.equal(second.status, 0);
    assert.equal(second.report.reconstructed, 0);
    assert.equal(second.report.skipped, 1);
    assert.deepEqual(snapshotBytes(join(root, "_tombstones")), afterFirst);
  });
});
