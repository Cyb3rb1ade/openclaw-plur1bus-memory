/**
 * Release 7.3.1 Sol follow-up regressions for memory compaction.
 *
 * These are runtime tests for page/batch traversal, owner-bound continuation,
 * exact ACL partitioning in daily consolidation, and action-result semantics.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createNeoStore } from "../lib/neo-arch.js";
import { runConsolidation } from "../lib/jobs/daily-consolidation.js";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";

const EMPTY_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const USER_A = "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AGENT = "agent-a";
const WORKSPACE = "workspace:v1:workspace-a";

const WORKSPACE_CONTEXT = Object.freeze({
  agentId: AGENT,
  workspaceIdentity: WORKSPACE,
  userPrincipal: USER_A,
  workspaceAliases: EMPTY_ALIASES,
});

const WORKSPACE_PARTITION = Object.freeze({
  scope: "workspace",
  agentId: AGENT,
  workspaceIdentity: WORKSPACE,
  ownerUserId: "",
});

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function makeTable(rows) {
  const archived = new Set();
  const added = [];
  const whereClauses = [];
  const fields = [
    "id", "text", "summary", "vector", "createdAt", "status", "category", "origin",
    "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId",
    "epistemicStatus", "epistemicStatusActor", "epistemicStatusReason",
    "epistemicStatusUpdatedAt", "previousEpistemicStatus", "validFrom", "validUntil",
    "memoryClass", "neverForget",
  ];

  return {
    async schema() {
      return { fields: fields.map((name) => ({ name })) };
    },
    query() {
      const state = { offset: 0, limit: rows.length, where: "" };
      return {
        where(clause) {
          state.where = String(clause);
          whereClauses.push(state.where);
          return this;
        },
        offset(value) {
          state.offset = value;
          return this;
        },
        limit(value) {
          state.limit = value;
          return this;
        },
        async toArray() {
          const ids = [...state.where.matchAll(/id = '([0-9a-f-]{36})'/gi)].map((match) => match[1]);
          const source = ids.length > 0
            ? rows.filter((row) => ids.includes(row.id))
            : rows;
          return source.slice(state.offset, state.offset + state.limit);
        },
      };
    },
    async update({ where, values }) {
      const id = String(where).match(/[0-9a-f-]{36}/i)?.[0];
      if (!id) throw new Error("missing id");
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error("row not found");
      Object.assign(row, values);
      if (values.status === "archived") archived.add(id);
    },
    async add(items) {
      added.push(...items);
    },
    _rows: rows,
    _archived: archived,
    _added: added,
    _whereClauses: whereClauses,
  };
}

function memoryRow(id, text, createdAt, overrides = {}) {
  return {
    id,
    text,
    summary: text,
    vector: [1, 0, 0],
    createdAt,
    status: "active",
    category: "fact",
    origin: "dm",
    scope: "agent-private",
    agentId: AGENT,
    storedBy: AGENT,
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: "",
    epistemicStatus: "trusted",
    ...overrides,
  };
}

function partitionContext(partition) {
  return Object.freeze({
    agentId: partition.agentId,
    workspaceIdentity: partition.workspaceIdentity || "",
    userPrincipal: partition.ownerUserId || "",
    workspaceAliases: EMPTY_ALIASES,
  });
}

function dailyRows(now) {
  return [
    memoryRow(uuidFor(101), "same fact across owners", now, {
      scope: "agent-private",
    }),
    memoryRow(uuidFor(102), "same fact across owners", now - 1, {
      scope: "agent-private",
    }),
    memoryRow(uuidFor(103), "same fact across owners", now - 2, {
      scope: "workspace",
      workspaceId: WORKSPACE,
      workspaceKey: WORKSPACE,
    }),
    memoryRow(uuidFor(104), "same fact across owners", now - 3, {
      scope: "workspace",
      workspaceId: WORKSPACE,
      workspaceKey: WORKSPACE,
    }),
    memoryRow(uuidFor(105), "same fact across owners", now - 4, {
      scope: "user",
      ownerUserId: USER_A,
    }),
    memoryRow(uuidFor(106), "same fact across owners", now - 5, {
      scope: "user",
      ownerUserId: USER_A,
    }),
    memoryRow(uuidFor(107), "same fact across owners", now - 6, {
      scope: "user",
      ownerUserId: USER_B,
    }),
    memoryRow(uuidFor(108), "same fact across owners", now - 7, {
      scope: "user",
      ownerUserId: USER_B,
    }),
  ];
}

describe("release 7.3.1 compaction follow-up", () => {
  it("compares exact duplicates split at a maxBatchSize boundary", async (t) => {
    const now = Date.now();
    const newer = uuidFor(201);
    const older = uuidFor(202);
    const table = makeTable([
      memoryRow(uuidFor(200), "unrelated first batch row", now, { vector: [0, 1, 0] }),
      memoryRow(newer, "boundary duplicate", now - 1),
      memoryRow(older, "boundary duplicate", now - 2),
    ].map((row) => ({
      ...row,
      scope: "workspace",
      workspaceId: WORKSPACE,
      workspaceKey: WORKSPACE,
    })));

    const result = await runMemoryCompaction({ table }, {
      requestContext: WORKSPACE_CONTEXT,
      aclPartition: WORKSPACE_PARTITION,
      similarityThreshold: 0.99,
      lookbackDays: 30,
      maxBatchSize: 2,
      autoApply: true,
      workspaceDir: tempDir(t, "release-731-boundary-output-"),
      logger: { info() {}, warn() {} },
    });

    assert.equal(result.plannedDeleted, 1);
    assert.equal(result.deleted, 1);
    assert.equal(result.plannedMerged, 0);
    assert.ok(table._archived.has(older), "the older duplicate must be archived");
    assert.equal(table._rows.find((row) => row.id === newer).status, "active");
  });

  it("continues a bounded owner-bound scan from its persisted keyset cursor", async (t) => {
    const now = Date.now();
    const laterDuplicate = uuidFor(212);
    const olderDuplicate = uuidFor(213);
    const table = makeTable([
      memoryRow(uuidFor(210), "cursor prefix alpha", now, { vector: [0, 1, 0] }),
      memoryRow(uuidFor(211), "cursor prefix beta", now - 1, { vector: [0, 0, 1] }),
      memoryRow(laterDuplicate, "cursor continuation duplicate", now - 2),
      memoryRow(olderDuplicate, "cursor continuation duplicate", now - 3),
    ].map((row) => ({
      ...row,
      scope: "workspace",
      workspaceId: WORKSPACE,
      workspaceKey: WORKSPACE,
    })));
    const stateRoot = tempDir(t, "release-731-compaction-state-");
    const outputDir = tempDir(t, "release-731-compaction-cursor-output-");
    const neoStore = createNeoStore(stateRoot, WORKSPACE);
    const opts = {
      requestContext: WORKSPACE_CONTEXT,
      aclPartition: WORKSPACE_PARTITION,
      similarityThreshold: 0.99,
      lookbackDays: 30,
      scanLimit: 2,
      maxScanRows: 2,
      maxBatchSize: 10,
      autoApply: true,
      neoStore,
      workspaceDir: outputDir,
      logger: { info() {}, warn() {} },
    };

    const first = await runMemoryCompaction({ table }, opts);
    assert.equal(first.deleted, 0);
    assert.equal(first.plannedDeleted, 0);
    const stateAfterFirst = neoStore.readRunState();
    const scanState = stateAfterFirst.memoryCompactionScan;
    assert.ok(scanState, "the bounded scan must persist owner-bound progress");
    assert.match(JSON.stringify(scanState), new RegExp(uuidFor(211)));

    const second = await runMemoryCompaction({ table }, opts);
    assert.equal(second.plannedDeleted, 1);
    assert.equal(second.deleted, 1);
    assert.ok(table._archived.has(olderDuplicate));
    assert.ok(
      table._whereClauses.some((clause) => clause.includes("createdAt <") || clause.includes("id >")),
      "the continuation must use a keyset predicate instead of restarting at offset zero",
    );
    assert.equal(table._rows.find((row) => row.id === laterDuplicate).status, "active");
  });

  it("runs daily compaction once per valid ownership tuple without private workspace output", async (t) => {
    const rows = dailyRows(Date.now());
    const table = makeTable(rows);
    const workspaceDir = tempDir(t, "release-731-daily-tuples-");
    const result = await runConsolidation({
      async init() {},
      table,
      async isAvailable() {
        return true;
      },
    }, AGENT, {
      workspaceDir,
      workspaceKey: WORKSPACE,
      requestContext: WORKSPACE_CONTEXT,
      compaction: {
        similarityThreshold: 0.99,
        maxBatchSize: 10,
        autoApply: true,
      },
      logger: { info() {}, warn() {} },
    });

    assert.equal(result.compaction.deleted, 4);
    assert.equal(result.compaction.plannedDeleted, 4);
    assert.equal(result.compaction.partitionResults.length, 4);
    assert.deepEqual(
      result.compaction.partitionResults.map((entry) => entry.aclPartition).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [
        { scope: "agent-private", agentId: AGENT, workspaceIdentity: "", ownerUserId: "" },
        { scope: "user", agentId: AGENT, workspaceIdentity: "", ownerUserId: USER_A },
        { scope: "user", agentId: AGENT, workspaceIdentity: "", ownerUserId: USER_B },
        { scope: "workspace", agentId: AGENT, workspaceIdentity: WORKSPACE, ownerUserId: "" },
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    for (const id of [uuidFor(102), uuidFor(104), uuidFor(106), uuidFor(108)]) {
      assert.ok(table._archived.has(id), `older row ${id} must be archived in its own partition`);
    }
    for (const id of [uuidFor(101), uuidFor(103), uuidFor(105), uuidFor(107)]) {
      assert.equal(table._rows.find((row) => row.id === id).status, "active");
    }

    assert.equal(existsSync(join(workspaceDir, "run-state.json")), false);
    assert.equal(existsSync(join(workspaceDir, "memory")), false);
    assert.equal(existsSync(join(workspaceDir, ".adaptive-learning")), false);
  });

  it("ignores an invalid ownership tuple instead of compacting it", async (t) => {
    const now = Date.now();
    const validOld = uuidFor(222);
    const invalidNew = uuidFor(223);
    const invalidOld = uuidFor(224);
    const table = makeTable([
      memoryRow(uuidFor(221), "valid user fact", now, { scope: "user", ownerUserId: USER_A }),
      memoryRow(validOld, "valid user fact", now - 1, { scope: "user", ownerUserId: USER_A }),
      memoryRow(invalidNew, "invalid user fact", now - 2, { scope: "user", ownerUserId: "not-a-principal" }),
      memoryRow(invalidOld, "invalid user fact", now - 3, { scope: "user", ownerUserId: "not-a-principal" }),
    ]);
    const result = await runConsolidation({
      async init() {},
      table,
      async isAvailable() {
        return true;
      },
    }, AGENT, {
      workspaceDir: tempDir(t, "release-731-invalid-ownership-"),
      workspaceKey: WORKSPACE,
      requestContext: WORKSPACE_CONTEXT,
      compaction: { similarityThreshold: 0.99, autoApply: true },
      logger: { info() {}, warn() {} },
    });

    assert.equal(result.compaction.deleted, 1);
    assert.ok(table._archived.has(validOld));
    assert.equal(table._rows.find((row) => row.id === invalidNew).status, "active");
    assert.equal(table._rows.find((row) => row.id === invalidOld).status, "active");
    assert.equal(
      result.compaction.partitionResults.some((entry) => entry.aclPartition.ownerUserId === "not-a-principal"),
      false,
    );
  });
});
