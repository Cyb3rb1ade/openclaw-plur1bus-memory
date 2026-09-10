import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadCompactionCandidates } from "../lib/jobs/memory-compaction.js";
import { applyDailyDecayToAll } from "../lib/jobs/memory-dynamics-maintenance.js";

// 7.12.29: ACL-Ablehnungen (code PLUR1BUS_ACL_DENIED) sind keine Query-Fehler.

function aclError(operation = "query") {
  const error = new Error(`ACL denied for ${operation}`);
  error.code = "PLUR1BUS_ACL_DENIED";
  error.aclReason = "acl.user.missing_principal";
  error.rowId = "row-user-1";
  return error;
}

function makeCompactionTable({ onQuery }) {
  const calls = [];
  return {
    calls,
    async schema() { return { fields: ["id", "createdAt", "status", "scope", "agentId", "storedBy"].map((name) => ({ name })) }; },
    query() {
      const state = { where: null, limit: null, offset: 0 };
      const builder = {
        where(clause) { state.where = clause; return builder; },
        limit(n) { state.limit = n; return builder; },
        offset(n) { state.offset = n; return builder; },
        async toArray() { calls.push({ ...state }); return onQuery(state); },
      };
      return builder;
    },
  };
}

describe("memory-compaction ACL handling", () => {
  it("does not fall back to an unfiltered scan when the filtered query is ACL-denied", async () => {
    const table = makeCompactionTable({ onQuery: () => { throw aclError(); } });
    await assert.rejects(
      loadCompactionCandidates(table, 30, { agentId: "bernhardine", aclPartition: { scope: "agent-private", agentId: "bernhardine", workspaceIdentity: "", ownerUserId: "" } }),
      (error) => error.code === "PLUR1BUS_ACL_DENIED" && /ACL denied for query/.test(error.message),
    );
    assert.equal(table.calls.length, 1, "exactly one (filtered) query, no fallback");
    assert.match(table.calls[0].where, /scope = 'agent-private'/);
  });

  it("still falls back to an unfiltered scan on a genuine query error", async () => {
    const table = makeCompactionTable({ onQuery: (state) => { if (state.where) throw new Error("unsupported predicate"); return []; } });
    const candidates = await loadCompactionCandidates(table, 30, { agentId: "bernhardine", aclPartition: { scope: "agent-private", agentId: "bernhardine", workspaceIdentity: "", ownerUserId: "" } });
    assert.equal(candidates.length, 0);
    assert.equal(table.calls.length, 2, "filtered attempt plus one fallback");
    assert.equal(table.calls[1].where, null);
  });
});

function makeDecayDb(rows, { supportsWhere = true, whereError = null, schema = true } = {}) {
  const updates = [];
  const queries = [];
  const db = {
    updates,
    queries,
    table: {
      query() {
        const state = { where: null, offset: 0, limit: rows.length };
        const builder = {
          limit(n) { state.limit = n; return builder; },
          offset(n) { state.offset = n; return builder; },
          async toArray() {
            queries.push({ ...state });
            if (state.where && whereError) throw whereError;
            // Ein echtes Pushdown wuerde filtern; die Attrappe liefert alles,
            // damit der JS-Filter mitgeprueft wird.
            return rows.slice(state.offset, state.offset + state.limit);
          },
        };
        if (supportsWhere) builder.where = (clause) => { state.where = clause; return builder; };
        return builder;
      },
    },
    async update(id, patch) { updates.push({ id, patch }); },
  };
  if (schema) db.table.schema = async () => ({ fields: ["id", "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId"].map((name) => ({ name })) });
  return db;
}

const DAY = 86_400_000;
const old = Date.now() - 40 * DAY;
function row(id, extra = {}) {
  return { id, status: "active", memoryStrength: 1, halfLifeDays: 30, lastDynamicsAt: old, createdAt: old, importance: 0.5, ...extra };
}

describe("applyDailyDecayToAll partition filter", () => {
  const rows = [
    row("11111111-1111-4111-8111-111111111111", { scope: "user", ownerUserId: "user:v1:" + "a".repeat(64) }),
    row("22222222-2222-4222-8222-222222222222", { scope: "agent-private", storedBy: "bernhardine" }),
    row("33333333-3333-4333-8333-333333333333", { scope: "workspace", workspaceId: "workspace:v1:bernhardine" }),
    row("44444444-4444-4444-8444-444444444444", { scope: "agent-private", agentId: "main" }),
  ];
  const partition = { scope: "agent-private", agentId: "bernhardine", workspaceIdentity: "", ownerUserId: "" };

  it("pushes the partition as a where clause and only decays rows of that partition", async () => {
    const db = makeDecayDb(rows);
    const result = await applyDailyDecayToAll(db, { batchSize: 10, partition });
    assert.equal(result.errors, 0);
    assert.match(db.queries[0].where, /scope = 'agent-private' AND \(agentId = 'bernhardine' OR storedBy = 'bernhardine'\)/);
    assert.deepEqual(db.updates.map((u) => u.id), ["22222222-2222-4222-8222-222222222222"]);
  });

  it("filters in JS when the table has no where support", async () => {
    const db = makeDecayDb(rows, { supportsWhere: false });
    const result = await applyDailyDecayToAll(db, { batchSize: 10, partition });
    assert.equal(result.errors, 0);
    assert.deepEqual(db.updates.map((u) => u.id), ["22222222-2222-4222-8222-222222222222"]);
  });

  it("retries without pushdown on a genuine where error but never on an ACL denial", async () => {
    const generic = makeDecayDb(rows, { whereError: new Error("unsupported predicate") });
    const ok = await applyDailyDecayToAll(generic, { batchSize: 10, partition });
    assert.equal(ok.errors, 0);
    assert.equal(generic.queries.length, 2);
    assert.equal(generic.queries[1].where, null);
    assert.deepEqual(generic.updates.map((u) => u.id), ["22222222-2222-4222-8222-222222222222"]);

    const denied = makeDecayDb(rows, { whereError: aclError() });
    const failed = await applyDailyDecayToAll(denied, { batchSize: 10, partition });
    assert.equal(failed.errors, 1, "ACL denial is reported, not retried");
    assert.equal(denied.queries.length, 1);
    assert.equal(denied.updates.length, 0);
  });

  it("keeps the unfiltered behaviour without a partition", async () => {
    const db = makeDecayDb(rows);
    const result = await applyDailyDecayToAll(db, { batchSize: 10 });
    assert.equal(result.errors, 0);
    assert.equal(db.queries[0].where, null);
    assert.equal(db.updates.length, 4);
  });
});
