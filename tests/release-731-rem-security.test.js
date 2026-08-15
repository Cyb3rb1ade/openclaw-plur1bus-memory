/**
 * Release 7.3.1 REM security regressions.
 *
 * These tests exercise the callable REM boundary rather than only helper
 * predicates: failed reads must not reach providers or durable sinks, ACL
 * partitions must remain independent, and output targets must be owner-bound.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildRemPartition,
  buildRemPartitions,
  getPreviousWeekWindow,
  loadCandidateMemories,
  runRemDream,
  writeRemDreamToVault,
} from "../lib/dreaming/rem-dream.js";

const AGENT = "release731-agent";
const USER_A = `user:v1:${"a".repeat(64)}`;
const USER_B = `user:v1:${"b".repeat(64)}`;
const WORKSPACE = "workspace:v1:release731-workspace";
const ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const WEEK_START = getPreviousWeekWindow().startMs;
const ROW_TIME = WEEK_START + 60 * 60 * 1000;

function context(overrides = {}) {
  return {
    agentId: AGENT,
    workspaceIdentity: WORKSPACE,
    userPrincipal: USER_A,
    workspaceAliases: ALIASES,
    ...overrides,
  };
}

function row(id, text, overrides = {}) {
  return {
    id,
    text,
    summary: text,
    vector: [1, 0],
    createdAt: ROW_TIME,
    sourceTimestamp: ROW_TIME,
    status: "active",
    epistemicStatus: "",
    memoryClass: "standard",
    scope: "agent-private",
    agentId: AGENT,
    storedBy: AGENT,
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: "",
    ...overrides,
  };
}

function fieldsFor(rows) {
  return [...new Set(rows.flatMap((item) => Object.keys(item)))].map((name) => ({ name }));
}

/**
 * A small query-builder fixture that applies the caller-supplied predicate
 * class before limit/offset. It intentionally leaves the exact SQL matching
 * to the test so the regression remains independent of LanceDB internals.
 */
function dbFor(rows, {
  schema = fieldsFor(rows),
  schemaError = null,
  whereError = null,
  predicateRows = null,
  calls = {},
} = {}) {
  calls.where = calls.where || [];
  calls.offset = calls.offset || [];
  calls.limit = calls.limit || [];
  calls.unfiltered = calls.unfiltered || 0;

  return {
    table: {
      async schema() {
        if (schemaError) throw schemaError;
        return { fields: schema };
      },
      query() {
        const state = { clause: null, offset: 0, limit: rows.length };
        const builder = {
          where(clause) {
            calls.where.push(clause);
            if (whereError) throw whereError;
            state.clause = clause;
            return builder;
          },
          offset(value) {
            calls.offset.push(value);
            state.offset = value;
            return builder;
          },
          limit(value) {
            calls.limit.push(value);
            state.limit = value;
            return builder;
          },
          async toArray() {
            if (!state.clause) calls.unfiltered += 1;
            const eligible = typeof predicateRows === "function"
              ? predicateRows(rows, state.clause)
              : rows;
            return eligible.slice(state.offset, state.offset + state.limit);
          },
        };
        return builder;
      },
      vectorSearch() {
        return {
          limit() {
            return { async toArray() { return rows.map((item) => ({ ...item, _distance: 0 })); } };
          },
        };
      },
    },
  };
}

function makeSink(partition, counters = {}) {
  const neoStore = {
    aclBindings: partition,
    paths: {},
    hasCompletedRun(_runKey, binding) {
      counters.bindings = [...(counters.bindings || []), binding];
      return false;
    },
    readPatterns(_limit, binding) {
      counters.bindings = [...(counters.bindings || []), binding];
      return [];
    },
    appendPatterns(items, binding) {
      counters.bindings = [...(counters.bindings || []), binding];
      counters.appendPatterns = (counters.appendPatterns || 0) + 1;
      counters.patterns = items;
    },
    markRunCompleted(_runKey, _meta, binding) {
      counters.bindings = [...(counters.bindings || []), binding];
      counters.markRunCompleted = (counters.markRunCompleted || 0) + 1;
    },
  };
  return {
    aclBindings: partition,
    neoStore,
    outputTarget: {
      aclBindings: partition,
      kind: partition.scope,
      workspaceDir: counters.workspaceDir || null,
    },
  };
}

function runArgs({ db, requestContext, partition, sink, callLlm, narrativeCfg = { enabled: false } }) {
  return {
    db,
    patternLlmCfg: {},
    narrativeLlmCfg: {},
    echoLlmCfg: {},
    callLlm,
    neoStore: sink.neoStore,
    partitionSink: sink,
    workspaceKey: WORKSPACE,
    agentId: AGENT,
    requestContext,
    aclPartition: partition,
    narrativeCfg,
    force: true,
  };
}

