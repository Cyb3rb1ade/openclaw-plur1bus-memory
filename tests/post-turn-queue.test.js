// Nacharbeit nach dem Turn ueber den Cron post-turn-refine (7.18.14).
//
// Unter OpenClaw 2026.9.7 lehnt der Host Plugin-LLM-Aufrufe aus agent_end ab
// ("agent tool caller authority is no longer active", openclaw/openclaw#162941):
// Light-Traum-Erzaehlungen erreichten nie das Traumtagebuch, Episoden blieben
// ohne LLM. agent_end reiht die Arbeit jetzt ein, der Cron fuehrt sie aus.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, test } from "node:test";

import { createEngine } from "../engine/create-engine.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { createStubHost } from "../lib/host-services.js";
import {
  POST_TURN_MAX_ATTEMPTS,
  POST_TURN_QUEUE_CAP,
  POST_TURN_QUEUE_DIR,
  countPostTurnWork,
  drainPostTurnWork,
  enqueuePostTurnWork,
} from "../lib/post-turn-queue.js";
import { resolveEffectiveConfig } from "../lib/setup/config-contract.js";
import { selectEnabledFeatureCronSpecs } from "../lib/setup/feature-cron-plan.js";
import {
  POST_TURN_REFINE_UNSCHEDULED_REASON,
  shouldDeferPostTurnLlm,
} from "../engine/capture/post-turn-work.js";
import { flatEmbedder } from "./helpers/shared-workspace-engine.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const AGENT = "main";

function entryFiles(base, agentId = AGENT) {
  const dir = join(base, POST_TURN_QUEUE_DIR, agentId);
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
}

describe("post-turn queue", () => {
  it("writes one private file per entry and drains FIFO", async () => {
    const base = makeTempDir("plur1bus-post-turn-");
    enqueuePostTurnWork(base, AGENT, { digestHash: "a" }, { now: 1000 });
    enqueuePostTurnWork(base, AGENT, { digestHash: "b" }, { now: 2000 });
    const files = entryFiles(base);
    assert.equal(files.length, 2);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(base, POST_TURN_QUEUE_DIR, AGENT, files[0])).mode & 0o777, 0o600); // POSIX mode only
    }
    const seen = [];
    const result = await drainPostTurnWork(base, AGENT, async (entry) => { seen.push(entry.digestHash); return true; });
    assert.deepEqual(seen, ["a", "b"]);
    assert.deepEqual({ processed: result.processed, remaining: result.remaining }, { processed: 2, remaining: 0 });
    assert.equal(countPostTurnWork(base, AGENT), 0);
  });

  it("stops at a failed entry and keeps the order for the next run", async () => {
    const base = makeTempDir("plur1bus-post-turn-");
    for (const [now, digestHash] of [[1000, "a"], [2000, "b"], [3000, "c"]]) enqueuePostTurnWork(base, AGENT, { digestHash }, { now });
    const seen = [];
    const result = await drainPostTurnWork(base, AGENT, async (entry) => { seen.push(entry.digestHash); return entry.digestHash !== "b"; });
    assert.deepEqual(seen, ["a", "b"]);
    assert.deepEqual({ processed: result.processed, failed: result.failed, remaining: result.remaining }, { processed: 1, failed: 1, remaining: 2 });
    const head = JSON.parse(readFileSync(join(base, POST_TURN_QUEUE_DIR, AGENT, entryFiles(base)[0]), "utf8"));
    assert.deepEqual({ digestHash: head.digestHash, attempts: head.attempts }, { digestHash: "b", attempts: 1 });
  });

  it("drops an entry after repeated failures so the queue moves on", async () => {
    const base = makeTempDir("plur1bus-post-turn-");
    enqueuePostTurnWork(base, AGENT, { digestHash: "bad" }, { now: 1000 });
    enqueuePostTurnWork(base, AGENT, { digestHash: "good" }, { now: 2000 });
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args.join(" ")) };
    for (let run = 1; run < POST_TURN_MAX_ATTEMPTS; run += 1) {
      await drainPostTurnWork(base, AGENT, async (entry) => entry.digestHash !== "bad", { logger });
    }
    const seen = [];
    const result = await drainPostTurnWork(base, AGENT, async (entry) => { seen.push(entry.digestHash); return entry.digestHash !== "bad"; }, { logger });
    assert.deepEqual(seen, ["bad", "good"]);
    assert.deepEqual({ dropped: result.dropped, processed: result.processed, remaining: result.remaining }, { dropped: 1, processed: 1, remaining: 0 });
    assert.match(warnings.join("\n"), /dropped after repeated failures/);
  });

  it("caps the queue, skips corrupt files and respects the drain lock", async () => {
    const base = makeTempDir("plur1bus-post-turn-");
    for (let i = 0; i < POST_TURN_QUEUE_CAP + 2; i += 1) enqueuePostTurnWork(base, AGENT, { n: i }, { now: 1000 + i, logger: { warn() {} } });
    assert.equal(countPostTurnWork(base, AGENT), POST_TURN_QUEUE_CAP);
    const dir = join(base, POST_TURN_QUEUE_DIR, AGENT);
    writeFileSync(join(dir, entryFiles(base)[0]), "{not json");
    writeFileSync(join(dir, ".drain.lock"), "{}");
    const locked = await drainPostTurnWork(base, AGENT, async () => true);
    assert.equal(locked.locked, true);
    rmSync(join(dir, ".drain.lock"));
    const result = await drainPostTurnWork(base, AGENT, async () => true, { maxEntries: 5, logger: { warn() {} } });
    assert.deepEqual({ dropped: result.dropped, processed: result.processed }, { dropped: 1, processed: 5 });
  });

  it("keeps agent queues apart and rejects path-like agent ids", () => {
    const base = makeTempDir("plur1bus-post-turn-");
    enqueuePostTurnWork(base, "bernhardine", { x: 1 });
    assert.equal(countPostTurnWork(base, "bernhardine"), 1);
    assert.equal(countPostTurnWork(base, AGENT), 0);
    assert.throws(() => enqueuePostTurnWork(base, "../escape", { x: 1 }));
  });
});

