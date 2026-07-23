import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSparseNeighborGraph, loadCandidateMemories, runRemDream, writeRemDreamToVault } from "../lib/dreaming/rem-dream.js";
import { appendDreamEcho, loadFreshDreamEcho } from "../lib/dream-echo.js";

const NOW = Date.now();
const REQUEST_CONTEXT = Object.freeze({
  agentId: "agent-a",
  workspaceIdentity: "workspace:v1:workspace-a",
  userPrincipal: "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
});

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
  });

  assert.deepEqual(candidates.map((candidate) => candidate.id), ["a1"]);
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

  await runRemDream({
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
    embeddings: { embed: async () => [1, 0] },
    narrativeCfg: { enabled: true },
    force: true,
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].scope, "user");
  assert.equal(stored[0].ownerUserId, REQUEST_CONTEXT.userPrincipal);
  assert.equal(stored[0].workspaceKey, "");
  assert.equal(stored[0].agentId, "agent-a");
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

test("REM vault output retains the ownership binding for protected evidence", (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-rem-vault-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const aclBindings = { scope: "user", agentId: "agent-a", workspaceIdentity: "", ownerUserId: REQUEST_CONTEXT.userPrincipal };
  const output = writeRemDreamToVault({ weekOf: "2026-W01", patternsFound: 1, new: 1, stronger: 0, weaker: 0, disappeared: 0 }, [{
    patternName: "Owner pattern", trend: "neu", evidenceQuotes: ["owner-only evidence"], aclBindings,
  }], workspaceDir);

  const markdown = readFileSync(output.path, "utf8");
  assert.match(markdown, new RegExp(`owner_user_id: ${REQUEST_CONTEXT.userPrincipal}`));
  assert.match(markdown, /scope: user/);
});
