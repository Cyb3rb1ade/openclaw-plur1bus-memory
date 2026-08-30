import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";
import { lightDream } from "../lib/dreaming/light-dream.js";
import { buildRemPartition, runRemDream } from "../lib/dreaming/rem-dream.js";
import { extractEpisodesFromTurns } from "../lib/episodes.js";
import { resolveMemoryRequestContext, userPoolKey, workspacePoolKey } from "../lib/memory-request-context.js";
import { storeSharedMemory } from "../lib/shared-memory.js";

const repoSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
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

async function loadFreshPlugin() {
  return import(`../index.js?generic-llm-callers=${Date.now()}-${Math.random()}`);
}

function createApi(baseDbPath, configOverrides, runtimeLlm) {
  const commands = [];
  const toolFactories = [];
  const hooks = new Map();
  const services = [];
  const logs = [];
  const sessionEntries = new Map();
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
      ...configOverrides,
    },
    logger: {
      debug(...args) { logs.push(["debug", ...args]); },
      error(...args) { logs.push(["error", ...args]); },
      info(...args) { logs.push(["info", ...args]); },
      warn(...args) { logs.push(["warn", ...args]); },
    },
    runtime: {
      ...(runtimeLlm ? { llm: runtimeLlm } : {}),
      agent: {
        async resolveAgentWorkspaceDir() { return baseDbPath; },
        session: {
          async getSessionEntry({ sessionKey }) { return sessionEntries.get(sessionKey) || null; },
        },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool(factory) { toolFactories.push(factory); },
    registerService(service) { services.push(service); },
    on(name, handler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
    },
    _commands: commands,
    _toolFactories: toolFactories,
    _logs: logs,
    _setSessionEntry(sessionKey, entry) { sessionEntries.set(sessionKey, entry); },
    async _emit(name, event, ctx) {
      return Promise.all((hooks.get(name) || []).map((handler) => handler(event, ctx)));
    },
    async _shutdown() {
      await Promise.all((hooks.get("gateway_stop") || []).map((handler) => handler({}, {})));
      await Promise.all(services.map((service) => service?.stop?.()));
    },
  };
}

function officialCommandContext({ agentId, args, runtimeContext, senderId = "owner", chatId = "chat-a" }) {
  return {
    args,
    agentId,
    senderId,
    channel: "telegram",
    accountId: "default",
    sessionKey: `agent:${agentId}:main`,
    from: `telegram:${chatId}`,
    to: `telegram:${chatId}`,
    config: {},
    getCurrentConversationBinding: () => null,
    ...(runtimeContext ? { runtimeContext } : {}),
  };
}

async function observeOfficialTurn(api, { agentId, workspaceDir, runId, prompt, senderId = "42", chatId = "chat-a" }) {
  const sessionKey = `agent:${agentId}:main`;
  const sessionId = `session-${runId}`;
  const target = `telegram:${chatId}`;
  api._setSessionEntry(sessionKey, {
    sessionId,
    deliveryContext: { channel: "telegram", accountId: "default", to: target },
    origin: { provider: "telegram", accountId: "default", to: target },
    lastChannel: "telegram",
    lastAccountId: "default",
    lastTo: target,
  });
  await api._emit("reply_dispatch", {
    runId,
    sessionKey,
    originatingChannel: "telegram",
    originatingTo: target,
    originatingAccountId: "default",
    ctx: {
      AgentId: agentId,
      SessionKey: sessionKey,
      AccountId: "default",
      SenderId: senderId,
      Provider: "telegram",
      OriginatingChannel: "telegram",
      ChatId: chatId,
      OriginatingTo: target,
      CommandBody: prompt,
    },
  }, {});
  return {
    event: {
      runId,
      sessionKey,
      sessionId,
      prompt,
      messages: [{ role: "user", content: prompt }],
    },
    ctx: {
      runId,
      agentId,
      sessionKey,
      sessionId,
      workspaceDir,
      messageProvider: "telegram",
      senderId,
      chatId,
      channelContext: { sender: { id: senderId }, chat: { id: chatId } },
    },
  };
}

