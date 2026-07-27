import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractKeyInsights } from "../lib/dreaming/light-dream.js";
import { summarizeClusterWithLlm } from "../lib/dreaming/rem-dream.js";
import { inferEmotionalValenceAsync, setEmotionConfig } from "../lib/emotion.js";
import { enrichEpisodeNarratively } from "../lib/episodes.js";
import { runConflictResolver } from "../lib/jobs/conflict-resolver.js";
import { runConsolidation } from "../lib/jobs/daily-consolidation.js";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";
import { runSkillMiner } from "../lib/jobs/skill-miner.js";
import { extractSkillFromEvidence } from "../lib/jobs/skill-miner/llm-extractor.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(TEST_DIR, "..");
const AGENT_CONTEXTS = Object.freeze({
  compaction: { scopeId: "agent-a", purpose: "merge-decision" },
  conflict: { scopeId: "agent-a", purpose: "conflict-resolution" },
  skill: { scopeId: "agent-a", purpose: "skill-extraction" },
  lightDream: { scopeId: "agent-a", purpose: "conversation-insights" },
  remDream: { scopeId: "agent-a", purpose: "rem-pattern-analysis" },
  episode: { scopeId: "agent-a", purpose: "episode-analysis" },
});

function readSource(relativePath) {
  return readFileSync(join(ROOT_DIR, relativePath), "utf8");
}

function sourceSection(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  assert.notEqual(start, -1, `missing source start token: ${startToken}`);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.notEqual(end, -1, `missing source end token: ${endToken}`);
  return source.slice(start, end);
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

function skipQuoted(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === quote) {
      return index + 1;
    }
  }
  throw new Error(`unterminated ${quote} string`);
}

function findClosingDelimiter(source, start, open, close) {
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\"" || char === "'") {
      index = skipQuoted(source, index, char) - 1;
    } else if (char === "`") {
      index = skipTemplate(source, index) - 1;
    } else if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline;
    } else if (char === "/" && source[index + 1] === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      if (commentEnd === -1) throw new Error("unterminated block comment");
      index = commentEnd + 1;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`unterminated ${open}${close} expression`);
}

function skipTemplate(source, start) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
    } else if (source[index] === "`") {
      return index + 1;
    } else if (source[index] === "$" && source[index + 1] === "{") {
      index = findClosingDelimiter(source, index + 1, "{", "}");
    }
  }
  throw new Error("unterminated template string");
}

function extractCallExpressions(source, callee) {
  const expressions = [];
  const pattern = new RegExp(String.raw`\b${callee}\s*\(`, "g");
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const open = source.indexOf("(", match.index + callee.length);
    const close = findClosingDelimiter(source, open, "(", ")");
    expressions.push(source.slice(match.index, close + 1));
    pattern.lastIndex = close + 1;
  }
  return expressions;
}