describe("shouldDeferPostTurnLlm", () => {
  it("runs inline unless defer is true and the host scheduled post-turn-refine", () => {
    const warnings = [];
    const host = { logger: { warn: (message) => warnings.push(String(message)) }, capabilities: {} };
    assert.equal(shouldDeferPostTurnLlm({}, host), false);
    assert.equal(shouldDeferPostTurnLlm({ runtime: {} }, host), false);
    assert.equal(shouldDeferPostTurnLlm({ runtime: { deferPostTurnLlm: false } }, host), false);
    assert.equal(shouldDeferPostTurnLlm({ runtime: { deferPostTurnLlm: true } }, host), false);
    assert.match(warnings.join("\n"), new RegExp(POST_TURN_REFINE_UNSCHEDULED_REASON));
    assert.equal(
      shouldDeferPostTurnLlm(
        { runtime: { deferPostTurnLlm: true } },
        { capabilities: { postTurnRefineScheduled: true } },
      ),
      true,
    );
  });

  it("createEngine materializes the OpenClaw default, then falls back inline without a drain", () => {
    const cfg = resolveEffectiveConfig({});
    assert.equal(cfg.runtime.deferPostTurnLlm, true);
    const warnings = [];
    assert.equal(
      shouldDeferPostTurnLlm(cfg, { logger: { warn: (message) => warnings.push(String(message)) }, capabilities: {} }),
      false,
    );
    assert.match(warnings.join("\n"), new RegExp(POST_TURN_REFINE_UNSCHEDULED_REASON));
  });

  it("createEngine without postTurnRefineScheduled runs a light dream or episode inline", async () => {
    const baseDbPath = join(makeTempDir("pt-inline-root-"), "lancedb-namespaced");
    const purposes = [];
    const warnings = [];
    const host = createStubHost({
      stateDir: makeTempDir("pt-inline-state-"),
      workspaceDir: async () => makeTempDir("pt-inline-ws-"),
      logger: { warn: (message) => warnings.push(String(message)) },
      runtime: {
        llm: {
          async complete(params) {
            const purpose = typeof params?.purpose === "string" ? params.purpose : "";
            if (purpose) purposes.push(purpose);
            return { text: "[]", provider: "test", model: "test", usage: {} };
          },
        },
      },
    });
    assert.notEqual(host.capabilities?.postTurnRefineScheduled, true);
    const engine = createEngine(host, {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: true,
      autoRecall: false,
      neo: { enabled: true },
      gc: { enabled: false },
      obsidianBridge: { enabled: false },
      merging: { enabled: true },
      dreaming: { enabled: false },
      skillMiner: { enabled: false },
      temporalContext: { enabled: false },
      conversationReactivationRecall: { enabled: false },
      reranker: { enabled: false },
      runtime: { recallTimeoutMs: 10_000, deferPostTurnLlm: true },
      duplicateThreshold: 1.01,
    }, { internals: { embeddings: flatEmbedder(), reranker: null } });
    try {
      const outcome = await engine.capture({
        agentId: "agent-a",
        principal: { agentId: "agent-a", workspace: "workspace:v1:main", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "inferred" },
        agent: { origin: "user", background: false },
        messages: [
          { role: "user", content: "We decided to move the weekly planning meeting to Thursday mornings from now on." },
          { role: "assistant", content: "Noted: weekly planning moves to Thursday mornings." },
          { role: "user", content: "Also remember that the release freeze starts two days before every planning meeting." },
          { role: "assistant", content: "Understood, the release freeze begins two days earlier." },
        ],
        sessionKey: "agent:agent-a:main",
        incognito: false,
        signal: AbortSignal.timeout(8_000),
      }).done;
      assert.ok(outcome.stored >= 1, JSON.stringify(outcome));
      for (let i = 0; i < 100 && !purposes.includes("conversation-insights") && !purposes.includes("episode-analysis"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(entryFiles(baseDbPath, "agent-a").length, 0, "must not enqueue post-turn work");
      assert.match(warnings.join("\n"), new RegExp(POST_TURN_REFINE_UNSCHEDULED_REASON));
      assert.ok(
        purposes.includes("conversation-insights") || purposes.includes("episode-analysis"),
        `inline light dream or episode must call the LLM, got: ${purposes.join(",") || "(none)"}`,
      );
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });
});

describe("post-turn-refine feature cron selection", () => {
  const config = (pluginConfig) => ({ plugins: { entries: { "memory-lancedb-namespaced": { config: pluginConfig } } } });
  const features = (pluginConfig) => selectEnabledFeatureCronSpecs(config(pluginConfig)).map((spec) => spec.feature);

  it("is provisioned by default and follows runtime.deferPostTurnLlm and neo", () => {
    assert.ok(features({}).includes("post-turn-refine"));
    assert.ok(!features({ runtime: { deferPostTurnLlm: false } }).includes("post-turn-refine"));
    assert.ok(!features({ neo: { enabled: false } }).includes("post-turn-refine"));
  });
});

const VECTOR_DIM = 384;
const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined; },
  normalizeMessageChannel(value) { return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined; },
  isIncognitoSessionKey() { return false; },
});

