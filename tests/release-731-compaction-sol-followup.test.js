/**
 * Release 7.3.1 Sol follow-up regressions for compaction scan safety.
 *
 * These tests deliberately use the public compaction entry point, a runtime-
 * shaped table stub, and real Neo/run-state and proposal-sink files.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createNeoStore } from "../lib/neo-arch.js";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";

const EMPTY_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const USER_A = "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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
const USER_CONTEXT = Object.freeze({
  agentId: AGENT,
  workspaceIdentity: WORKSPACE,
  userPrincipal: USER_A,
  workspaceAliases: EMPTY_ALIASES,
});
const USER_PARTITION = Object.freeze({
  scope: "user",
  agentId: AGENT,
  workspaceIdentity: "",
  ownerUserId: USER_A,
});

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
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

function makeTable(rows) {
  const archived = new Set();
  const added = [];
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
      const state = { where: "", offset: 0, limit: rows.length };
      return {
        where(clause) {
          state.where = String(clause);
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
          const source = ids.length > 0 ? rows.filter((row) => ids.includes(row.id)) : rows;
          return source.slice(state.offset, state.offset + state.limit);
        },
      };
    },
    async update({ where, values }) {
      const id = String(where).match(/[0-9a-f-]{36}/i)?.[0];
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

function logger() {
  return { info() {}, warn() {}, debug() {} };
}

describe("release 7.3.1 Sol compaction follow-up", () => {
  it("keeps a safe owner-bound exact-text overlap across maxScanRows=1 runs", async (t) => {
    const now = Date.now();
    const newer = uuidFor(301);
    const older = uuidFor(302);
    const table = makeTable([
      memoryRow(newer, "owner-bound duplicate text", now, {
        scope: "workspace", workspaceId: WORKSPACE, workspaceKey: WORKSPACE,
      }),
      memoryRow(older, "owner-bound duplicate text", now - 1, {
        scope: "workspace", workspaceId: WORKSPACE, workspaceKey: WORKSPACE,
      }),
    ]);
    const stateRoot = tempDir(t, "release-731-sol-overlap-state-");
    const outputDir = tempDir(t, "release-731-sol-overlap-output-");
    const neoStore = createNeoStore(stateRoot, WORKSPACE);
    const opts = {
      requestContext: WORKSPACE_CONTEXT,
      aclPartition: WORKSPACE_PARTITION,
      similarityThreshold: 0.99,
      lookbackDays: 30,
      scanLimit: 1,
      maxScanRows: 1,
      autoApply: true,
      neoStore,
      workspaceDir: outputDir,
      logger: logger(),
    };

    const first = await runMemoryCompaction({ table }, opts);
    assert.equal(first.deleted, 0);
    const persistedFirst = JSON.stringify(neoStore.readRunState());
    assert.doesNotMatch(persistedFirst, /owner-bound duplicate text/);
    assert.match(persistedFirst, /textHash|exactCandidates/);

    const second = await runMemoryCompaction({ table }, opts);
    assert.equal(second.plannedDeleted, 1);
    assert.equal(second.deleted, 1);
    assert.ok(table._archived.has(older), "the older duplicate must be archived on the second window");

    const scanState = neoStore.readRunState().memoryCompactionScan;
    assert.ok(scanState, "the owner-bound scan state must remain persisted");
    assert.equal(Object.values(scanState).every((entry) => entry.aclBindings?.scope === "workspace"), true);
    assert.doesNotMatch(JSON.stringify(scanState), /owner-bound duplicate text/);
  });

  it("propagates filtered and fallback query errors without EOF or persistence", async (t) => {
    const outputDir = tempDir(t, "release-731-sol-query-error-output-");
    const stateRoot = tempDir(t, "release-731-sol-query-error-state-");
    const neoStore = createNeoStore(stateRoot, WORKSPACE);
    let queryCount = 0;
    let updates = 0;
    const table = {
      async schema() {
        return { fields: ["id", "text", "vector", "createdAt", "status", "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId"].map((name) => ({ name })) };
      },
      query() {
        queryCount += 1;
        const filtered = { where: false };
        return {
          where() {
            filtered.where = true;
            return this;
          },
          limit() {
            return this;
          },
          async toArray() {
            throw new Error(filtered.where ? "filtered query failed" : "fallback query failed");
          },
        };
      },
      async update() {
        updates += 1;
      },
      async add() {
        updates += 1;
      },
    };

    await assert.rejects(
      runMemoryCompaction({ table }, {
        requestContext: WORKSPACE_CONTEXT,
        aclPartition: WORKSPACE_PARTITION,
        autoApply: true,
        neoStore,
        workspaceDir: outputDir,
        logger: logger(),
      }),
      /fallback query failed/,
    );
    assert.equal(queryCount, 2, "the filtered query and exactly one fallback must be attempted");
    assert.equal(updates, 0);
    assert.deepEqual(neoStore.readRunState().memoryCompactionScan, undefined);
    assert.equal(existsSync(join(outputDir, ".adaptive-learning")), false);
  });

  it("reports an unsaved private proposal without claiming success, then persists through an owner sink", async (t) => {
    const makePrivateCase = () => {
      const now = Date.now();
      const table = makeTable([
        memoryRow(uuidFor(311), "private deployment fact", now, {
          scope: "user", ownerUserId: USER_A,
        }),
        memoryRow(uuidFor(312), "private deployment fact with rollout detail", now - 1, {
          scope: "user", ownerUserId: USER_A,
        }),
      ]);
      return { table, workspaceDir: tempDir(t, "release-731-sol-private-workspace-") };
    };
    const callLlm = async () => JSON.stringify({
      merge: true,
      reason: "same deployment fact",
      mergedText: "private deployment fact with rollout detail and owner-safe context",
    });

    const missingSink = makePrivateCase();
    const missing = await runMemoryCompaction({ table: missingSink.table }, {
      requestContext: USER_CONTEXT,
      aclPartition: USER_PARTITION,
      autoApply: false,
      llmCfg: { model: "test" },
      callLlm,
      workspaceDir: null,
      logger: logger(),
    });
    assert.equal(missing.compacted, 1);
    assert.equal(missing.planned, 1);
    assert.equal(missing.proposals, 1);
    assert.equal(missing.proposalsPersisted, 0);
    assert.equal(missing.executed, 0);
    assert.equal(missing.deleted, 0);
    assert.equal(missing.merged, 0);
    assert.ok(missing.errors > 0, "missing proposal persistence must be an observable failure");
    assert.equal(existsSync(join(missingSink.workspaceDir, ".adaptive-learning")), false);

    const ownerSink = tempDir(t, "release-731-sol-private-owner-sink-");
    const persistedCase = makePrivateCase();
    const persisted = await runMemoryCompaction({ table: persistedCase.table }, {
      requestContext: USER_CONTEXT,
      aclPartition: USER_PARTITION,
      autoApply: false,
      llmCfg: { model: "test" },
      callLlm,
      workspaceDir: null,
      proposalSink: { outputDir: ownerSink, aclBindings: USER_PARTITION },
      logger: logger(),
    });
    const proposalPath = join(ownerSink, ".adaptive-learning", "merge-proposals.jsonl");
    assert.equal(persisted.planned, 1);
    assert.equal(persisted.proposals, 1);
    assert.equal(persisted.proposalsPersisted, 1);
    assert.equal(persisted.executed, 0);
    assert.equal(persisted.deleted, 0);
    assert.equal(persisted.merged, 0);
    assert.equal(persisted.errors, 0);
    assert.equal(existsSync(proposalPath), true);
    const entry = JSON.parse(readFileSync(proposalPath, "utf8").trim());
    assert.deepEqual(entry.aclBindings, USER_PARTITION);
  });
});