test("REM schema discovery failure is fail-closed with zero provider or durable side effects", async () => {
  const calls = {};
  const counters = {};
  const requestContext = context();
  const partition = buildRemPartition({
    scope: "agent-private", agentId: AGENT, workspaceIdentity: "", ownerUserId: "",
  }, requestContext);
  const sink = makeSink(partition, counters);
  let llmCalls = 0;
  const result = await runRemDream(runArgs({
    db: dbFor([0, 1, 2].map((id) => row(`private-${id}`, `PRIVATE schema failure material ${id}`)), {
      schemaError: new Error("schema unavailable"),
      calls,
    }),
    requestContext,
    partition,
    sink,
    callLlm: async () => {
      llmCalls += 1;
      return JSON.stringify({ patternName: "must not run" });
    },
  }));

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "candidate_read_failed");
  assert.equal(llmCalls, 0);
  assert.equal(counters.appendPatterns || 0, 0);
  assert.equal(counters.markRunCompleted || 0, 0);
  assert.equal((counters.bindings || []).length, 0);
  assert.equal(calls.where.length, 0);
  assert.equal(calls.unfiltered, 0);
});

test("REM filtered-query failure never retries unfiltered and produces zero side effects", async () => {
  const calls = {};
  const counters = {};
  const requestContext = context();
  const partition = buildRemPartition({
    scope: "agent-private", agentId: AGENT, workspaceIdentity: "", ownerUserId: "",
  }, requestContext);
  const sink = makeSink(partition, counters);
  let llmCalls = 0;
  const rows = [0, 1, 2].map((id) => row(`private-${id}`, `PRIVATE query failure ${id}`));
  const result = await runRemDream(runArgs({
    db: dbFor(rows, { whereError: new Error("filtered query rejected"), calls }),
    requestContext,
    partition,
    sink,
    callLlm: async () => {
      llmCalls += 1;
      return JSON.stringify({ patternName: "must not run" });
    },
  }));

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "candidate_read_failed");
  assert.equal(llmCalls, 0);
  assert.equal(counters.appendPatterns || 0, 0);
  assert.equal(counters.markRunCompleted || 0, 0);
  assert.equal((counters.bindings || []).length, 0);
  assert.equal(calls.where.length, 1);
  assert.equal(calls.unfiltered, 0, "a filtered-query error must not reach query().limit() without where()");
});

test("REM discovers authorized agent-private, user, and workspace partitions together", () => {
  const partitions = buildRemPartitions(context());
  assert.deepEqual(partitions.map((partition) => partition.scope), ["agent-private", "user", "workspace"]);
  assert.equal(partitions.find((partition) => partition.scope === "user").ownerUserId, USER_A);
  assert.equal(partitions.find((partition) => partition.scope === "workspace").workspaceIdentity, WORKSPACE);
});

test("REM reads simultaneous user and workspace partitions independently", async () => {
  const requestContext = context();
  const partitions = buildRemPartitions(requestContext);
  const rows = [
    row("user-a", "USER A PRIVATE MATERIAL", {
      scope: "user", ownerUserId: USER_A,
    }),
    row("workspace", "WORKSPACE MATERIAL", {
      scope: "workspace", workspaceId: WORKSPACE, workspaceKey: WORKSPACE,
    }),
    row("user-b", "USER B PRIVATE MATERIAL", {
      scope: "user", ownerUserId: USER_B,
    }),
  ];
  const db = dbFor(rows, {
    predicateRows(allRows, clause) {
      if (clause?.includes("scope = 'user'")) {
        return allRows.filter((item) => item.scope === "user" && item.ownerUserId === USER_A);
      }
      if (clause?.includes("scope = 'workspace'")) {
        return allRows.filter((item) => item.scope === "workspace" && item.workspaceKey === WORKSPACE);
      }
      return [];
    },
  });
  const selected = {};
  for (const partition of partitions.filter(({ scope }) => scope !== "agent-private")) {
    selected[partition.scope] = (await loadCandidateMemories(db, {
      weekStartMs: WEEK_START,
      requestContext,
      aclPartition: partition,
      maxMemories: 3,
    })).map((memory) => memory.id);
  }

  assert.deepEqual(selected.user, ["user-a"]);
  assert.deepEqual(selected.workspace, ["workspace"]);
});

