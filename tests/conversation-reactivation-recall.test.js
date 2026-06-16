// tests/conversation-reactivation-recall.test.js
//
// Unit tests for Conversation Reactivation Recall (CRR).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  shouldRunConversationReactivation,
  selectReactivationMemories,
  formatReactivationContext,
  runConversationReactivationRecall,
  markUserTurn,
  markCrrRun,
} from "../lib/conversation-reactivation-recall.js";

describe("conversation-reactivation-recall", () => {
  const now = 1_000_000_000_000;
  const baseCfg = {
    enabled: true,
    idleThresholdMinutes: 45,
    cooldownMinutes: 30,
    maxReactivationMemories: 3,
    maxFadedReactivationMemories: 1,
    maxOpenThreads: 3,
    maxCommunities: 2,
    timeoutMs: 50,
    visibleHints: false,
  };

  beforeEach(() => {
    // Each test gets a fresh module state via re-importing would be ideal,
    // but node:test does not isolate module state between tests. We rely on
    // unique agentId/sessionKey pairs per test to avoid cross-test pollution.
  });

  // ── shouldRunConversationReactivation ───────────────────────────────────────

  describe("shouldRunConversationReactivation", () => {
    it("returns false when feature is disabled", async () => {
      const result = shouldRunConversationReactivation({
        cfg: { ...baseCfg, enabled: false },
        now,
        lastUserTurnAt: now - 60 * 60 * 1000,
        messageText: "wie machen wir weiter?",
        baseRecallTopScore: 0.1,
      });
      assert.strictEqual(result, false);
    });

    it("returns false for empty/whitespace message", async () => {
      for (const messageText of ["", "   ", null, undefined]) {
        const result = shouldRunConversationReactivation({
          cfg: baseCfg,
          now,
          lastUserTurnAt: now - 60 * 60 * 1000,
          messageText,
          baseRecallTopScore: 0.1,
        });
        assert.strictEqual(result, false, `expected false for messageText=${JSON.stringify(messageText)}`);
      }
    });

    it("returns false when cooldown is active", async () => {
      const result = shouldRunConversationReactivation({
        cfg: baseCfg,
        now,
        lastUserTurnAt: now - 60 * 60 * 1000,
        lastCrrAt: now - 5 * 60 * 1000,
        messageText: "wie machen wir weiter?",
        baseRecallTopScore: 0.1,
      });
      assert.strictEqual(result, false);
    });

    it("returns false for short irrelevant message 'ok'", async () => {
      const result = shouldRunConversationReactivation({
        cfg: baseCfg,
        now,
        lastUserTurnAt: now - 60 * 60 * 1000,
        messageText: "ok",
        baseRecallTopScore: 0.1,
      });
      assert.strictEqual(result, false);
    });

    it("returns false when base recall top score is high and no other signal", async () => {
      const result = shouldRunConversationReactivation({
        cfg: baseCfg,
        now,
        lastUserTurnAt: now - 5 * 60 * 1000,
        messageText: "hello again",
        baseRecallTopScore: 0.9,
      });
      assert.strictEqual(result, false);
    });

    it("returns true on idle trigger", async () => {
      const result = shouldRunConversationReactivation({
        cfg: baseCfg,
        now,
        lastUserTurnAt: now - 60 * 60 * 1000,
        messageText: "hello again",
        baseRecallTopScore: 0.1,
      });
      assert.strictEqual(result, true);
    });

    it("returns true on continuation trigger 'wie machen wir weiter?'", async () => {
      const result = shouldRunConversationReactivation({
        cfg: baseCfg,
        now,
        lastUserTurnAt: now - 5 * 60 * 1000,
        messageText: "wie machen wir weiter?",
        baseRecallTopScore: 0.1,
      });
      assert.strictEqual(result, true);
    });

    it("returns true on first real user message", async () => {
      const result = shouldRunConversationReactivation({
        cfg: baseCfg,
        now,
        lastUserTurnAt: null,
        messageText: "let us continue the project",
        baseRecallTopScore: 0.1,
      });
      assert.strictEqual(result, true);
    });

    it("returns true when compaction happened after last CRR", async () => {
      const result = shouldRunConversationReactivation({
        cfg: baseCfg,
        now,
        lastUserTurnAt: now - 5 * 60 * 1000,
        lastCrrAt: now - 60 * 60 * 1000,
        compactedAt: now - 30 * 60 * 1000,
        messageText: "hello again",
        baseRecallTopScore: 0.9,
      });
      assert.strictEqual(result, true);
    });

    it("treats short continuation signal as valid", async () => {
      const result = shouldRunConversationReactivation({
        cfg: baseCfg,
        now,
        lastUserTurnAt: now - 5 * 60 * 1000,
        messageText: "weiter",
        baseRecallTopScore: 0.9,
      });
      assert.strictEqual(result, true);
    });
  });

  // ── selectReactivationMemories ──────────────────────────────────────────────

  describe("selectReactivationMemories", () => {
    const prompt = "we should continue the dashboard project";

    it("returns empty when limits are zero", async () => {
      const result = await selectReactivationMemories({
        prompt,
        baseRecallIds: new Set(),
        semanticLens: { communities: [], memories: [], entries: {} },
        cfg: { ...baseCfg, maxReactivationMemories: 0 },
      });
      assert.deepStrictEqual(result.memories, []);
    });

    it("dedupes against base recall ids", async () => {
      const memory = {
        id: "m1",
        category: "project",
        display: "dashboard project plan",
      };
      const result = await selectReactivationMemories({
        prompt,
        baseRecallIds: new Set(["m1"]),
        semanticLens: {
          communities: [],
          memories: [memory],
          entries: {},
        },
        cfg: baseCfg,
      });
      assert.strictEqual(result.memories.length, 0);
    });

    it("selects community representatives matching prompt", async () => {
      const memory = {
        id: "m1",
        category: "project",
        display: "dashboard project architecture decisions",
      };
      const result = await selectReactivationMemories({
        prompt,
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [
            { id: "c1", representativeMemoryIds: ["m1"] },
          ],
          memories: [memory],
          entries: {},
        },
        cfg: baseCfg,
      });
      assert.strictEqual(result.memories.length, 1);
      assert.strictEqual(result.memories[0].id, "m1");
      assert.strictEqual(result.memories[0].source, "semantic-lens-community");
    });

    it("selects bridge memories via graph edges", async () => {
      const baseMemory = { id: "base1", category: "work", display: "base memory" };
      const bridgeMemory = { id: "bridge1", category: "work", display: "bridge memory" };
      const result = await selectReactivationMemories({
        prompt,
        baseRecallIds: new Set(["base1"]),
        semanticLens: {
          communities: [],
          memories: [baseMemory, bridgeMemory],
          entries: {},
        },
        graphEdges: [{ source: "base1", target: "bridge1", weight: 0.8 }],
        cfg: baseCfg,
      });
      assert.strictEqual(result.memories.length, 1);
      assert.strictEqual(result.memories[0].id, "bridge1");
      assert.strictEqual(result.memories[0].source, "graph-bridge");
    });

    it("selects open project/plan memories on continuation signal", async () => {
      const memory = {
        id: "m2",
        category: "plan",
        display: "finish dashboard ui plan",
      };
      const result = await selectReactivationMemories({
        prompt: "continue dashboard plan",
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [],
          memories: [memory],
          entries: {},
        },
        cfg: baseCfg,
      });
      assert.strictEqual(result.memories.length, 1);
      assert.strictEqual(result.memories[0].id, "m2");
      assert.strictEqual(result.memories[0].source, "open-project");
    });

    it("respects maxReactivationMemories limit", async () => {
      const memories = [
        { id: "m1", category: "project", display: "dashboard one" },
        { id: "m2", category: "project", display: "dashboard two" },
        { id: "m3", category: "project", display: "dashboard three" },
        { id: "m4", category: "project", display: "dashboard four" },
      ];
      const result = await selectReactivationMemories({
        prompt,
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [{ id: "c1", representativeMemoryIds: ["m1", "m2", "m3", "m4"] }],
          memories,
          entries: {},
        },
        cfg: { ...baseCfg, maxReactivationMemories: 2 },
      });
      assert.strictEqual(result.memories.length, 2);
    });

    it("respects maxFadedReactivationMemories limit", async () => {
      const memories = [
        { id: "m1", category: "memory", display: "faded one", faded: true, memoryStrength: 0.1 },
        { id: "m2", category: "memory", display: "faded two", faded: true, memoryStrength: 0.1 },
      ];
      const result = await selectReactivationMemories({
        prompt: "dashboard faded one faded two",
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [],
          memories,
          entries: {},
        },
        cfg: { ...baseCfg, maxReactivationMemories: 3, maxFadedReactivationMemories: 1 },
      });
      const fadedCount = result.memories.filter((m) => m.faded).length;
      assert.strictEqual(fadedCount, 1);
    });

    it("respects maxCommunities limit", async () => {
      const memories = [
        { id: "m1", category: "topic", display: "community one dashboard" },
        { id: "m2", category: "topic", display: "community two dashboard" },
        { id: "m3", category: "topic", display: "community three dashboard" },
      ];
      const result = await selectReactivationMemories({
        prompt: "dashboard community",
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [
            { id: "c1", representativeMemoryIds: ["m1"] },
            { id: "c2", representativeMemoryIds: ["m2"] },
            { id: "c3", representativeMemoryIds: ["m3"] },
          ],
          memories,
          entries: {},
        },
        cfg: { ...baseCfg, maxCommunities: 2, maxReactivationMemories: 10 },
      });
      assert.strictEqual(result.memories.length, 2);
      assert.ok(!result.memories.some((m) => m.id === "m3"));
    });

    it("skips candidates without usable display text", async () => {
      const result = await selectReactivationMemories({
        prompt,
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [{ id: "c1", representativeMemoryIds: ["m1"] }],
          memories: [{ id: "m1", category: "project" }],
          entries: {},
        },
        cfg: baseCfg,
      });
      assert.strictEqual(result.memories.length, 0);
    });

    it("does not select anything when prompt has no token overlap", async () => {
      const memory = { id: "m1", category: "project", display: "dashboard plan" };
      const result = await selectReactivationMemories({
        prompt: "totally unrelated topic",
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [{ id: "c1", representativeMemoryIds: ["m1"] }],
          memories: [memory],
          entries: {},
        },
        cfg: baseCfg,
      });
      assert.strictEqual(result.memories.length, 0);
    });

    it("enforces hard caps even when config exceeds them", async () => {
      const memories = [
        { id: "m1", category: "project", display: "dashboard one" },
        { id: "m2", category: "project", display: "dashboard two" },
        { id: "m3", category: "project", display: "dashboard three" },
        { id: "m4", category: "project", display: "dashboard four" },
      ];
      const result = await selectReactivationMemories({
        prompt: "dashboard project",
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [{ id: "c1", representativeMemoryIds: ["m1", "m2", "m3", "m4"] }],
          memories,
          entries: {},
        },
        cfg: { ...baseCfg, maxReactivationMemories: 10, maxFadedReactivationMemories: 5, maxOpenThreads: 10, maxCommunities: 10 },
      });
      assert.strictEqual(result.memories.length, 3);
    });

    it("does not hydrate in-map community candidates that do not overlap", async () => {
      let hydrateCalls = 0;
      const getMemoryById = async (id) => {
        hydrateCalls++;
        return { id, category: "topic", display: `hydrated ${id}` };
      };
      const result = await selectReactivationMemories({
        prompt: "only specific tokens match",
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [{ id: "c1", representativeMemoryIds: ["m1", "m2", "m3", "m4"] }],
          memories: [
            { id: "m1", category: "topic", display: "alpha beta gamma" },
            { id: "m2", category: "topic", display: "alpha beta gamma" },
            { id: "m3", category: "topic", display: "match specific tokens" },
            { id: "m4", category: "topic", display: "alpha beta gamma" },
          ],
          entries: {},
        },
        cfg: baseCfg,
        getMemoryById,
      });
      assert.strictEqual(result.memories.length, 1);
      assert.strictEqual(result.memories[0].id, "m3");
      assert.strictEqual(hydrateCalls, 0, "in-map candidates should not trigger getMemoryById");
    });

    it("limits getMemoryById calls for community candidates missing from lens map", async () => {
      let hydrateCalls = 0;
      const getMemoryById = async (id) => {
        hydrateCalls++;
        return { id, category: "topic", display: `hydrated ${id}` };
      };
      const communities = [];
      for (let c = 0; c < 20; c++) {
        const reps = [];
        for (let i = 0; i < 10; i++) reps.push(`c${c}-m${i}`);
        communities.push({ id: `c${c}`, representativeMemoryIds: reps, bridgeMemoryIds: [] });
      }
      const result = await selectReactivationMemories({
        prompt: "no overlap anywhere",
        baseRecallIds: new Set(),
        semanticLens: { communities, memories: [], entries: {} },
        cfg: baseCfg,
        getMemoryById,
      });
      assert.strictEqual(result.memories.length, 0);
      assert.ok(hydrateCalls > 0, "should attempt some hydration");
      assert.ok(hydrateCalls <= 3, `expected <=3 hydrations, got ${hydrateCalls}`);
    });

    it("still hydrates selected memories that are not in the lens map", async () => {
      let hydrateCalls = 0;
      const getMemoryById = async (id) => {
        hydrateCalls++;
        if (id === "m1") {
          return { id: "m1", category: "project", display: "dashboard project plan" };
        }
        return null;
      };
      const result = await selectReactivationMemories({
        prompt: "continue dashboard project",
        baseRecallIds: new Set(),
        semanticLens: {
          communities: [{ id: "c1", representativeMemoryIds: ["m1"] }],
          memories: [],
          entries: {},
        },
        cfg: baseCfg,
        getMemoryById,
      });
      assert.strictEqual(result.memories.length, 1);
      assert.strictEqual(result.memories[0].id, "m1");
      assert.strictEqual(hydrateCalls, 1, "selected missing memory should be hydrated exactly once");
    });
  });

  // ── formatReactivationContext ───────────────────────────────────────────────

  describe("formatReactivationContext", () => {
    it("returns empty string when no memories", async () => {
      assert.strictEqual(formatReactivationContext([]), "");
      assert.strictEqual(formatReactivationContext(null), "");
      assert.strictEqual(formatReactivationContext(undefined), "");
    });

    it("emits <memory-reactivation> block only when additions exist", async () => {
      const out = formatReactivationContext([{
        id: "m1",
        category: "project",
        display: "dashboard plan",
      }]);
      assert.ok(out.includes("<memory-reactivation"));
      assert.ok(out.includes('untrusted="true"'));
      assert.ok(out.includes('mode="historical-evidence-only"'));
      assert.ok(out.includes("RECALL SAFETY:"));
      assert.ok(out.includes("<memory-record"));
      assert.ok(out.includes('source="reactivation"'));
    });

    it("adds faded attribute for faded memories", async () => {
      const out = formatReactivationContext([{
        id: "m1",
        category: "project",
        display: "old plan",
        faded: true,
      }]);
      assert.ok(out.includes('faded="true"'));
    });

    it("visibleHints off by default and adds tiny intro only when true", async () => {
      const outOff = formatReactivationContext([{
        id: "m1",
        category: "project",
        display: "plan",
      }]);
      const outOn = formatReactivationContext([{
        id: "m1",
        category: "project",
        display: "plan",
      }], { visibleHints: true });
      assert.ok(!outOff.includes("[HINT:"));
      assert.ok(outOn.includes("[HINT:"));
    });

    it("sanitizes memory text and attributes", async () => {
      const out = formatReactivationContext([{
        id: 'm1" data-x="y',
        category: "project",
        display: "<script>alert(1)</script>",
      }]);
      assert.ok(!out.includes("<script>"));
      assert.ok(!out.includes('data-x="y"'));
      assert.ok(out.includes("m1_data-x_y"));
    });
  });

  // ── runConversationReactivationRecall ───────────────────────────────────────

  describe("runConversationReactivationRecall", () => {
    function makeArgs(overrides = {}) {
      return {
        prompt: "continue dashboard project",
        messageText: "continue dashboard project",
        baseRecallIds: new Set(),
        workspaceDir: null,
        neoStore: null,
        graphEdges: [],
        cfg: baseCfg,
        agentId: `agent-${Math.random()}`,
        sessionKey: `session-${Math.random()}`,
        now,
        logger: { warn: () => {}, debug: () => {} },
        ...overrides,
      };
    }

    it("disabled feature returns empty context", async () => {
      const args = makeArgs({ cfg: { ...baseCfg, enabled: false } });
      const result = await runConversationReactivationRecall(args);
      assert.strictEqual(result.context, "");
      assert.deepStrictEqual(result.additions, []);
    });

    it("missing state does not crash", async () => {
      const args = makeArgs({ agentId: "missing-state-agent", sessionKey: "missing-state-session" });
      const result = await runConversationReactivationRecall(args);
      assert.strictEqual(typeof result.context, "string");
      assert.ok(Array.isArray(result.additions));
    });

    it("idle trigger returns reactivation context", async () => {
      const agentId = `idle-agent-${Math.random()}`;
      const sessionKey = `idle-session-${Math.random()}`;
      markUserTurn(agentId, sessionKey, now - 60 * 60 * 1000);
      const tmpDir = mkdtempSync(join(tmpdir(), "crr-test-"));
      mkdirSync(join(tmpDir, ".plur1bus"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".plur1bus", "semantic-lens-index.json"),
        JSON.stringify({
          communities: [{ id: "c1", representativeMemoryIds: ["m1"] }],
          memories: [{ id: "m1", category: "project", display: "dashboard project plan" }],
          entries: {},
        }),
        "utf8"
      );
      const args = makeArgs({ agentId, sessionKey, workspaceDir: tmpDir });
      const result = await runConversationReactivationRecall(args);
      assert.ok(result.context.includes("<memory-reactivation"));
      assert.strictEqual(result.additions.length, 1);
    });

    it("cooldown suppresses CRR", async () => {
      const agentId = `cooldown-agent-${Math.random()}`;
      const sessionKey = `cooldown-session-${Math.random()}`;
      markUserTurn(agentId, sessionKey, now - 60 * 60 * 1000);
      markCrrRun(agentId, sessionKey, now - 5 * 60 * 1000);
      const args = makeArgs({ agentId, sessionKey });
      const result = await runConversationReactivationRecall(args);
      assert.strictEqual(result.context, "");
      assert.deepStrictEqual(result.additions, []);
    });

    it("continuation trigger works", async () => {
      const agentId = `cont-agent-${Math.random()}`;
      const sessionKey = `cont-session-${Math.random()}`;
      const tmpDir = mkdtempSync(join(tmpdir(), "crr-test-"));
      mkdirSync(join(tmpDir, ".plur1bus"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".plur1bus", "semantic-lens-index.json"),
        JSON.stringify({
          communities: [{ id: "c1", representativeMemoryIds: ["m1"] }],
          memories: [{ id: "m1", category: "project", display: "dashboard plan weiter" }],
          entries: {},
        }),
        "utf8"
      );
      const args = makeArgs({
        agentId,
        sessionKey,
        prompt: "wie machen wir weiter?",
        messageText: "wie machen wir weiter?",
        workspaceDir: tmpDir,
      });
      const result = await runConversationReactivationRecall(args);
      assert.ok(result.context.includes("<memory-reactivation"));
    });

    it("short irrelevant message returns empty", async () => {
      const agentId = `short-agent-${Math.random()}`;
      const sessionKey = `short-session-${Math.random()}`;
      markUserTurn(agentId, sessionKey, now - 60 * 60 * 1000);
      const args = makeArgs({ agentId, sessionKey, prompt: "ok", messageText: "ok" });
      const result = await runConversationReactivationRecall(args);
      assert.strictEqual(result.context, "");
      assert.deepStrictEqual(result.additions, []);
    });

    it("silent fallback on error", async () => {
      const args = makeArgs({
        cfg: { ...baseCfg, enabled: true },
        workspaceDir: "/nonexistent/path/that/cannot/be/read",
      });
      // Loading a missing file is fine; force an error via invalid baseRecallIds type.
      const badArgs = { ...args, baseRecallIds: null };
      const result = await runConversationReactivationRecall(badArgs);
      assert.strictEqual(typeof result.context, "string");
      assert.ok(Array.isArray(result.additions));
    });

    it("timeout fallback for slow lookup", async () => {
      const agentId = `timeout-agent-${Math.random()}`;
      const sessionKey = `timeout-session-${Math.random()}`;
      markUserTurn(agentId, sessionKey, now - 60 * 60 * 1000);
      const slowNeoStore = {
        readGraphEdges: () => {
          // Intentionally synchronously slow; the caller's Promise.race handles timeout.
          const start = Date.now();
          while (Date.now() - start < 200) {
            // busy wait
          }
          return [];
        },
        readPatterns: () => [],
        readEpisodes: () => [],
      };
      const args = makeArgs({ agentId, sessionKey, neoStore: slowNeoStore });
      // runConversationReactivationRecall itself does not enforce a timeout; it relies
      // on the caller. Here we simulate the caller timeout with Promise.race.
      const result = await Promise.race([
        runConversationReactivationRecall(args),
        new Promise((resolve) => setTimeout(() => resolve({ context: "", additions: [] }), 10)),
      ]);
      assert.strictEqual(typeof result.context, "string");
      assert.ok(Array.isArray(result.additions));
    });

    it("does not write to workspace or memory files", async () => {
      const agentId = `write-agent-${Math.random()}`;
      const sessionKey = `write-session-${Math.random()}`;
      markUserTurn(agentId, sessionKey, now - 60 * 60 * 1000);
      const tmpDir = mkdtempSync(join(tmpdir(), "crr-write-test-"));
      mkdirSync(join(tmpDir, ".plur1bus"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".plur1bus", "semantic-lens-index.json"),
        JSON.stringify({
          communities: [{ id: "c1", representativeMemoryIds: ["m1"] }],
          memories: [{ id: "m1", category: "project", display: "dashboard plan" }],
          entries: {},
        }),
        "utf8"
      );
      const { statSync, readdirSync } = await import("node:fs");
      const filesBefore = readdirSync(tmpDir, { recursive: true })
        .filter((name) => statSync(join(tmpDir, name)).isFile())
        .sort();
      const args = makeArgs({ agentId, sessionKey, workspaceDir: tmpDir });
      await runConversationReactivationRecall(args);
      const filesAfter = readdirSync(tmpDir, { recursive: true })
        .filter((name) => statSync(join(tmpDir, name)).isFile())
        .sort();
      // The module must not create or modify any files in the workspace.
      assert.deepStrictEqual(filesAfter, filesBefore);
    });

    it("performance dry-run completes fast with <=3 additions", async () => {
      const agentId = `perf-agent-${Math.random()}`;
      const sessionKey = `perf-session-${Math.random()}`;
      const tmpDir = mkdtempSync(join(tmpdir(), "crr-perf-"));
      mkdirSync(join(tmpDir, ".plur1bus"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".plur1bus", "semantic-lens-index.json"),
        JSON.stringify({
          communities: [
            { id: "c1", representativeMemoryIds: ["m1", "m2"] },
            { id: "c2", representativeMemoryIds: ["m3", "m4"] },
            { id: "c3", representativeMemoryIds: ["m5"] },
          ],
          memories: [
            { id: "m1", category: "project", display: "dashboard project alpha" },
            { id: "m2", category: "project", display: "dashboard project beta" },
            { id: "m3", category: "plan", display: "dashboard plan gamma" },
            { id: "m4", category: "plan", display: "dashboard plan delta" },
            { id: "m5", category: "goal", display: "dashboard goal epsilon" },
          ],
          entries: {},
        }),
        "utf8"
      );
      const baseRecallIds = new Set(["base1", "base2", "base3", "base4", "base5"]);
      const args = makeArgs({
        agentId,
        sessionKey,
        workspaceDir: tmpDir,
        baseRecallIds,
        prompt: "continue dashboard project",
        messageText: "continue dashboard project",
      });
      const start = performance.now();
      const result = await runConversationReactivationRecall(args);
      const elapsed = performance.now() - start;
      assert.ok(elapsed <= 50, `expected <=50ms, got ${elapsed}ms`);
      assert.ok(result.additions.length <= 3, `expected <=3 additions, got ${result.additions.length}`);
      assert.ok(result.context.includes("<memory-reactivation") || result.additions.length === 0);
    });

    it("timeout fallback when neoStore read is slow", async () => {
      const agentId = `timeout-neo-agent-${Math.random()}`;
      const sessionKey = `timeout-neo-session-${Math.random()}`;
      markUserTurn(agentId, sessionKey, now - 60 * 60 * 1000);
      const slowNeoStore = {
        readPatterns: () => {
          const start = Date.now();
          while (Date.now() - start < 50) {
            // synchronously slow; caller's Promise.race must win
          }
          return [];
        },
        readEpisodes: () => [],
        readGraphEdges: () => [],
      };
      const args = makeArgs({ agentId, sessionKey, neoStore: slowNeoStore });
      // runConversationReactivationRecall itself does not enforce a timeout;
      // it relies on the caller. Here we simulate the caller timeout with Promise.race.
      const result = await Promise.race([
        runConversationReactivationRecall(args),
        new Promise((resolve) => setTimeout(() => resolve({ context: "", additions: [] }), 10)),
      ]);
      assert.strictEqual(typeof result.context, "string");
      assert.ok(Array.isArray(result.additions));
    });

    it("delivers additions under caller timeout despite many missing community candidates", async () => {
      const agentId = `timeout-deliver-agent-${Math.random()}`;
      const sessionKey = `timeout-deliver-session-${Math.random()}`;
      markUserTurn(agentId, sessionKey, now - 60 * 60 * 1000);
      const tmpDir = mkdtempSync(join(tmpdir(), "crr-timeout-deliver-"));
      mkdirSync(join(tmpDir, ".plur1bus"), { recursive: true });

      const communities = [];
      for (let c = 0; c < 20; c++) {
        const reps = [];
        for (let i = 0; i < 10; i++) reps.push(`c${c}-m${i}`);
        communities.push({ id: `c${c}`, representativeMemoryIds: reps, bridgeMemoryIds: [] });
      }
      // First community contains the only matching candidate at position 2.
      // Without a hydration cap this would resolve 100 candidates and timeout.
      writeFileSync(
        join(tmpDir, ".plur1bus", "semantic-lens-index.json"),
        JSON.stringify({ version: 1, memoryToCommunity: {}, communities }),
        "utf8"
      );

      let hydrateCalls = 0;
      const getMemoryById = async (id) => {
        hydrateCalls++;
        await new Promise((r) => setTimeout(r, 1));
        return {
          id,
          category: "topic",
          display: id === "c0-m2" ? "match target memory" : `community text ${id}`,
        };
      };

      const args = makeArgs({
        agentId,
        sessionKey,
        workspaceDir: tmpDir,
        getMemoryById,
        prompt: "match target exactly",
        messageText: "match target exactly",
      });

      // This test verifies the CRR budget/timeout behavior, not the
      // millisecond-precision of the CI scheduler. Use a generous simulated
      // caller timeout so shared CI runners with Node 20 do not trip over
      // scheduling jitter, while the hydrate-count assertion still proves the
      // budget cap is in effect.
      const callerTimeoutMs = 200;
      const ciTimingSlackMs = 50;

      const start = performance.now();
      const result = await Promise.race([
        runConversationReactivationRecall(args),
        new Promise((_, reject) => setTimeout(() => reject(new Error("crr_timeout")), callerTimeoutMs)),
      ]);
      const elapsed = performance.now() - start;

      // Functional goal: we must not hit the caller timeout and still deliver
      // the single matching addition while keeping hydration bounded.
      assert.ok(elapsed < callerTimeoutMs + ciTimingSlackMs, `expected <${callerTimeoutMs + ciTimingSlackMs}ms, got ${elapsed}ms`);
      assert.strictEqual(result.additions.length, 1);
      assert.strictEqual(result.additions[0].id, "c0-m2");
      assert.ok(hydrateCalls <= 3, `expected <=3 hydrations, got ${hydrateCalls}`);
    });
  });
});
