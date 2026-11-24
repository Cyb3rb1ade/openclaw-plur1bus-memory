import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, openSync, readFileSync, readdirSync, renameSync, statSync, truncateSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import {
  createNeoStore,
  searchNeoCandidatesGlobal,
  neoVectorCacheMaxBytes,
  neoVectorCacheStats,
  resetNeoVectorCache,
  NEO_VECTOR_CACHE_DEFAULT_MAX_BYTES,
} from "../lib/neo-arch.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// 7.20.9: Prozess-Cache fuer die Sidecar-Vektoren der globalen Neo-Suche.
// Jeder Test vergleicht den gecachten Pfad mit dem ungecachten
// (PLUR1BUS_NEO_VECTOR_CACHE_MAX_BYTES=0, exakt der Lesepfad von 7.20.8).
const ENV_KEY = "PLUR1BUS_NEO_VECTOR_CACHE_MAX_BYTES";
const NOW = Date.parse("2026-11-24T12:00:00Z");
const DAY = 86_400_000;
const DIMS = 16;
const ENTRY_BYTES = DIMS * 4 + 256; // Vektor + Verwaltungsaufschlag
const REQUESTER = { requesterAgentId: "bernhardine", requesterWorkspaceKey: "", requesterOwnerId: "" };

function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nicht-negative Komponenten: jeder Cosinus ist >= 0, alle Kandidaten bleiben
// bei minSimilarity 0 in den Treffern.
function vectorFor(seed) {
  const next = prng(seed);
  return Array.from({ length: DIMS }, () => Math.fround(next() + 0.01));
}

function assertUnitSimilarity(hit) {
  assert.ok(Math.abs(hit.similarity - 1) < 1e-9, `similarity ${hit.similarity}`);
}

function candidate(id, index, extra = {}) {
  return {
    id, workspaceKey: "ws", agentId: "bernhardine", statement: `Erinnerung ${id}`, normalizedStatement: `erinnerung ${id}`,
    sourceTurnIds: ["turn-1"], status: "candidate", embeddingStatus: "pending", impact: "low",
    visibility: { scope: "agent_private" },
    createdAt: new Date(NOW - (index + 1) * DAY).toISOString(), ...extra,
  };
}

async function seed(store, ids, vectors, { impact = "low" } = {}) {
  const items = ids.map((id, i) => candidate(id, i, { impact }));
  if (impact === "low") store.appendCandidates(items);
  store.appendEmbeddingQueue(items);
  const result = await store.drainEmbeddingQueue({ impact: impact === "low" ? "low" : "all", maxItems: 500, embedder: (_text, target) => vectors[target.id], dimensions: DIMS });
  assert.equal(result.processed, ids.length);
}

async function seededStore(root, workspace, count, seedBase = 1) {
  const store = createNeoStore(root, workspace);
  const ids = Array.from({ length: count }, (_, i) => `${workspace}-mem-${String(i).padStart(3, "0")}`);
  const vectors = Object.fromEntries(ids.map((id, i) => [id, vectorFor(seedBase + i)]));
  await seed(store, ids, vectors);
  return { store, ids, vectors };
}

function search(store, queryVector, extra = {}) {
  return searchNeoCandidatesGlobal(store, { queryVector, requester: REQUESTER, now: NOW, minSimilarity: 0, topK: 200, ...extra });
}

function uncached(store, queryVector, extra = {}) {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = "0";
  try {
    return search(store, queryVector, extra);
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previous;
  }
}

function comparable(result) {
  const { ms: _ms, vectorCache: _vectorCache, ...rest } = result;
  return rest;
}

function assertSameAsUncached(store, queryVector, message) {
  const cached = search(store, queryVector);
  const plain = uncached(store, queryVector);
  assert.deepStrictEqual(comparable(cached), comparable(plain), message);
  return cached;
}

function vectorFile(store) {
  const index = JSON.parse(readFileSync(store.paths.vectorIndex, "utf8"));
  return { index, path: join(store.paths.workspaceDir, index.file) };
}

