import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEdgesForSession, createEdge } from "../lib/memory-graph.js";
import { runConversationReactivationRecall } from "../lib/conversation-reactivation-recall.js";
import { buildRemPartition, runRemDream } from "../lib/dreaming/rem-dream.js";
import { runSkillMiner } from "../lib/jobs/skill-miner.js";

const EMPTY_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });
const USER_A = "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USER_B = "user:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REQUEST_CONTEXT = Object.freeze({
  agentId: "agent-a",
  workspaceIdentity: "workspace:v1:workspace-a",
  userPrincipal: USER_A,
  workspaceAliases: EMPTY_ALIASES,
});

function uuidFor(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function workspaceRow(id, text, overrides = {}) {
  return {
    id,
    text,
    summary: text,
    vector: [1, 0],
    createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    sourceTimestamp: Date.now() - 10 * 24 * 60 * 60 * 1000,
    status: "active",
    epistemicStatus: "trusted",
    scope: "workspace",
    agentId: "agent-a",
    storedBy: "agent-a",
    workspaceId: REQUEST_CONTEXT.workspaceIdentity,
    workspaceKey: REQUEST_CONTEXT.workspaceIdentity,
    ownerUserId: "",
    category: "workspace_rule",
    retrievalCount: 3,
    ...overrides,
  };
}

function makeTable(rows) {
  const fields = [
    "id", "text", "summary", "vector", "createdAt", "sourceTimestamp", "status", "epistemicStatus",
    "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId", "category", "retrievalCount",
    "memoryClass", "expiresAt", "topics", "entities", "emotionalDominant", "emotionalIntensity",
  ];
  return {
    async schema() {
      return { fields: fields.map((name) => ({ name })) };
    },
    query() {
      let offset = 0;
      let limit = rows.length;
      return {
        where() { return this; },
        offset(value) { offset = value; return this; },
        limit(value) { limit = value; return this; },
        async toArray() { return rows.slice(offset, offset + limit); },
      };
    },
    vectorSearch() {
      return {
        limit() {
          return { async toArray() { return rows.map((row) => ({ ...row, _distance: 0 })); } };
        },
      };
    },
  };
}

test("release call sites thread the canonical context and never use an unbound output path", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /partitionSink: remSink/);
  assert.match(source, /writeRemDreamToVault\(partitionResult\.report, partitionResult\.trends, remSink\.outputTarget\)/);
  assert.doesNotMatch(source, /writeRemDreamToVault\(partitionResult\.report, partitionResult\.trends, commandCtx\.workspaceDir\)/);
  assert.match(source, /for \(const skillAclPartition of buildRemPartitions\(memoryCtx\)\)/);
  assert.match(source, /requestContext: memoryCtx,\n\s+aclPartition: skillAclPartition/);
  assert.match(source, /\{ requestContext: memoryCtx \}/);
  assert.match(source, /requestContext: memoryCtx,\n\s+getMemoryById: async/);
  assert.match(source, /const memory = await db\.getById\(memoryId\);\n\s+if \(!memory \|\| !checkAccess\(memoryCtx, memory\)\.allowed\) return null;/);
  for (const field of ["scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId"]) {
    assert.match(source, new RegExp(`\\"${field}\\"`), `graph projection must include ${field}`);
  }
});

test("REM provider callback receives only the exact workspace partition", async () => {
  const localRows = [1, 2, 3].map((n) => workspaceRow(uuidFor(n), `LOCAL protected release procedure ${n}`));
  const foreignRows = [4, 5, 6].map((n) => workspaceRow(uuidFor(n), `FOREIGN SECRET release procedure ${n}`, {
    workspaceId: "workspace:v1:workspace-b",
    workspaceKey: "workspace:v1:workspace-b",
  }));
  const rows = [...localRows, ...foreignRows];
  const table = makeTable(rows);
  const partition = buildRemPartition({
    scope: "workspace",
    agentId: REQUEST_CONTEXT.agentId,
    workspaceIdentity: REQUEST_CONTEXT.workspaceIdentity,
    ownerUserId: "",
  }, REQUEST_CONTEXT);
  const seen = [];
  const neoStore = {
    aclBindings: partition,
    paths: { workspaceDir: mkdtempSync(join(tmpdir(), "release-731-rem-store-")) },
    hasCompletedRun: () => false,
    readPatterns: () => [],
    appendPatterns: () => {},
    markRunCompleted: () => {},
  };
  try {
    const result = await runRemDream({
      db: { table },
      patternLlmCfg: {},
      callLlm: async (messages) => {
        seen.push(messages.map((message) => message.content).join("\n"));
        return JSON.stringify({ patternName: "local", description: "local only", trend: "neu", confidence: 0.9 });
      },
      neoStore,
      partitionSink: {
        aclBindings: partition,
        neoStore,
        outputTarget: { aclBindings: partition, kind: "workspace" },
      },
      workspaceKey: partition.workspaceIdentity,
      agentId: REQUEST_CONTEXT.agentId,
      requestContext: REQUEST_CONTEXT,
      aclPartition: partition,
      force: true,
    });
    assert.ok(result.report);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((content) => content.includes("LOCAL")));
    assert.ok(seen.every((content) => !content.includes("FOREIGN SECRET")));
  } finally {
    rmSync(neoStore.paths.workspaceDir, { recursive: true, force: true });
  }
});