test("generic chat callers declare owner-specific OpenClaw routes", () => {
  const source = repoSource("index.js");
  const routeOwners = [
    ["captureSummaryLlmCfg", "capture-summary"],
    ["recallQueryLlmCfg", "recall-query-summary"],
    ["memoryCompactionLlmCfg", "memory-compaction"],
    ["conflictResolutionLlmCfg", "conflict-resolution"],
    ["remPatternLlmCfg", "rem-pattern-analysis"],
    ["conversationInsightsLlmCfg", "conversation-insights"],
    ["dreamNarrativeLlmCfg", "dream-narrative"],
    ["dreamEchoLlmCfg", "dream-echo"],
    ["episodeExtractionLlmCfg", "episode-extraction"],
    ["afterthoughtLlmCfg", "afterthought"],
    ["personaVoiceLlmCfg", "persona-voice"],
    ["wikiLlmCfg", "wiki"],
    ["overlayLlmCfg", "continuity-overlay"],
    ["overlayAuditLlmCfg", "overlay-audit-contradiction"],
    ["memoryTextContradictionLlmCfg", "memory-text-contradiction"],
  ];

  for (const [variable, feature] of routeOwners) {
    assert.match(
      source,
      new RegExp(`const\\s+${variable}\\s*=[\\s\\S]{0,100}?createFeatureRoute\\(\\"${feature}\\"`),
      `${feature} must have its own route descriptor`,
    );
  }
});

test("generic chat caller inventory contains no cross-feature route fallback", () => {
  const sources = [
    "index.js",
    "lib/jobs/daily-consolidation.js",
    "lib/jobs/memory-compaction.js",
    "lib/jobs/conflict-resolver.js",
    "lib/jobs/skill-miner/llm-extractor.js",
    "lib/dreaming/light-dream.js",
    "lib/dreaming/rem-dream.js",
    "lib/dreaming/dream-narrative.js",
    "lib/dream-echo.js",
    "lib/overlay-commands.js",
    "lib/episodes.js",
  ].map((path) => `${path}\n${repoSource(path)}`).join("\n");

  for (const forbidden of [
    /skillMinerLlmCfg\s*\|\|\s*mergingLlmCfg/,
    /llmCfg:\s*mergingLlmCfg/,
    /mergingLlmCfg\?\.model/,
    /\bapi\.llm\b/,
  ]) {
    assert.doesNotMatch(sources, forbidden);
  }
});

test("the router seam prefers the call-local scheduler signal", () => {
  const source = repoSource("index.js");
  assert.match(
    source,
    /signal:\s*llmCfg\?\.callContext\?\.signal\s*\?\?\s*llmCfg\?\.signal/,
  );
});

test("long /memory query uses its session runtime and recall-query owner route", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-owner-query-"));
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector();
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
  });

  const globalCalls = [];
  const sessionCalls = [];
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, {
    merging: { enabled: true, model: "blocked/merging-model" },
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      globalCalls.push(params);
      return { text: "global summary that should not be used", provider: "global", model: "global", usage: {} };
    },
  });
  t.after(() => api._shutdown());
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  const memoryCommand = api._commands.find((command) => command.name === "memory");
  assert.ok(memoryCommand);
  const sessionRuntime = {
    async complete(params) {
      sessionCalls.push(params);
      return { text: "A compact searchable summary for the requested topic.", provider: "session", model: "session", usage: {} };
    },
  };

  const response = await memoryCommand.handler(officialCommandContext({
    args: "search topic. ".repeat(600),
    agentId: "query-session-agent",
    runtimeContext: { llm: sessionRuntime },
  }));

  assert.equal(globalCalls.length, 0);
  assert.equal(sessionCalls.length, 1, JSON.stringify(response));
  assert.equal(sessionCalls[0].purpose, "recall-query-summary");
  assert.equal(Object.hasOwn(sessionCalls[0], "agentId"), false);
  assert.equal(Object.hasOwn(sessionCalls[0], "model"), false);

  const memoryAlias = api._commands.find((command) => command.name === "plur1bus_memory");
  assert.ok(memoryAlias);
  await memoryAlias.handler(officialCommandContext({
    args: "alias search topic. ".repeat(400),
    agentId: "query-session-agent",
    runtimeContext: { llm: sessionRuntime },
  }));
  assert.equal(sessionCalls.length, 2);
  assert.equal(sessionCalls[1].purpose, "recall-query-summary");
  assert.equal(Object.hasOwn(sessionCalls[1], "agentId"), false);

  const tooLarge = await memoryCommand.handler(officialCommandContext({
    args: "x".repeat(100_001),
    agentId: "query-session-agent",
    runtimeContext: { llm: { async complete() { throw new Error("must not run"); } } },
  }));
  assert.match(tooLarge.text, /100.?000/);
  const aliasTooLarge = await memoryAlias.handler(officialCommandContext({
    args: "x".repeat(100_001),
    agentId: "query-session-agent",
    runtimeContext: { llm: sessionRuntime },
  }));
  assert.match(aliasTooLarge.text, /100.?000/);
  assert.equal(sessionCalls.length, 2);
});

