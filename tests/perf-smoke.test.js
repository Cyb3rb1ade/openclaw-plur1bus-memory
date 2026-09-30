/**
 * P3 Release-Härtung: Performance Smoke Benchmark
 *
 * 1. Embedding-Cache cold vs. warm
 * 2. Graph Traversal mit/ohne Index
 * 3. Metrics accumulate vs. direct atomicJsonUpdate
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmbeddingCache } from "../lib/embedding-cache.js";
import { buildGraphIndex, queryGraphIndex } from "../lib/graph-index.js";
import { createMetricsDebouncer } from "../lib/metrics-debounce.js";
import { atomicJsonUpdate } from "../lib/atomic-json.js";
import { measureAverageCpuMilliseconds, measureCpuMilliseconds } from "./helpers/benchmark-clock.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeVector(len = 384) {
  const v = new Array(len);
  for (let i = 0; i < len; i++) v[i] = Math.random();
  return v;
}

function buildEdges(n = 10_000) {
  const edges = [];
  for (let i = 0; i < n; i++) {
    edges.push({
      id: `e${i}`,
      type: `type${i % 10}`,
      source: `src${i % 100}`,
      target: `tgt${i % 100}`,
      weight: i % 5,
    });
  }
  return edges;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

// ─── 1. Embedding-Cache cold vs. warm ─────────────────────────────────────

describe("Benchmark 1: Embedding-Cache cold vs. warm", () => {
  const N = 100;
  const vector = makeVector(384);
  const agentId = "agent-perf";
  const model = "text-embedding-3-small@1";
  let warmupCache;

  // Simuliert embedQuery: Cache-Lookup + bei Miss "teure" Vektor-Erzeugung
  function embedQuery(cache, query) {
    const cached = cache.get(agentId, query, model);
    if (cached) return cached.vector;
    // teurer Miss (Vektor kopieren)
    const copy = vector.slice();
    cache.set(agentId, query, model, copy);
    return copy;
  }

  before(() => {
    // Compile both the miss and set paths before measuring a separate empty
    // cache. Keep the warm-up fixture alive until the suite ends so its
    // allocations cannot become an unrelated main-thread GC charge inside a
    // later benchmark interval.
    warmupCache = createEmbeddingCache({ maxEntries: 2_000 });
    for (let i = 0; i < 2_000; i++) embedQuery(warmupCache, `warmup query ${i}`);
  });

  after(() => {
    warmupCache.clear();
    warmupCache.close();
  });

  it("cold: 100x embedQuery ohne Cache → Miss", () => {
    const queries = Array.from({ length: N }, (_, i) => `query ${i}`);
    const caches = [];
    const coldMs = median(Array.from({ length: 5 }, () => {
      const cache = createEmbeddingCache();
      caches.push(cache);
      return measureCpuMilliseconds(() => {
        for (const q of queries) embedQuery(cache, q);
      });
    }));
    for (const cache of caches) {
      cache.clear();
      cache.close();
    }

    // Nur Smoke: darf nicht absurd lange dauern (< 50 ms)
    assert.ok(coldMs < 50, `Cold-Miss dauerte ${coldMs.toFixed(2)}ms, erwartet < 50ms`);
  });

  it("warm: 100x embedQuery mit Cache → Hit (< 1ms pro Call)", () => {
    const cache = createEmbeddingCache();
    const query = "warm query";
    cache.set(agentId, query, model, vector);

    const warmMs = measureCpuMilliseconds(() => {
      for (let i = 0; i < N; i++) {
        embedQuery(cache, query);
      }
    });
    const perCall = warmMs / N;

    assert.ok(warmMs < 100, `Warm-Hit dauerte ${warmMs.toFixed(2)}ms total, erwartet < 100ms`);
    assert.ok(perCall < 1, `Warm-Hit pro Call ${perCall.toFixed(3)}ms, erwartet < 1ms`);
  });

  it("warm ist schneller als cold", async () => {
    // Proved by work, not by milliseconds: a warm lookup must do none of the
    // embedder work a cold lookup does. The old CPU-time comparison measured
    // 1000 in-memory lookups (well under 1 ms) with a clock whose resolution
    // is one scheduler tick on Windows (~15.6 ms): both sides read 0.00 ms
    // and `warm < cold` failed on windows-2025 (tc6). Counting the embedder
    // calls and the cache's own hit/miss accounting is exact on every host.
    const M = 1000;
    const queries = Array.from({ length: M }, (_, i) => `query ${i}`);
    const options = { agentId, model, persist: false };
    let embedderTexts = 0;
    let embedderCalls = 0;
    const embedder = async (texts) => {
      embedderCalls++;
      embedderTexts += texts.length;
      return texts.map(() => vector.slice());
    };

    const cache = createEmbeddingCache({ maxEntries: M });
    try {
      const coldVectors = await cache.getMany(queries, options, embedder);
      const cold = { ...cache.getMetrics(), embedderCalls, embedderTexts };

      const warmVectors = await cache.getMany(queries, options, embedder);
      const total = cache.getMetrics();
      const warm = {
        hits: total.hits - cold.hits,
        misses: total.misses - cold.misses,
        embedderCalls: embedderCalls - cold.embedderCalls,
        embedderTexts: embedderTexts - cold.embedderTexts,
      };

      // Cold: every query misses and is embedded (once, batched).
      assert.equal(cold.misses, M, "cold: every query must miss");
      assert.equal(cold.hits, 0, "cold: nothing may be served from the cache");
      assert.equal(cold.embedderTexts, M, "cold: every query must reach the embedder");
      // Warm: every query is a memory hit and the embedder is not called at all.
      assert.equal(warm.hits, M, "warm: every query must be a cache hit");
      assert.equal(warm.misses, 0, "warm: no query may miss");
      assert.equal(warm.embedderCalls, 0, "warm: the embedder must not be called");
      assert.equal(total.memoryHits, M, "warm hits must come from the memory tier");
      // Same answers, served from the cached vectors (identity, not a recompute).
      assert.equal(warmVectors.length, M);
      for (let i = 0; i < M; i++) assert.equal(warmVectors[i], coldVectors[i]);
      // Strictly less work: warm does lookups only, cold does lookups + embeds.
      assert.ok(
        warm.embedderTexts < cold.embedderTexts,
        `Warm (${warm.embedderTexts} embeds) war nicht schneller als Cold (${cold.embedderTexts} embeds)`
      );
    } finally {
      cache.clear();
      cache.close();
    }
  });
});

// ─── 2. Graph Traversal mit/ohne Index ────────────────────────────────────

describe("Benchmark 2: Graph Traversal mit/ohne Index (10k Edges)", () => {
  let edges;
  let index;
  const ITERATIONS = 1000;
  const INDEX_FILTER = Object.freeze({ type: "type0", target: "tgt0" });

  // Build the allocation-heavy graph only after Benchmark 1 has completed.
  // Constructing it during test registration can leave parallel V8 GC work
  // running inside the same process while process.cpuUsage() measures the
  // unrelated cold-cache loop.
  before(() => {
    edges = buildEdges(10_000);
    index = buildGraphIndex(edges);
    // Keep lazy compilation and V8's later optimization tier outside the
    // steady-state query budget. Without this warm-up, a fresh Node process
    // can charge either compilation phase to an arbitrary measured round even
    // though the same index query itself remains unchanged.
    for (let i = 0; i < ITERATIONS * 10; i++) queryGraphIndex(index, INDEX_FILTER);
  });

  function scanArray(type, target) {
    return edges.filter((e) => e.type === type && e.target === target);
  }

  it("ohne Index: Array-Scan liefert passende Treffer", () => {
    const start = performance.now();
    let result = [];
    for (let i = 0; i < ITERATIONS; i++) {
      result = scanArray("type0", "tgt0");
    }
    const scanMs = performance.now() - start;

    assert.ok(result.length > 0, "Array-Scan sollte Treffer liefern");
    assert.ok(Number.isFinite(scanMs), `Array-Scan lieferte keine valide Dauer: ${scanMs}`);
  });

  // 1000 index queries take well under one Windows CPU-clock tick (~15.6 ms),
  // so a single interval reads 0 or a whole tick. Average over RUNS intervals
  // (see measureAverageCpuMilliseconds) so the 10 ms budget and the 10x
  // ratio compare real cost, not tick placement.
  const RUNS = 50;

  it("mit Index: queryGraphIndex ist schnell", () => {
    const idxMs = measureAverageCpuMilliseconds(() => {
      for (let i = 0; i < ITERATIONS; i++) {
        queryGraphIndex(index, INDEX_FILTER);
      }
    }, RUNS);

    assert.ok(idxMs < 10, `Index-Query dauerte ${idxMs.toFixed(2)}ms, erwartet < 10ms`);
  });

  it("Index ist mindestens 10x schneller als Array-Scan", () => {
    const scanMs = measureCpuMilliseconds(() => {
      for (let i = 0; i < ITERATIONS; i++) scanArray("type0", "tgt0");
    });

    const idxMs = measureAverageCpuMilliseconds(() => {
      for (let i = 0; i < ITERATIONS; i++) queryGraphIndex(index, INDEX_FILTER);
    }, RUNS);

    assert.ok(
      idxMs * 10 < scanMs,
      `Index (${idxMs.toFixed(2)}ms) war nicht 10x schneller als Scan (${scanMs.toFixed(2)}ms)`
    );
  });
});

// ─── 3. Metrics accumulate vs. direct atomicJsonUpdate ────────────────────

describe("Benchmark 3: Metrics accumulate vs. direct atomicJsonUpdate", () => {
  const N = 100;

  it("100x accumulate() ist < 2ms total", async () => {
    const debouncer = createMetricsDebouncer({
      flushFn: async () => {},
      debounceMs: 60_000, // Timer soll während des Tests nicht feuern
    });
    debouncer.accumulate("/warmup", { latencyMs: 0 });
    await debouncer.flush();

    // Sub-tick on Windows: average over 50 runs of 100 calls (see
    // measureAverageCpuMilliseconds).
    const accMs = measureAverageCpuMilliseconds(() => {
      for (let i = 0; i < N; i++) {
        debouncer.accumulate("/ws", { latencyMs: i });
      }
    }, 50);
    await debouncer.stop(); // Timer aufräumen, sonst hält er den Prozess offen

    assert.ok(accMs < 10, `100x accumulate dauerte ${accMs.toFixed(3)}ms, erwartet < 10ms`);
  });

  it("100x direct atomicJsonUpdate ist deutlich langsamer", async () => {
    const dir = makeTempDir("perf-atomic-");
    const path = join(dir, "state.json");

    // Referenz: 100x reines In-Memory-accumulate im selben Environment messen,
    // statt eine absolute Untergrenze anzunehmen (schlägt auf tmpfs/schnellen
    // Disks sonst fehl).
    const debouncer = createMetricsDebouncer({
      flushFn: async () => {},
      debounceMs: 60_000,
    });
    debouncer.accumulate("/warmup", { latencyMs: 0 });
    await debouncer.flush();
    const accMs = measureCpuMilliseconds(() => {
      for (let i = 0; i < N; i++) {
        debouncer.accumulate("/ws", { latencyMs: i });
      }
    });
    await debouncer.stop(); // Timer aufräumen, sonst hält er den Prozess offen

    const start = performance.now();
    for (let i = 0; i < N; i++) {
      await atomicJsonUpdate(path, (data) => ({ ...data, count: (data.count || 0) + 1 }));
    }
    const atomicMs = performance.now() - start;

    // Smoke-Grenze: 100 atomare Disk-Writes müssen unter 5s bleiben (meist 100–400ms)
    assert.ok(atomicMs < 5000, `100x atomicJsonUpdate dauerte ${atomicMs.toFixed(2)}ms, erwartet < 5000ms`);
    // Sollte langsamer als reines In-Memory sein (relativer Vergleich statt absoluter Floor)
    assert.ok(
      atomicMs > accMs,
      `100x atomicJsonUpdate (${atomicMs.toFixed(2)}ms) war nicht langsamer als 100x accumulate (${accMs.toFixed(3)}ms)`
    );
  });
});