test("skill-miner callback receives one authorized partition, not foreign evidence", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "release-731-skill-callsite-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const rows = [
    workspaceRow(uuidFor(11), "LOCAL release deployment procedure verification", { category: "workspace_rule" }),
    workspaceRow(uuidFor(12), "LOCAL release deployment procedure verification", { category: "workspace_rule" }),
    workspaceRow(uuidFor(13), "FOREIGN SECRET release deployment procedure verification", {
      workspaceId: "workspace:v1:workspace-b",
      workspaceKey: "workspace:v1:workspace-b",
    }),
  ];
  const partition = buildRemPartition({
    scope: "workspace",
    agentId: REQUEST_CONTEXT.agentId,
    workspaceIdentity: REQUEST_CONTEXT.workspaceIdentity,
    ownerUserId: "",
  }, REQUEST_CONTEXT);
  const prompts = [];
  const result = await runSkillMiner({ init: async () => {}, table: makeTable(rows) }, REQUEST_CONTEXT.agentId, {
    requestContext: REQUEST_CONTEXT,
    aclPartition: partition,
    workspaceDir,
    workspaceKey: partition.workspaceIdentity,
    llmCfg: { model: "test" },
    callLlm: async (messages) => {
      prompts.push(messages[0].content);
      return JSON.stringify({
        skillName: "local-release",
        skillTitle: "Local release",
        description: "Local only",
        instructions: "Use local evidence.",
        examples: [],
        confidence: 0.9,
        category: "workflow",
      });
    },
    dryRun: true,
  });
  assert.equal(result.proposalsCreated, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /LOCAL/);
  assert.doesNotMatch(prompts[0], /FOREIGN SECRET/);
});

test("CRR rejects foreign and legacy graph content before hydration/rendering", async () => {
  const foreignId = uuidFor(21);
  const hydratedForeignId = uuidFor(23);
  const baseId = uuidFor(22);
  const ownership = {
    schemaVersion: 1,
    scope: "workspace",
    agentId: REQUEST_CONTEXT.agentId,
    workspaceIdentity: REQUEST_CONTEXT.workspaceIdentity,
    ownerUserId: "",
  };
  const hydrated = [];
  const result = await runConversationReactivationRecall({
    prompt: "continue release deployment procedure",
    messageText: "continue release deployment procedure",
    baseRecallIds: new Set([baseId]),
    baseRecallTopScore: 0,
    workspaceDir: "",
    graphEdges: [
      { source: baseId, target: foreignId, type: "semantic", strength: 0.9 },
      createEdge(baseId, hydratedForeignId, "semantic", 0.9, false, {
        sourceOwnership: ownership,
        targetOwnership: ownership,
      }),
    ],
    requestContext: REQUEST_CONTEXT,
    cfg: { enabled: true, cooldownMinutes: 0, maxReactivationMemories: 3 },
    agentId: REQUEST_CONTEXT.agentId,
    sessionKey: "release-731-crr",
    now: Date.now(),
    getMemoryById: async (id) => {
      hydrated.push(id);
      return {
        id,
        text: "FOREIGN SECRET release procedure",
        status: "active",
        scope: "user",
        agentId: REQUEST_CONTEXT.agentId,
        ownerUserId: USER_B,
      };
    },
    logger: { warn() {}, debug() {} },
  });
  assert.equal(result.context, "");
  assert.deepEqual(hydrated, [hydratedForeignId]);
});

test("graph build does not create a bound edge for foreign or unowned ANN rows", async () => {
  const local = workspaceRow(uuidFor(31), "local graph memory", { topics: ["Release", "Procedure"] });
  const foreign = workspaceRow(uuidFor(32), "FOREIGN SECRET graph memory", {
    workspaceId: "workspace:v1:workspace-b",
    workspaceKey: "workspace:v1:workspace-b",
    topics: ["Release", "Procedure"],
  });
  const unowned = workspaceRow(uuidFor(33), "UNOWNED graph memory", {
    scope: undefined,
    agentId: undefined,
    storedBy: undefined,
    workspaceId: undefined,
    workspaceKey: undefined,
    topics: ["Release", "Procedure"],
  });
  const edges = await buildEdgesForSession(
    [local],
    [local, foreign, unowned],
    makeTable([foreign, unowned]),
    null,
    { requestContext: REQUEST_CONTEXT },
  );
  assert.equal(edges.length, 0);
});