test("exact-limit punctuation-free /memory input stays usable with merging disabled", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-bounded-query-fallback-"));
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
  LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => makeVector();
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
  });
  const runtimeCalls = [];
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, {
    merging: { enabled: false },
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      runtimeCalls.push(params);
      throw new Error("must not run");
    },
  });
  t.after(() => api._shutdown());
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  const memoryCommand = api._commands.find((command) => command.name === "memory");
  assert.ok(memoryCommand);

  const response = await memoryCommand.handler(officialCommandContext({
    args: "x".repeat(100_000),
    agentId: "bounded-query-agent",
  }));

  assert.equal(runtimeCalls.length, 0);
  assert.doesNotMatch(response.text, /100.?000|maximum length|too large/i);
  assert.match(response.text, /Nothing found|Nichts gefunden/i);
});

test("light dreaming fans out to four distinct owner descriptors", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-light-routes-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const features = [];
  const callLlm = async (_messages, cfg) => {
    features.push(cfg.feature);
    if (cfg.feature === "conversation-insights") return JSON.stringify(["A durable insight about the current project."]);
    if (cfg.feature === "dream-narrative") return "A long dream narrative moves through a quiet library and returns with one clear decision.";
    if (cfg.feature === "dream-echo") return JSON.stringify({ sentence: "Mir ging die Entscheidung noch einmal durch den Kopf.", topics: ["decision"] });
    if (cfg.feature === "persona-voice") return "- kurze Sätze\n- freundlich direkt\n- Emoji-Palette: 🌿 ✨\n- ruhige Anrede\n- kleine Marotte";
    throw new Error(`unexpected feature: ${cfg.feature}`);
  };
  const owner = (feature) => ({ feature, callContext: { agentId: "light-agent", purpose: feature } });

  await lightDream({
    turns: [
      { agentId: "light-agent", role: "user", content: "We should keep the project decision for tomorrow." },
      { agentId: "light-agent", role: "assistant", content: "I will preserve the decision and its rationale." },
      { agentId: "light-agent", role: "user", content: "Good, that will make the next step easier." },
    ],
    neoStore: { appendDreams() {}, appendBehaviorCards() {}, readReactions() { return []; } },
    db: { async search() { return []; } },
    embeddings: { async embed() { return [0.1, 0.2]; } },
    insightLlmCfg: owner("conversation-insights"),
    narrativeLlmCfg: owner("dream-narrative"),
    echoLlmCfg: owner("dream-echo"),
    personaLlmCfg: owner("persona-voice"),
    callLlm,
    narrativeCfg: { enabled: true, storeAsMemory: false },
    workspaceDir,
    personaSeedCfg: { agentId: "light-agent", lang: "en" },
  });

  assert.deepEqual(features, [
    "conversation-insights",
    "dream-narrative",
    "dream-echo",
    "persona-voice",
  ]);
});