describe("neo vector cache (7.20.9)", () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    resetNeoVectorCache();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
    resetNeoVectorCache();
  });

  it("returns byte-identical hits, scores and vectors cold and warm", async () => {
    const root = makeTempDir("neo-vcache-eq-");
    const { store, ids, vectors } = await seededStore(root, "ws", 40);
    // Re-Embeddings lassen verwaiste Slots (Luecken) in der Datei zurueck.
    const reembedded = Object.fromEntries(ids.slice(0, 10).map((id, i) => [id, vectorFor(1000 + i)]));
    await seed(store, ids.slice(0, 10), reembedded, { impact: "high" });
    for (let q = 0; q < 4; q++) {
      const query = vectorFor(500 + q);
      const plain = uncached(store, query);
      assert.equal(plain.vectorCache.disabled, true);
      const cold = search(store, query);
      const warm = search(store, query);
      assert.deepStrictEqual(comparable(cold), comparable(plain), `cold query ${q}`);
      assert.deepStrictEqual(comparable(warm), comparable(plain), `warm query ${q}`);
      assert.equal(warm.vectorCache.hits, 40, "second call is served from the cache");
      assert.equal(warm.vectorCache.misses, 0);
    }
    const first = search(store, vectorFor(500)).hits;
    const byId = new Map(first.map((hit) => [hit.item.id, hit.item.embedding]));
    assert.equal(first.length, 40);
    for (const id of ids) {
      const expected = (reembedded[id] || vectors[id]);
      assert.deepStrictEqual(byId.get(id), expected, `${id} carries its newest vector`);
    }
    assert.ok(neoVectorCacheStats().coldReads <= 2, "missing vectors are read in few large blocks");
  });

  it("hands out copies: mutating a hit embedding does not touch the cache", async () => {
    const root = makeTempDir("neo-vcache-copy-");
    const { store } = await seededStore(root, "ws", 5);
    const query = vectorFor(77);
    const before = search(store, query);
    for (const hit of before.hits) hit.item.embedding.fill(0);
    assert.deepStrictEqual(comparable(search(store, query)), comparable(uncached(store, query)));
  });

  it("sees an appended vector and loads only that one", async () => {
    const root = makeTempDir("neo-vcache-append-");
    const { store } = await seededStore(root, "ws", 12);
    const query = vectorFor(900);
    search(store, query);
    const extra = { "ws-new": query.map((value) => value) };
    await seed(store, ["ws-new"], extra);
    const after = assertSameAsUncached(store, query, "appended vector is visible");
    assert.equal(after.hits[0].item.id, "ws-new");
    assertUnitSimilarity(after.hits[0]);
    assert.equal(after.vectorCache.misses, 1, "only the appended vector is read");
    assert.equal(after.vectorCache.hits, 12);
    const stats = search(store, query).vectorCache;
    assert.equal(stats.misses, 0, "the appended vector is cached after one load");
    assert.equal(stats.hits, 13);
  });

  it("treats a re-embedded id as a miss and serves the new vector", async () => {
    const root = makeTempDir("neo-vcache-reembed-");
    const { store, ids } = await seededStore(root, "ws", 6);
    const query = vectorFor(4242);
    search(store, query);
    await seed(store, [ids[3]], { [ids[3]]: query }, { impact: "high" });
    const result = assertSameAsUncached(store, query, "re-embedded vector replaces the cached one");
    assert.equal(result.hits[0].item.id, ids[3]);
    assert.equal(result.vectorCache.misses, 1);
    assert.equal(result.vectorCache.hits, 5);
  });

  it("drops the old generation after compaction and reloads from the new file", async () => {
    const root = makeTempDir("neo-vcache-gen-");
    const { store, ids } = await seededStore(root, "ws", 8);
    await seed(store, ids.slice(0, 3), Object.fromEntries(ids.slice(0, 3).map((id, i) => [id, vectorFor(300 + i)])), { impact: "high" });
    const query = vectorFor(31);
    search(store, query);
    const oldFile = vectorFile(store).path;
    const report = store.compactVectors();
    assert.equal(report.rewritten, true);
    assert.notEqual(vectorFile(store).path, oldFile, "compaction wrote a new generation");
    const invalidatedBefore = neoVectorCacheStats().invalidated;
    const after = assertSameAsUncached(store, query, "results after compaction");
    assert.equal(after.vectorCache.misses, 8, "the new generation is loaded from disk");
    const stats = neoVectorCacheStats();
    assert.equal(stats.invalidated, invalidatedBefore + 1, "the old generation was dropped");
    assert.equal(stats.files, 1);
    assert.equal(stats.entries, 8);
    assert.equal(stats.bytes, 8 * ENTRY_BYTES);
  });

  it("invalidates on an inode change of the vector file", async () => {
    const root = makeTempDir("neo-vcache-ino-");
    const { store, ids } = await seededStore(root, "ws", 6);
    const query = vectorFor(55);
    search(store, query);
    const { index, path } = vectorFile(store);
    const bytes = Buffer.from(readFileSync(path));
    const target = index.entries[ids[4]];
    Buffer.from(Float32Array.from(query).buffer).copy(bytes, target.offset);
    writeFileSync(`${path}.tmp`, bytes);
    renameSync(`${path}.tmp`, path);
    const after = assertSameAsUncached(store, query, "new file content wins over the cache");
    assert.equal(after.hits[0].item.id, ids[4]);
    assertUnitSimilarity(after.hits[0]);
    assert.equal(after.vectorCache.misses, 6);
  });

  // Pruefung F2: ext4 vergibt nach unlink+create im selben Tick dieselbe
  // Inode und Birthtime, ein Ueberschreiben mit "w" oder "r+" behaelt beide.
  // Die Datei-Identitaet allein haelt den Cache dann fuer gueltig.
  for (const mode of ["r+", "w"]) {
    it(`detects a vector file overwritten in place ("${mode}", same inode and birthtime)`, async () => {
      const root = makeTempDir("neo-vcache-overwrite-");
      const { store, ids } = await seededStore(root, "ws", 6);
      const query = vectorFor(4711);
      const warm = search(store, query);
      assert.equal(warm.vectorCache.misses, 6);
      const { index, path } = vectorFile(store);
      const before = statSync(path);
      const bytes = Buffer.from(readFileSync(path));
      ids.forEach((id, i) => Buffer.from(Float32Array.from(vectorFor(7000 + i)).buffer).copy(bytes, index.entries[id].offset));
      Buffer.from(Float32Array.from(query).buffer).copy(bytes, index.entries[ids[2]].offset);
      const fd = openSync(path, mode);
      try { writeSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
      // Ein echtes Ueberschreiben liegt zeitlich nach dem Laden; der Test
      // setzt die mtime ausdruecklich, damit er nicht am Tick haengt.
      const later = new Date(before.mtimeMs + 5000);
      utimesSync(path, later, later);
      const after = statSync(path);
      assert.equal(after.ino, before.ino, "same inode");
      assert.equal(after.birthtimeMs, before.birthtimeMs, "same birthtime");
      assert.equal(after.size, before.size, "same size");
      const result = assertSameAsUncached(store, query, "overwritten bytes win over the cache");
      assert.equal(result.hits[0].item.id, ids[2]);
      assertUnitSimilarity(result.hits[0]);
      assert.equal(result.vectorCache.verifyFailed, 1, "the sample check caught the overwrite");
      assert.equal(result.vectorCache.misses, 6, "all vectors are read again");
      const again = search(store, query);
      assert.equal(again.vectorCache.hits, 6, "the new content is cached");
      assert.equal(again.vectorCache.verified + again.vectorCache.verifyFailed, 0, "unchanged file, no second check");
    });
  }

  it("an append passes the sample check and keeps every cached vector", async () => {
    const root = makeTempDir("neo-vcache-verify-");
    const { store } = await seededStore(root, "ws", 40);
    const query = vectorFor(31337);
    const first = search(store, query);
    assert.equal(first.vectorCache.verified, 0, "a new file record needs no check");
    const steady = search(store, query);
    assert.equal(steady.vectorCache.verified + steady.vectorCache.verifyFailed, 0, "no check while the file is unchanged");
    await seed(store, ["ws-appended"], { "ws-appended": vectorFor(4040) });
    const after = assertSameAsUncached(store, query, "results after the append");
    assert.equal(after.vectorCache.verified, 1, "the changed file was checked once");
    assert.equal(after.vectorCache.verifyFailed, 0);
    assert.equal(after.vectorCache.hits, 40);
    assert.equal(after.vectorCache.misses, 1, "only the appended vector is read");
    const stats = neoVectorCacheStats();
    assert.equal(stats.invalidated, 0, "nothing was dropped");
    assert.equal(stats.verified, 1);
  });

  it("invalidates when the vector file shrinks below a cached vector", async () => {
    const root = makeTempDir("neo-vcache-trunc-");
    const { store } = await seededStore(root, "ws", 6);
    const query = vectorFor(66);
    const before = search(store, query);
    assert.equal(before.withVector, 6);
    const { path } = vectorFile(store);
    truncateSync(path, statSync(path).size - DIMS * 2);
    const after = assertSameAsUncached(store, query, "truncated file behaves like the uncached path");
    assert.equal(after.withVector, 5, "the cut vector is gone, not served from the cache");
    assert.equal(neoVectorCacheStats().entries, 5);
  });

  it("does not cache a half-written vector at the end of the file", async () => {
    const root = makeTempDir("neo-vcache-half-");
    const { store } = await seededStore(root, "ws", 4);
    const query = vectorFor(808);
    search(store, query);
    // Ein Index-Eintrag, dessen Bytes erst zur Haelfte in der Datei liegen.
    const item = candidate("ws-half", 0);
    store.appendCandidates([item]);
    const { index, path } = vectorFile(store);
    const offset = statSync(path).size;
    const full = Buffer.from(Float32Array.from(query).buffer);
    appendFileSync(path, full.subarray(0, full.length / 2));
    index.entries["ws-half"] = { offset, length: full.length, dims: DIMS };
    writeFileSync(store.paths.vectorIndex, JSON.stringify(index));
    const partial = assertSameAsUncached(store, query, "half-written vector is skipped like before");
    assert.ok(!partial.hits.some((hit) => hit.item.id === "ws-half"));
    assert.equal(partial.withVector, 4);
    assert.equal(neoVectorCacheStats().entries, 4, "nothing cached for the partial vector");
    appendFileSync(path, full.subarray(full.length / 2));
    const complete = assertSameAsUncached(store, query, "completed vector is read");
    assert.equal(complete.hits[0].item.id, "ws-half");
    assertUnitSimilarity(complete.hits[0]);
    assert.equal(search(store, query).vectorCache.hits, 5, "the completed vector is cached");
  });

  it("re-reads a rewritten vector index with the same size and mtime (new inode)", async () => {
    const root = makeTempDir("neo-vcache-index-");
    const { store, ids } = await seededStore(root, "ws", 4);
    const query = vectorFor(5);
    const indexPath = store.paths.vectorIndex;
    const original = JSON.parse(readFileSync(indexPath, "utf8"));
    const pinned = new Date(NOW);
    const writeIndex = (index) => {
      writeFileSync(`${indexPath}.tmp`, JSON.stringify(index, null, 2));
      utimesSync(`${indexPath}.tmp`, pinned, pinned);
      renameSync(`${indexPath}.tmp`, indexPath);
    };
    writeIndex(original);
    search(store, query);
    // Zwei Offsets tauschen: gleiche Laenge, gleiche mtime, neue Inode.
    const swapped = structuredClone(original);
    const [a, b] = [ids[0], ids[1]];
    [swapped.entries[a].offset, swapped.entries[b].offset] = [swapped.entries[b].offset, swapped.entries[a].offset];
    const before = statSync(indexPath);
    writeIndex(swapped);
    const after = statSync(indexPath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.notEqual(after.ino, before.ino);
    const result = assertSameAsUncached(store, query, "swapped offsets are honoured");
    const embeddingOf = (id) => result.hits.find((hit) => hit.item.id === id).item.embedding;
    assert.deepStrictEqual(embeddingOf(a), vectorFor(2), "id a now points at b's bytes");
    assert.deepStrictEqual(embeddingOf(b), vectorFor(1));
  });

  it("stays within the byte limit and evicts the least recently used workspace first", async () => {
    const root = makeTempDir("neo-vcache-cap-");
    const first = await seededStore(root, "wa", 6, 10);
    const second = await seededStore(root, "wb", 6, 50);
    const query = vectorFor(123);
    process.env[ENV_KEY] = String(8 * ENTRY_BYTES);
    search(first.store, query);
    assert.equal(neoVectorCacheStats().entries, 6);
    const result = search(second.store, query);
    assert.deepStrictEqual(comparable(result), comparable(uncached(second.store, query)), "eviction never changes results");
    const stats = neoVectorCacheStats();
    assert.ok(stats.bytes <= 8 * ENTRY_BYTES, `bytes ${stats.bytes} within the limit`);
    assert.ok(stats.evicted >= 4, "older entries were evicted");
    const again = search(second.store, query);
    assert.equal(again.vectorCache.hits, 6, "the most recently used workspace stayed cached");
    const firstAgain = search(first.store, query);
    assert.ok(firstAgain.vectorCache.misses >= 4, "the older workspace lost its entries");
    assert.deepStrictEqual(comparable(firstAgain), comparable(uncached(first.store, query)));
    assert.ok(neoVectorCacheStats().bytes <= 8 * ENTRY_BYTES);
  });

  it("keeps working when one search needs more than the limit", async () => {
    const root = makeTempDir("neo-vcache-tiny-");
    const { store } = await seededStore(root, "ws", 10);
    const query = vectorFor(9);
    process.env[ENV_KEY] = String(3 * ENTRY_BYTES);
    for (let i = 0; i < 3; i++) {
      assert.deepStrictEqual(comparable(search(store, query)), comparable(uncached(store, query)), `round ${i}`);
      assert.ok(neoVectorCacheStats().bytes <= 3 * ENTRY_BYTES);
    }
    process.env[ENV_KEY] = "10";
    resetNeoVectorCache();
    const tiny = search(store, query);
    assert.deepStrictEqual(comparable(tiny), comparable(uncached(store, query)), "a limit below one vector caches nothing");
    assert.equal(neoVectorCacheStats().entries, 0);
    assert.equal(tiny.vectorCache.uncached, 10);
  });

  // Pruefung F1: liegt die Arbeitsmenge ueber der Grenze, darf ein Aufruf
  // nicht verdraengen, was er gerade selbst geladen hat (sonst laedt jeder
  // Aufruf N - 0,9 * Grenze nach und sortiert dafuer alle Eintraege).
  it("keeps a stable subset when the working set exceeds the limit (no churn)", async () => {
    const root = makeTempDir("neo-vcache-over-");
    const { store } = await seededStore(root, "ws", 10);
    process.env[ENV_KEY] = String(4 * ENTRY_BYTES);
    const query = vectorFor(2024);
    const first = search(store, query);
    assert.deepStrictEqual(comparable(first), comparable(uncached(store, query)));
    assert.equal(first.vectorCache.loaded, 4, "fills the cache up to the limit");
    assert.equal(first.vectorCache.overflow, 6, "the rest is read without caching");
    assert.deepStrictEqual(first.vectorCache.capacityWarning, { maxBytes: 4 * ENTRY_BYTES, cachedBytes: 4 * ENTRY_BYTES, wanted: 10, overflow: 6, refaults: 0 });
    for (let round = 0; round < 4; round++) {
      const result = search(store, vectorFor(3000 + round));
      assert.deepStrictEqual(comparable(result), comparable(uncached(store, vectorFor(3000 + round))), `round ${round}`);
      const cache = result.vectorCache;
      assert.equal(cache.hits, 4, `round ${round}: the same four stay cached`);
      assert.equal(cache.misses, 6);
      assert.equal(cache.evicted, 0, `round ${round}: nothing of its own is evicted`);
      assert.equal(cache.loaded, 0);
      assert.equal(cache.overflow, 6);
      assert.equal(cache.capacityWarning, undefined, "the warning comes once per process");
    }
    const stats = neoVectorCacheStats();
    assert.equal(stats.evicted, 0);
    assert.equal(stats.entries, 4);
    assert.ok(stats.bytes <= 4 * ENTRY_BYTES);
  });

  it("warns once when alternating workspaces refault each other's vectors", async () => {
    const root = makeTempDir("neo-vcache-refault-");
    const first = await seededStore(root, "wa", 6, 10);
    const second = await seededStore(root, "wb", 6, 50);
    process.env[ENV_KEY] = String(8 * ENTRY_BYTES);
    const query = vectorFor(99);
    const warnings = [];
    for (let round = 0; round < 3; round++) {
      for (const { store } of [first, second]) {
        const result = search(store, query);
        assert.deepStrictEqual(comparable(result), comparable(uncached(store, query)), `round ${round}`);
        if (result.vectorCache.capacityWarning) warnings.push(result.vectorCache.capacityWarning);
        assert.ok(neoVectorCacheStats().bytes <= 8 * ENTRY_BYTES);
      }
    }
    assert.equal(warnings.length, 1, "one warning per process");
    assert.ok(warnings[0].refaults > 0, "raised by vectors that were evicted and asked for again");
    assert.equal(warnings[0].overflow, 0, "each workspace fits on its own");
    assert.ok(neoVectorCacheStats().refaults > 0);
    resetNeoVectorCache();
    search(first.store, query);
    assert.ok(search(second.store, query).vectorCache.capacityWarning === undefined, "no refault right after a reset");
    assert.ok(search(first.store, query).vectorCache.capacityWarning, "the reset re-arms the warning");
  });

  it("reads the limit from PLUR1BUS_NEO_VECTOR_CACHE_MAX_BYTES; 0 turns the cache off", async () => {
    assert.equal(NEO_VECTOR_CACHE_DEFAULT_MAX_BYTES, 512 * 1024 * 1024);
    assert.equal(neoVectorCacheMaxBytes({}), NEO_VECTOR_CACHE_DEFAULT_MAX_BYTES);
    assert.equal(neoVectorCacheMaxBytes({ [ENV_KEY]: "" }), NEO_VECTOR_CACHE_DEFAULT_MAX_BYTES);
    assert.equal(neoVectorCacheMaxBytes({ [ENV_KEY]: "abc" }), NEO_VECTOR_CACHE_DEFAULT_MAX_BYTES);
    assert.equal(neoVectorCacheMaxBytes({ [ENV_KEY]: "-1" }), NEO_VECTOR_CACHE_DEFAULT_MAX_BYTES);
    assert.equal(neoVectorCacheMaxBytes({ [ENV_KEY]: "1048576" }), 1048576);
    assert.equal(neoVectorCacheMaxBytes({ [ENV_KEY]: "0" }), 0);

    const root = makeTempDir("neo-vcache-env-");
    const { store } = await seededStore(root, "ws", 5);
    process.env[ENV_KEY] = "0";
    const off = search(store, vectorFor(1));
    assert.equal(off.vectorCache.disabled, true);
    assert.equal(neoVectorCacheStats().entries, 0, "nothing cached while disabled");
    assert.equal(neoVectorCacheStats().maxBytes, 0);
    delete process.env[ENV_KEY];
    const on = search(store, vectorFor(1));
    assert.equal(on.vectorCache.loaded, 5);
    assert.deepStrictEqual(comparable(on), comparable(off));
  });

  it("leaves the vector files untouched", async () => {
    const root = makeTempDir("neo-vcache-ro-");
    const { store } = await seededStore(root, "ws", 5);
    const list = () => readdirSync(store.paths.workspaceDir).filter((name) => /^vector/.test(name)).map((name) => {
      const stat = statSync(join(store.paths.workspaceDir, name));
      return [name, stat.size, stat.mtimeMs, stat.ino];
    });
    const before = list();
    for (let i = 0; i < 3; i++) search(store, vectorFor(i));
    assert.deepStrictEqual(list(), before);
  });
});
