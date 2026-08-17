import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEdgesForSession, createEdge } from "../lib/memory-graph.js";
import { runConversationReactivationRecall } from "../lib/conversation-reactivation-recall.js";
import { buildRemPartition, getPreviousWeekWindow, runRemDream } from "../lib/dreaming/rem-dream.js";

const FROZEN_REM_NOW = new Date("2026-08-10T12:00:00.000Z");
import { runSkillMiner } from "../lib/jobs/skill-miner.js";
import { resolveMemoryRequestContext } from "../lib/memory-request-context.js";

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
    createdAt: getPreviousWeekWindow(FROZEN_REM_NOW).startMs + 36 * 60 * 60 * 1000,
    sourceTimestamp: getPreviousWeekWindow(FROZEN_REM_NOW).startMs + 36 * 60 * 60 * 1000,
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

const VECTOR_DIM = 384;

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    return { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

function makeVector() {
  return Array(VECTOR_DIM).fill(0.1);
}

function createRuntimeLogger() {
  const calls = [];
  const record = (level) => (...args) => calls.push([level, ...args]);
  return {
    calls,
    debug: record("debug"),
    error: record("error"),
    info: record("info"),
    warn: record("warn"),
  };
}

function createRuntimeApi(baseDbPath, runtimeLlm) {
  const commands = [];
  const logger = createRuntimeLogger();
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: true },
      merging: { enabled: true },
      skillMiner: { enabled: true, minEvidenceScore: 3 },
      dailyConsolidation: { enabled: true },
      security: { allowedUserIds: ["owner-a"] },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
    },
    logger,
    runtime: {
      llm: runtimeLlm,
      agent: {
        async resolveAgentWorkspaceDir(config) { return config?.workspaceDir || baseDbPath; },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool() {},
    registerService() {},
    on() {},
    _commands: commands,
  };
}

function runtimeCommand(workspaceDir, args) {
  return {
    args,
    agentId: "agent-a",
    channel: "telegram",
    accountId: "default",
    from: "telegram:12345",
    to: "telegram:12345",
    senderId: "owner-a",
    sessionKey: "agent:agent-a:telegram:direct:12345",
    config: { workspaceDir },
  };
}

async function seedRuntimeMemories(pluginModule, baseDbPath, workspaceDir) {
  const agentId = "agent-a";
  const requestContext = resolveMemoryRequestContext({
    agentId,
    workspaceDir,
    userId: "owner-a",
    channel: "telegram",
    accountId: "default",
  });
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  const createdAt = getPreviousWeekWindow().startMs + 36 * 60 * 60 * 1000;
  const rows = [];
  for (const scope of ["agent-private", "user", "workspace"]) {
    const ownership = scope === "agent-private"
      ? { agentId, storedBy: agentId, ownerUserId: "", workspaceId: "", workspaceKey: "" }
      : scope === "user"
        ? { agentId, storedBy: agentId, ownerUserId: requestContext.userPrincipal, workspaceId: "", workspaceKey: "" }
        : { agentId, storedBy: agentId, ownerUserId: "", workspaceId: requestContext.workspaceIdentity, workspaceKey: requestContext.workspaceIdentity };
    for (let index = 0; index < 3; index++) {
      rows.push({
        id: uuidFor(100 + rows.length),
        text: `${scope.toUpperCase()} LOCAL release procedure ${index}`,
        summary: `${scope.toUpperCase()} LOCAL release procedure ${index}`,
        vector: makeVector(),
        createdAt,
        sourceTimestamp: createdAt,
        status: "active",
        epistemicStatus: "trusted",
        category: scope === "workspace" ? "workspace_rule" : "fact",
        origin: "dm",
        scope,
        ...ownership,
      });
    }
  }
  rows.push({
    id: uuidFor(200),
    text: "WORKSPACE FOREIGN SECRET release procedure",
    summary: "WORKSPACE FOREIGN SECRET release procedure",
    vector: makeVector(),
    createdAt,
    sourceTimestamp: createdAt,
    status: "active",
    epistemicStatus: "trusted",
    category: "workspace_rule",
    origin: "dm",
    scope: "workspace",
    agentId,
    storedBy: agentId,
    workspaceId: "workspace-dir:v1:foreign-workspace",
    workspaceKey: "workspace-dir:v1:foreign-workspace",
    ownerUserId: "",
  });
  try {
    for (const row of rows) await db.store(row);
  } finally {
    await db.shutdown();
  }
  return { requestContext, rows };
}

function responseJson(result) {
  return JSON.parse(result.text);
}

function filesUnder(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  return files;
}

