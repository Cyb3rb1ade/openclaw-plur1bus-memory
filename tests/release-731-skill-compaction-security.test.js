/**
 * Release 7.3.1 security regressions for skill mining and compaction.
 *
 * These tests exercise the job boundaries with rows from different canonical
 * ownership tuples and with a duplicate pair outside the first work batch.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadMemories, runSkillMiner } from "../lib/jobs/skill-miner.js";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";

const EMPTY_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const USER_A = "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REQUEST_CONTEXT_A = Object.freeze({
  agentId: "agent-a",
  workspaceIdentity: "workspace:v1:workspace-a",
  userPrincipal: USER_A,
  workspaceAliases: EMPTY_ALIASES,
});
const USER_A_PARTITION = Object.freeze({
  scope: "user",
  agentId: "agent-a",
  workspaceIdentity: "",
  ownerUserId: USER_A,
});
const REQUEST_CONTEXT_B = Object.freeze({
  agentId: "agent-a",
  workspaceIdentity: "workspace:v1:workspace-a",
  userPrincipal: USER_B,
  workspaceAliases: EMPTY_ALIASES,
});
const USER_B_PARTITION = Object.freeze({
  scope: "user",
  agentId: "agent-a",
  workspaceIdentity: "",
  ownerUserId: USER_B,
});

function tempWorkspace(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function makeTable(rows, { onWhere } = {}) {
  const archived = new Set();
  const added = [];
  const fields = [
    "id", "text", "summary", "vector", "createdAt", "status", "category",
    "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId",
    "epistemicStatus", "epistemicStatusActor", "epistemicStatusReason",
    "epistemicStatusUpdatedAt", "previousEpistemicStatus", "validFrom", "validUntil",
  ];

  return {
    async schema() {
      return { fields: fields.map((name) => ({ name })) };
    },
    query() {
      let offset = 0;
      let limit = rows.length;
      let idFilter = null;
      return {
        where(clause) {
          onWhere?.(String(clause), rows);
          const ids = [...String(clause).matchAll(/id = '([0-9a-f-]{36})'/gi)].map((match) => match[1]);
          idFilter = ids.length > 0 ? new Set(ids) : null;
          return this;
        },
        offset(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        async toArray() {
          const source = idFilter ? rows.filter((row) => idFilter.has(row.id)) : rows;
          return source.slice(offset, offset + limit);
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
    _archived: archived,
    _added: added,
    _rows: rows,
  };
}

function skillDb(rows) {
  const table = makeTable(rows);
  return { init: async () => {}, table };
}

function makePagedSkillTable(rows, { whereError = false, fallbackError = false } = {}) {
  const calls = [];
  let queryCount = 0;
  const fields = [
    "id", "text", "summary", "createdAt", "status", "category", "origin",
    "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId",
    "epistemicStatus", "retrievalCount",
  ];

  return {
    async schema() {
      return { fields: fields.map((name) => ({ name })) };
    },
    query() {
      queryCount++;
      let offset = 0;
      let limit = rows.length;
      let filtered = rows;
      let usedWhere = false;
      return {
        where(clause) {
          if (whereError) throw new Error("filtered query failed");
          usedWhere = true;
          const text = String(clause);
          const owner = text.match(/ownerUserId = '([^']+)'/)?.[1];
          const scope = text.match(/scope = '([^']+)'/)?.[1];
          filtered = rows.filter((row) => {
            if (owner && row.ownerUserId !== owner) return false;
            if (scope && row.scope !== scope) return false;
            return true;
          });
          return this;
        },
        offset(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        async toArray() {
          if (!usedWhere && fallbackError) throw new Error("fallback query failed");
          const page = filtered.slice(offset, offset + limit);
          calls.push({ usedWhere, offset, limit, ids: page.map((row) => row.id) });
          return page;
        },
      };
    },
    _calls: calls,
    _queryCount: () => queryCount,
    _rows: rows,
  };
}

function readRunState(workspaceDir) {
  const path = join(workspaceDir, "run-state.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function skillScanOptions(workspaceDir, partition, requestContext, { scanLimit = 2, maxScanRows = 2 } = {}) {
  return {
    workspaceDir,
    workspaceKey: "workspace-a",
    requestContext,
    aclPartition: partition,
    scanLimit,
    maxScanRows,
    minEvidenceScore: 999,
    logger: { info() {}, warn() {} },
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
    category: "workspace_rule",
    origin: "dm",
    epistemicStatus: "trusted",
    retrievalCount: 3,
    ...overrides,
  };
}

describe("release 7.3.1 skill-miner and compaction security", () => {
  it("propagates filtered and fallback query failures without completion state", async (t) => {
    const table = makePagedSkillTable([], { whereError: true, fallbackError: true });
    const workspaceDir = tempWorkspace(t, "release-731-skill-query-failure-");

    await assert.rejects(
      runSkillMiner({ init: async () => {}, table }, "agent-a", {
        ...skillScanOptions(workspaceDir, USER_A_PARTITION, REQUEST_CONTEXT_A),
      }),
      /fallback query failed/,
    );

    assert.equal(table._queryCount(), 2, "both the filtered and fallback queries must be attempted");
    const state = readRunState(workspaceDir);
    assert.equal(state.jobRateLimits, undefined, "a failed scan must not consume the weekly rate limit");
    assert.equal(state.skillMinerScan, undefined, "a failed scan must not write completion/cursor state");
    assert.equal(
      existsSync(join(workspaceDir, ".adaptive-learning", "skill-miner-report.jsonl")),
      false,
    );
  });

  it("continues a bounded scan from its persistent cursor after a restart and records completion only at EOF", async (t) => {
    const now = Date.now();
    const rows = [1, 2, 3, 4].map((n) => memoryRow(
      uuidFor(400 + n),
      `release verification window ${n}`,
      now - n,
      { scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_A },
    ));
    const workspaceDir = tempWorkspace(t, "release-731-skill-cursor-");
    const options = skillScanOptions(workspaceDir, USER_A_PARTITION, REQUEST_CONTEXT_A);

    const firstTable = makePagedSkillTable(rows);
    const first = await runSkillMiner({ init: async () => {}, table: firstTable }, "agent-a", options);
    assert.equal(first.scanned, 2);
    assert.equal(first.scanComplete, false);
    assert.deepEqual(firstTable._calls[0].ids, [uuidFor(401), uuidFor(402)]);
    assert.equal(readRunState(workspaceDir).jobRateLimits, undefined);

    const failedTable = makePagedSkillTable(rows, { whereError: true, fallbackError: true });
    await assert.rejects(
      runSkillMiner({ init: async () => {}, table: failedTable }, "agent-a", options),
      /fallback query failed/,
    );
    assert.equal(failedTable._queryCount(), 2);
    assert.equal(
      Object.values(readRunState(workspaceDir).skillMinerScan)[0].cursor.offset,
      2,
      "a failed continuation must not advance the persisted cursor",
    );

    const secondTable = makePagedSkillTable(rows);
    const second = await runSkillMiner({ init: async () => {}, table: secondTable }, "agent-a", options);
    assert.equal(second.scanned, 2);
    assert.equal(second.scanComplete, false);
    assert.deepEqual(secondTable._calls[0].ids, [uuidFor(403), uuidFor(404)]);
    assert.equal(readRunState(workspaceDir).jobRateLimits, undefined);

    const eofTable = makePagedSkillTable(rows);
    const eof = await runSkillMiner({ init: async () => {}, table: eofTable }, "agent-a", options);
    assert.equal(eof.scanned, 0);
    assert.equal(eof.scanComplete, true);
    assert.deepEqual(eofTable._calls.map((call) => call.ids), [[]]);
    assert.equal(Object.keys(readRunState(workspaceDir).jobRateLimits).length, 1);

    const rateLimited = await runSkillMiner({ init: async () => {}, table: makePagedSkillTable(rows) }, "agent-a", options);
    assert.equal(rateLimited.reason, "rate_limited");
  });

  it("keeps bounded scan cursors isolated by owner partition", async (t) => {
    const now = Date.now();
    const rows = [
      memoryRow(uuidFor(411), "owner A release window one", now, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_A,
      }),
      memoryRow(uuidFor(412), "owner B release window one", now - 1, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_B,
      }),
      memoryRow(uuidFor(413), "owner A release window two", now - 2, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_A,
      }),
      memoryRow(uuidFor(414), "owner B release window two", now - 3, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_B,
      }),
    ];
    const workspaceDir = tempWorkspace(t, "release-731-skill-owner-cursors-");

    const firstOwnerATable = makePagedSkillTable(rows);
    await runSkillMiner(
      { init: async () => {}, table: firstOwnerATable },
      "agent-a",
      skillScanOptions(workspaceDir, USER_A_PARTITION, REQUEST_CONTEXT_A, { scanLimit: 1, maxScanRows: 1 }),
    );
    assert.deepEqual(firstOwnerATable._calls[0].ids, [uuidFor(411)]);

    const firstOwnerBTable = makePagedSkillTable(rows);
    await runSkillMiner(
      { init: async () => {}, table: firstOwnerBTable },
      "agent-a",
      skillScanOptions(workspaceDir, USER_B_PARTITION, REQUEST_CONTEXT_B, { scanLimit: 1, maxScanRows: 1 }),
    );
    assert.deepEqual(firstOwnerBTable._calls[0].ids, [uuidFor(412)]);

    const secondOwnerATable = makePagedSkillTable(rows);
    await runSkillMiner(
      { init: async () => {}, table: secondOwnerATable },
      "agent-a",
      skillScanOptions(workspaceDir, USER_A_PARTITION, REQUEST_CONTEXT_A, { scanLimit: 1, maxScanRows: 1 }),
    );
    assert.deepEqual(secondOwnerATable._calls[0].ids, [uuidFor(413)]);

    const scanState = readRunState(workspaceDir).skillMinerScan;
    assert.equal(Object.keys(scanState).length, 2, "each owner partition needs its own persistent cursor");
  });

  it("does not aggregate user principals or drop the selected ownership fields", async (t) => {
    const now = Date.now();
    const rows = [
      memoryRow(uuidFor(1), "OWNER_A release rollback checklist", now, {
        scope: "user",
        agentId: "agent-a",
        storedBy: "agent-a",
        ownerUserId: USER_A,
      }),
      memoryRow(uuidFor(2), "OWNER_B release rollback checklist SECRET", now - 1, {
        scope: "user",
        agentId: "agent-a",
        storedBy: "agent-a",
        ownerUserId: USER_B,
      }),
    ];
    const db = skillDb(rows);
    const selected = await loadMemories(db, 30, {
      requestContext: REQUEST_CONTEXT_A,
      aclPartition: USER_A_PARTITION,
      scanLimit: 1,
    });

    assert.deepEqual(selected.map((memory) => memory.id), [uuidFor(1)]);
    assert.equal(selected[0].scope, "user");
    assert.equal(selected[0].agentId, "agent-a");
    assert.equal(selected[0].storedBy, "agent-a");
    assert.equal(selected[0].ownerUserId, USER_A);

    const workspaceDir = tempWorkspace(t, "release-731-skill-acl-");
    const prompts = [];
    const result = await runSkillMiner(db, "agent-a", {
      workspaceDir,
      workspaceKey: "workspace-a",
      requestContext: REQUEST_CONTEXT_A,
      aclPartition: USER_A_PARTITION,
      callLlm: async (messages) => {
        prompts.push(messages[0].content);
        return JSON.stringify({
          skillName: "owner-a-rollback",
          skillTitle: "Owner A rollback",
          description: "Use the owner A rollback checklist.",
          instructions: "Verify the owner A release rollback checklist.",
          examples: [],
          confidence: 0.9,
          category: "workflow",
        });
      },
      llmCfg: { model: "test" },
      dryRun: true,
    });

    assert.equal(result.proposalsCreated, 1);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /OWNER_A/);
    assert.doesNotMatch(prompts[0], /OWNER_B|SECRET/);
  });

  it("does not combine or mutate user/workspace rows during compaction", async (t) => {
    const now = Date.now();
    const userA1 = uuidFor(11);
    const userA2 = uuidFor(12);
    const userB = uuidFor(13);
    const workspace = uuidFor(14);
    const table = makeTable([
      memoryRow(userA1, "same private deployment fact", now, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_A,
      }),
      memoryRow(userA2, "same private deployment fact", now - 1, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_A,
      }),
      memoryRow(userB, "same private deployment fact", now - 2, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_B,
      }),
      memoryRow(workspace, "same private deployment fact", now - 3, {
        scope: "workspace",
        agentId: "agent-a",
        storedBy: "agent-a",
        workspaceKey: "workspace:v1:workspace-a",
        workspaceId: "workspace:v1:workspace-a",
        ownerUserId: "",
      }),
    ]);

    const workspaceDir = tempWorkspace(t, "release-731-compaction-acl-");
    const result = await runMemoryCompaction(
      { table },
      {
        agentId: "agent-a",
        requestContext: REQUEST_CONTEXT_A,
        aclPartition: USER_A_PARTITION,
        similarityThreshold: 0.5,
        lookbackDays: 30,
        maxBatchSize: 10,
        autoApply: true,
        workspaceDir,
        logger: { info() {}, warn() {} },
      },
    );

    assert.equal(result.deleted, 1);
    assert.deepEqual([...table._archived], [userA2]);
    assert.equal(table._rows.find((row) => row.id === userB).status, "active");
    assert.equal(table._rows.find((row) => row.id === workspace).status, "active");

    assert.equal(
      existsSync(join(workspaceDir, ".adaptive-learning", "memory-aliases.jsonl")),
      false,
      "user-private compaction must not write an alias file into the workspace",
    );
  });

  it("fails closed when ownership changes between proposal generation and auto-archive", async (t) => {
    const now = Date.now();
    const userA1 = uuidFor(31);
    const userA2 = uuidFor(32);
    let rereadMutationDone = false;
    const table = makeTable([
      memoryRow(userA1, "same mutable ownership fact", now, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_A,
      }),
      memoryRow(userA2, "same mutable ownership fact", now - 1, {
        scope: "user", agentId: "agent-a", storedBy: "agent-a", ownerUserId: USER_A,
      }),
    ], {
      onWhere(clause, rows) {
        if (!rereadMutationDone && clause.includes("id = ")) {
          rereadMutationDone = true;
          rows.find((row) => row.id === userA2).ownerUserId = USER_B;
        }
      },
    });

    const result = await runMemoryCompaction(
      { table },
      {
        agentId: "agent-a",
        requestContext: REQUEST_CONTEXT_A,
        aclPartition: USER_A_PARTITION,
        similarityThreshold: 0.5,
        lookbackDays: 30,
        maxBatchSize: 10,
        autoApply: true,
        workspaceDir: tempWorkspace(t, "release-731-compaction-reread-"),
        logger: { info() {}, warn() {} },
      },
    );

    assert.equal(result.deleted, 0, "a failed revalidation must not report a successful archive");
    assert.equal(result.plannedDeleted, 1, "the planned action remains observable separately");
    assert.equal(result.executed, 0);
    assert.deepEqual([...table._archived], []);
    assert.equal(table._rows.find((row) => row.id === userA2).ownerUserId, USER_B);
  });

  it("eventually considers an identical pair beyond the first compaction batch", async (t) => {
    const now = Date.now();
    const duplicateNew = uuidFor(21);
    const duplicateOld = uuidFor(22);
    const table = makeTable([
      memoryRow(uuidFor(23), "unrelated first batch alpha", now, { vector: [1, 0, 0] }),
      memoryRow(uuidFor(24), "unrelated first batch beta", now - 1, { vector: [0, 1, 0] }),
      memoryRow(duplicateNew, "duplicate pair beyond first batch", now - 2, { vector: [1, 0, 0] }),
      memoryRow(duplicateOld, "duplicate pair beyond first batch", now - 3, { vector: [1, 0, 0] }),
    ]);

    const result = await runMemoryCompaction(
      { table },
      {
        similarityThreshold: 0.99,
        lookbackDays: 30,
        maxBatchSize: 2,
        autoApply: true,
        workspaceDir: tempWorkspace(t, "release-731-compaction-page-"),
        logger: { info() {}, warn() {} },
      },
    );

    assert.equal(result.deleted, 1);
    assert.ok(table._archived.has(duplicateOld), "the duplicate after the first batch must be reached");
  });
});
