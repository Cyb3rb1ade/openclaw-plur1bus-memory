import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { lightDream } from "../lib/dreaming/light-dream.js";
import { runRemDream } from "../lib/dreaming/rem-dream.js";
import { extractEpisodesFromTurns } from "../lib/episodes.js";

const repoSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const VECTOR_DIM = 384;

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
    runtime: runtimeLlm ? { llm: runtimeLlm } : {},
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
    async _emit(name, event, ctx) {
      return Promise.all((hooks.get(name) || []).map((handler) => handler(event, ctx)));
    },
    async _shutdown() {
      await Promise.all((hooks.get("gateway_stop") || []).map((handler) => handler({}, {})));
      await Promise.all(services.map((service) => service?.stop?.()));
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
  pluginModule.default.register(api);
  const memoryCommand = api._commands.find((command) => command.name === "memory");
  assert.ok(memoryCommand);
  const sessionRuntime = {
    async complete(params) {
      sessionCalls.push(params);
      return { text: "A compact searchable summary for the requested topic.", provider: "session", model: "session", usage: {} };
    },
  };

  const response = await memoryCommand.handler({
    args: "search topic. ".repeat(600),
    agentId: "query-session-agent",
    workspaceDir: baseDbPath,
    workspaceKey: "query-session-workspace",
    runtimeContext: { llm: sessionRuntime },
  });

  assert.equal(globalCalls.length, 0);
  assert.equal(sessionCalls.length, 1, JSON.stringify(response));
  assert.equal(sessionCalls[0].purpose, "recall-query-summary");
  assert.equal(Object.hasOwn(sessionCalls[0], "agentId"), false);
  assert.equal(Object.hasOwn(sessionCalls[0], "model"), false);

  const memoryAlias = api._commands.find((command) => command.name === "plur1bus_memory");
  assert.ok(memoryAlias);
  await memoryAlias.handler({
    args: "alias search topic. ".repeat(400),
    agentId: "query-session-agent",
    workspaceDir: baseDbPath,
    workspaceKey: "query-session-workspace",
    runtimeContext: { llm: sessionRuntime },
  });
  assert.equal(sessionCalls.length, 2);
  assert.equal(sessionCalls[1].purpose, "recall-query-summary");
  assert.equal(Object.hasOwn(sessionCalls[1], "agentId"), false);

  const tooLarge = await memoryCommand.handler({
    args: "x".repeat(100_001),
    agentId: "query-session-agent",
    workspaceDir: baseDbPath,
    workspaceKey: "query-session-workspace",
    runtimeContext: { llm: { async complete() { throw new Error("must not run"); } } },
  });
  assert.match(tooLarge.text, /100.?000/);
  const aliasTooLarge = await memoryAlias.handler({
    args: "x".repeat(100_001),
    agentId: "query-session-agent",
    workspaceDir: baseDbPath,
    runtimeContext: { llm: sessionRuntime },
  });
  assert.match(aliasTooLarge.text, /100.?000/);
  assert.equal(sessionCalls.length, 2);
});

