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
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";
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

describe("deterministic LLM result-cache allowlist", () => {
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
      const logDir = join(workspaceDir, ".adaptive-learning");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, "conflict-log.jsonl"), `${JSON.stringify({
        timestamp: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        newMemoryId: "33333333-3333-3333-3333-333333333333",
        existingMemoryId: "44444444-4444-4444-4444-444444444444",
        newText: "User prefers dark mode",
        existingText: "User prefers light mode",
      })}\n`, "utf8");
      let captureCfg;

      await runConflictResolver({
        agentId: "agent-a",
        workspaceDir,
        llmCfg: { model: "mock" },
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

  it("wires private index transforms to their exact cache purposes", () => {
    const source = readSource("index.js");

    assert.match(source, /createLlmResultCache\(\{[\s\S]*?baseDbPath,[\s\S]*?logger: api\.logger,[\s\S]*?\}\)/);
    assert.match(source, /callOpenAiLlm\(messages, llmCfg, \{[\s\S]*?resultCache: llmCfg\?\.resultCache[\s\S]*?\}\)/);
    assert.match(source, /summarizeForCapture\(text, maxChars, llmCfg, logger, agentId\)/);
    assert.match(source, /CAPTURE_SUMMARY/);
    assert.match(source, /makeQuerySummarizer\(llmCfg, logger, agentId\)/);
    assert.match(source, /RECALL_QUERY_SUMMARY/);
    assert.match(source, /callMergeCheck\(existingText, newText, llmCfg, agentId\)/);
    assert.match(source, /MERGE_DECISION/);
    assert.match(source, /context\.agentId[\s\S]*?EMOTION_CLASSIFICATION/);
    assert.ok((source.match(/KNOWLEDGE_UPDATE/g) || []).length >= 4, "all knowledge update and compaction calls must opt in");
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