function createApi(baseDbPath, configOverrides, runtimeLlm) {
  const commands = [];
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
    runtime: {
      llm: runtimeLlm,
      agent: {
        async resolveAgentWorkspaceDir() { return baseDbPath; },
        session: { async getSessionEntry() { return null; } },
      },
    },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool() {},
    registerService(service) { services.push(service); },
    on(name, handler) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
    },
    _commands: commands,
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

async function runTurn(t, runtimeOverrides) {
  const baseDbPath = makeTempDir("plur1bus-post-turn-e2e-");
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const originalEmbedPassage = LocalTransformersEmbeddingProvider.prototype.embedPassage;
  const originalEmbedBatch = LocalTransformersEmbeddingProvider.prototype.embedBatch;
  LocalTransformersEmbeddingProvider.prototype.embedPassage = async () => Array(VECTOR_DIM).fill(0.1);
  LocalTransformersEmbeddingProvider.prototype.embedBatch = async (texts) => texts.map(() => Array(VECTOR_DIM).fill(0.1));
  t.after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbedPassage;
    LocalTransformersEmbeddingProvider.prototype.embedBatch = originalEmbedBatch;
  });

  const purposes = [];
  const pluginModule = await import(`../index.js?post-turn-queue=${Date.now()}-${Math.random()}`);
  const agentId = "post-turn-agent";
  const api = createApi(baseDbPath, {
    autoCapture: true,
    neo: { enabled: true },
    merging: { enabled: true },
    emotion: { t3: { enabled: false } },
    runtime: { captureTimeoutMs: 10_000, ...runtimeOverrides },
  }, {
    async complete(params) {
      purposes.push(params.purpose);
      return { text: "[]", provider: "test", model: "test", usage: {} };
    },
  });
  t.after(() => api._shutdown());
  pluginModule.default.register(api, { importRouting: async () => routingCapability });

  const sessionKey = `agent:${agentId}:main`;
  await api._emit("agent_end", {
    success: true,
    runId: "run-post-turn",
    sessionKey,
    sessionId: "session-post-turn",
    messages: [
      { role: "user", content: "We decided to move the weekly planning meeting to Thursday mornings from now on." },
      { role: "assistant", content: "Noted: weekly planning moves to Thursday mornings." },
      { role: "user", content: "Also remember that the release freeze starts two days before every planning meeting." },
      { role: "assistant", content: "Understood, the release freeze begins two days earlier." },
    ],
  }, {
    agentId,
    workspaceDir: baseDbPath,
    sessionKey,
    sessionId: "session-post-turn",
    messageProvider: "telegram",
    senderId: "owner",
    chatId: "private-chat",
  });

  return { api, baseDbPath, agentId, purposes };
}