test("REM dreaming fans out to distinct pattern, narrative, and echo descriptors", async (t) => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-rem-routes-"));
  t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
  const now = Date.now();
  const rows = ["a", "b", "c"].map((id) => ({
    id,
    text: `Shared project pattern ${id}`,
    vector: [1, 0],
    createdAt: now,
    sourceTimestamp: now,
    status: "active",
    scope: "workspace",
    workspaceKey: "workspace:v1:rem-workspace",
    agentId: "rem-agent",
  }));
  const features = [];
  const callLlm = async (_messages, cfg) => {
    features.push(cfg.feature);
    if (cfg.feature === "rem-pattern-analysis") return JSON.stringify({ patternName: "Shared project", description: "A repeated project pattern.", trend: "neu", confidence: 0.9 });
    if (cfg.feature === "dream-narrative") return "A weekly dream narrative crosses three connected project memories and finds a shared direction.";
    if (cfg.feature === "dream-echo") return JSON.stringify({ sentence: "Die gemeinsame Richtung blieb mir im Kopf.", topics: ["project"] });
    throw new Error(`unexpected feature: ${cfg.feature}`);
  };
  const owner = (feature) => ({ feature, callContext: { agentId: "rem-agent", purpose: feature } });
  const table = {
    schema: async () => ({ fields: [
      { name: "id" }, { name: "text" }, { name: "scope" }, { name: "workspaceKey" },
      { name: "agentId" }, { name: "createdAt" }, { name: "sourceTimestamp" },
      { name: "status" }, { name: "memoryClass" },
    ] }),
    query() {
      let offset = 0;
      let limit = rows.length;
      const builder = {
        where() { return builder; },
        offset(value) { offset = value; return builder; },
        limit(value) { limit = value; return builder; },
        async toArray() { return rows.slice(offset, offset + limit); },
      };
      return builder;
    },
    vectorSearch() { return { limit() { return { async toArray() { return rows.map((row) => ({ ...row, _distance: 0 })); } }; } }; },
  };

  const remPartition = buildRemPartition({
    scope: "workspace",
    agentId: "rem-agent",
    workspaceIdentity: "workspace:v1:rem-workspace",
    ownerUserId: "",
  }, {
    agentId: "rem-agent",
    workspaceIdentity: "workspace:v1:rem-workspace",
    workspaceAliases: { paths: [], aliases: [] },
  });
  const boundWorkspaceTarget = {
    aclBindings: remPartition,
    kind: "workspace",
    workspaceDir,
  };
  await runRemDream({
    db: { table },
    patternLlmCfg: owner("rem-pattern-analysis"),
    narrativeLlmCfg: owner("dream-narrative"),
    echoLlmCfg: owner("dream-echo"),
    callLlm,
    neoStore: {
      hasCompletedRun() { return false; },
      readPatterns() { return []; },
      appendPatterns() {},
      markRunCompleted() {},
      aclBindings: remPartition,
    },
    partitionSink: {
      aclBindings: remPartition,
      neoStore: {
        hasCompletedRun() { return false; },
        readPatterns() { return []; },
        appendPatterns() {},
        markRunCompleted() {},
        aclBindings: remPartition,
      },
      memoryStore: { aclBindings: remPartition, store() {} },
      inputTarget: boundWorkspaceTarget,
      outputTarget: boundWorkspaceTarget,
    },
    workspaceKey: "rem-workspace",
    agentId: "rem-agent",
    requestContext: {
      agentId: "rem-agent",
      workspaceIdentity: "workspace:v1:rem-workspace",
      workspaceAliases: { paths: [], aliases: [] },
    },
    aclPartition: remPartition,
    force: true,
    narrativeCfg: { enabled: true, storeAsMemory: false },
    workspaceDir,
  });

  assert.deepEqual(features, ["rem-pattern-analysis", "dream-narrative", "dream-echo"]);
});

