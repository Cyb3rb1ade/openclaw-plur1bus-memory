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
    agentId: "agent-a",
    ...overrides,
  };
}

function dbFor(rows) {
  return {
    table: {
      query() { return { where() { return { limit() { return { async toArray() { return rows; } }; } }; } }; },
      vectorSearch() { return { limit() { return { async toArray() { return rows.map((item) => ({ ...item, _distance: 0 })); } }; } }; },
    },
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

test("REM owner partitions have distinct run, completion, lock, and vault identities", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-rem-partitions-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const ownerA = buildRemPartition({ scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: REQUEST_CONTEXT.userPrincipal }, REQUEST_CONTEXT);
  const ownerBContext = { ...REQUEST_CONTEXT, userPrincipal: "user:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
  const ownerB = buildRemPartition({ scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: ownerBContext.userPrincipal }, ownerBContext);
  assert.notEqual(ownerA.key, ownerB.key);

  const reportA = { weekOf: "2026-W01", patternsFound: 0, new: 0, stronger: 0, weaker: 0, disappeared: 0, aclPartition: ownerA };
  const reportB = { ...reportA, aclPartition: ownerB };
  const outputA = writeRemDreamToVault(reportA, [], workspaceDir);
  const outputB = writeRemDreamToVault(reportB, [], workspaceDir);
  assert.notEqual(outputA.path, outputB.path);
  assert.match(readFileSync(outputA.path, "utf8"), new RegExp(`owner_user_id: ${REQUEST_CONTEXT.userPrincipal}`));
  assert.match(readFileSync(outputB.path, "utf8"), new RegExp(`owner_user_id: ${ownerBContext.userPrincipal}`));

  const completionKeys = [];
  const completionStore = { hasCompletedRun(key) { completionKeys.push(key); return false; }, readPatterns: () => [], appendPatterns() {}, markRunCompleted() {} };
  await runRemDream({ db: dbFor([]), callLlm: async () => "{}", neoStore: completionStore, workspaceKey: "workspace-a", agentId: "agent-a", requestContext: REQUEST_CONTEXT, aclPartition: ownerA, force: false });
  await runRemDream({ db: dbFor([]), callLlm: async () => "{}", neoStore: completionStore, workspaceKey: "workspace-a", agentId: "agent-a", requestContext: ownerBContext, aclPartition: ownerB, force: false });
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
  assert.equal(result.reason, "too_few_memories");
  assert.equal(calls.length, 0);
});

test("REM keeps the selected user ownership binding on its persisted dream memory", async () => {
  const rows = ["1", "2", "3"].map((id) => row(id, `owner material ${id}`, {
    scope: "user",
    workspaceKey: "",
    ownerUserId: REQUEST_CONTEXT.userPrincipal,
  }));
  const stored = [];
  let call = 0;

  const result = await runRemDream({
    db: { ...dbFor(rows), store: async (memory) => stored.push(memory) },
    callLlm: async () => {
      call += 1;
      return call === 1
        ? JSON.stringify({ patternName: "Owner pattern", description: "Repeated owner-only material.", trend: "neu", confidence: 0.9 })
        : "A sufficiently long owner-only dream narrative that remains private to this one owner.";
    },
    patternLlmCfg: {},
    narrativeLlmCfg: {},
    neoStore: { hasCompletedRun: () => false, readPatterns: () => [], appendPatterns() {}, markRunCompleted() {} },
    workspaceKey: "workspace-a",
    agentId: "agent-a",
    requestContext: REQUEST_CONTEXT,
    aclPartition: buildRemPartition({ scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: REQUEST_CONTEXT.userPrincipal }, REQUEST_CONTEXT),
    embeddings: { embed: async () => [1, 0] },
    narrativeCfg: { enabled: true },
    force: true,
  });

  assert.equal(stored.length, 1);
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

test("REM vault output retains the ownership binding for protected evidence", (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-rem-vault-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const aclBindings = { scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: REQUEST_CONTEXT.userPrincipal };
  const output = writeRemDreamToVault({ weekOf: "2026-W01", patternsFound: 1, new: 1, stronger: 0, weaker: 0, disappeared: 0, aclPartition: { ...aclBindings, key: "owner-partition" } }, [{
    patternName: "Owner pattern", trend: "neu", evidenceQuotes: ["owner-only evidence"], aclBindings,
  }], workspaceDir);

  const markdown = readFileSync(output.path, "utf8");
  assert.match(markdown, new RegExp(`owner_user_id: ${REQUEST_CONTEXT.userPrincipal}`));
  assert.match(markdown, /scope: user/);
});

// ─── Lücke 3 (epistemicStatus, Auflage B): fallback-path exclusion ────────
//
// loadCandidateMemories() has three load paths (where()-available,
// no-where() branch, catch-fallback on a throwing where()) that all
// converge into one shared JS-side .filter() (see lib/dreaming/rem-dream.js,
// the epistemicStatus check right after the __schema__/status checks). The
// tests above (and lib/epistemic-status.js's own db-adapter/index.js tests)
// only exercise the where()-available path. These two exercise the actual
// fallback paths and prove an invalidated row is still excluded there too.

function dbForNoWhere(rows) {
  return {
    table: {
      // No .where() on the query() result at all -> loadCandidateMemories's
      // `typeof query.where === "function"` check is false, forcing the
      // no-where() branch (`rows = await query.limit(maxMemories).toArray()`).
      query() { return { limit() { return { async toArray() { return rows; } }; } }; },
      vectorSearch() { return { limit() { return { async toArray() { return rows.map((item) => ({ ...item, _distance: 0 })); } }; } }; },
    },
  };
}

function dbForThrowingWhere(rows) {
  return {
    table: {
      // .where() exists but throws -> forces the catch-fallback branch
      // (`rows = await db.table.query().limit(maxMemories).toArray()`).
      query() {
        return {
          where() { throw new Error("simulated where() failure"); },
          limit() { return { async toArray() { return rows; } }; },
        };
      },
      vectorSearch() { return { limit() { return { async toArray() { return rows.map((item) => ({ ...item, _distance: 0 })); } }; } }; },
    },
  };
}

test("REM candidate loading (no-where() fallback path) still excludes an invalidated row via the shared JS filter", async () => {
  const rows = [
    row("live-1", "still-valid material"),
    row("invalid-1", "retracted material", { epistemicStatus: "invalidated" }),
  ];
  const candidates = await loadCandidateMemories(dbForNoWhere(rows), {
    weekStartMs: NOW - 1_000,
    requestContext: REQUEST_CONTEXT,
    aclPartition: WORKSPACE_PARTITION,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["live-1"]);
});

test("REM candidate loading (throwing-where() catch-fallback path) still excludes an invalidated row via the shared JS filter", async () => {
  const rows = [
    row("live-2", "still-valid material"),
    row("invalid-2", "retracted material", { epistemicStatus: "invalidated" }),
  ];
  const candidates = await loadCandidateMemories(dbForThrowingWhere(rows), {
    weekStartMs: NOW - 1_000,
    requestContext: REQUEST_CONTEXT,
    aclPartition: WORKSPACE_PARTITION,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["live-2"]);
});