test("REM user partition does not mix multiple normalized users and avoids prefix starvation", async () => {
  const requestContext = context();
  const partition = buildRemPartition({
    scope: "user", agentId: AGENT, workspaceIdentity: "", ownerUserId: USER_A,
  }, requestContext);
  const rows = [
    ...[0, 1, 2, 3].map((id) => row(`user-b-${id}`, `SECRET USER B ${id}`, {
      scope: "user", agentId: AGENT, storedBy: AGENT, ownerUserId: USER_B,
    })),
    ...[0, 1, 2].map((id) => row(`user-a-${id}`, `USER A ${id}`, {
      scope: "user", agentId: AGENT, storedBy: AGENT, ownerUserId: USER_A,
    })),
  ];
  const calls = {};
  const memories = await loadCandidateMemories(dbFor(rows, {
    calls,
    predicateRows(allRows, clause) {
      if (clause?.includes(`ownerUserId = '${USER_A}'`)) {
        return allRows.filter((item) => item.scope === "user" && item.ownerUserId === USER_A);
      }
      return allRows;
    },
  }), {
    weekStartMs: WEEK_START,
    requestContext,
    aclPartition: partition,
    maxMemories: 3,
  });

  assert.deepEqual(memories.map((memory) => memory.id), ["user-a-0", "user-a-1", "user-a-2"]);
  assert.ok(calls.where[0].includes("scope = 'user'"));
  assert.ok(calls.where[0].includes(`ownerUserId = '${USER_A}'`));
  assert.ok(calls.offset.length >= 1, "bounded pagination must be explicit");
});

test("REM refuses a shared workspace vault target for private material", () => {
  const root = mkdtempSync(join(tmpdir(), "release731-rem-output-"));
  try {
    const requestContext = context();
    const privatePartition = buildRemPartition({
      scope: "agent-private", agentId: AGENT, workspaceIdentity: "", ownerUserId: "",
    }, requestContext);
    const result = writeRemDreamToVault({
      weekOf: "2026-W32",
      patternsFound: 1,
      new: 1,
      stronger: 0,
      weaker: 0,
      disappeared: 0,
      narrative: "PRIVATE REM NARRATIVE MUST NOT REACH SHARED VAULT",
      aclPartition: privatePartition,
    }, [{
      patternName: "private",
      trend: "neu",
      description: "PRIVATE REM EVIDENCE",
      evidenceQuotes: ["PRIVATE REM QUOTE"],
      aclBindings: privatePartition,
    }], root);

    assert.equal(result.written, false);
    assert.equal(readdirSync(root).length, 0);
    assert.equal(existsSync(join(root, "memory", "dream-diary", "rem")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REM refuses a path-only private output target even when its metadata claims private ACL", () => {
  const root = mkdtempSync(join(tmpdir(), "release731-rem-private-target-"));
  try {
    const requestContext = context();
    const privatePartition = buildRemPartition({
      scope: "user", agentId: AGENT, workspaceIdentity: "", ownerUserId: USER_A,
    }, requestContext);
    const result = writeRemDreamToVault({
      weekOf: "2026-W32",
      patternsFound: 0,
      new: 0,
      stronger: 0,
      weaker: 0,
      disappeared: 0,
      aclPartition: privatePartition,
    }, [], {
      aclBindings: privatePartition,
      kind: "user",
      workspaceDir: root,
    });

    assert.equal(result.written, false);
    assert.equal(readdirSync(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REM never sends private report text to a workspace-bound sink", () => {
  const requestContext = context();
  const privatePartition = buildRemPartition({
    scope: "agent-private", agentId: AGENT, workspaceIdentity: "", ownerUserId: "",
  }, requestContext);
  const workspacePartition = buildRemPartition({
    scope: "workspace", agentId: AGENT, workspaceIdentity: WORKSPACE, ownerUserId: "",
  }, requestContext);
  let writes = 0;
  const result = writeRemDreamToVault({
    weekOf: "2026-W32",
    patternsFound: 1,
    new: 1,
    stronger: 0,
    weaker: 0,
    disappeared: 0,
    narrative: "PRIVATE REPORT TEXT MUST NOT CROSS INTO WORKSPACE SINK",
    aclPartition: privatePartition,
  }, [{
    patternName: "private",
    trend: "neu",
    description: "PRIVATE EVIDENCE",
    evidenceQuotes: ["PRIVATE QUOTE"],
    aclBindings: privatePartition,
  }], {
    aclBindings: workspacePartition,
    kind: "workspace",
    writeFile() {
      writes += 1;
    },
  });

  assert.equal(result.written, false);
  assert.equal(writes, 0);
});