test("episode enrichment receives only the episode owner descriptor", async () => {
  const calls = [];
  const createdAt = new Date().toISOString();
  const turns = Array.from({ length: 5 }, (_, index) => ({
    id: `turn-${index}`,
    agentId: "episode-agent",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Episode turn ${index} contains enough narrative detail for extraction.`,
    createdAt,
  }));

  await extractEpisodesFromTurns(turns, {
    agentId: "episode-agent",
    llmCfg: {
      feature: "episode-extraction",
      callContext: { agentId: "episode-agent", purpose: "episode-extraction" },
    },
    callLlm: async (_messages, cfg) => {
      calls.push(cfg);
      return JSON.stringify({ title: "A focused episode", narrativeArc: "decision", turningPoint: "turn 3", summary: "A decision was reached." });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].feature, "episode-extraction");
  assert.equal(calls[0].callContext.agentId, "episode-agent");
  assert.equal(calls[0].resultCacheContext.purpose, "episode-analysis");
});

test("tool and auto-recall query summaries carry global agent and scheduler context", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-global-query-routes-"));
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector();
  LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => makeVector();
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
  });

  const runtimeCalls = [];
  const pluginModule = await loadFreshPlugin();
  const api = createApi(baseDbPath, {
    merging: { enabled: true, model: "blocked/merging-model" },
    autoRecall: true,
    runtime: { recallTimeoutMs: 5_000 },
    continuityEngine: { enabled: false },
    emotion: { t3: { enabled: false } },
  }, {
    async complete(params) {
      runtimeCalls.push(params);
      return { text: "A compact searchable summary for global recall.", provider: "native", model: "primary", usage: {} };
    },
  });
  t.after(() => api._shutdown());
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const toolContext = {
    agentId: "tool-query-agent",
    workspaceDir: baseDbPath,
    workspaceKey: "tool-query-workspace",
  };
  const tools = api._toolFactories.flatMap((factory) => factory(toolContext) || []);
  const recallTool = tools.find((tool) => tool.name === "memory_recall");
  assert.ok(recallTool);
  await recallTool.execute("tool-call", { query: "tool recall topic. ".repeat(1_400), limit: 2 });

  const autoAgent = "auto-query-agent";
  const autoPrompt = "auto recall topic. ".repeat(1_400);
  const autoTurn = await observeOfficialTurn(api, {
    agentId: autoAgent,
    workspaceDir: baseDbPath,
    runId: "run-auto-query",
    prompt: autoPrompt,
  });
  await api._emit("before_prompt_build", autoTurn.event, autoTurn.ctx);

  const summaryCalls = runtimeCalls.filter((call) => call.purpose === "recall-query-summary");
  assert.equal(summaryCalls.length, 2);
  // The host resolves the agent itself; plugins must not send one.
  assert.equal(Object.hasOwn(summaryCalls[0], "agentId"), false);
  assert.equal(Object.hasOwn(summaryCalls[1], "agentId"), false);
  assert.equal(summaryCalls[1].signal instanceof AbortSignal, true);
  assert.equal(Object.hasOwn(summaryCalls[0], "model"), false);
  assert.equal(Object.hasOwn(summaryCalls[1], "model"), false);
});

test("verified auto-recall tickets and /memory compose authorized shared pools", async (t) => {
  // Shared pool reads route through fd-backed directory capabilities; platforms
  // without a stat-verifiable fd alias (e.g. darwin, see lib/directory-capability.js)
  // fail closed and disable shared reads, so the composed pools stay empty there.
  if (!stableDirectoryCapabilitiesSupported()) {
    t.skip("stable directory capabilities are unavailable on this platform; shared pool reads are disabled");
    return;
  }
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-shared-runtime-recall-"));
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
  const embeddingCalls = [];
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async function embedPassage(text, ctx) {
    embeddingCalls.push(["passage", text, ctx]);
    return makeVector();
  };
  LocalTransformersEmbeddingProvider.prototype.embedQuery = async function embedQuery(text, ctx) {
    embeddingCalls.push(["query", text, ctx]);
    return makeVector();
  };
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
  });

  const pluginModule = await loadFreshPlugin();
  const agentId = "shared-runtime-agent";
  const memoryCtx = resolveMemoryRequestContext({
    agentId,
    workspaceDir: baseDbPath,
    channel: "telegram",
    accountId: "default",
    userId: "42",
    chatId: "chat-a",
  });
  const workspaceDb = new pluginModule.MemoryDB(
    join(baseDbPath, ".plur1bus-shared", "workspaces", workspacePoolKey(memoryCtx.workspaceIdentity)),
    VECTOR_DIM,
  );
  const userDb = new pluginModule.MemoryDB(
    join(baseDbPath, ".plur1bus-shared", "users", userPoolKey(memoryCtx.userPrincipal)),
    VECTOR_DIM,
  );
  await workspaceDb.init();
  await userDb.init();
  await storeSharedMemory(
    workspaceDb,
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      text: "Workspace shared runtime topic",
      summary: "Workspace shared runtime topic",
      category: "fact",
      agentId: "source-agent",
      storedBy: "source-agent",
      createdAt: Date.now(),
      expiresAt: 0,
    },
    memoryCtx,
    { targetScope: "workspace", vector: makeVector(), sourceAgentId: "source-agent" },
  );
  await storeSharedMemory(
    userDb,
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      text: "Owner shared runtime topic",
      summary: "Owner shared runtime topic",
      category: "fact",
      agentId: "source-agent",
      storedBy: "source-agent",
      createdAt: Date.now(),
      expiresAt: 0,
    },
    memoryCtx,
    { targetScope: "user", vector: makeVector(), sourceAgentId: "source-agent" },
  );
  await workspaceDb.shutdown();
  await userDb.shutdown();

  const api = createApi(baseDbPath, {
    autoRecall: true,
    merging: { enabled: false },
    runtime: { recallTimeoutMs: 5_000 },
    recall: { maxPromptMemories: 5, dedup: false, canonicalFirst: false },
    continuityEngine: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    emotion: { t3: { enabled: false } },
  });
  t.after(() => api._shutdown());
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const verified = await observeOfficialTurn(api, {
    agentId,
    workspaceDir: baseDbPath,
    runId: "run-shared-verified",
    prompt: "shared runtime topic",
    senderId: "42",
    chatId: "chat-a",
  });
  const verifiedResults = await api._emit("before_prompt_build", verified.event, verified.ctx);
  const verifiedText = verifiedResults.map((result) => result?.prependContext || "").join("\n");
  assert.match(verifiedText, /Workspace shared runtime topic/);
  assert.match(verifiedText, /Owner shared runtime topic/);

  const unverifiedResults = await api._emit(
    "before_prompt_build",
    { ...verified.event, runId: "run-shared-unverified", prompt: "shared runtime topic without ticket" },
    { ...verified.ctx, runId: "run-shared-unverified" },
  );
  const unverifiedText = unverifiedResults.map((result) => result?.prependContext || "").join("\n");
  assert.match(unverifiedText, /Workspace shared runtime topic/);
  assert.doesNotMatch(unverifiedText, /Owner shared runtime topic/);

  const memoryCommand = api._commands.find((command) => command.name === "memory");
  const rendered = await memoryCommand.handler(officialCommandContext({
    args: "shared runtime topic",
    agentId,
    senderId: "42",
    chatId: "chat-a",
  }));
  assert.match(rendered.text, /Workspace shared runtime topic/);
  assert.match(rendered.text, /Owner shared runtime topic/);
  assert.doesNotMatch(rendered.text, /\(untitled\)/);
  assert.doesNotMatch(rendered.text, /\? \/ \?/);
  assert.ok(embeddingCalls.some(([purpose, _text, ctx]) => purpose === "query" && ctx?.agentId === agentId));
  assert.equal(embeddingCalls.some(([_purpose, _text, ctx]) => (
    ctx && ["model", "apiKey", "baseUrl", "headers"].some((key) => Object.hasOwn(ctx, key))
  )), false);
});

test("/correct bounds an oversized canonical replacement before candidate lookup", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-correction-limit-"));
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const pluginModule = await loadFreshPlugin();
  let runtimeCalls = 0;
  const api = createApi(baseDbPath, {
    merging: { enabled: true },
    security: { allowedUserIds: ["owner"] },
    emotion: { t3: { enabled: false } },
  }, {
    async complete() {
      runtimeCalls += 1;
      return { text: "z".repeat(4_001), provider: "native", model: "primary", usage: {} };
    },
  });
  t.after(() => api._shutdown());
  pluginModule.default.register(api, { importRouting: async () => routingCapability });
  const speakerCommand = api._commands.find((command) => command.name === "speaker");
  const genericTooLarge = await speakerCommand.handler({ args: "x".repeat(4_001) });
  assert.match(genericTooLarge.text, /maximum length of 4000/i);
  const correctCommand = api._commands.find((command) => command.name === "correct");
  const longCorrectionArgs = `${"old correction target. ".repeat(350)} -> ${"new replacement detail. ".repeat(350)}`;
  const denied = await correctCommand.handler(officialCommandContext({
    args: longCorrectionArgs,
    agentId: "correction-agent",
    senderId: "intruder",
    chatId: "private-chat",
    runtimeContext: { llm: api.runtime.llm },
  }));
  assert.match(denied.text, /allowed|unauthorized/i);
  assert.equal(runtimeCalls, 0);
  const response = await correctCommand.handler(officialCommandContext({
    args: longCorrectionArgs,
    agentId: "correction-agent",
    senderId: "owner",
    chatId: "private-chat",
    runtimeContext: { llm: api.runtime.llm },
  }));

  assert.equal(runtimeCalls, 2);
  assert.doesNotMatch(response.text, /correction text exceeds maximum length of 4000/i);
  assert.match(response.text, /Nothing found|Nichts gefunden/i);
  assert.doesNotMatch(response.text, /confirm/i);
});

test("capture scheduler abort reaches summary and Emotion without late durable writes", async (t) => {
  for (const scenario of ["capture-summary", "emotion-classification"]) {
    const baseDbPath = mkdtempSync(join(tmpdir(), `plur1bus-capture-abort-${scenario}-`));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedBatch = LocalTransformersEmbeddingProvider.prototype.embedBatch;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector();
    LocalTransformersEmbeddingProvider.prototype.embedBatch = async (texts) => texts.map(() => makeVector());
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
      LocalTransformersEmbeddingProvider.prototype.embedBatch = originalEmbedBatch;
    });

    const pluginModule = await loadFreshPlugin();
    const captureAgentId = `${scenario}-agent`;
    const warmDb = new pluginModule.MemoryDB(join(baseDbPath, captureAgentId), VECTOR_DIM);
    await warmDb.init();
    await warmDb.shutdown();
    const originalStore = pluginModule.MemoryDB.prototype.store;
    let storeCalls = 0;
    pluginModule.MemoryDB.prototype.store = async function trackedStore(...args) {
      storeCalls += 1;
      return originalStore.apply(this, args);
    };
    t.after(() => { pluginModule.MemoryDB.prototype.store = originalStore; });

    const calls = [];
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const api = createApi(baseDbPath, {
      autoCapture: true,
      merging: { enabled: true },
      captureMaxChars: scenario === "capture-summary" ? 100 : 15_000,
      runtime: { captureTimeoutMs: 1_000 },
      emotion: scenario === "emotion-classification"
        ? { tier: "t3", t3: { enabled: true, timeoutMs: 5_000 } }
        : { t3: { enabled: false } },
    }, {
      async complete(params) {
        calls.push(params);
        startedResolve();
        return new Promise((resolve, reject) => {
          if (params.signal.aborted) return reject(params.signal.reason);
          params.signal.addEventListener("abort", () => reject(params.signal.reason), { once: true });
        });
      },
    });
    t.after(() => api._shutdown());
    pluginModule.default.register(api, { importRouting: async () => routingCapability });
    const emitted = api._emit("agent_end", {
      success: true,
      turnId: `turn-${scenario}`,
      sessionKey: `agent:${scenario}:main`,
      messages: [{ role: "user", content: scenario === "capture-summary" ? "remember this capture summary detail. ".repeat(20) : "Remember this emotionally important decision for tomorrow." }],
    }, { agentId: captureAgentId, workspaceDir: baseDbPath });

    const didStart = await Promise.race([
      started.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    assert.equal(didStart, true, JSON.stringify(api._logs));
    const results = await emitted;
    assert.ok(results.some((result) => result?.timedOut === true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].purpose, scenario);
    assert.equal(Object.hasOwn(calls[0], "agentId"), false);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(storeCalls, 0);
  }
});

test("automatic capture reflection uses the captured workspace context", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-auto-reflection-workspace-"));
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  const originalEmbedBatch = LocalTransformersEmbeddingProvider.prototype.embedBatch;
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector();
  LocalTransformersEmbeddingProvider.prototype.embedBatch = async (texts) => texts.map(() => makeVector());
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedBatch = originalEmbedBatch;
  });

  const pluginModule = await loadFreshPlugin();
  const agentId = "auto-reflection-agent";
  const api = createApi(baseDbPath, {
    autoCapture: true,
    metaCognition: { enabled: true, sessionThreshold: 1, intervalDays: 7 },
    neo: { enabled: true },
    runtime: { captureTimeoutMs: 10_000 },
  });
  t.after(() => api._shutdown());
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  await api._emit("agent_end", {
    success: true,
    turnId: "turn-auto-reflection",
    runId: "run-auto-reflection",
    sessionKey: `agent:${agentId}:main`,
    sessionId: "session-auto-reflection",
    messages: [{
      role: "user",
      content: "Remember that automatic reflection should keep the workspace directory from the capture context.",
    }],
  }, {
    agentId,
    workspaceDir: baseDbPath,
    sessionKey: `agent:${agentId}:main`,
    sessionId: "session-auto-reflection",
    messageProvider: "telegram",
    senderId: "owner",
    chatId: "private-chat",
  });

  assert.doesNotMatch(JSON.stringify(api._logs), /ReferenceError|commandCtx is not defined|workspaceDir is not defined/);
  assert.match(JSON.stringify(api._logs), /meta-reflection triggered after 1 sessions/);
  assert.equal(existsSync(join(baseDbPath, ".adaptive-learning", "meta-cognition-metrics.json")), true);
  const state = JSON.parse(readFileSync(join(baseDbPath, "_meta-cognition-state.json"), "utf8"));
  assert.equal(state.sessionCountSinceReflection, 0);
  assert.ok(state.lastReflectionAt > 0);
});

test("recall commit barriers block writes when the runtime ignores abort and succeeds late", async (t) => {
  for (const scenario of ["emotion-classification", "continuity-overlay"]) {
    const baseDbPath = mkdtempSync(join(tmpdir(), `plur1bus-recall-abort-${scenario}-`));
    t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
    const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector();
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => makeVector();
    t.after(() => {
      LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
      LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    });

    const pluginModule = await loadFreshPlugin();
    const agentId = `${scenario}-agent`;
    {
      const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
      if (scenario !== "emotion-classification") {
        const memories = [{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          text: "The project used to follow the original roadmap.",
          summary: "Original project roadmap",
        }];
        for (const memory of memories) {
          await db.store({
            ...memory,
            vector: makeVector(),
            category: "project",
            createdAt: Date.now(),
            storedBy: agentId,
          });
        }
      } else {
        await db.init();
      }
      await db.shutdown();
    }

    const calls = [];
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const api = createApi(baseDbPath, {
      autoRecall: true,
      merging: { enabled: true },
      runtime: { recallTimeoutMs: 1_500 },
      emotion: scenario === "emotion-classification"
        ? { tier: "t3", t3: { enabled: true, timeoutMs: 5_000 } }
        : { t3: { enabled: false } },
      personaVoice: { enabled: false },
      continuityEngine: scenario === "continuity-overlay" ? {
        enabled: true,
        tasteGate: { enabled: false },
        overlays: { enabled: true, autoCreateOnRecall: true, maxPerSession: 1 },
      } : { enabled: false },
    }, {
      async complete(params) {
        calls.push(params);
        startedResolve();
        await new Promise((resolve) => setTimeout(resolve, 1_750));
        const text = scenario === "emotion-classification"
          ? JSON.stringify({
              valence: 0.5,
              arousal: 0.5,
              dominance: 0.5,
              intensity: 0.8,
              primary_emotion: "joy",
              emotion_labels: { joy: 0.8 },
              confidence: 0.9,
              language: "en",
            })
          : scenario === "continuity-overlay"
            ? JSON.stringify({
                shiftType: "meaning",
                shiftDescription: "The roadmap now has a different meaning.",
                confidence: 0.9,
                confidenceDelta: 0.1,
              })
            : "yes";
        return { text, provider: "late-runtime", model: "late-model", usage: {} };
      },
    });
    t.after(() => api._shutdown());
    pluginModule.default.register(api, { importRouting: async () => routingCapability });
    const prompt = scenario === "continuity-overlay"
      ? "Since then the project now follows a different roadmap."
      : "This project decision feels unexpectedly joyful and important.";
    const turn = await observeOfficialTurn(api, {
      agentId,
      workspaceDir: baseDbPath,
      runId: `run-${scenario}`,
      prompt,
    });
    const emitted = api._emit("before_prompt_build", turn.event, turn.ctx);

    const didStart = await Promise.race([
      started.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    assert.equal(didStart, true, JSON.stringify(api._logs));
    await emitted;
    assert.match(JSON.stringify(api._logs), /recall timed out without cache/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].purpose, scenario);
    assert.equal(Object.hasOwn(calls[0], "agentId"), false);
    assert.equal(calls[0].signal.aborted, true);
    if (scenario === "continuity-overlay") {
      assert.equal(existsSync(join(baseDbPath, "interpretation-overlays.jsonl")), false);
    }
    if (scenario === "emotion-classification") {
      assert.equal(existsSync(join(baseDbPath, ".emotional-state.json")), false);
      assert.equal(existsSync(join(baseDbPath, ".current-mood.txt")), false);
    }
  }
});

test("continuity overlay contradiction enrichment reuses the recall target set", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-continuity-overlay-targets-"));
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  const originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => makeVector();
  LocalTransformersEmbeddingProvider.prototype.embedQuery = async () => makeVector();
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
  });

  const pluginModule = await loadFreshPlugin();
  const agentId = "continuity-overlay-targets-agent";
  const db = new pluginModule.MemoryDB(join(baseDbPath, agentId), VECTOR_DIM);
  try {
    await db.store({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      text: "The release process originally required a full verification run.",
      summary: "Original release verification process",
      vector: makeVector(),
      category: "project",
      createdAt: Date.now(),
      storedBy: agentId,
    });
  } finally {
    await db.shutdown();
  }

  const api = createApi(baseDbPath, {
    autoRecall: true,
    runtime: { recallTimeoutMs: 5_000 },
    continuityEngine: {
      enabled: true,
      tasteGate: { enabled: false },
      overlays: { enabled: true, autoCreateOnRecall: false, maxPerSession: 1 },
    },
  });
  t.after(() => api._shutdown());
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const turn = await observeOfficialTurn(api, {
    agentId,
    workspaceDir: baseDbPath,
    runId: "continuity-overlay-targets",
    prompt: "The release process now uses a different verification route.",
  });
  const results = await api._emit("before_prompt_build", turn.event, turn.ctx);

  assert.ok(results.some((result) => result?.prependContext?.includes("Original release verification process")));
  assert.doesNotMatch(
    JSON.stringify(api._logs),
    /continuity-engine: contradiction enrichment failed/,
  );
});
