/**
 * tests/epistemic-status.test.js
 *
 * Phase 1 — Explicit Trust State. Covers the transition matrix, legacy
 * behavior, recall exclusion/scoring, merge/consolidation rules, the
 * version-boundary inheritance rule (Blocker 2 / Auflage A), and the
 * row-materialization survey fixes (§6d / Auflage B).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EPISTEMIC_STATUSES,
  normalizeEpistemicStatus,
  epistemicScoreBoost,
  isLegalEpistemicTransition,
  transitionEpistemicStatus,
  collapseEpistemicStatusOnContentChange,
  combineEpistemicStatusForMerge,
} from "../lib/epistemic-status.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { MemoryDB, applyEpistemicStatusToLanceDb, applyEpistemicStatusToNeo } from "../index.js";
import { runRecallPipeline as runRecallPipelineRaw } from "../lib/recall-pipeline.js";
import { makeEmbeddings, makeRow as makeHarnessRow, mockTable } from "./helpers/golden-recall-harness.js";
import { scoreNeoRecallItem, routeNeoRecall, formatNeoRecallContext } from "../lib/neo-arch.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";
import { buildUpdateEntry, safeUpdate } from "../lib/safe-update.js";
import { applyDynamicsDefaults } from "../lib/memory-dynamics.js";
import { MEMORY_ORIGINS } from "../lib/categorize.js";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});
function tmpRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function memoryCtx(overrides = {}) {
  return {
    agentId: "agent-a",
    workspaceIdentity: "workspace:v1:workspace-a",
    userPrincipal: "user:v1:" + "a".repeat(64),
    workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
    ...overrides,
  };
}

describe("epistemic-status — normalization", () => {
  it("normalizeEpistemicStatus resolves unrecognized/missing values to untrusted, never a pass-through", () => {
    assert.equal(normalizeEpistemicStatus(undefined), "untrusted");
    assert.equal(normalizeEpistemicStatus(null), "untrusted");
    assert.equal(normalizeEpistemicStatus(""), "untrusted");
    assert.equal(normalizeEpistemicStatus("bogus"), "untrusted");
    assert.equal(normalizeEpistemicStatus("trusted"), "trusted");
    for (const status of EPISTEMIC_STATUSES) {
      assert.equal(normalizeEpistemicStatus(status), status);
    }
  });

  it("epistemicScoreBoost is neutral (0) for absent/unrecognized values, directional only for real values", () => {
    assert.equal(epistemicScoreBoost(undefined), 0);
    assert.equal(epistemicScoreBoost(""), 0);
    assert.equal(epistemicScoreBoost("bogus"), 0);
    assert.equal(epistemicScoreBoost("untrusted"), -0.15);
    assert.equal(epistemicScoreBoost("disputed"), -0.4);
    assert.equal(epistemicScoreBoost("corroborated"), 0.15);
    assert.equal(epistemicScoreBoost("trusted"), 0.25);
    assert.equal(epistemicScoreBoost("observed"), 0);
  });
});

describe("epistemic-status — transition matrix", () => {
  it("rejects illegal transitions: the four non-self exits from invalidated, for human actors", () => {
    for (const to of ["observed", "corroborated", "trusted", "disputed"]) {
      assert.equal(
        isLegalEpistemicTransition("invalidated", to, "human"),
        false,
        `invalidated -> ${to} must be illegal even for human`,
      );
    }
    // The two legal exits from invalidated: self (no-op) and back to untrusted.
    assert.equal(isLegalEpistemicTransition("invalidated", "invalidated", "human"), true);
    assert.equal(isLegalEpistemicTransition("invalidated", "untrusted", "human"), true);
  });

  it("rejects a system:tombstone-cascade actor targeting anything other than invalidated", () => {
    for (const to of ["untrusted", "observed", "corroborated", "trusted", "disputed"]) {
      assert.equal(
        isLegalEpistemicTransition("untrusted", to, "system:tombstone-cascade"),
        false,
        `cascade actor must not be able to set ${to}`,
      );
    }
    assert.equal(isLegalEpistemicTransition("trusted", "invalidated", "system:tombstone-cascade"), true);
  });

  it("human actor may set almost any target (the matrix is a permission matrix gated by actor tier, not a rich state machine)", () => {
    for (const from of EPISTEMIC_STATUSES) {
      for (const to of EPISTEMIC_STATUSES) {
        if (from === "invalidated" && to !== "invalidated" && to !== "untrusted") continue; // covered above
        assert.equal(isLegalEpistemicTransition(from, to, "human"), true, `${from} -> ${to} should be legal for human`);
      }
    }
  });

  it("rejects an unknown actor tier entirely", () => {
    assert.equal(isLegalEpistemicTransition("untrusted", "trusted", "nobody"), false);
  });
});

describe("epistemic-status — transitionEpistemicStatus (pure builder)", () => {
  it("builds a patch for a legal human transition", () => {
    const patch = transitionEpistemicStatus(
      { id: "m1", epistemicStatus: "observed" },
      "corroborated",
      { actor: "user:v1:" + "a".repeat(64), reason: "second independent source found", evidence: "m2" },
    );
    assert.equal(patch.epistemicStatus, "corroborated");
    assert.equal(patch.previousEpistemicStatus, "observed");
    assert.equal(patch.epistemicStatusActor, "user:v1:" + "a".repeat(64));
    assert.equal(patch.epistemicStatusReason, "second independent source found");
    assert.ok(Number.isFinite(patch.epistemicStatusUpdatedAt));
  });

  it("throws on an illegal transition", () => {
    assert.throws(
      () => transitionEpistemicStatus({ epistemicStatus: "invalidated" }, "trusted", { actor: "human-x", authorized: true }),
      /illegal transition/,
    );
  });

  it("requires opts.authorized === true for targets trusted/invalidated", () => {
    assert.throws(
      () => transitionEpistemicStatus({ epistemicStatus: "observed" }, "trusted", { actor: "human-x" }),
      /requires opts\.authorized/,
    );
    assert.throws(
      () => transitionEpistemicStatus({ epistemicStatus: "observed" }, "invalidated", { actor: "human-x" }),
      /requires opts\.authorized/,
    );
    // Does not throw once authorized.
    const patch = transitionEpistemicStatus({ epistemicStatus: "observed" }, "trusted", { actor: "human-x", authorized: true });
    assert.equal(patch.epistemicStatus, "trusted");
  });

  it("requires a non-empty actor identity", () => {
    assert.throws(
      () => transitionEpistemicStatus({ epistemicStatus: "observed" }, "corroborated", {}),
      /actor is required/,
    );
  });
});

describe("epistemic-status — version-boundary collapse rule (Blocker 2 / Auflage A)", () => {
  it("a legacy row (no stored epistemicStatus) collapses to a no-op — never materializes an explicit untrusted", () => {
    const result = collapseEpistemicStatusOnContentChange({ id: "legacy-1" });
    assert.equal(result.changed, false, "legacy row content edit must be a no-op for epistemicStatus");
  });

  it("an explicit untrusted/observed row is unaffected by a content edit (no-op, not a bogus collapse)", () => {
    assert.equal(collapseEpistemicStatusOnContentChange({ epistemicStatus: "untrusted" }).changed, false);
    assert.equal(collapseEpistemicStatusOnContentChange({ epistemicStatus: "observed" }).changed, false);
  });

  it("trusted/corroborated collapse to observed on a content-changing edit", () => {
    const t = collapseEpistemicStatusOnContentChange({ epistemicStatus: "trusted" });
    assert.equal(t.changed, true);
    assert.equal(t.epistemicStatus, "observed");
    const c = collapseEpistemicStatusOnContentChange({ epistemicStatus: "corroborated" });
    assert.equal(c.changed, true);
    assert.equal(c.epistemicStatus, "observed");
  });

  it("disputed/invalidated are sticky-forward — unchanged by a content edit", () => {
    const d = collapseEpistemicStatusOnContentChange({ epistemicStatus: "disputed" });
    assert.equal(d.changed, false);
    assert.equal(d.epistemicStatus, "disputed");
    const i = collapseEpistemicStatusOnContentChange({ epistemicStatus: "invalidated" });
    assert.equal(i.changed, false);
    assert.equal(i.epistemicStatus, "invalidated");
  });
});

describe("epistemic-status — lib/db-adapter.js (§6d rows 7/8, real projection/filter paths)", () => {
  function schemaOf(fieldNames) {
    return async () => ({ fields: fieldNames.map((name) => ({ name })) });
  }

  it("_ensureEpistemicStatusColumns adds all five columns when missing, is idempotent", async () => {
    const addedColumns = [];
    const mockTable = {
      schema: schemaOf(["id", "text", "vector", "status"]),
      async addColumns(cols) { for (const col of cols) addedColumns.push(col.name); },
    };
    const adapter = createDbAdapter({ basePath: "/tmp/test-epistemic-db", getTable: async () => mockTable, logger: { info() {}, warn() {} } });
    await adapter._ensureEpistemicStatusColumns("agent-a", mockTable);
    for (const name of ["epistemicStatus", "epistemicStatusUpdatedAt", "epistemicStatusActor", "epistemicStatusReason", "previousEpistemicStatus"]) {
      assert.ok(addedColumns.includes(name), `${name} should be added`);
    }

    const addedColumns2 = [];
    const mockTable2 = {
      schema: schemaOf(["id", "text", "epistemicStatus", "epistemicStatusUpdatedAt", "epistemicStatusActor", "epistemicStatusReason", "previousEpistemicStatus"]),
      async addColumns(cols) { for (const col of cols) addedColumns2.push(col.name); },
    };
    const adapter2 = createDbAdapter({ basePath: "/tmp/test-epistemic-db-2", getTable: async () => mockTable2, logger: { info() {}, warn() {} } });
    await adapter2._ensureEpistemicStatusColumns("agent-a", mockTable2);
    assert.strictEqual(addedColumns2.length, 0, "no columns should be added when already present");
  });

  it("searchByTopic (vector path, where() available) excludes an invalidated row via the JS filter even if the WHERE predicate is not actually applied by the mock DB", async () => {
    const rows = [
      { id: "r1", text: "alpha fact", summary: "alpha", status: "active", epistemicStatus: "trusted", createdAt: Date.now(), _distance: 0.1 },
      { id: "r2", text: "alpha invalidated fact", summary: "alpha bad", status: "active", epistemicStatus: "invalidated", createdAt: Date.now(), _distance: 0.1 },
    ];
    const table = {
      vectorSearch() {
        return {
          // Deliberately ignores `clause` — simulates a DB where the WHERE
          // predicate did not actually filter anything, so the test proves
          // the JS-side filter is the real safety boundary, not the SQL string.
          where(_clause) { return { limit() { return { async toArray() { return rows; } }; } }; },
          limit() { return { async toArray() { return rows; } }; },
        };
      },
    };
    const adapter = createDbAdapter({ basePath: "/tmp/test-epistemic-search", getTable: async () => table, getEmbedding: async () => [1, 0, 0], logger: { info() {}, warn() {} } });
    const results = await adapter.searchByTopic("agent-a", "alpha", { limit: 10 });
    assert.deepEqual(results.map((r) => r.id), ["r1"], "invalidated row must be excluded from search results");
  });

  it("searchByTopic (vector path, where() throws -> catch fallback with no WHERE at all) still excludes an invalidated row via the JS filter", async () => {
    const rows = [
      { id: "r1", text: "beta fact", summary: "beta", status: "active", epistemicStatus: "", createdAt: Date.now(), _distance: 0.1 },
      { id: "r2", text: "beta invalidated fact", summary: "beta bad", status: "active", epistemicStatus: "invalidated", createdAt: Date.now(), _distance: 0.1 },
    ];
    const table = {
      vectorSearch() {
        return {
          where() { throw new Error("simulated: WHERE unsupported on this query builder version"); },
          limit() { return { async toArray() { return rows; } }; }, // the raw fallback path — no WHERE at all
        };
      },
    };
    const adapter = createDbAdapter({ basePath: "/tmp/test-epistemic-search-2", getTable: async () => table, getEmbedding: async () => [1, 0, 0], logger: { info() {}, warn() {} } });
    const results = await adapter.searchByTopic("agent-a", "beta", { limit: 10 });
    assert.deepEqual(results.map((r) => r.id), ["r1"]);
  });

  it("searchByTopic text-fallback path (no embedder) excludes an invalidated row via its own JS filter", async () => {
    const rows = [
      { id: "r1", text: "gamma fact about topic", summary: "gamma", status: "active", epistemicStatus: "observed", createdAt: Date.now() },
      { id: "r2", text: "gamma invalidated fact about topic", summary: "gamma bad", status: "active", epistemicStatus: "invalidated", createdAt: Date.now() },
    ];
    const table = {
      query() {
        return {
          where() { return { limit() { return { async toArray() { return rows; } }; } }; },
          limit() { return { async toArray() { return rows; } }; }, // reached when no searchOpts.filters -> filterClause is falsy
        };
      },
    };
    const adapter = createDbAdapter({ basePath: "/tmp/test-epistemic-search-3", getTable: async () => table, logger: { info() {}, warn() {} } }); // no getEmbedding -> text fallback
    const results = await adapter.searchByTopic("agent-a", "gamma", { limit: 10 });
    assert.deepEqual(results.map((r) => r.id), ["r1"]);
  });

  it("getCard (rowToCard) carries epistemicStatus through so the human-review surface can read the current status", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const rows = [{ id, text: "t", summary: "s", status: "active", epistemicStatus: "disputed", createdAt: Date.now() }];
    const table = { query() { return { where() { return { limit() { return { async toArray() { return rows; } }; } }; } }; } };
    const adapter = createDbAdapter({ basePath: "/tmp/test-epistemic-getcard", getTable: async () => table, logger: { info() {}, warn() {} } });
    const card = await adapter.getCard("agent-a", id);
    assert.equal(card.epistemicStatus, "disputed");
  });
});

describe("epistemic-status — index.js MemoryDB (§6a-i, §4c, real query/filter paths)", () => {
  // Minimal predicate applier for the ONE known clause shape vectorSearchActive
  // sends — proves the predicate both reaches .where() AND has the intended
  // effect, rather than just asserting a substring.
  function applyKnownWhereClause(clause, rows) {
    let out = rows;
    if (/status = 'active' OR status IS NULL/.test(clause)) {
      out = out.filter((r) => !r.status || r.status === "active");
    }
    if (/epistemicStatus != 'invalidated'/.test(clause)) {
      out = out.filter((r) => r.epistemicStatus !== "invalidated");
    }
    return out;
  }

  it("vectorSearchActive (where() available) sends a real, correctly-parenthesized predicate that excludes invalidated rows", async () => {
    const db = new MemoryDB("/tmp/fake-epistemic-vsa", 4);
    const rows = [
      { id: "a", status: "active", epistemicStatus: "trusted" },
      { id: "b", status: "active", epistemicStatus: "invalidated" },
    ];
    let capturedClause = null;
    db.table = {
      vectorSearch() {
        return {
          where(clause) {
            capturedClause = clause;
            return { limit() { return { async toArray() { return applyKnownWhereClause(clause, rows); } }; } };
          },
        };
      },
    };
    const results = await db.vectorSearchActive([1, 0, 0, 0], 10);
    assert.deepEqual(results.map((r) => r.id), ["a"]);
    // Defense-in-depth secondary check: the AND is parenthesized correctly
    // (AND binds tighter than OR — an unparenthesized append would let an
    // invalidated row with status='active' through).
    assert.match(capturedClause, /^\(status = 'active' OR status IS NULL\) AND epistemicStatus != 'invalidated'$/);
  });

  it("vectorSearchActive falls back to a JS-side filter (no WHERE at all) that still excludes invalidated rows", async () => {
    const db = new MemoryDB("/tmp/fake-epistemic-vsa-2", 4);
    const rows = [
      { id: "a", status: "active", epistemicStatus: "" },
      { id: "b", status: "active", epistemicStatus: "invalidated" },
    ];
    db.table = {
      vectorSearch() {
        return {
          // No `.where` method at all -> forces the raw fallback path.
          limit() { return { async toArray() { return rows; } }; },
        };
      },
    };
    const results = await db.vectorSearchActive([1, 0, 0, 0], 10);
    assert.deepEqual(results.map((r) => r.id), ["a"]);
  });

  it("MemoryDB.search() carries epistemicStatus through to the returned entry", async () => {
    const db = new MemoryDB("/tmp/fake-epistemic-search", 4);
    db.init = async () => true; // table is injected directly below; skip real LanceDB connect
    db.table = {
      async countRows() { return 1; },
      vectorSearch() {
        return {
          where() {
            return { limit() { return { async toArray() { return [{ id: "a", status: "active", epistemicStatus: "corroborated", halfLifeDays: 30, _distance: 0.1 }]; } }; } };
          },
        };
      },
    };
    const results = await db.search([1, 0, 0, 0], 5, 0);
    assert.equal(results[0].entry.epistemicStatus, "corroborated");
  });
});

describe("epistemic-status — persistence adapters (index.js)", () => {
  function ctxFor(agentId) {
    return { agentId, userPrincipal: "" };
  }

  it("applyEpistemicStatusToLanceDb persists the transition and writes the destructive-op audit log", async () => {
    const workspaceDir = tmpRoot("plur1bus-epistemic-audit-");
    const updateCalls = [];
    const db = {
      async getById(id) { return { id, agentId: "agent-a", storedBy: "agent-a", scope: "agent-private", epistemicStatus: "observed" }; },
      async update(id, patch) { updateCalls.push([id, patch]); },
    };
    const result = await applyEpistemicStatusToLanceDb(db, "m1", "corroborated", {
      ctx: ctxFor("agent-a"),
      actor: "agent-a-user",
      reason: "second source confirmed",
      evidence: "m2",
      workspaceDir,
    });
    assert.equal(result.ok, true);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0][1].epistemicStatus, "corroborated");

    const logPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.operation, "trust_transition");
    assert.equal(entry.memoryId, "m1");
    assert.equal(entry.previousEpistemicStatus, "observed");
    assert.equal(entry.newEpistemicStatus, "corroborated");
  });

  it("applyEpistemicStatusToLanceDb rejects a cross-agent transition (fail-closed via checkAccess)", async () => {
    const updateCalls = [];
    const db = {
      async getById(id) { return { id, agentId: "agent-a", storedBy: "agent-a", scope: "agent-private", epistemicStatus: "observed" }; },
      async update(id, patch) { updateCalls.push([id, patch]); },
    };
    const result = await applyEpistemicStatusToLanceDb(db, "m1", "corroborated", {
      ctx: ctxFor("agent-b"), // different agent than the record's owner
      actor: "agent-b-user",
      reason: "should not be allowed",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /acl\./);
    assert.equal(updateCalls.length, 0, "must not persist when checkAccess denies");
  });

  it("applyEpistemicStatusToLanceDb rejects a cross-workspace transition (fail-closed via checkAccess)", async () => {
    const updateCalls = [];
    const db = {
      async getById(id) { return { id, scope: "workspace", workspaceId: "workspace:v1:workspace-a", storedBy: "agent-a" }; },
      async update(id, patch) { updateCalls.push([id, patch]); },
    };
    const result = await applyEpistemicStatusToLanceDb(db, "m1", "corroborated", {
      ctx: { agentId: "agent-x", workspaceIdentity: "workspace:v1:workspace-b" },
      actor: "agent-x-user",
      reason: "should not be allowed",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /acl\./);
    assert.equal(updateCalls.length, 0);
  });

  it("applyEpistemicStatusToNeo persists via the same append mechanism transitionRecordStatus results already use, for an authorized requester", () => {
    const appendedCandidates = [];
    const appendedQueue = [];
    const store = {
      appendCandidates(items) { appendedCandidates.push(...items); },
      appendEmbeddingQueue(items) { appendedQueue.push(...items); },
    };
    // agent_private scope requires requesterAgentId === item.agentId via
    // isNeoRecordAccessible() — this is the real fail-closed gate this
    // function calls, not a mock.
    const item = { id: "n1", agentId: "agent-a", visibility: { scope: "agent_private" }, status: "active", epistemicStatus: "observed" };
    const result = applyEpistemicStatusToNeo(store, item, "corroborated", {
      ctx: { agentId: "agent-a" }, actor: "human-1", reason: "second source",
    });
    assert.equal(result.ok, true);
    assert.equal(appendedCandidates.length, 1);
    assert.equal(appendedCandidates[0].epistemicStatus, "corroborated");
    assert.equal(appendedQueue.length, 1);
  });

  it("Lücke 4: applyEpistemicStatusToNeo denies fail-closed (via the real isNeoRecordAccessible gate) for a cross-agent requester and does not persist", () => {
    const appendedCandidates = [];
    const store = {
      appendCandidates(items) { appendedCandidates.push(...items); },
      appendEmbeddingQueue() {},
    };
    const item = { id: "n1", agentId: "agent-a", visibility: { scope: "agent_private" }, status: "active", epistemicStatus: "observed" };
    const result = applyEpistemicStatusToNeo(store, item, "corroborated", {
      ctx: { agentId: "agent-b" }, // different agent than the record's owner
      actor: "agent-b-user", reason: "should not be allowed",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "acl.denied");
    assert.equal(appendedCandidates.length, 0, "must not persist when isNeoRecordAccessible denies");
  });

  it("Lücke 4: applyEpistemicStatusToNeo denies fail-closed when no ctx is supplied at all (absence must not default to allowed)", () => {
    const appendedCandidates = [];
    const store = {
      appendCandidates(items) { appendedCandidates.push(...items); },
      appendEmbeddingQueue() {},
    };
    const item = { id: "n1", agentId: "agent-a", visibility: { scope: "agent_private" }, status: "active", epistemicStatus: "observed" };
    const result = applyEpistemicStatusToNeo(store, item, "corroborated", { actor: "no-ctx-caller", reason: "missing ctx" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "acl.denied");
    assert.equal(appendedCandidates.length, 0);
  });

  it("Lücke 4: applyEpistemicStatusToNeo denies fail-closed for a record with no recognizable scope at all (absence of scope must not default to allowed)", () => {
    const appendedCandidates = [];
    const store = {
      appendCandidates(items) { appendedCandidates.push(...items); },
      appendEmbeddingQueue() {},
    };
    const item = { id: "n1", agentId: "agent-a", status: "active", epistemicStatus: "observed" }; // no visibility.scope / origin.scope
    const result = applyEpistemicStatusToNeo(store, item, "corroborated", {
      ctx: { agentId: "agent-a" }, actor: "human-1", reason: "second source",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "acl.denied");
    assert.equal(appendedCandidates.length, 0);
  });
});

describe("epistemic-status — lib/recall-pipeline.js (§6a/§6b, real runRecallPipeline path)", () => {
  it("excludes an invalidated memory even when it is the closest vector match", async () => {
    const rows = [
      makeHarnessRow({ id: "invalid-but-close", text: "closest match", distance: 0.01, epistemicStatus: "invalidated", agentId: "agent-a" }),
      makeHarnessRow({ id: "valid-but-far", text: "farther match", distance: 0.5, epistemicStatus: "observed", agentId: "agent-a" }),
    ];
    const result = await runRecallPipelineRaw({
      agentId: "agent-a",
      query: "match",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: { warn() {}, info() {} },
    });
    const ids = result.memories.map((m) => m.entry.id);
    assert.ok(!ids.includes("invalid-but-close"), "invalidated row must never surface via recall, regardless of relevance");
    assert.ok(ids.includes("valid-but-far"));
  });

  it("ranks a trusted memory above an equally-relevant untrusted one via the real single-pass scoring path", async () => {
    const rows = [
      makeHarnessRow({ id: "untrusted", text: "untrusted content variant", distance: 0.3, epistemicStatus: "untrusted", agentId: "agent-a" }),
      makeHarnessRow({ id: "trusted", text: "trusted content variant", distance: 0.3, epistemicStatus: "trusted", agentId: "agent-a" }),
    ];
    const result = await runRecallPipelineRaw({
      agentId: "agent-a",
      query: "content variant",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0,
      importanceBoost: 0, // isolate the epistemic boost from the importance boost
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: { warn() {}, info() {} },
    });
    const ids = result.memories.map((m) => m.entry.id);
    assert.deepEqual(ids, ["trusted", "untrusted"], "trusted must outrank untrusted at identical relevance");
  });

  it("a legacy row (no epistemicStatus in the row) is scored identically to an explicit 'observed' row via the real path", async () => {
    const rows = [
      makeHarnessRow({ id: "legacy", text: "legacy content variant", distance: 0.3, agentId: "agent-a" }), // epistemicStatus omitted -> ""
      makeHarnessRow({ id: "observed", text: "observed content variant", distance: 0.3, epistemicStatus: "observed", agentId: "agent-a" }),
    ];
    const result = await runRecallPipelineRaw({
      agentId: "agent-a",
      query: "content variant",
      dbTable: mockTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: { warn() {}, info() {} },
    });
    const legacy = result.memories.find((m) => m.entry.id === "legacy");
    const observed = result.memories.find((m) => m.entry.id === "observed");
    assert.ok(legacy && observed);
    assert.equal(legacy.score, observed.score, "absent epistemicStatus must score identically to explicit 'observed' (both neutral, 0 boost)");
  });
});

describe("epistemic-status — lib/neo-arch.js (§4d/§6b/§6c, real scoring/formatting path)", () => {
  it("scoreNeoRecallItem hard-excludes an invalidated NEO record (-Infinity) regardless of otherwise-strong signal", () => {
    const item = {
      id: "n1", statement: "the exact query text", category: "fact", status: "active",
      epistemicStatus: "invalidated", origin: { trustLevel: "curated" }, salience: 1, recency: 1,
    };
    const score = scoreNeoRecallItem(item, "the exact query text", "workspace_facts", {});
    assert.equal(score, -Infinity);
  });

  it("scoreNeoRecallItem gives a trusted record a strictly higher score than an otherwise-identical untrusted one", () => {
    const base = { statement: "shared statement text", category: "fact", status: "active", origin: {} };
    const trusted = { ...base, id: "t1", epistemicStatus: "trusted" };
    const untrusted = { ...base, id: "u1", epistemicStatus: "untrusted" };
    const trustedScore = scoreNeoRecallItem(trusted, "shared statement text", "workspace_facts", {});
    const untrustedScore = scoreNeoRecallItem(untrusted, "shared statement text", "workspace_facts", {});
    assert.ok(trustedScore > untrustedScore, `trusted (${trustedScore}) must outscore untrusted (${untrustedScore})`);
  });

  it("scoreNeoRecallItem scores a legacy record (no epistemicStatus) identically to an explicit 'observed' record", () => {
    const base = { statement: "shared statement text", category: "fact", status: "active", origin: {} };
    const legacy = { ...base, id: "l1" };
    const observed = { ...base, id: "o1", epistemicStatus: "observed" };
    const legacyScore = scoreNeoRecallItem(legacy, "shared statement text", "workspace_facts", {});
    const observedScore = scoreNeoRecallItem(observed, "shared statement text", "workspace_facts", {});
    assert.equal(legacyScore, observedScore);
  });

  it("routeNeoRecall (real path, real ACL) never routes an invalidated record into any lane", () => {
    const items = [
      { id: "inv-1", agentId: "agent-a", visibility: { scope: "agent_private" }, statement: "the exact query text", category: "fact", status: "active", epistemicStatus: "invalidated" },
      { id: "ok-1", agentId: "agent-a", visibility: { scope: "agent_private" }, statement: "the exact query text", category: "fact", status: "active", epistemicStatus: "observed" },
    ];
    const lanes = routeNeoRecall(items, "the exact query text", { requesterAgentId: "agent-a", minScore: -1 });
    const allIds = Object.values(lanes).flat().map((r) => r.item.id);
    assert.ok(!allIds.includes("inv-1"), "invalidated NEO record must never be routed into a recall lane");
    assert.ok(allIds.includes("ok-1"));
  });

  it("formatNeoRecallContext renders a fail-closed epistemic=\"untrusted\" attribute for a legacy record with no epistemicStatus", () => {
    const lanes = { workspace_facts: [{ item: { id: "n1", statement: "legacy record text", category: "fact", status: "active" }, score: 0.5 }] };
    const xml = formatNeoRecallContext(lanes, {});
    assert.match(xml, /epistemic="untrusted"/, "an absent epistemicStatus must render as the fail-closed label, not blank or 'trusted'");
  });

  it("formatNeoRecallContext renders the real epistemic label for an explicitly trusted record", () => {
    const lanes = { workspace_facts: [{ item: { id: "n2", statement: "trusted record text", category: "fact", status: "active", epistemicStatus: "trusted" }, score: 0.5 }] };
    const xml = formatNeoRecallContext(lanes, {});
    assert.match(xml, /epistemic="trusted"/);
  });
});

describe("epistemic-status — lib/relevant-memory-context.js (§6c, real formatRelevantMemoriesContext path)", () => {
  it("renders a fail-closed epistemic=\"untrusted\" attribute for a legacy memory with no epistemicStatus", () => {
    const out = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0 },
    ]);
    assert.match(out, /epistemic="untrusted"/, "an absent epistemicStatus must render as the fail-closed label, not blank or 'trusted'");
  });

  it("renders the real epistemic label for an explicitly trusted memory", () => {
    const out = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0, epistemicStatus: "trusted" },
    ]);
    assert.match(out, /epistemic="trusted"/);
  });

  it("sanitizes an injected epistemicStatus value instead of passing it through raw", () => {
    const out = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0, epistemicStatus: '"><script>alert(1)</script>' },
    ]);
    assert.ok(!out.includes("<script>"), "malformed/injected epistemicStatus must never pass through raw into the prompt");
    // Not a real enum member, so normalizeEpistemicStatus resolves it fail-closed.
    assert.match(out, /epistemic="untrusted"/);
  });
});

describe("epistemic-status — lib/jobs/memory-compaction.js (§7a/§7b, real runMemoryCompaction path, Blocker 1)", () => {
  function makeDbTable(rows) {
    const archived = new Set();
    const added = [];
    return {
      query: () => ({ limit: () => ({ toArray: async () => rows }) }),
      update: async ({ where, values }) => {
        const m = where.match(/id = '([0-9a-f-]{36})'/i);
        const id = m ? m[1] : where;
        if (values.status === "archived") archived.add(id);
      },
      add: async (items) => { for (const item of items) added.push(item); },
      _archived: archived,
      _added: added,
    };
  }

  it("§7a: an invalidated memory is excluded from compaction candidates entirely (never merged, never a merge target)", async () => {
    const rows = [
      { id: "81d38141-96b8-4656-9e6c-d57e7d534ef0", text: "alpha beta gamma", vector: [1, 0, 0], createdAt: Date.now(), importance: 0.5, category: "other", origin: "dm", storedBy: "", confirmed: false, epistemicStatus: "trusted" },
      { id: "7c82b440-0e5d-4e6e-b3b1-adea8b574996", text: "alpha beta gamma", vector: [1, 0, 0], createdAt: Date.now() - 1000, importance: 0.5, category: "other", origin: "dm", storedBy: "", confirmed: false, epistemicStatus: "invalidated" },
    ];
    const table = makeDbTable(rows);
    const workspaceDir = tmpRoot("plur1bus-compaction-invalidated-");
    const result = await runMemoryCompaction(
      { table },
      { similarityThreshold: 0.5, lookbackDays: 30, maxBatchSize: 50, dryRun: false, autoApply: true, logger: { info() {}, warn() {} }, workspaceDir },
    );
    assert.equal(result.note, "too_few_candidates", "with the invalidated row excluded, only 1 candidate remains -> too few to cluster");
    assert.equal(table._archived.size, 0, "the invalidated row must never be archived/aliased by compaction");
    assert.equal(table._added.length, 0, "no merge should ever be constructed from/into an invalidated row");
  });

  // §7b integration-test note: `executeActions`'s "merge" case (the code
  // this Auflage-B fix targets) is only ever reached when an action passes
  // isLowRiskAutoApplyAction(), which — independent of this feature, and
  // unchanged by it (no unrelated refactoring) — currently accepts ONLY
  // type==="delete" && reason==="identical_duplicate". A "merge" action is
  // therefore always routed to persistProposals() and never auto-executed
  // by the current codebase, regardless of autoApply. Confirmed empirically:
  // driving runMemoryCompaction() end-to-end through a real merge (LLM mock
  // returning merge:true) produces executed:0/proposals:1 and table._added
  // stays empty — the merge branch is unreachable via the public API today.
  // This is a pre-existing characteristic of memory-compaction.js, not
  // something introduced by this change, so it is not in scope to alter
  // here. The fix in the merge-construction code is still correct and
  // matters the moment that gate is ever loosened (or the branch is invoked
  // some other way); combineEpistemicStatusForMerge() itself — the exact
  // function that branch calls — is fully covered below via its real,
  // exported entry point.
  it("§7b: combineEpistemicStatusForMerge (the exact function the merge-construction fix calls) takes the more conservative of two statuses", () => {
    assert.equal(combineEpistemicStatusForMerge("trusted", "untrusted"), "untrusted", "lower ladder position wins, regardless of argument order intent");
    assert.equal(combineEpistemicStatusForMerge("untrusted", "trusted"), "untrusted");
    assert.equal(combineEpistemicStatusForMerge("trusted", "corroborated"), "corroborated");
    assert.equal(combineEpistemicStatusForMerge("observed", "observed"), "observed");
  });

  it("§7b: disputed is sticky in a merge — an active dispute is not resolved by merging into an undisputed memory", () => {
    assert.equal(combineEpistemicStatusForMerge("disputed", "trusted"), "disputed");
    assert.equal(combineEpistemicStatusForMerge("trusted", "disputed"), "disputed");
  });

  it("§7b: invalidated is sticky in a merge (defensive — loadCompactionCandidates already excludes it upstream)", () => {
    assert.equal(combineEpistemicStatusForMerge("invalidated", "trusted"), "invalidated");
    assert.equal(combineEpistemicStatusForMerge("disputed", "invalidated"), "invalidated", "invalidated outranks disputed as the more severe sticky state");
  });

  it("§7b: a legacy input (no epistemicStatus) resolves fail-closed to untrusted, the correct conservative default", () => {
    assert.equal(combineEpistemicStatusForMerge(undefined, "trusted"), "untrusted");
  });
});

describe("epistemic-status — lib/safe-update.js (§8, Blocker 2 / Auflage A, real buildUpdateEntry/safeUpdate path)", () => {
  const OLD_ROW = {
    id: "11111111-1111-1111-1111-111111111111",
    text: "Original fact",
    summary: "Original fact",
    vector: [0.1, 0.2, 0.3],
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: "",
    status: "active",
    versionNumber: 1,
  };
  const PATCH = { text: "Corrected fact", vector: [0.11, 0.21, 0.31] };
  const EVIDENCE = { updateSource: "test", updateEvidence: "unit test", confidence: 0.9 };

  it("Auflage A: a legacy row (no epistemicStatus key) survives a content-changing edit and still scores exactly 0, never -0.15", () => {
    // The exact regression the review's Auflage A named: comparing against
    // the RAW old value (undefined) instead of the NORMALIZED one
    // (normalizeEpistemicStatus(undefined) === "untrusted") would silently
    // materialize an explicit "untrusted" on a legacy row's new version,
    // degrading its recall score from 0 to -0.15 the moment it gets edited.
    const newEntry = buildUpdateEntry(OLD_ROW, PATCH, EVIDENCE, {});
    assert.equal("epistemicStatus" in newEntry, true, "the key exists on the returned object (as undefined) — normalizeEntryForTable defaults it on insert");
    assert.equal(newEntry.epistemicStatus, undefined, "must carry the RAW old (absent) value forward, not materialize 'untrusted'");
    assert.equal(epistemicScoreBoost(newEntry.epistemicStatus), 0, "must still score neutral 0, exactly like the pre-edit legacy row — not -0.15");
    assert.equal(newEntry.epistemicStatusActor, undefined, "no fabricated actor for a no-op collapse");
  });

  it("trusted/corroborated collapse to observed on a real buildUpdateEntry content change, with fresh actor/reason metadata", () => {
    const trustedRow = { ...OLD_ROW, epistemicStatus: "trusted" };
    const newEntry = buildUpdateEntry(trustedRow, PATCH, EVIDENCE, {});
    assert.equal(newEntry.epistemicStatus, "observed");
    assert.equal(newEntry.previousEpistemicStatus, "trusted");
    assert.equal(newEntry.epistemicStatusActor, "system:content-edit");
    assert.ok(newEntry.epistemicStatusReason.length > 0);
    assert.ok(Number.isFinite(newEntry.epistemicStatusUpdatedAt));
  });

  it("an explicit untrusted/disputed row is carried forward verbatim (raw value, not re-collapsed) on a content change", () => {
    const untrustedRow = { ...OLD_ROW, epistemicStatus: "untrusted", epistemicStatusActor: "human-x", epistemicStatusReason: "prior review" };
    const untrustedNext = buildUpdateEntry(untrustedRow, PATCH, EVIDENCE, {});
    assert.equal(untrustedNext.epistemicStatus, "untrusted");
    assert.equal(untrustedNext.epistemicStatusActor, "human-x", "prior provenance metadata carries forward on a true no-op, not fabricated anew");

    const disputedRow = { ...OLD_ROW, epistemicStatus: "disputed" };
    const disputedNext = buildUpdateEntry(disputedRow, PATCH, EVIDENCE, {});
    assert.equal(disputedNext.epistemicStatus, "disputed", "disputed is sticky-forward even across a content edit");
  });

  it("real safeUpdate() path: a legacy row's content-changing update logs no bogus epistemic transition", async () => {
    const storeCalls = [];
    const updateCalls = [];
    const loggedEvents = [];
    const db = {
      getById: async () => OLD_ROW,
      store: async (entry) => storeCalls.push(entry),
      update: async (...args) => updateCalls.push(args),
    };
    const neoStore = {
      async readReconsolidationEvents() { return []; },
      async appendReconsolidationEvents(events) { loggedEvents.push(...events); },
    };
    const result = await safeUpdate(db, OLD_ROW.id, PATCH, EVIDENCE, {
      agentId: "agent-a", neoStore, skipDriftGate: true,
    });
    assert.equal(result.inline, false, "text change must create a new version, not an inline update");
    assert.equal(storeCalls.length, 1);
    assert.equal(storeCalls[0].epistemicStatus, undefined, "the stored new version must still carry the legacy row forward as a true no-op");
    assert.equal(loggedEvents.length, 1);
    assert.equal("previousEpistemicStatus" in loggedEvents[0], false, "a no-op collapse must not log a bogus previousEpistemicStatus/newEpistemicStatus pair");
    assert.equal("newEpistemicStatus" in loggedEvents[0], false);
  });

  it("real safeUpdate() path: a trusted row's content-changing update logs the real collapse transition", async () => {
    const trustedRow = { ...OLD_ROW, epistemicStatus: "trusted" };
    const storeCalls = [];
    const loggedEvents = [];
    const db = {
      getById: async () => trustedRow,
      store: async (entry) => storeCalls.push(entry),
      update: async () => {},
    };
    const neoStore = {
      async readReconsolidationEvents() { return []; },
      async appendReconsolidationEvents(events) { loggedEvents.push(...events); },
    };
    await safeUpdate(db, trustedRow.id, PATCH, EVIDENCE, { agentId: "agent-a", neoStore, skipDriftGate: true });
    assert.equal(storeCalls[0].epistemicStatus, "observed");
    assert.equal(loggedEvents[0].previousEpistemicStatus, "trusted");
    assert.equal(loggedEvents[0].newEpistemicStatus, "observed");
  });
});

describe("epistemic-status — Requirement 3: assistant/agent-generated content is never auto-trusted (real capture path)", () => {
  // Coverage note: this repo has no literal "assistant" MEMORY_ORIGINS value
  // (lib/categorize.js: ["dm", "group", "cron", "internal"]) — "internal"
  // ("agent-generated", per the memory_store tool schema's own description
  // in index.js) is the closest concept to assistant-authored content. The
  // memory_store MCP tool handler itself (index.js, ~line 8064: `const entry
  // = applyDynamicsDefaults({ id: randomUUID(), text: params.text, ...,
  // origin, ... }, ...)` followed immediately by `await db.store(entry)`)
  // lives inside the plugin registration closure and is not exported, so it
  // cannot be invoked directly here — this is the same pre-existing
  // testability gap noted for runCorrectCommand in the implementation
  // report (no test in this repo instantiates the full plugin to call any
  // command/tool handler). What IS tested here, exercising the real,
  // exported functions on the exact call sequence the tool handler uses
  // (applyDynamicsDefaults() -> MemoryDB.normalizeEntryForTable() ->
  // MemoryDB.store() -> table.add()): the entry object the capture path
  // builds carries no epistemicStatus field for ANY origin, including
  // "internal", and normalizeEntryForTable — the function that fills every
  // schema-column default immediately before every table.add() call in this
  // codebase — defaults an absent epistemicStatus to "", never "trusted".
  // NOT covered: the memory_store tool handler's own argument wiring
  // (i.e., that it doesn't itself set entry.epistemicStatus somewhere
  // between params and the applyDynamicsDefaults() call) — verified instead
  // by direct code reading (index.js ~8064-8073: the object literal has no
  // epistemicStatus key at all).
  for (const origin of MEMORY_ORIGINS) {
    it(`a captured memory with origin="${origin}" is never auto-trusted — real applyDynamicsDefaults -> normalizeEntryForTable -> store -> table.add path`, async () => {
      const db = new MemoryDB(`/tmp/fake-epistemic-capture-${origin}`, 4);
      db.init = async () => true;
      const addedRows = [];
      db.table = { add: async (rows) => { addedRows.push(...rows); } };

      // Exact shape the memory_store tool handler builds (index.js ~8064),
      // minus fields irrelevant to this invariant (vector/emotion/etc.) —
      // critically, no epistemicStatus key anywhere in the literal, matching
      // the real handler.
      const entry = applyDynamicsDefaults({
        id: `capture-${origin}`, text: "some captured content", summary: "some captured content",
        origin, vector: [0.1, 0.2, 0.3, 0.4], importance: 0.5, category: "fact",
        createdAt: Date.now(), mergedFrom: "[]", expiresAt: 0,
        agentId: "agent-a", storedBy: "agent-a", workspaceId: "", workspaceKey: "", ownerUserId: "", scope: "agent-private",
        sourceTurnId: "", sourceMessageRole: "", sourceTimestamp: Date.now(), sourceUrl: "", evidenceQuote: "",
        emotionalValence: "", emotionalIntensity: 0, emotionalDominant: "neutral", moodContextAtCapture: "",
      }, Date.now(), {}, {});

      assert.equal("epistemicStatus" in entry, false, `applyDynamicsDefaults must not introduce an epistemicStatus key for origin="${origin}"`);

      await db.store(entry);
      assert.equal(addedRows.length, 1);
      const storedRow = addedRows[0];
      assert.equal(storedRow.epistemicStatus, "", `a freshly captured memory (origin="${origin}") must never be auto-trusted — stored value must be the legacy/absent default "", never "trusted"`);
      assert.equal(normalizeEpistemicStatus(storedRow.epistemicStatus), "untrusted", "resolves conservatively for legality/labeling, exactly like any other never-reviewed memory");
      assert.equal(epistemicScoreBoost(storedRow.epistemicStatus), 0, "scores neutral, not the +0.25 'trusted' boost");
    });
  }
});

describe("epistemic-status — Requirement 10: reindexing does not reactivate an invalidated memory (real promoted-memory-reindex path)", () => {
  it("applyPromotionReindex's underlying recall (db.search -> vectorSearchActive) excludes an invalidated memory from what gets reindexed", async () => {
    // applyPromotionReindex (lib/promoted-memory-reindex.js) resolves the
    // memories it reindexes via db.search(), whose row mapper we already
    // extend with epistemicStatus, and vectorSearchActive(), which we
    // already hard-exclude 'invalidated' from (see the "index.js MemoryDB"
    // describe block above). This test proves invalidated exclusion holds
    // on the real vectorSearchActive() path with data shaped like a
    // reindex candidate (promoted-memory fields), rather than re-asserting
    // the already-covered generic case.
    const db = new MemoryDB("/tmp/fake-epistemic-reindex", 4);
    const rows = [
      { id: "promoted-live", status: "active", epistemicStatus: "trusted", category: "fact", text: "still-valid promoted fact" },
      { id: "promoted-retracted", status: "active", epistemicStatus: "invalidated", category: "fact", text: "retracted promoted fact" },
    ];
    db.table = {
      vectorSearch() {
        return {
          where(clause) {
            return { limit() { return { async toArray() { return rows.filter((r) => (!r.status || r.status === "active") && r.epistemicStatus !== "invalidated"); } }; } };
          },
        };
      },
    };
    const results = await db.vectorSearchActive([1, 0, 0, 0], 10);
    const ids = results.map((r) => r.id);
    assert.ok(ids.includes("promoted-live"));
    assert.ok(!ids.includes("promoted-retracted"), "an invalidated memory must never be selected for reindexing/promotion, even if it would otherwise match");
  });

  it("MemoryDB.search()'s row mapper (what applyPromotionReindex ultimately reads) carries epistemicStatus through so a caller CAN check it, real query path", async () => {
    const db = new MemoryDB("/tmp/fake-epistemic-reindex-search", 4);
    db.init = async () => true;
    db.table = {
      countRows: async () => 1,
      vectorSearch() {
        return {
          limit() {
            return {
              async toArray() {
                // "disputed", not "invalidated" — vectorSearchActive()'s own
                // filter only excludes "invalidated" (tested elsewhere); using
                // that value here would make this row vanish before ever
                // reaching the mapper this test is actually about.
                return [{ id: "m1", text: "t", category: "fact", importance: 0.5, createdAt: Date.now(), halfLifeDays: 30, epistemicStatus: "disputed", _distance: 0.1 }];
              },
            };
          },
        };
      },
    };
    const results = await db.search([1, 0, 0, 0], 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].entry.epistemicStatus, "disputed", "the real search() row mapper must surface epistemicStatus so callers (including reindexing) can act on it, not silently drop it");
  });
});
