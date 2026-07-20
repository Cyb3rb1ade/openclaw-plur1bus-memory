import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractKeyInsights } from "../lib/dreaming/light-dream.js";
import { generateDreamNarrative } from "../lib/dreaming/dream-narrative.js";
import { summarizeClusterWithLlm } from "../lib/dreaming/rem-dream.js";
import { ContradictionDetector } from "../lib/contradiction-detector.js";
import { runConflictResolver } from "../lib/jobs/conflict-resolver.js";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";
import { extractSkillFromEvidence } from "../lib/jobs/skill-miner/llm-extractor.js";
import { withAbortableLlmTimeout } from "../lib/llm-failure.js";
import { OverlayGenerator } from "../lib/overlay-generator.js";

const SECRET = "Authorization Bearer TEST_SECRET";
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureLogger() {
  const entries = [];
  return {
    entries,
    logger: {
      info: (...args) => entries.push(["info", ...args]),
      warn: (...args) => entries.push(["warn", ...args]),
      debug: (...args) => entries.push(["debug", ...args]),
    },
  };
}

function serialized(value) {
  return JSON.stringify(value);
}

function makeEvidenceGroup() {
  return {
    memories: [{ id: "m1", text: "A validated workflow", trustLevel: "validated" }],
  };
}

function makeConflictWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-llm-hygiene-"));
  tempDirs.push(dir);
  const adaptiveDir = join(dir, ".adaptive-learning");
  mkdirSync(adaptiveDir, { recursive: true });
  writeFileSync(join(adaptiveDir, "conflict-log.jsonl"), `${JSON.stringify({
    timestamp: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    newMemoryId: "11111111-1111-1111-1111-111111111111",
    existingMemoryId: "22222222-2222-2222-2222-222222222222",
    newText: "User prefers dark mode",
    existingText: "User prefers light mode",
  })}\n`, "utf8");
  return dir;
}

function makeCompactionDb() {
  const now = Date.now();
  const rows = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      text: "User prefers dark mode in all applications",
      vector: [1, 0],
      createdAt: now,
      status: "active",
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      text: "User prefers dark mode",
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
    },
  };
}

async function trackTimers(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const created = [];
  const cleared = new Set();
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = originalSetTimeout(callback, ms, ...args);
    created.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    cleared.add(timer);
    return originalClearTimeout(timer);
  };
  try {
    await run();
    return { created, cleared };
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    for (const timer of created) originalClearTimeout(timer);
  }
}