test("OpenClaw adapter queues light dream and episodes; the cron runs their LLM calls", async (t) => {
  const { api, baseDbPath, agentId, purposes } = await runTurn(t, {});
  const queued = entryFiles(baseDbPath, agentId);
  assert.equal(queued.length, 1, JSON.stringify(api._logs.filter(([level]) => level !== "debug")).slice(0, 2000));
  const entry = JSON.parse(readFileSync(join(baseDbPath, POST_TURN_QUEUE_DIR, agentId, queued[0]), "utf8"));
  assert.deepEqual({ light: entry.lightDream, episodes: entry.episodes, turns: entry.turns.length }, { light: true, episodes: true, turns: 4 });
  assert.equal(entry.ctx.workspaceDir, baseDbPath);
  for (const purpose of ["conversation-insights", "dream-narrative", "episode-analysis"]) {
    assert.ok(!purposes.includes(purpose), `${purpose} must not run inside agent_end`);
  }

  const command = api._commands.find((candidate) => candidate.name === "plur1bus");
  const reply = await command.handler({
    args: "internal post-turn-refine",
    agentId,
    channel: "cron",
    origin: "cron",
    source: "cron",
    sessionKey: `agent:${agentId}:cron:plur1bus-post-turn-refine`,
    config: {},
    workspaceDir: baseDbPath,
  });
  const result = JSON.parse(reply.text);
  assert.deepEqual({ job: result.job, processed: result.processed, remaining: result.remaining }, { job: "post-turn-refine", processed: 1, remaining: 0 });
  assert.ok(purposes.includes("conversation-insights"), `cron ran the light dream insights: ${purposes.join(",")}`);
  assert.equal(entryFiles(baseDbPath, agentId).length, 0);
  for (const purpose of ["dream-narrative", "episode-analysis"]) {
    assert.ok(purposes.includes(purpose), `cron ran ${purpose}: ${purposes.join(",")}`);
  }
});

test("runtime.deferPostTurnLlm=false keeps the inline agent_end path", async (t) => {
  const { baseDbPath, agentId, purposes } = await runTurn(t, { deferPostTurnLlm: false });
  for (let i = 0; i < 50 && !purposes.includes("conversation-insights"); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(entryFiles(baseDbPath, agentId).length, 0);
  assert.ok(purposes.includes("conversation-insights"), `inline light dream ran: ${purposes.join(",")}`);
});
