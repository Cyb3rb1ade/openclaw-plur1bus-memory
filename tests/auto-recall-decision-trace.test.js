// tests/auto-recall-decision-trace.test.js
//
// Decision-trace coverage for Conversation Reactivation Recall (CRR).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runConversationReactivationRecall,
} from "../lib/conversation-reactivation-recall.js";
import {
  createRecallDecisionTrace,
} from "../lib/recall-decision-trace.js";
import plugin, { MemoryDB } from "../index.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";

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

describe("auto-recall-decision-trace", () => {
  const baseCfg = {
    enabled: true,
    idleThresholdMinutes: 45,
    cooldownMinutes: 30,
    maxReactivationMemories: 3,
    maxFadedReactivationMemories: 1,
    maxOpenThreads: 3,
    maxCommunities: 3,
    timeoutMs: 50,
    visibleHints: false,
  };

  function makeLensDir(memories, communities) {
    const dir = mkdtempSync(join(tmpdir(), "crr-trace-"));
    mkdirSync(join(dir, ".plur1bus"), { recursive: true });
    writeFileSync(
      join(dir, ".plur1bus", "semantic-lens-index.json"),
      JSON.stringify({ communities, memories, entries: {} }),
      "utf8"
    );
    return dir;
  }

  function makeArgs(overrides = {}) {
    return {
      prompt: "continue dashboard architecture",
      messageText: "continue dashboard architecture",
      baseRecallIds: new Set(),
      baseRecallTopScore: 0.1,
      workspaceDir: null,
      neoStore: null,
      graphEdges: [],
      cfg: baseCfg,
      agentId: `trace-agent-${Math.random()}`,
      sessionKey: `trace-session-${Math.random()}`,
      now: Date.now(),
      logger: { warn: () => {}, debug: () => {} },
      ...overrides,
    };
  }

  it("reactivation memory gets source=reactivation in trace", async () => {
    const trace = createRecallDecisionTrace({ query: "continue dashboard architecture" });
    const workspaceDir = makeLensDir(
      [{ id: "m1", category: "project", display: "dashboard architecture plan" }],
      [{ id: "c1", representativeMemoryIds: ["m1"] }]
    );

    const result = await runConversationReactivationRecall(makeArgs({ workspaceDir, decisionTrace: trace }));

    assert.ok(result.trace, "result.trace should be present");
    assert.strictEqual(result.additions.length, 1);
    assert.strictEqual(result.additions[0].id, "m1");

    const candidate = result.trace.candidates.find((c) => c.id === "m1");
    assert.ok(candidate, "selected memory should appear as a candidate");
    assert.strictEqual(candidate.source, "reactivation");

    const decision = result.trace.decisions.find((d) => d.memoryId === "m1" && d.action === "inclusion");
    assert.ok(decision, "selected memory should have an inclusion decision");
    assert.strictEqual(decision.scoreBreakdown?.source, "reactivation");
    assert.strictEqual(decision.scoreBreakdown?.evidence, "derived");
  });

  it("rejected reactivation candidates have reasons", async () => {
    const trace = createRecallDecisionTrace({ query: "continue dashboard architecture" });
    const workspaceDir = makeLensDir(
      [
        { id: "m1", category: "project", display: "dashboard architecture plan" },
        { id: "m2", category: "project", display: "unrelated topic content" },
      ],
      [{ id: "c1", representativeMemoryIds: ["m1", "m2"] }]
    );

    const result = await runConversationReactivationRecall(makeArgs({ workspaceDir, decisionTrace: trace }));

    assert.ok(result.trace, "result.trace should be present");
    assert.strictEqual(result.additions.length, 1);
    assert.strictEqual(result.additions[0].id, "m1");

    const rejection = result.trace.decisions.find((d) => d.memoryId === "m2" && d.action === "rejection");
    assert.ok(rejection, "non-overlapping candidate should have a rejection decision");
    assert.ok(
      rejection.reason.toLowerCase().includes("token overlap") || rejection.reason.toLowerCase().includes("overlap"),
      `expected overlap rejection reason, got: ${rejection.reason}`
    );
  });

  it("final returned trace object is populated", async () => {
    const trace = createRecallDecisionTrace({ query: "continue dashboard architecture" });
    const workspaceDir = makeLensDir(
      [
        { id: "m1", category: "project", display: "dashboard architecture plan" },
      ],
      [{ id: "c1", representativeMemoryIds: ["m1"] }]
    );

    const result = await runConversationReactivationRecall(makeArgs({ workspaceDir, decisionTrace: trace }));

    assert.ok(result.trace, "result.trace should be present");
    assert.ok(Array.isArray(result.trace.candidates));
    assert.ok(result.trace.candidates.length > 0, "trace should contain candidates");
    assert.ok(result.trace.decisions.length > 0, "trace should contain decisions");
    assert.ok(result.trace.guards.length > 0, "trace should contain the reactivation-trigger guard");
    assert.strictEqual(result.trace.summary.included, 1);
    assert.ok(result.trace.summary.totalCandidates >= 1);
  });
});


