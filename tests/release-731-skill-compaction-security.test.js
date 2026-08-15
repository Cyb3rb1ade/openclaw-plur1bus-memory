/**
 * Release 7.3.1 security regressions for skill mining and compaction.
 *
 * These tests exercise the job boundaries with rows from different canonical
 * ownership tuples and with a duplicate pair outside the first work batch.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

    const aliases = readFileSync(join(workspaceDir, ".adaptive-learning", "memory-aliases.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(aliases.length, 1);
    assert.deepEqual(aliases[0].aclBindings, USER_A_PARTITION);
    assert.equal(aliases[0].oldId, userA2);
    assert.equal(aliases[0].canonicalId, userA1);
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

    assert.equal(result.deleted, 1, "the candidate action may be generated but must not report a successful archive");
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