describe("LLM caller error hygiene", () => {
  it("keeps provider error text out of skill-miner logs and results", async () => {
    const { logger, entries } = captureLogger();
    const result = await extractSkillFromEvidence(makeEvidenceGroup(), {
      llmCfg: { model: "mock" },
      callLlm: async () => { throw new Error(SECRET); },
      logger,
    });

    assert.strictEqual(result.reason, "llm_error");
    assert.doesNotMatch(serialized({ entries, result }), /TEST_SECRET|Authorization|Bearer/);
  });

  it("classifies malformed skill-miner output as invalid_response", async () => {
    const result = await extractSkillFromEvidence(makeEvidenceGroup(), {
      llmCfg: { model: "mock" },
      callLlm: async () => "not-json",
    });

    assert.strictEqual(result.reason, "invalid_response");
  });

  it("persists only a stable conflict failure reason", async () => {
    const workspaceDir = makeConflictWorkspace();
    const { logger, entries } = captureLogger();
    const result = await runConflictResolver({
      workspaceDir,
      llmCfg: { model: "mock" },
      callLlm: async () => { throw new Error(SECRET); },
      logger,
      minAgeDays: 7,
    });
    const resolvedPath = join(workspaceDir, ".adaptive-learning", "conflict-resolved.jsonl");

    assert.strictEqual(existsSync(resolvedPath), true);
    const persisted = readFileSync(resolvedPath, "utf8");
    assert.strictEqual(JSON.parse(persisted).reason, "llm_error");
    assert.doesNotMatch(serialized({ entries, result, persisted }), /TEST_SECRET|Authorization|Bearer/);
  });

  it("keeps provider error text out of memory-compaction logs and results", async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    const { logger, entries } = captureLogger();
    try {
      const result = await runMemoryCompaction(makeCompactionDb(), {
        llmCfg: { model: "mock" },
        callLlm: async () => { throw new Error(SECRET); },
        logger,
        dryRun: true,
        timeoutMs: 1000,
      });
      assert.match(serialized(entries), /errorClass/);
      assert.doesNotMatch(serialized({ entries, warnings, result }), /TEST_SECRET|Authorization|Bearer/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("keeps provider error text out of REM-dream logs and fallback results", async () => {
    const { logger, entries } = captureLogger();
    const result = await summarizeClusterWithLlm(
      [{ text: "A recurring topic" }],
      { model: "mock" },
      async () => { throw new Error(SECRET); },
      logger,
    );

    assert.doesNotMatch(serialized({ entries, result }), /TEST_SECRET|Authorization|Bearer/);
  });

  it("returns only a stable light-dream failure reason", async () => {
    const { logger, entries } = captureLogger();
    const result = await extractKeyInsights(
      [{ role: "user", content: "A substantive turn" }],
      { model: "mock", logger },
      async () => { throw new Error(SECRET); },
    );

    assert.strictEqual(result.error, "llm_error");
    assert.doesNotMatch(serialized({ entries, result }), /TEST_SECRET|Authorization|Bearer/);
  });

  it("keeps provider error text out of dream-narrative logs", async () => {
    const { logger, entries } = captureLogger();
    const result = await generateDreamNarrative({
      mode: "light",
      llmCfg: {},
      callLlm: async () => { throw new Error(SECRET); },
      material: ["A substantive memory"],
      logger,
    });

    assert.strictEqual(result, null);
    assert.match(serialized(entries), /llm_error/);
    assert.doesNotMatch(serialized(entries), /TEST_SECRET|Authorization|Bearer/);
  });

  it("keeps provider error text out of overlay-generation logs", async () => {
    const { logger, entries } = captureLogger();
    const generator = new OverlayGenerator({
      enabled: true,
      llm: async () => { throw new Error(SECRET); },
      logger,
    });
    const result = await generator.generate({
      memory: { id: "memory-1", text: "We chose Postgres." },
      conversationContext: "Since then, the context changed.",
      relevanceScore: 0.9,
    });

    assert.strictEqual(result, null);
    assert.match(serialized(entries), /llm_error/);
    assert.doesNotMatch(serialized(entries), /TEST_SECRET|Authorization|Bearer/);
  });

  it("keeps provider error text out of contradiction logs", async () => {
    const { logger, entries } = captureLogger();
    const detector = new ContradictionDetector({
      llm: async () => { throw new Error(SECRET); },
      logger,
    });
    const result = await detector.findContradictions([
      { id: "overlay-a", targetMemoryId: "memory-1", shiftType: "meaning", shiftDescription: "Use Postgres." },
      { id: "overlay-b", targetMemoryId: "memory-1", shiftType: "meaning", shiftDescription: "Use MySQL." },
    ]);

    assert.deepStrictEqual(result, []);
    assert.match(serialized(entries), /llm_error/);
    assert.doesNotMatch(serialized(entries), /TEST_SECRET|Authorization|Bearer/);
  });

  it("uses safe failure logging in capture summarization", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    const start = source.indexOf("async function summarizeForCapture");
    const end = source.indexOf("// Baut eine querySummarizer-Funktion", start);
    const section = source.slice(start, end);

    assert.match(section, /safeWarnLlmFailure\(/);
    assert.doesNotMatch(section, /\$\{e\.message\}|\$\{String\(e\)\}/);
  });
});

describe("LLM caller timeout cleanup", () => {
  it("does not start a transport for an already-aborted caller signal", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    let starts = 0;
    let lateEffects = 0;

    await assert.rejects(
      withAbortableLlmTimeout(async () => {
        starts += 1;
        lateEffects += 1;
        return "late";
      }, { signal: controller.signal, timeoutMs: 10_000 }),
      { name: "AbortError" },
    );
    await Promise.resolve();

    assert.strictEqual(starts, 0);
    assert.strictEqual(lateEffects, 0);
  });

  it("clears the skill-miner timeout after a fast response", async () => {
    const { created, cleared } = await trackTimers(() => extractSkillFromEvidence(makeEvidenceGroup(), {
      llmCfg: { model: "mock" },
      callLlm: async () => JSON.stringify({ skip: true, confidence: 0 }),
      timeoutMs: 10_000,
    }));

    assert.ok(created.length > 0);
    assert.ok(created.every((timer) => cleared.has(timer)));
  });

  it("clears the conflict-resolver timeout after a fast response", async () => {
    const workspaceDir = makeConflictWorkspace();
    const { created, cleared } = await trackTimers(() => runConflictResolver({
      workspaceDir,
      llmCfg: { model: "mock" },
      callLlm: async () => JSON.stringify({ resolution: "uncertain", confidence: 0, reason: "review" }),
      llmTimeoutMs: 10_000,
      logger: { info: () => {}, warn: () => {} },
    }));

    assert.ok(created.length > 0);
    assert.ok(created.every((timer) => cleared.has(timer)));
  });

  it("clears the compaction LLM timeout after a fast response", async () => {
    const { created, cleared } = await trackTimers(() => runMemoryCompaction(makeCompactionDb(), {
      llmCfg: { model: "mock" },
      callLlm: async () => JSON.stringify({ merge: false, reason: "review" }),
      llmMergeTimeoutMs: 10_000,
      timeoutMs: 20_000,
      dryRun: true,
    }));

    assert.ok(created.length > 0);
    assert.ok(created.every((timer) => cleared.has(timer)));
  });

  it("aborts the skill-miner transport when its local timeout fires", async () => {
    let transportSignal;
    const result = await extractSkillFromEvidence(makeEvidenceGroup(), {
      llmCfg: { model: "mock" },
      callLlm: async (_messages, cfg) => {
        transportSignal = cfg.callContext.signal;
        return new Promise(() => {});
      },
      timeoutMs: 20,
    });

    assert.strictEqual(result.reason, "timeout");
    assert.strictEqual(transportSignal.aborted, true);
  });

  it("aborts the conflict-resolver transport when its local timeout fires", async () => {
    const workspaceDir = makeConflictWorkspace();
    let transportSignal;
    await runConflictResolver({
      workspaceDir,
      llmCfg: { model: "mock" },
      callLlm: async (_messages, cfg) => {
        transportSignal = cfg.callContext.signal;
        return new Promise(() => {});
      },
      llmTimeoutMs: 20,
      logger: { info: () => {}, warn: () => {} },
    });
    const persisted = JSON.parse(readFileSync(
      join(workspaceDir, ".adaptive-learning", "conflict-resolved.jsonl"),
      "utf8",
    ));

    assert.strictEqual(persisted.reason, "timeout");
    assert.strictEqual(transportSignal.aborted, true);
  });

  it("aborts the compaction LLM transport when its local timeout fires", async () => {
    let transportSignal;
    await runMemoryCompaction(makeCompactionDb(), {
      llmCfg: { model: "mock" },
      callLlm: async (_messages, cfg) => {
        transportSignal = cfg.callContext.signal;
        return new Promise(() => {});
      },
      llmMergeTimeoutMs: 20,
      timeoutMs: 1000,
      dryRun: true,
    });

    assert.strictEqual(transportSignal.aborted, true);
  });
});
