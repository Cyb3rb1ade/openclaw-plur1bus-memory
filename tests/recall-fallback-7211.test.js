/**
 * tests/recall-fallback-7211.test.js — 7.21.1: the Neo prelude has a hard
 * budget and the automatic recall falls back to keyword/recent search when
 * the query embedding does not arrive.
 *
 * Production, 24.11.2026 09:44 and 22:29: the first recall after a restart
 * waited 8.7 s / 17.5 s in the Neo prelude for the query embedding, the
 * scheduler's budget (runtime.recallTimeoutMs 12 000) ran out, and the turn
 * got no memories at all ("recall timed out without cache").
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SCENARIOS } from "./fixtures/golden-prefix/scenarios.js";
import { runScenario } from "./helpers/golden-prefix-driver.js";
import { readNeoPrelude } from "../engine/recall/neo-prelude.js";
import { crrTimeoutMs, neoPreludeBudgetMs, recallEmbedDeadline } from "../engine/recall/assemble-prompt-context.js";
import {
  buildKeywordPredicate,
  extractFallbackKeywords,
  scoreFallbackRow,
  searchKeywordRecentFallback,
} from "../lib/recall-keyword-fallback.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";

const base = () => SCENARIOS.find((s) => s.name === "recall-aborted");

// The aborted scenario's memory, asked for by a word it contains: only the
// keyword path can find it while the embedder hangs.
function fallbackScenario({ recallTimeoutMs, neo = false }) {
  const scenario = base();
  return {
    ...scenario,
    name: "recall-keyword-fallback",
    startNotice: null,
    config: {
      ...scenario.config,
      // The aborted scenario switches the fallback off; here it is on (default).
      recall: { ...scenario.config.recall, keywordFallback: { enabled: true } },
      runtime: { recallTimeoutMs },
      ...(neo ? { neo: { enabled: true } } : {}),
    },
    event: { ...scenario.event, prompt: "Erzähl mir nochmal von der Reise nach Lisbon" },
  };
}

describe("7.21.1 keyword/recent fallback (real before_prompt_build path)", () => {
  it("a hanging embedder still yields a marked memory block well inside the budget", async () => {
    const recallTimeoutMs = 4_000;
    const events = [];
    const embedder = { calls: 0, abortedAt: null };
    let recallMs = null;
    const prefix = await runScenario(fallbackScenario({ recallTimeoutMs }), {
      hostEvents: { emit: (name, payload) => events.push({ name, payload }) },
      embedderProbe: embedder,
      onTiming: (t) => { recallMs = t.recallMs; },
      // Real clock: the deadlines are wall-clock instants. With the frozen
      // clock a cold first recall in a fresh process (imports, LanceDB) would
      // not count against them, but against the scheduler's real timer.
      freezeClock: false,
    });
    assert.ok(embedder.calls >= 1, "the embedder was reached");
    // "In time" means: the scheduler's budget did not run out (no timeout
    // reason, a memory block came back). Wall-clock bounds only as a sanity
    // check; a loaded runner must not turn this into a flaky race.
    assert.ok(recallMs < recallTimeoutMs + 1_000, `recall took ${recallMs} ms, budget ${recallTimeoutMs} ms`);
    assert.equal(events.some((e) => e.name === "recall.degraded" && e.payload?.degraded?.reason === "timeout"), false, "no scheduler timeout");
    assert.match(prefix, /<relevant-memories [^>]*retrieval="keyword-recent-fallback"/);
    assert.match(prefix, /FALLBACK RECALL:/);
    assert.match(prefix, /Lisbon/);
    const degraded = events.find((e) => e.name === "recall.degraded");
    assert.equal(degraded?.payload?.degraded?.reason, "embedding-unavailable", "honestly reported as degraded, not as a timeout");
  });

  it("with Neo on, a hanging embedder cannot use up the budget in the prelude (hard prelude budget)", async () => {
    const recallTimeoutMs = 4_000;
    const events = [];
    let recallMs = null;
    const prefix = await runScenario(fallbackScenario({ recallTimeoutMs, neo: true }), {
      hostEvents: { emit: (name, payload) => events.push({ name, payload }) },
      embedderProbe: { calls: 0, abortedAt: null },
      onTiming: (t) => { recallMs = t.recallMs; },
      // Real clock: the deadlines are wall-clock instants. With the frozen
      // clock a cold first recall in a fresh process (imports, LanceDB) would
      // not count against them, but against the scheduler's real timer.
      freezeClock: false,
    });
    // Prelude budget 1 s (a quarter of 4 s), then 0.5 s grace for the known
    // slow embedding, then the keyword search: about 2 s on an idle runner.
    assert.ok(recallMs < recallTimeoutMs + 1_000, `recall took ${recallMs} ms, budget ${recallTimeoutMs} ms`);
    assert.match(prefix, /retrieval="keyword-recent-fallback"/);
    assert.match(prefix, /Lisbon/);
    assert.equal(events.some((e) => e.name === "recall.degraded" && e.payload?.degraded?.reason === "timeout"), false, "no scheduler timeout");
  });

  it("recall.keywordFallback.enabled=false keeps the old behaviour: the scheduler times out", async () => {
    const scenario = fallbackScenario({ recallTimeoutMs: 1_000 });
    scenario.config = { ...scenario.config, recall: { ...scenario.config.recall, keywordFallback: { enabled: false } } };
    const events = [];
    await runScenario(scenario, { hostEvents: { emit: (name, payload) => events.push({ name, payload }) } });
    assert.equal(events.find((e) => e.name === "recall.degraded")?.payload?.degraded?.reason, "timeout");
  });
});

describe("7.21.1 Neo prelude budget (readNeoPrelude)", () => {
  const TIMEOUT = Symbol("timeout");
  const fakeStore = (items = [{ id: "n1", text: "Lisbon trip", category: "fact", createdAt: Date.now() }]) => ({
    readCandidates: () => items,
  });
  const requester = { requesterAgentId: "a", agentId: "a" };
  const logger = { warn() {}, debug() {}, info() {} };

  it("cuts a hanging embedding at the deadline and skips global search and lanes", async () => {
    let globalCalls = 0;
    const prelude = { startedAt: Date.now() };
    const started = Date.now();
    const out = await readNeoPrelude({
      neoStore: fakeStore(),
      requester,
      prompt: "Lisbon",
      embeddings: { embedQuery: () => new Promise(() => {}) },
      embedTimeoutMs: 10_000,
      timeoutSymbol: TIMEOUT,
      runNeoGlobalSearch: () => { globalCalls++; return new Set(); },
      logger,
      prelude,
      deadlineAt: started + 150,
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_000, `prelude took ${elapsed} ms`);
    assert.equal(prelude.embedTimedOut, true);
    assert.equal(prelude.budgetExceeded, true);
    assert.equal(globalCalls, 0);
    assert.deepEqual(out.neoLanes, {});
    assert.equal(out.neoGlobalIds, null);
  });

  it("a deadline that already passed (main-thread stall) skips the rest at once", async () => {
    let globalCalls = 0;
    const prelude = { startedAt: Date.now() };
    await readNeoPrelude({
      neoStore: fakeStore(),
      requester,
      prompt: "Lisbon",
      embeddings: { embedQuery: async () => [1, 0, 0] },
      embedTimeoutMs: 4_000,
      timeoutSymbol: TIMEOUT,
      runNeoGlobalSearch: () => { globalCalls++; return new Set(); },
      logger,
      prelude,
      deadlineAt: Date.now() - 1,
    });
    assert.equal(prelude.budgetExceeded, true);
    assert.equal(globalCalls, 0);
  });

  it("without a deadline the prelude is unchanged (warm path, older callers)", async () => {
    let globalCalls = 0;
    const prelude = { startedAt: Date.now() };
    await readNeoPrelude({
      neoStore: fakeStore(),
      requester,
      prompt: "Lisbon",
      embeddings: { embedQuery: async () => [1, 0, 0] },
      embedTimeoutMs: 4_000,
      timeoutSymbol: TIMEOUT,
      runNeoGlobalSearch: () => { globalCalls++; return new Set(); },
      logger,
      prelude,
    });
    assert.equal(prelude.budgetExceeded, undefined);
    assert.equal(globalCalls, 1);
  });
});

describe("7.21.1 budget arithmetic", () => {
  it("prelude budget: min(embedTimeoutMs, a quarter of the recall budget, at least 250 ms)", () => {
    assert.equal(neoPreludeBudgetMs(12_000, 4_000), 3_000);
    assert.equal(neoPreludeBudgetMs(30_000, 4_000), 4_000);
    assert.equal(neoPreludeBudgetMs(400, 4_000), 250);
    assert.equal(neoPreludeBudgetMs(undefined, undefined), 3_000);
  });

  it("embed deadline keeps a reserve and shortens to a grace when the embedding is known slow", () => {
    assert.equal(recallEmbedDeadline({ startedAt: 0, recallTimeoutMs: 12_000 }), 9_000);
    assert.equal(recallEmbedDeadline({ startedAt: 0, recallTimeoutMs: 1_000 }), 500);
    assert.equal(recallEmbedDeadline({ startedAt: 0, recallTimeoutMs: 4_000 }), 2_500);
    assert.equal(recallEmbedDeadline({ startedAt: 0, recallTimeoutMs: 12_000, embedKnownSlow: true, now: 3_000 }), 4_500);
    assert.equal(recallEmbedDeadline({ startedAt: 0, recallTimeoutMs: 12_000, embedKnownSlow: true, now: 8_500 }), 9_000);
  });

  it("CRR timeout: default 250 ms (was 50), explicit values clamped to 10–2000 ms", () => {
    assert.equal(crrTimeoutMs(undefined), 250);
    assert.equal(crrTimeoutMs({}), 250);
    assert.equal(crrTimeoutMs({ timeoutMs: 50 }), 50);
    assert.equal(crrTimeoutMs({ timeoutMs: 5 }), 10);
    assert.equal(crrTimeoutMs({ timeoutMs: 60_000 }), 2_000);
  });
});

describe("7.21.1 keyword fallback helpers", () => {
  it("keywords: no stop words, longest first, at most six, digits allowed", () => {
    assert.deepEqual(extractFallbackKeywords("Was haben wir über PLUR1BUS und den Cohere-Reranker gesagt?"), ["plur1bus", "reranker", "cohere", "gesagt"]);
    assert.deepEqual(extractFallbackKeywords("ja ok"), []);
    assert.deepEqual(extractFallbackKeywords("Version 7.21 ist da"), ["version", "21"]);
    assert.equal(extractFallbackKeywords("eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf").length, 6);
  });

  it("the SQL predicate only ever contains letters and digits inside the quotes", () => {
    assert.equal(buildKeywordPredicate([]), null);
    assert.equal(buildKeywordPredicate(["lisbon", "x'; drop"]), "(lower(text) LIKE '%lisbon%')");
  });

  it("scores: keyword share dominates, recency adds a little, never above 0.9", () => {
    const now = 1_000 * 86_400_000;
    const hit = scoreFallbackRow({ text: "Lisbon trip", createdAt: now - 30 * 86_400_000 }, ["lisbon", "trip"], now);
    const recentOnly = scoreFallbackRow({ text: "something else", createdAt: now }, ["lisbon"], now);
    assert.ok(hit.score > recentOnly.score);
    assert.equal(hit.matched, 2);
    assert.ok(hit.score <= 0.9 && recentOnly.score <= 0.9);
  });

  it("a failing sub-query does not lose the other one, and the vector column is never selected", async () => {
    const selects = [];
    const table = {
      schema: async () => ({ fields: [{ name: "id" }, { name: "text" }, { name: "vector" }, { name: "createdAt" }] }),
      query() {
        let predicate = "";
        const q = {
          where(p) { predicate = p; return q; },
          select(cols) { selects.push(cols); return q; },
          limit() { return q; },
          toArray: async () => {
            if (predicate.includes("LIKE")) throw new Error("boom");
            return [{ id: "r1", text: "recent row", createdAt: Date.now() }];
          },
        };
        return q;
      },
    };
    const out = await searchKeywordRecentFallback({ dbTable: table, query: "Lisbon Reise" });
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].via, "recent");
    assert.equal(out.errors.length, 1);
    for (const cols of selects) assert.equal(cols.includes("vector"), false);
  });

  it("the block says it is a fallback", () => {
    const out = formatRelevantMemoriesContext([{ id: "m1", category: "fact", display: "Lisbon trip", createdAt: Date.now() }], { retrievalFallback: { kind: "keyword-recent", reason: "embed-timeout" } });
    assert.match(out, /retrieval="keyword-recent-fallback"/);
    assert.match(out, /FALLBACK RECALL:/);
    const normal = formatRelevantMemoriesContext([{ id: "m1", category: "fact", display: "Lisbon trip", createdAt: Date.now() }]);
    assert.doesNotMatch(normal, /retrieval=|FALLBACK RECALL/);
  });
});