describe("auto-recall decision trace integration", () => {
  const VECTOR_DIM = 384;
  const AGENT_PREFIX = "auto-recall-trace";

  function makeVector(offset = 0) {
    const vec = Array(VECTOR_DIM).fill(0.1);
    vec[0] = 0.1 + offset;
    return vec;
  }

  function makeMockApi(baseDbPath, traceEnabled = false, includeInPrompt = false) {
    const noop = () => {};
    const cfg = {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      duplicateThreshold: 0.99,
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: true,
      neo: { enabled: false },
      gc: { enabled: false },
      continuityEngine: { enabled: false },
      conversationReactivationRecall: { enabled: false },
      runtime: { recallTimeoutMs: 5000 },
    };
    if (traceEnabled) {
      cfg.recall = {
        decisionTrace: { enabled: true, includeInPrompt, persist: false },
      };
    }
    return {
      pluginConfig: cfg,
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      resolvePath: (p) => p,
      registerCommand: noop,
      registerTool(factory) {
        this._toolFactory = factory;
      },
      on(name, fn) {
        if (!this._hooks) this._hooks = {};
        this._hooks[name] = fn;
      },
      registerService: noop,
      _hooks: {},
    };
  }

  let basePath;
  let originalEmbed;
  let originalEmbedQuery;

  before(async () => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-auto-trace-"));
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    originalEmbedQuery = LocalTransformersEmbeddingProvider.prototype.embedQuery;
  });

  after(() => {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalEmbedQuery;
    try { rmSync(basePath, { recursive: true, force: true }); } catch {}
  });

  async function runRecallFor(agentId, prompt, traceEnabled, includeInPrompt, overrides = {}) {
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return makeVector();
    };
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async function mockedEmbedQuery() {
      return makeVector();
    };

    const api = makeMockApi(basePath, traceEnabled, includeInPrompt);
    Object.assign(api.pluginConfig, overrides.pluginConfig || {});
    plugin.register(api, { importRouting: async () => routingCapability });

    const hook = api._hooks["before_prompt_build"];
    assert.ok(hook, "before_prompt_build hook should be registered");

    return await hook(
      { prompt, messages: [{ role: "user", content: prompt }] },
      { agentId, workspaceDir: overrides.workspaceDir ?? null, sessionKey: "sess-1" }
    );
  }

  it("final prompt memory carries trace metadata when enabled", async () => {
    const agentId = `${AGENT_PREFIX}-meta`;
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: "m1",
      text: "User prefers dark mode.",
      vector: makeVector(),
      category: "preference",
      createdAt: Date.now(),
      storedBy: agentId,
    });

    const result = await runRecallFor(agentId, "What does the user prefer?", true, true);
    assert.ok(result?.prependContext, "prependContext should be present");
    assert.match(
      result.prependContext,
      /source-stage="vector"/,
      "memory record should carry trace source-stage attribute"
    );
    assert.match(
      result.prependContext,
      /<memory-decision-trace>/,
      "decision trace block should be rendered when includeInPrompt is true"
    );
  });

  it("default config does not render trace block", async () => {
    const agentId = `${AGENT_PREFIX}-default`;
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: "m2",
      text: "User likes tea.",
      vector: makeVector(),
      category: "preference",
      createdAt: Date.now(),
      storedBy: agentId,
    });

    const result = await runRecallFor(agentId, "What does the user like?", false, false);
    assert.ok(result?.prependContext, "prependContext should be present");
    assert.doesNotMatch(
      result.prependContext,
      /<memory-decision-trace>/,
      "trace block should not be rendered when disabled"
    );
    assert.doesNotMatch(
      result.prependContext,
      /source-stage=/,
      "memory records should not carry trace attributes when disabled"
    );
  });

  it("before_prompt_build projects known valid-time bounds from the recalled DB row", async () => {
    const agentId = `${AGENT_PREFIX}-valid-time-label`;
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: "77777777-7777-4777-8777-777777777777",
      text: "User worked at Firma A.",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
      validFrom: Date.parse("2025-01-01T00:00:00.000Z"),
      validUntil: Date.parse("2025-06-01T00:00:00.000Z"),
    });

    const result = await runRecallFor(agentId, "Where did the user work?", false, false);
    assert.match(result?.prependContext || "", /valid-from="2025-01-01T00:00:00\.000Z"/);
    assert.match(result?.prependContext || "", /valid-until="2025-06-01T00:00:00\.000Z"/);
  });

  it("before_prompt_build preserves epistemic status on primary recall projection", async () => {
    const agentId = `${AGENT_PREFIX}-epistemic-label`;
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: "88888888-8888-4888-8888-888888888888",
      text: "The migration date is disputed.",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
      epistemicStatus: "disputed",
    });

    const result = await runRecallFor(agentId, "What is disputed about the migration?", false, false);
    assert.match(
      result?.prependContext || "",
      /id="88888888-8888-4888-8888-888888888888"[^>]*epistemic="disputed"/,
    );
  });

  it("before_prompt_build preserves known valid-time bounds on Semantic Lens projection", async () => {
    const agentId = `${AGENT_PREFIX}-semantic-lens-valid-time`;
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-semantic-lens-valid-time-"));
    mkdirSync(join(workspaceDir, ".plur1bus"), { recursive: true });
    writeFileSync(join(workspaceDir, ".plur1bus", "semantic-lens-index.json"), JSON.stringify({
      version: 1,
      generatedAt: "2026-08-12T00:00:00.000Z",
      memoryToCommunity: {
        "99999999-9999-4999-8999-999999999999": "c1",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": "c1",
      },
      communities: {
        c1: {
          id: "c1",
          representativeMemoryIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
          bridgeMemoryIds: [],
          fadedCandidateMemoryIds: [],
        },
      },
    }), "utf8");
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: "99999999-9999-4999-8999-999999999999",
      text: "Base memory for semantic lens.",
      vector: makeVector(),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
    });
    await db.store({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      text: "Historical semantic lens memory.",
      vector: makeVector().map((value) => -value),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
      epistemicStatus: "trusted",
      validFrom: Date.parse("2024-01-01T00:00:00.000Z"),
      validUntil: Date.parse("2024-12-01T00:00:00.000Z"),
    });

    const result = await runRecallFor(agentId, "Base memory", false, false, {
      workspaceDir,
      pluginConfig: {
        // Generous timeoutMs: test subject is valid-time bounds survival, not timeout mechanism (covered separately in semantic-lens-index.test.js with timeoutMs: 1). Tight budget races Promise.race under load.
        semanticLens: { enabled: true, maxLensMemories: 1, maxCommunities: 1, timeoutMs: 30000 },
        recall: { maxPromptMemories: 1 },
      },
    });
    const context = result?.prependContext || "";
    assert.match(context, /<memory-semantic-lens>/);
    assert.match(context, /id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"[^>]*valid-from="2024-01-01T00:00:00\.000Z"/);
    assert.match(context, /id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"[^>]*valid-until="2024-12-01T00:00:00\.000Z"/);
    assert.match(context, /id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"[^>]*epistemic="trusted"/);
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("includeInPrompt=true renders compact decision trace block", async () => {
    const agentId = `${AGENT_PREFIX}-in-prompt`;
    const db = new MemoryDB(join(basePath, agentId), VECTOR_DIM);
    await db.store({
      id: "m3",
      text: "User prefers email notifications.",
      vector: makeVector(),
      category: "preference",
      createdAt: Date.now(),
      storedBy: agentId,
    });

    const result = await runRecallFor(agentId, "How should we notify?", true, true);
    assert.ok(result?.prependContext, "prependContext should be present");
    assert.match(
      result.prependContext,
      /<memory-decision-trace>/,
      "compact decision trace block should be rendered"
    );
    assert.match(
      result.prependContext,
      /totalCandidates="/,
      "trace summary should include totalCandidates"
    );
  });
});