function callArguments(expression) {
  const open = expression.indexOf("(");
  const close = findClosingDelimiter(expression, open, "(", ")");
  const args = [];
  let argumentStart = open + 1;
  for (let index = argumentStart; index < close; index += 1) {
    const char = expression[index];
    if (char === "\"" || char === "'") {
      index = skipQuoted(expression, index, char) - 1;
    } else if (char === "`") {
      index = skipTemplate(expression, index) - 1;
    } else if (char === "/" && expression[index + 1] === "/") {
      const newline = expression.indexOf("\n", index + 2);
      index = newline === -1 ? close : newline;
    } else if (char === "/" && expression[index + 1] === "*") {
      const commentEnd = expression.indexOf("*/", index + 2);
      if (commentEnd === -1) throw new Error("unterminated block comment");
      index = commentEnd + 1;
    } else if (char === "(" || char === "[" || char === "{") {
      const closing = char === "(" ? ")" : char === "[" ? "]" : "}";
      index = findClosingDelimiter(expression, index, char, closing);
    } else if (char === ",") {
      args.push(expression.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
  }
  const finalArg = expression.slice(argumentStart, close).trim();
  if (finalArg) args.push(finalArg);
  return args;
}

// requireTemperatureZero=false for EMOTION_CLASSIFICATION, MERGE_DECISION and
// KNOWLEDGE_UPDATE: the Kimi coding endpoint rejects any explicit temperature
// (HTTP 400, "only 0.6 is allowed"), so those calls leave it to the provider
// default. Their result cache stays agent- and purpose-scoped, just no longer
// temperature-pinned.
function countDeterministicCalls(source, purpose, scope = "agentId", requireTemperatureZero = true) {
  const temperatureOk = (text) => !requireTemperatureZero || /\btemperature\s*:\s*0\b/.test(text);
  return extractCallExpressions(source, "callLlm").filter((expression) => {
    const args = callArguments(expression);
    if (args.length !== 2) return false;
    const composed = extractCallExpressions(args[1], "withDeterministicLlmContext");
    if (composed.length === 1 && composed[0].trim() === args[1].trim()) {
      const composedArgs = callArguments(composed[0]);
      return composedArgs.length >= 4
        && composedArgs[1] === scope
        && composedArgs[2] === `LLM_RESULT_CACHE_PURPOSES.${purpose}`
        && temperatureOk(composedArgs[3]);
    }
    const contexts = extractCallExpressions(args[1], "withLlmCallContext");
    if (contexts.length !== 1 || contexts[0].trim() !== args[1].trim()) return false;
    const wrappers = extractCallExpressions(args[1], "withLlmResultCacheContext");
    if (wrappers.length !== 1) return false;
    const wrapperArgs = callArguments(wrappers[0]);
    return wrapperArgs.length === 3
      && temperatureOk(wrapperArgs[0])
      && wrapperArgs[1] === scope
      && wrapperArgs[2] === `LLM_RESULT_CACHE_PURPOSES.${purpose}`;
  }).length;
}

const TEMPERATURE_FREE_PURPOSES = new Set([
  "EMOTION_CLASSIFICATION",
  "MERGE_DECISION",
  "KNOWLEDGE_UPDATE",
]);

function assertEveryCallIsDeterministic(source, purpose, expectedCount, scope = "agentId") {
  const callCount = extractCallExpressions(source, "callLlm").length;
  assert.equal(callCount, expectedCount, `unexpected callLlm count for ${purpose}`);
  assert.equal(
    countDeterministicCalls(source, purpose, scope, !TEMPERATURE_FREE_PURPOSES.has(purpose)),
    expectedCount,
    `every ${purpose} callLlm must use its own deterministic cache wrapper`,
  );
}

function jsdocFor(source, signature) {
  const signatureIndex = source.indexOf(signature);
  assert.notEqual(signatureIndex, -1, `missing documented signature: ${signature}`);
  const prefix = source.slice(0, signatureIndex);
  const commentStart = prefix.lastIndexOf("/**");
  const commentEnd = prefix.lastIndexOf("*/");
  assert.ok(commentStart >= 0 && commentEnd > commentStart, `missing JSDoc for ${signature}`);
  assert.equal(prefix.slice(commentEnd + 2).trim(), "", `JSDoc must immediately precede ${signature}`);
  return prefix.slice(commentStart, commentEnd + 2);
}

function makeCompactionDb() {
  const now = Date.now();
  const rows = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      text: "alpha beta gamma",
      vector: [1, 0],
      createdAt: now,
      status: "active",
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      text: "alpha beta",
      vector: [1, 0],
      createdAt: now - 1,
      status: "active",
    },
  ];
  return {
    table: {
      query: () => ({
        limit: () => ({ toArray: async () => rows }),
      }),
      update: async () => {},
      add: async () => {},
    },
  };
}

function writeEligibleConflict(workspaceDir) {
  const logDir = join(workspaceDir, ".adaptive-learning");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "conflict-log.jsonl"), `${JSON.stringify({
    timestamp: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    newMemoryId: "33333333-3333-3333-3333-333333333333",
    existingMemoryId: "44444444-4444-4444-4444-444444444444",
    newText: "User prefers dark mode",
    existingText: "User prefers light mode",
  })}\n`, "utf8");
}