test("exact-limit punctuation-free /memory input stays usable with merging disabled", async (t) => {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-bounded-query-fallback-"));
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
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
  pluginModule.default.register(api);
  const memoryCommand = api._commands.find((command) => command.name === "memory");
  assert.ok(memoryCommand);

  const response = await memoryCommand.handler({
    args: "x".repeat(100_000),
    agentId: "bounded-query-agent",
    workspaceDir: baseDbPath,
    workspaceKey: "bounded-query-workspace",
  });

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
    query() { return { where() { return { limit() { return { async toArray() { return rows; } }; } }; } }; },
    vectorSearch() { return { limit() { return { async toArray() { return rows.map((row) => ({ ...row, _distance: 0 })); } }; } }; },
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
    },
    workspaceKey: "rem-workspace",
    agentId: "rem-agent",
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
  pluginModule.default.register(api);

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
  await api._emit("before_prompt_build", {
    prompt: "auto recall topic. ".repeat(1_400),
    messages: [{ role: "user", content: "auto recall topic" }],
    sessionKey: `agent:${autoAgent}:main`,
  }, {
    agentId: autoAgent,
    workspaceDir: baseDbPath,
    workspaceKey: "auto-query-workspace",
    sessionKey: `agent:${autoAgent}:main`,
  });

  const summaryCalls = runtimeCalls.filter((call) => call.purpose === "recall-query-summary");
  assert.equal(summaryCalls.length, 2);
  assert.equal(summaryCalls[0].agentId, "tool-query-agent");
  assert.equal(summaryCalls[1].agentId, autoAgent);
  assert.equal(summaryCalls[1].signal instanceof AbortSignal, true);
  assert.equal(Object.hasOwn(summaryCalls[0], "model"), false);
  assert.equal(Object.hasOwn(summaryCalls[1], "model"), false);
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
  pluginModule.default.register(api);
  const speakerCommand = api._commands.find((command) => command.name === "speaker");
  const genericTooLarge = await speakerCommand.handler({ args: "x".repeat(4_001) });
  assert.match(genericTooLarge.text, /maximum length of 4000/i);
  const correctCommand = api._commands.find((command) => command.name === "correct");
  const longCorrectionArgs = `${"old correction target. ".repeat(350)} -> ${"new replacement detail. ".repeat(350)}`;
  const denied = await correctCommand.handler({
    args: longCorrectionArgs,
    agentId: "correction-agent",
    workspaceDir: baseDbPath,
    userId: "intruder",
    chatId: "private-chat",
    chatType: "private",
    runtimeContext: { llm: api.runtime.llm },
  });
  assert.match(denied.text, /allowed|unauthorized/i);
  assert.equal(runtimeCalls, 0);
  const response = await correctCommand.handler({
    args: longCorrectionArgs,
    agentId: "correction-agent",
    workspaceDir: baseDbPath,
    workspaceKey: "correction-workspace",
    userId: "owner",
    chatId: "private-chat",
    chatType: "private",
    runtimeContext: { llm: api.runtime.llm },
  });

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
    pluginModule.default.register(api);
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
    assert.equal(calls[0].agentId, captureAgentId);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(storeCalls, 0);
  }
});

test("recall scheduler abort reaches query summary and overlay without late overlay writes", async (t) => {
  for (const scenario of ["recall-query-summary", "continuity-overlay"]) {
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
      if (scenario === "continuity-overlay") {
      await db.store({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        text: "The project used to follow the original roadmap.",
        summary: "Original project roadmap",
        vector: makeVector(),
        category: "project",
        createdAt: Date.now(),
        storedBy: agentId,
      });
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
      runtime: { recallTimeoutMs: 200 },
      emotion: { t3: { enabled: false } },
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
        return new Promise((resolve, reject) => {
          if (params.signal.aborted) return reject(params.signal.reason);
          params.signal.addEventListener("abort", () => reject(params.signal.reason), { once: true });
        });
      },
    });
    t.after(() => api._shutdown());
    pluginModule.default.register(api);
    const prompt = scenario === "recall-query-summary"
      ? "long recall query topic. ".repeat(1_000)
      : "Since then the project now follows a different roadmap.";
    const emitted = api._emit("before_prompt_build", {
      prompt,
      messages: [{ role: "user", content: prompt }],
      sessionKey: `agent:${agentId}:main`,
    }, { agentId, workspaceDir: baseDbPath, workspaceKey: "recall-abort-workspace", sessionKey: `agent:${agentId}:main` });

    const didStart = await Promise.race([
      started.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    assert.equal(didStart, true, JSON.stringify(api._logs));
    await emitted;
    assert.match(JSON.stringify(api._logs), /recall timed out without cache/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].purpose, scenario);
    assert.equal(calls[0].agentId, agentId);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(existsSync(join(baseDbPath, "interpretation-overlays.jsonl")), false);
  }
});
