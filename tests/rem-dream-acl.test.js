import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildRemPartition, buildSparseNeighborGraph, loadCandidateMemories, runRemDream, writeRemDreamToVault } from "../lib/dreaming/rem-dream.js";
import { appendDreamEcho, loadFreshDreamEcho } from "../lib/dream-echo.js";
import { lightDream } from "../lib/dreaming/light-dream.js";

const NOW = Date.now();
const REQUEST_CONTEXT = Object.freeze({
  agentId: "agent-a",
  workspaceIdentity: "workspace:v1:workspace-a",
  userPrincipal: "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
});
const WORKSPACE_PARTITION = buildRemPartition({
  scope: "workspace", agentId: "agent-a", workspaceIdentity: "workspace:v1:workspace-a", ownerUserId: "",
}, REQUEST_CONTEXT);

function row(id, text, overrides = {}) {
  return {
    id,
    text,
    summary: text,
    vector: [1, 0],
    createdAt: NOW,
    sourceTimestamp: NOW,
    status: "active",
    scope: "workspace",
    workspaceKey: "workspace:v1:workspace-a",
    workspaceId: "workspace:v1:workspace-a",
    agentId: "agent-a",
    storedBy: "agent-a",
    ownerUserId: "",
    ...overrides,
  };
}

function fieldsFor(rows) {
  return [...new Set(rows.flatMap((item) => Object.keys(item)))].map((name) => ({ name }));
}

function dbFor(rows, { schema = fieldsFor(rows), predicateRows = null } = {}) {
  return {
    table: {
      async schema() { return { fields: schema }; },
      query() {
        const state = { offset: 0, limit: rows.length, filtered: false };
        const builder = {
          where() { state.filtered = true; return builder; },
          offset(value) { state.offset = value; return builder; },
          limit(value) { state.limit = value; return builder; },
          async toArray() {
            const selected = typeof predicateRows === "function" ? predicateRows(rows) : rows;
            return selected.slice(state.offset, state.offset + state.limit);
          },
        };
        return builder;
      },
      vectorSearch() { return { limit() { return { async toArray() { return rows.map((item) => ({ ...item, _distance: 0 })); } }; } }; },
    },
  };
}

function makeSink(partition, { counters = {}, memoryStore = null, outputTarget = null } = {}) {
  const neoStore = {
    aclBindings: partition,
    hasCompletedRun() { counters.completed = (counters.completed || 0) + 1; return false; },
    readPatterns() { return []; },
    appendPatterns() { counters.appended = (counters.appended || 0) + 1; },
    markRunCompleted() { counters.completed = (counters.completed || 0) + 1; },
  };
  return {
    aclBindings: partition,
    neoStore,
    memoryStore,
    outputTarget: outputTarget || { aclBindings: partition, kind: partition.scope },
  };
}