describe("deterministic LLM result-cache allowlist", () => {
  it("rejects a detached cache wrapper after a context-free LLM call", () => {
    const detachedWrapper = `
      callLlm(messages, llmCfg);
      withLlmResultCacheContext(
        { ...llmCfg, temperature: 0 },
        agentId,
        LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
      );
    `;

    assert.throws(
      () => assertEveryCallIsDeterministic(detachedWrapper, "CAPTURE_SUMMARY", 1),
      /must use its own deterministic cache wrapper/,
    );
  });

  it("attaches merge-decision context to memory compaction", async () => {
    let captureCfg;
    await runMemoryCompaction(makeCompactionDb(), {
      agentId: "agent-a",
      similarityThreshold: 0.5,
      dryRun: true,
      llmCfg: { model: "mock" },
      llmMergeTimeoutMs: 25,
      callLlm: async (_messages, cfg) => {
        captureCfg = cfg;
        return JSON.stringify({
          merge: true,
          reason: "compatible",
          mergedText: "alpha beta gamma merged",
        });
      },
      logger: { info: () => {}, warn: () => {} },
    });

    assert.deepEqual(captureCfg?.resultCacheContext, AGENT_CONTEXTS.compaction);
    assert.equal(captureCfg?.temperature, 0);
  });

  it("attaches conflict-resolution context to conflict resolution", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "llm-cache-conflict-"));
    try {
      writeEligibleConflict(workspaceDir);
      let captureCfg;

      await runConflictResolver({
        agentId: "agent-a",
        workspaceDir,
        llmCfg: { feature: "conflict-resolution", model: "mock" },
        llmTimeoutMs: 25,
        callLlm: async (_messages, cfg) => {
          captureCfg = cfg;
          return JSON.stringify({ resolution: "keep_a", confidence: 0.8, reason: "newer" });
        },
        minAgeDays: 7,
        dryRun: true,
        logger: { info: () => {}, warn: () => {} },
      });

      assert.deepEqual(captureCfg?.resultCacheContext, AGENT_CONTEXTS.conflict);
      assert.equal(captureCfg?.temperature, 0);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("forwards the consolidation agent to compaction and conflict resolution", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "llm-cache-consolidation-"));
    try {
      writeEligibleConflict(workspaceDir);
      const capturedCfgs = [];

      await runConsolidation(makeCompactionDb(), "agent-a", {
        workspaceDir,
        workspaceKey: "workspace-a",
        dryRun: true,
        compaction: { similarityThreshold: 0.5, autoApply: false },
        compactionLlmCfg: { feature: "memory-compaction", model: "mock" },
        conflictLlmCfg: { feature: "conflict-resolution", model: "mock" },
        llmMergeTimeoutMs: 25,
        callLlm: async (messages, cfg) => {
          capturedCfgs.push(cfg);
          const prompt = messages?.[0]?.content || "";
          if (prompt.includes("Two memory fragments")) {
            return JSON.stringify({
              merge: true,
              reason: "compatible",
              mergedText: "alpha beta gamma merged",
            });
          }
          return JSON.stringify({ resolution: "keep_a", confidence: 0.8, reason: "newer" });
        },
        logger: { info: () => {}, warn: () => {} },
      });

      const contexts = capturedCfgs.map((cfg) => cfg.resultCacheContext);
      assert.deepEqual(capturedCfgs.map((cfg) => cfg.feature).sort(), [
        "conflict-resolution",
        "memory-compaction",
      ]);
      assert.deepEqual(
        Object.fromEntries(contexts.map((context) => [context?.purpose, context?.scopeId])),
        {
          [AGENT_CONTEXTS.compaction.purpose]: AGENT_CONTEXTS.compaction.scopeId,
          [AGENT_CONTEXTS.conflict.purpose]: AGENT_CONTEXTS.conflict.scopeId,
        },
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("attaches skill-extraction context to skill extraction", async () => {
    let captureCfg;
    await extractSkillFromEvidence({
      memories: [{ text: "Use the same verified workflow every week." }],
    }, {
      agentId: "agent-a",
      llmCfg: { model: "mock" },
      timeoutMs: 25,
      callLlm: async (_messages, cfg) => {
        captureCfg = cfg;
        return JSON.stringify({ skip: true, confidence: 0 });
      },
    });

    assert.deepEqual(captureCfg?.resultCacheContext, AGENT_CONTEXTS.skill);
    assert.equal(captureCfg?.temperature, 0);
  });

  it("forwards the skill-miner agent to skill extraction", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "llm-cache-skill-miner-"));
    const rows = [{
      id: "skill-memory-1",
      text: "User confirmed the same weekly release verification workflow",
      category: "user_preference",
      origin: "user_confirmation",
      trustLevel: "validated",
      retrievalCount: 3,
      createdAt: Date.now(),
      status: "active",
    }];
    const db = {
      init: async () => {},
      table: {
        query: () => ({
          limit() { return this; },
          toArray: async () => rows,
        }),
      },
    };
    let captureCfg;

    try {
      await runSkillMiner(db, "agent-a", {
        workspaceDir,
        workspaceKey: "workspace-a",
        dryRun: true,
        llmCfg: { model: "mock" },
        callLlm: async (_messages, cfg) => {
          captureCfg = cfg;
          return JSON.stringify({ skip: true, confidence: 0 });
        },
        logger: { info: () => {}, warn: () => {} },
      });

      assert.deepEqual(captureCfg?.resultCacheContext, AGENT_CONTEXTS.skill);
      assert.equal(captureCfg?.temperature, 0);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("attaches conversation-insights context to light dreaming", async () => {
    let captureCfg;
    await extractKeyInsights([
      { agentId: "agent-a", role: "user", content: "Remember that the deployment window is Friday." },
    ], { model: "mock" }, async (_messages, cfg) => {
      captureCfg = cfg;
      return "[]";
    });

    assert.deepEqual(captureCfg?.resultCacheContext, AGENT_CONTEXTS.lightDream);
    assert.equal(captureCfg?.temperature, 0);
  });

  it("attaches rem-pattern-analysis context to REM pattern analysis", async () => {
    let captureCfg;
    await summarizeClusterWithLlm(
      [{ text: "The same deployment pattern recurs." }],
      { model: "mock" },
      async (_messages, cfg) => {
        captureCfg = cfg;
        return JSON.stringify({
          patternName: "Deployment cadence",
          description: "Deployments recur on Fridays.",
          trend: "gleich",
          confidence: 0.8,
        });
      },
      { warn: () => {} },
      "agent-a",
    );

    assert.deepEqual(captureCfg?.resultCacheContext, AGENT_CONTEXTS.remDream);
    assert.equal(captureCfg?.temperature, 0);
  });

  it("attaches episode-analysis context to episode enrichment", async () => {
    let captureCfg;
    const episode = { agentId: "fallback-agent", title: "Existing", summary: "Existing summary" };
    const turns = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Turn ${index} contains enough conversation material.`,
    }));

    await enrichEpisodeNarratively(episode, turns, { model: "mock" }, async (_messages, cfg) => {
      captureCfg = cfg;
      return JSON.stringify({ title: "Deployment", narrativeArc: "decision", summary: "A decision was made." });
    }, { agentId: "agent-a" });

    assert.deepEqual(captureCfg?.resultCacheContext, AGENT_CONTEXTS.episode);
    assert.equal(captureCfg?.temperature, 0);
  });

  it("forwards the real emotion agent scope through the full emotion stack", async () => {
    let providerContext;
    setEmotionConfig({
      tier: "t3",
      t2: { enabled: false },
      t3: {
        enabled: true,
        callLlm: async (_messages, context) => {
          providerContext = context;
          return JSON.stringify({
            valence: 0.5,
            arousal: 0.2,
            dominance: 0.1,
            intensity: 0.6,
            primary_emotion: "joy",
            emotion_labels: { joy: 1 },
            confidence: 0.9,
            language: "en",
          });
        },
      },
    });

    try {
      await inferEmotionalValenceAsync("This worked", "user", null, { agentId: "agent-a" });
    } finally {
      setEmotionConfig({ t3: { enabled: false } });
    }

    assert.deepEqual(providerContext, { agentId: "agent-a" });
  });

  it("binds every private index transform to its exact scope, purpose, and deterministic config", () => {
    const source = readSource("index.js");
    const captureSection = sourceSection(source, "async function summarizeForCapture", "// Baut eine querySummarizer-Funktion");
    const recallSection = sourceSection(source, "function makeQuerySummarizer", "const REINDEX_WRITE_THRESHOLD");
    const mergeSection = sourceSection(source, "async function callMergeCheck", "// Schicht 1.5 — Pending-Tracking");
    const bridgeStoreSection = sourceSection(source, "async function storeMemoryFromToolParams", "if (obsidianBridgeEnabled)");
    const modelStoreSection = sourceSection(source, "name: \"memory_store\"", "name: \"memory_forget\"");
    const knowledgeSection = sourceSection(source, "async function updateKnowledgeMd", "// applyImportanceBoost");
    const knowledgeToolSection = sourceSection(source, "name: \"knowledge_update\"", "names: [\"memory_recall\"");
    const emotionSection = sourceSection(source, "const emotionT3CallLlm", "if (emotionT3Enabled && emotionT3LlmCfg)");

    assert.match(source, /createLlmResultCache\(\{[\s\S]*?baseDbPath,[\s\S]*?logger: api\.logger,[\s\S]*?\}\)/);
    assert.match(source, /completeFeatureLlm\(messages, llmCfg,[\s\S]*?resultCacheContext: llmCfg\?\.resultCacheContext/);
    assert.match(source, /directCall: \(directMessages, directCfg\) => callOpenAiLlm\(directMessages, directCfg,[\s\S]*?resultCache: directCfg\?\.resultCache/);
    assertEveryCallIsDeterministic(captureSection, "CAPTURE_SUMMARY", 1);
    assertEveryCallIsDeterministic(recallSection, "RECALL_QUERY_SUMMARY", 1);
    assertEveryCallIsDeterministic(mergeSection, "MERGE_DECISION", 1);
    assertEveryCallIsDeterministic(knowledgeSection, "KNOWLEDGE_UPDATE", 2);
    assertEveryCallIsDeterministic(knowledgeToolSection, "KNOWLEDGE_UPDATE", 2);

    assert.doesNotMatch(source, /summarizeForCapture\(text, maxChars, mergingLlmCfg/);
    assert.doesNotMatch(source, /makeQuerySummarizer\(mergingLlmCfg/);
    assert.match(source, /summarizeForCapture\([\s\S]{0,250}?captureSummaryLlmCfg/);
    assert.equal(countMatches(source, /makeQuerySummarizer\(\s*(?:mergingEnabled\s*\?\s*)?recallQueryLlmCfg/g), 5);
    assert.equal(countMatches(bridgeStoreSection, /callMergeCheck\([\s\S]{0,220}?mergingLlmCfg,[\s\S]{0,80}?storeAgentId,[\s\S]{0,80}?storeCtx\.callContext/g), 1);
    assert.equal(countMatches(modelStoreSection, /callMergeCheck\(authoritativeCandidate\.text, params\.text, mergingLlmCfg, agentId\)/g), 1);
    assert.equal(countMatches(bridgeStoreSection, /withDurableMerge\(\{\s*db: storeDb,\s*agentId: storeAgentId,/g), 1);
    assert.equal(countMatches(modelStoreSection, /withDurableMerge\(\{\s*db,\s*agentId,/g), 1);

    const emotionCallCount = extractCallExpressions(emotionSection, "callLlm").length;
    const scopedEmotionCallCount = countDeterministicCalls(emotionSection, "EMOTION_CLASSIFICATION", "context.agentId", false);
    assert.equal(scopedEmotionCallCount, 1);
    const emotionCfgInitializer = sourceSection(emotionSection, "const emotionLlmCfg = withLlmCallContext(", "return context.agentId");
    assert.doesNotMatch(
      emotionCfgInitializer,
      /resultCacheContext|withLlmResultCacheContext|["'](?:default|shared)["']/,
    );
    const missingAgentCalls = extractCallExpressions(emotionSection, "callLlm").filter((expression) => {
      const args = callArguments(expression);
      return args.length === 2 && args[0] === "messages" && args[1] === "emotionLlmCfg";
    });
    assert.equal(missingAgentCalls.length, 1);
    assert.equal(scopedEmotionCallCount + missingAgentCalls.length, emotionCallCount);
  });

  it("documents every new agent-scope and context carrier", () => {
    const contracts = [
      ["index.js", "async function summarizeForCapture", ["@param {string} agentId", "@returns {Promise<string>}"]],
      ["index.js", "function makeQuerySummarizer", ["@param {string} agentId", "@returns {Function|null}"]],
      ["index.js", "async function callMergeCheck", ["@param {string} agentId", "@returns {Promise<object|null>}"]],
      ["index.js", "async function updateKnowledgeMd", ["@param {string} agentId", "@returns {Promise<void>}"]],
      ["index.js", "(messages, context = {}) =>", ["@param {Array<object>} messages", "@param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [context]", "@returns {Promise<string|null>}"]],
      ["lib/jobs/conflict-resolver.js", "async function resolveConflictPair", ["@param {string} agentId", "@returns {Promise<object>}"]],
      ["lib/jobs/conflict-resolver.js", "export async function runConflictResolver", ["@param {string} [opts.agentId]", "@returns {Promise<object>}"]],
      ["lib/jobs/memory-compaction.js", "async function callMergeCheck", ["@param {string} agentId", "@returns {Promise<object|null>}"]],
      ["lib/jobs/memory-compaction.js", "async function generateCompactionActions", ["@param {string} opts.agentId", "@returns {Promise<Array<object>>}"]],
      ["lib/jobs/memory-compaction.js", "export async function runMemoryCompaction", ["@param {string} [opts.agentId]", "@returns {Promise<object>}"]],
      ["lib/jobs/skill-miner/llm-extractor.js", "export async function extractSkillFromEvidence", ["@param {string} [opts.agentId]", "@returns {Promise<object>}"]],
      ["lib/episodes.js", "export async function enrichEpisodeNarratively", ["@param {string} [opts.agentId]", "@returns {Promise<object>}"]],
      ["lib/episodes.js", "export async function extractEpisodesFromTurns", ["@param {string} [opts.agentId]", "@returns {Promise<Array>}"]],
      ["lib/dreaming/light-dream.js", "export async function extractKeyInsights", ["agentId?: string", "@returns {Promise<"]],
      ["lib/dreaming/light-dream.js", "export async function lightDream", ["agentId?: string", "@returns {Promise<Object>}"]],
      ["lib/dreaming/rem-dream.js", "export async function summarizeClusterWithLlm", ["@param {string} [agentId=\"default\"]", "@returns {Promise<object>}"]],
      ["lib/dreaming/rem-dream.js", "export async function runRemDream", ["@param {string} [params.agentId", "@returns {Promise<object>}"]],
      ["lib/emotion.js", "export async function inferEmotionalValenceAsync", ["@param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [context]", "@returns {Promise<"]],
      ["lib/emotion-engine.js", "async analyze", ["@param {{agentId?: string, signal?: AbortSignal}} [context]", "@returns {Promise<EmotionScore>}"]],
      ["lib/emotion-engine.js", "async _tier3Only", ["@param {{agentId?: string, signal?: AbortSignal}} [context]", "@returns {Promise<EmotionScore>}"]],
      ["lib/emotion-engine.js", "async _defaultRouting", ["@param {{agentId?: string, signal?: AbortSignal}} [context]", "@returns {Promise<EmotionScore>}"]],
      ["lib/emotion-engine.js", "async _maybeT3", ["@param {{agentId?: string, signal?: AbortSignal}} [context]", "@returns {Promise<EmotionScore>}"]],
      ["lib/tier3-llm.js", "async classify", ["@param {{agentId?: string, signal?: AbortSignal}} [context]", "@returns {Promise<EmotionScore>}"]],
    ];

    for (const [relativePath, signature, fragments] of contracts) {
      const doc = jsdocFor(readSource(relativePath), signature);
      for (const fragment of fragments) {
        assert.match(doc, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    }
  });
});

describe("non-deterministic and live LLM exclusion boundary", () => {
  const excludedFiles = [
    "lib/wiki-command.js",
    "lib/dreaming/dream-narrative.js",
    "lib/dream-echo.js",
    "lib/afterthought.js",
    "lib/persona-voice.js",
    "lib/jobs/critical-classifier.js",
    "lib/critical-push-classifier.js",
    "lib/overlay-commands.js",
    "lib/overlay-generator.js",
    "lib/interpretation-overlay.js",
  ];

  for (const relativePath of excludedFiles) {
    it(`keeps ${relativePath} context-free`, () => {
      const source = readSource(relativePath);
      assert.doesNotMatch(source, /resultCacheContext/);
      assert.doesNotMatch(source, /LLM_RESULT_CACHE_PURPOSES/);
      assert.doesNotMatch(source, /withLlmResultCacheContext/);
    });
  }
});