test("registered internal REM processes every allowed partition with isolated prompts and sinks", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "release-731-runtime-rem-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "release-731-runtime-rem-ws-"));
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  const prompts = [];
  const runtimeLlm = {
    async complete(params) {
      prompts.push({ purpose: params.purpose, content: params.messages?.map((message) => message.content).join("\n") || "" });
      return {
        text: params.purpose === "rem-pattern-analysis"
          ? JSON.stringify({ patternName: "release", description: "release only", trend: "neu", confidence: 0.9 })
          : "{}",
        provider: "runtime-test",
        model: "runtime-test",
        usage: {},
      };
    },
  };
  const pluginModule = await import(`../index.js?release-731-runtime-rem=${Date.now()}-${Math.random()}`);
  const { requestContext } = await seedRuntimeMemories(pluginModule, baseDbPath, workspaceDir);
  const api = createRuntimeApi(baseDbPath, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await api._commands.find((command) => command.name === "plur1bus").handler(
    runtimeCommand(workspaceDir, "internal rem-dream"),
  );
  const parsed = responseJson(result);
  assert.deepEqual(parsed.partitions.map((entry) => entry.scope).sort(), ["agent-private", "user", "workspace"]);
  const remPrompts = prompts.filter((entry) => entry.purpose === "rem-pattern-analysis");
  assert.equal(remPrompts.length, 3);
  for (const prompt of remPrompts) {
    const scopes = ["AGENT-PRIVATE", "USER", "WORKSPACE"].filter((scope) => prompt.content.includes(`${scope} LOCAL`));
    assert.equal(scopes.length, 1, prompt.content);
  }
  const neoFiles = filesUnder(join(baseDbPath, "_neo"));
  assert.ok(neoFiles.some((path) => path.endsWith("pattern-analysis.jsonl")));
  assert.ok(filesUnder(workspaceDir).some((path) => path.includes("dream-diary")));
  assert.ok(!filesUnder(workspaceDir).some((path) => path.includes("agent-private") || path.includes("user")));
  assert.equal(requestContext.workspaceIdentity.startsWith("workspace-dir:v1:"), true);
});

test("registered internal skill-miner processes every allowed partition without workspace leakage", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "release-731-runtime-skill-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "release-731-runtime-skill-ws-"));
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  const prompts = [];
  const runtimeLlm = {
    async complete(params) {
      prompts.push(params.messages?.map((message) => message.content).join("\n") || "");
      return {
        text: JSON.stringify({ skillName: "release-check", skillTitle: "Release check", description: "local", instructions: "check local", examples: [], confidence: 0.9, category: "workflow" }),
        provider: "runtime-test",
        model: "runtime-test",
        usage: {},
      };
    },
  };
  const pluginModule = await import(`../index.js?release-731-runtime-skill=${Date.now()}-${Math.random()}`);
  await seedRuntimeMemories(pluginModule, baseDbPath, workspaceDir);
  const api = createRuntimeApi(baseDbPath, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await api._commands.find((command) => command.name === "plur1bus").handler(
    runtimeCommand(workspaceDir, "internal skill-miner"),
  );
  const parsed = responseJson(result);
  assert.deepEqual(parsed.partitions.map((entry) => entry.scope).sort(), ["agent-private", "user", "workspace"]);
  assert.equal(parsed.partialFailure, false);
  assert.equal(parsed.scanned, 9);
  assert.equal(parsed.proposalsCreated, 3);
  assert.equal(parsed.pushMessages.length, 3);
  assert.equal(parsed.aclBindings, null);
  assert.equal(prompts.length, 3);
  for (const prompt of prompts) {
    const scopes = ["AGENT-PRIVATE", "USER", "WORKSPACE"].filter((scope) => prompt.includes(`${scope} LOCAL`));
    assert.equal(scopes.length, 1, prompt);
  }
  const proposalFiles = filesUnder(join(baseDbPath, "_neo")).filter((path) => path.endsWith("skill-proposals.jsonl"));
  assert.equal(proposalFiles.length, 2);
  assert.equal(filesUnder(workspaceDir).filter((path) => path.endsWith("skill-proposals.jsonl")).length, 1);
});

test("registered internal daily compaction invokes the partition-aware API per allowed partition", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "release-731-runtime-daily-db-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "release-731-runtime-daily-ws-"));
  t.after(() => {
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
  const runtimeLlm = {
    async complete() {
      return { text: JSON.stringify({ decision: "keep", reason: "runtime test" }), provider: "runtime-test", model: "runtime-test", usage: {} };
    },
  };
  const pluginModule = await import(`../index.js?release-731-runtime-daily=${Date.now()}-${Math.random()}`);
  await seedRuntimeMemories(pluginModule, baseDbPath, workspaceDir);
  const api = createRuntimeApi(baseDbPath, runtimeLlm);
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const result = await api._commands.find((command) => command.name === "plur1bus").handler(
    runtimeCommand(workspaceDir, "internal consolidate-daily"),
  );
  const parsed = responseJson(result);
  assert.deepEqual(parsed.partitionResults.map((entry) => entry.scope).sort(), ["agent-private", "user", "workspace"]);
  assert.equal(parsed.partitionResults.length, 3);
  for (const partitionRun of parsed.partitionResults) {
    assert.equal(partitionRun.result.compaction.partitionResults.length, 1);
    assert.equal(partitionRun.result.compaction.partitionResults[0].aclPartition.scope, partitionRun.scope);
    assert.equal(partitionRun.result.compaction.partitionResults[0].aclPartition.agentId, "agent-a");
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
      now: FROZEN_REM_NOW,
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