test("REM candidate loading excludes foreign workspace and owner rows before provider input", async () => {
  const rows = [
    row("a1", "workspace-a material"),
    row("b1", "SECRET workspace-b material", { workspaceKey: "workspace:v1:workspace-b" }),
    row("u1", "SECRET owner-b material", {
      scope: "user",
      workspaceKey: "",
      ownerUserId: "user:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  ];

  const candidates = await loadCandidateMemories(dbFor(rows), {
    weekStartMs: NOW - 1_000,
    requestContext: REQUEST_CONTEXT,
    aclPartition: WORKSPACE_PARTITION,
  });

  assert.deepEqual(candidates.map((candidate) => candidate.id), ["a1"]);
});

test("REM selects exactly one normalized ACL partition even when workspace and user rows are both accessible", async () => {
  const partition = buildRemPartition({
    scope: "workspace", agentId: "agent-a", workspaceIdentity: "workspace:v1:workspace-a", ownerUserId: "",
  }, REQUEST_CONTEXT);
  const rows = [
    row("w1", "workspace material"),
    row("u1", "owner material", { scope: "user", workspaceKey: "", ownerUserId: REQUEST_CONTEXT.userPrincipal }),
  ];
  const candidates = await loadCandidateMemories(dbFor(rows), {
    weekStartMs: NOW - 1_000, requestContext: REQUEST_CONTEXT, aclPartition: partition,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["w1"]);
});

test("REM owner partitions have distinct run, completion, lock, and vault identities", async () => {
  const ownerA = buildRemPartition({ scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: REQUEST_CONTEXT.userPrincipal }, REQUEST_CONTEXT);
  const ownerBContext = { ...REQUEST_CONTEXT, userPrincipal: "user:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  const ownerB = buildRemPartition({ scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: ownerBContext.userPrincipal }, ownerBContext);
  assert.notEqual(ownerA.key, ownerB.key);

  const reportA = { weekOf: "2026-W01", patternsFound: 0, new: 0, stronger: 0, weaker: 0, disappeared: 0, aclPartition: ownerA };
  const reportB = { ...reportA, aclPartition: ownerB };
  const vaultWritesA = [];
  const vaultWritesB = [];
  const outputA = writeRemDreamToVault(reportA, [], {
    aclBindings: ownerA,
    kind: "user",
    writeFile(payload) { vaultWritesA.push(payload); return { written: true }; },
  });
  const outputB = writeRemDreamToVault(reportB, [], {
    aclBindings: ownerB,
    kind: "user",
    writeFile(payload) { vaultWritesB.push(payload); return { written: true }; },
  });
  assert.notEqual(outputA.path, outputB.path);
  assert.equal(vaultWritesA[0].aclBindings.ownerUserId, REQUEST_CONTEXT.userPrincipal);
  assert.equal(vaultWritesB[0].aclBindings.ownerUserId, ownerBContext.userPrincipal);

  const completionKeys = [];
  const sinkA = makeSink(ownerA, { counters: { completionKeys }, outputTarget: { aclBindings: ownerA, kind: "user" } });
  const sinkB = makeSink(ownerB, { counters: { completionKeys }, outputTarget: { aclBindings: ownerB, kind: "user" } });
  sinkA.neoStore.hasCompletedRun = (key) => { completionKeys.push(key); return false; };
  sinkB.neoStore.hasCompletedRun = (key) => { completionKeys.push(key); return false; };
  const rowsA = ["1", "2", "3"].map((id) => row(`owner-a-${id}`, `owner A material ${id}`, {
    scope: "user", workspaceKey: "", workspaceId: "", ownerUserId: ownerA.ownerUserId,
  }));
  const rowsB = ["1", "2", "3"].map((id) => row(`owner-b-${id}`, `owner B material ${id}`, {
    scope: "user", workspaceKey: "", workspaceId: "", ownerUserId: ownerB.ownerUserId,
  }));
  await runRemDream({ db: dbFor(rowsA), callLlm: async () => "{}", neoStore: sinkA.neoStore, partitionSink: sinkA, workspaceKey: "workspace-a", agentId: "agent-a", requestContext: REQUEST_CONTEXT, aclPartition: ownerA, force: false });
  await runRemDream({ db: dbFor(rowsB), callLlm: async () => "{}", neoStore: sinkB.neoStore, partitionSink: sinkB, workspaceKey: "workspace-a", agentId: "agent-a", requestContext: ownerBContext, aclPartition: ownerB, force: false });
  assert.equal(completionKeys.length, 2);
  assert.notEqual(completionKeys[0], completionKeys[1]);
});

test("REM graph construction ignores a foreign vector neighbor before it can form an edge", async () => {
  const local = row("a1", "workspace-a material");
  const foreign = row("b1", "SECRET workspace-b vector neighbor", { workspaceKey: "workspace:v1:workspace-b" });
  const edges = await buildSparseNeighborGraph([local], {
    vectorSearch() { return { limit() { return { async toArray() { return [{ ...foreign, _distance: 0 }]; } }; } }; },
  }, { requestContext: REQUEST_CONTEXT, minSimilarity: 0.5 });

  assert.deepEqual(edges, []);
});

test("REM denies a missing owner context before any provider receives user-scoped material", async () => {
  const rows = ["1", "2", "3"].map((id) => row(id, `SECRET owner material ${id}`, {
    scope: "user",
    workspaceKey: "",
    workspaceId: "",
    ownerUserId: REQUEST_CONTEXT.userPrincipal,
  }));
  const calls = [];

  const result = await runRemDream({
    db: dbFor(rows),
    callLlm: async (messages) => { calls.push(messages); return "{}"; },
    neoStore: { hasCompletedRun: () => false, readPatterns: () => [], appendPatterns() {}, markRunCompleted() {} },
    workspaceKey: "workspace-a",
    agentId: "agent-a",
    requestContext: { ...REQUEST_CONTEXT, userPrincipal: "" },
    aclPartition: WORKSPACE_PARTITION,
    force: true,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "acl_sink_missing");
  assert.equal(calls.length, 0);
});

test("REM keeps the selected user ownership binding on its persisted dream memory", async () => {
  const rows = ["1", "2", "3"].map((id) => row(id, `owner material ${id}`, {
    scope: "user",
    workspaceKey: "",
    workspaceId: "",
    ownerUserId: REQUEST_CONTEXT.userPrincipal,
  }));
  const stored = [];
  let call = 0;
  const partition = buildRemPartition({ scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: REQUEST_CONTEXT.userPrincipal }, REQUEST_CONTEXT);
  const memoryStore = { aclBindings: partition, store: async (memory) => stored.push(memory) };
  const sink = makeSink(partition, { memoryStore, outputTarget: { aclBindings: partition, kind: "user", appendEcho() {} } });

  const result = await runRemDream({
    db: dbFor(rows),
    callLlm: async () => {
      call += 1;
      return call === 1
        ? JSON.stringify({ patternName: "Owner pattern", description: "Repeated owner-only material.", trend: "neu", confidence: 0.9 })
        : call === 2
          ? "A sufficiently long owner-only dream narrative that remains private to this one owner."
          : JSON.stringify({ sentence: "Owner-only echo." });
    },
    patternLlmCfg: {},
    narrativeLlmCfg: {},
    neoStore: sink.neoStore,
    partitionSink: sink,
    workspaceKey: "workspace-a",
    agentId: "agent-a",
    requestContext: REQUEST_CONTEXT,
    aclPartition: partition,
    embeddings: { embed: async () => [1, 0] },
    narrativeCfg: { enabled: true, storeAsMemory: true },
    force: true,
  });

  assert.equal(stored.length, 1, JSON.stringify(result));
  assert.equal(stored[0].scope, "user");
  assert.equal(stored[0].ownerUserId, REQUEST_CONTEXT.userPrincipal);
  assert.equal(stored[0].workspaceKey, "");
  assert.equal(stored[0].agentId, "agent-a");
  assert.equal(result.trends[0].workspaceKey, "");
});

test("a protected REM echo is not loaded without its matching owner context", (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-rem-echo-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  appendDreamEcho(workspaceDir, {
    sentence: "Private owner dream echo.",
    createdAt: NOW,
    aclBindings: { scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: REQUEST_CONTEXT.userPrincipal },
  });

  assert.equal(loadFreshDreamEcho(workspaceDir, { now: NOW, requestContext: { ...REQUEST_CONTEXT, userPrincipal: "" } }), null);
  assert.equal(loadFreshDreamEcho(workspaceDir, { now: NOW, requestContext: REQUEST_CONTEXT })?.sentence, "Private owner dream echo.");
});

test("legacy or unbound dream echoes fail closed", (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-unbound-echo-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  appendDreamEcho(workspaceDir, { sentence: "legacy echo", createdAt: NOW });
  assert.equal(loadFreshDreamEcho(workspaceDir, { now: NOW, requestContext: REQUEST_CONTEXT }), null);
});

test("light dreaming writes only a validated bound echo", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-light-bound-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const aclBindings = { scope: "workspace", agentId: "agent-a", workspaceIdentity: "workspace:v1:workspace-a", ownerUserId: "" };
  await lightDream({
    turns: ["one", "two", "three"].map((content) => ({ role: "user", content, agentId: "agent-a" })),
    neoStore: { readReactions: () => [], appendDreams() {}, appendBehaviorCards() {} },
    db: { search: async () => [] }, embeddings: { embed: async () => [1, 0] },
    insightLlmCfg: {}, narrativeLlmCfg: {}, echoLlmCfg: {},
    callLlm: async () => JSON.stringify(["bound light insight"]),
    narrativeCfg: { enabled: true, storeAsMemory: false }, workspaceDir, aclBindings, requestContext: REQUEST_CONTEXT,
  });
  assert.equal(loadFreshDreamEcho(workspaceDir, { requestContext: REQUEST_CONTEXT })?.aclBindings?.scope, "workspace");
});

test("REM workspace vault output retains the matching workspace ACL binding", (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-rem-vault-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const aclBindings = WORKSPACE_PARTITION;
  const output = writeRemDreamToVault({ weekOf: "2026-W01", patternsFound: 1, new: 1, stronger: 0, weaker: 0, disappeared: 0, aclPartition: aclBindings }, [{
    patternName: "Owner pattern", trend: "neu", evidenceQuotes: ["owner-only evidence"], aclBindings,
  }], { aclBindings, kind: "workspace", workspaceDir });

  const markdown = readFileSync(output.path, "utf8");
  assert.match(markdown, new RegExp(`workspace_identity: ${REQUEST_CONTEXT.workspaceIdentity}`));
  assert.match(markdown, /scope: workspace/);
});

// ─── Fail-closed query-builder contract ────────────────────────────────────
//
// A positively identified schema is required before candidate reads. Query
// builders without `where()` or with a throwing `where()` must never fall back
// to an unfiltered read.

function dbForNoWhere(rows) {
  return {
    table: {
      async schema() { return { fields: fieldsFor(rows) }; },
      query() { return { offset() { return this; }, limit() { return this; }, async toArray() { return rows; } }; },
      vectorSearch() { return { limit() { return { async toArray() { return rows.map((item) => ({ ...item, _distance: 0 })); } }; } }; },
    },
  };
}

function dbForThrowingWhere(rows) {
  return {
    table: {
      async schema() { return { fields: fieldsFor(rows) }; },
      query() {
        return {
          where() { throw new Error("simulated where() failure"); },
          offset() { return this; },
          limit() { return { async toArray() { return rows; } }; },
        };
      },
      vectorSearch() { return { limit() { return { async toArray() { return rows.map((item) => ({ ...item, _distance: 0 })); } }; } }; },
    },
  };
}

test("REM candidate loading without where() fails closed with zero provider or durable side effects", async () => {
  const rows = [
    row("live-1", "still-valid material"),
    row("invalid-1", "retracted material", { epistemicStatus: "invalidated" }),
  ];
  const counters = {};
  const sink = makeSink(WORKSPACE_PARTITION, { counters });
  let providerCalls = 0;
  const result = await runRemDream({
    db: dbForNoWhere(rows),
    callLlm: async () => { providerCalls += 1; return "{}"; },
    neoStore: sink.neoStore,
    partitionSink: sink,
    workspaceKey: "workspace-a",
    agentId: "agent-a",
    requestContext: REQUEST_CONTEXT,
    aclPartition: WORKSPACE_PARTITION,
    force: true,
  });
  assert.equal(result.reason, "candidate_read_failed");
  assert.equal(providerCalls, 0);
  assert.equal(counters.completed || 0, 0);
  assert.equal(counters.appended || 0, 0);
});

test("REM candidate loading with throwing where() fails closed with zero provider or durable side effects", async () => {
  const rows = [
    row("live-2", "still-valid material"),
    row("invalid-2", "retracted material", { epistemicStatus: "invalidated" }),
  ];
  const counters = {};
  const sink = makeSink(WORKSPACE_PARTITION, { counters });
  let providerCalls = 0;
  const result = await runRemDream({
    db: dbForThrowingWhere(rows),
    callLlm: async () => { providerCalls += 1; return "{}"; },
    neoStore: sink.neoStore,
    partitionSink: sink,
    workspaceKey: "workspace-a",
    agentId: "agent-a",
    requestContext: REQUEST_CONTEXT,
    aclPartition: WORKSPACE_PARTITION,
    force: true,
  });
  assert.equal(result.reason, "candidate_read_failed");
  assert.equal(providerCalls, 0);
  assert.equal(counters.completed || 0, 0);
  assert.equal(counters.appended || 0, 0);
});
