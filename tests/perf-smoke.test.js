/**
 * P3 Release-Härtung: Performance Smoke Benchmark
 *
 * 1. Embedding-Cache cold vs. warm
 * 2. Graph Traversal mit/ohne Index
 * 3. Metrics accumulate vs. direct atomicJsonUpdate
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmbeddingCache } from "../lib/embedding-cache.js";
import { buildGraphIndex, queryGraphIndex } from "../lib/graph-index.js";
import { createMetricsDebouncer } from "../lib/metrics-debounce.js";
import { atomicJsonUpdate } from "../lib/atomic-json.js";

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

// ─── 1. Embedding-Cache cold vs. warm ─────────────────────────────────────

describe("Benchmark 1: Embedding-Cache cold vs. warm", () => {
  const N = 100;
  const vector = makeVector(384);
  const agentId = "agent-perf";
  const model = "text-embedding-3-small@1";

  // Simuliert embedQuery: Cache-Lookup + bei Miss "teure" Vektor-Erzeugung
  function embedQuery(cache, query) {
    const cached = cache.get(agentId, query, model);
    if (cached) return cached.vector;
    // teurer Miss (Vektor kopieren)
    const copy = vector.slice();
    cache.set(agentId, query, model, copy);
    return copy;
  }

  it("cold: 100x embedQuery ohne Cache → Miss", () => {
    const cache = createEmbeddingCache();
    const queries = Array.from({ length: N }, (_, i) => `query ${i}`);

    const start = performance.now();
    for (const q of queries) {
      embedQuery(cache, q);
    }
    const coldMs = performance.now() - start;

    // Nur Smoke: darf nicht absurd lange dauern (< 50 ms)
    assert.ok(coldMs < 50, `Cold-Miss dauerte ${coldMs.toFixed(2)}ms, erwartet < 50ms`);
  });

  it("warm: 100x embedQuery mit Cache → Hit (< 1ms pro Call)", () => {
    const cache = createEmbeddingCache();
    const query = "warm query";
    cache.set(agentId, query, model, vector);

    const start = performance.now();
    for (let i = 0; i < N; i++) {
      embedQuery(cache, query);
    }
    const warmMs = performance.now() - start;
    const perCall = warmMs / N;

    assert.ok(warmMs < 100, `Warm-Hit dauerte ${warmMs.toFixed(2)}ms total, erwartet < 100ms`);
    assert.ok(perCall < 1, `Warm-Hit pro Call ${perCall.toFixed(3)}ms, erwartet < 1ms`);
  });

  it("warm ist mindestens 2x schneller als cold", () => {
    const M = 1000; // mehr Iterationen für stabileren Vergleich
    const coldCache = createEmbeddingCache();
    const warmCache = createEmbeddingCache();
    const queries = Array.from({ length: M }, (_, i) => `query ${i}`);

    // Cold: teurer Miss (Vektor kopieren)
    const coldStart = performance.now();
    for (const q of queries) {
      const cached = coldCache.get(agentId, q, model);
      if (!cached) coldCache.set(agentId, q, model, vector.slice());
    }
    const coldMs = performance.now() - coldStart;

    // Warm (alle vorher gesetzt)
    for (const q of queries) warmCache.set(agentId, q, model, vector);
    const warmStart = performance.now();
    for (const q of queries) {
      warmCache.get(agentId, q, model);
    }
    const warmMs = performance.now() - warmStart;

    assert.ok(
      warmMs * 2 < coldMs,
      `Warm (${warmMs.toFixed(2)}ms) war nicht mindestens 2x schneller als Cold (${coldMs.toFixed(2)}ms)`
    );
  });
});

// ─── 2. Graph Traversal mit/ohne Index ────────────────────────────────────

describe("Benchmark 2: Graph Traversal mit/ohne Index (10k Edges)", () => {
  const edges = buildEdges(10_000);
  const index = buildGraphIndex(edges);
  const ITERATIONS = 1000;

  function scanArray(type, target) {
    return edges.filter((e) => e.type === type && e.target === target);
  }

  it("ohne Index: Array-Scan ist langsam", () => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      scanArray("type0", "tgt0");
    }
    const scanMs = performance.now() - start;

    // Smoke-Grenze: 1000 Scans auf 10k Edges müssen unter 100ms bleiben
    // (ist auf moderner HW meist 5–20ms, aber wir lassen Puffer)
    assert.ok(scanMs < 100, `Array-Scan dauerte ${scanMs.toFixed(2)}ms, erwartet < 100ms`);
  });

  it("mit Index: queryGraphIndex ist schnell", () => {
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      queryGraphIndex(index, { type: "type0", target: "tgt0" });
    }
    const idxMs = performance.now() - start;

    assert.ok(idxMs < 10, `Index-Query dauerte ${idxMs.toFixed(2)}ms, erwartet < 10ms`);
  });

  it("Index ist mindestens 10x schneller als Array-Scan", () => {
    const startScan = performance.now();
    for (let i = 0; i < ITERATIONS; i++) scanArray("type0", "tgt0");
    const scanMs = performance.now() - startScan;

    const startIdx = performance.now();
    for (let i = 0; i < ITERATIONS; i++) queryGraphIndex(index, { type: "type0", target: "tgt0" });
    const idxMs = performance.now() - startIdx;

    assert.ok(
      idxMs * 10 < scanMs,
      `Index (${idxMs.toFixed(2)}ms) war nicht 10x schneller als Scan (${scanMs.toFixed(2)}ms)`
    );
  });
});

// ─── 3. Metrics accumulate vs. direct atomicJsonUpdate ────────────────────

describe("Benchmark 3: Metrics accumulate vs. direct atomicJsonUpdate", () => {
  const N = 100;

  it("100x accumulate() ist < 1ms total", async () => {
    const debouncer = createMetricsDebouncer({
      flushFn: async () => {},
      debounceMs: 60_000, // Timer soll während des Tests nicht feuern
    });

    const start = performance.now();
    for (let i = 0; i < N; i++) {
      debouncer.accumulate("/ws", { latencyMs: i });
    }
    const accMs = performance.now() - start;
    await debouncer.stop(); // Timer aufräumen, sonst hält er den Prozess offen

    assert.ok(accMs < 1, `100x accumulate dauerte ${accMs.toFixed(3)}ms, erwartet < 1ms`);
  });

  it("100x direct atomicJsonUpdate ist deutlich langsamer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-atomic-"));
    const path = join(dir, "state.json");

    // Referenz: 100x reines In-Memory-accumulate im selben Environment messen,
    // statt eine absolute Untergrenze anzunehmen (schlägt auf tmpfs/schnellen
    // Disks sonst fehl).
    const debouncer = createMetricsDebouncer({
      flushFn: async () => {},
      debounceMs: 60_000,
    });
    const accStart = performance.now();
    for (let i = 0; i < N; i++) {
      debouncer.accumulate("/ws", { latencyMs: i });
    }
    const accMs = performance.now() - accStart;
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
