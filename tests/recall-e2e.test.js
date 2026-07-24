/**
 * End-to-End Recall Smoke Tests — gesamte Recall-Pipeline
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { runRecallPipeline as runRecallPipelineRaw, dedupResults } from "../lib/recall-pipeline.js";
import { tokenize, jaccardSimilarity } from "../lib/text-utils.js";
import { computeDecayedStrength } from "../lib/memory-dynamics.js";
import { createEmbeddingCache } from "../lib/embedding-cache.js";
import { allocateMemoryTiers } from "../lib/recall-budget.js";

describe("recall-e2e", () => {
  const makeDbTable = (rows) => {
    const authorizedRows = rows.map((row) => ({
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
      ...row,
    }));
    return ({
    vectorSearch: () => ({
      limit: () => ({
        toArray: async () => authorizedRows,
      }),
    }),
    });
  };

  const runRecallPipeline = (options) => runRecallPipelineRaw({ agentId: "agent-a", ...options });

  const makeEmbeddings = (vec = [0.1, 0.2, 0.3]) => ({
    dim: vec.length,
    embed: async () => vec,
    embedQuery: async () => vec,
  });

  // ─── Szenario 1: Technische Akronyme ──────────────────────────────────────
  it("preserves acronyms via tokenize >=2 and recalls them", async () => {
    const rows = [
      { id: "m1", text: "AI framework for NLP tasks", _distance: 0.1, importance: 0.8 },
      { id: "m2", text: "REST API gateway design", _distance: 0.15, importance: 0.7 },
      { id: "m3", text: "GPU acceleration in CUDA", _distance: 0.2, importance: 0.6 },
    ];

    // Akronyme bleiben wegen tokenize ≥2 erhalten
    assert.ok(tokenize("AI").has("ai"), "tokenize should preserve 2-letter acronym AI");
    assert.ok(tokenize("API").has("api"), "tokenize should preserve 3-letter acronym API");
    assert.ok(tokenize("GPU").has("gpu"), "tokenize should preserve 3-letter acronym GPU");
    assert.ok(tokenize("CUDA").has("cuda"), "tokenize should preserve 4-letter acronym CUDA");

    // Pipeline-Recall
    const { memories } = await runRecallPipeline({
      query: "machine learning API",
      dbTable: makeDbTable(rows),
      embeddings: makeEmbeddings(),
      topN: 5,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger: { warn: () => {}, info: () => {} },
    });

    const ids = memories.map((m) => m.entry.id);
    assert.ok(ids.includes("m1"), "should recall AI memory");
    assert.ok(ids.includes("m2"), "should recall API memory");
    assert.ok(ids.includes("m3"), "should recall GPU memory");
  });

  // ─── Szenario 2: project/person longContext ───────────────────────────────
  it("project memory with halfLifeDays=365 has computeDecayedStrength > 0.88 after 50 days", () => {
    const now = Date.now();
    const row = {
      memoryStrength: 1.0,
      halfLifeDays: 365,
      lastDynamicsAt: now - 50 * 86400000,
      createdAt: now - 50 * 86400000,
    };

    const strength = computeDecayedStrength(row, now);
    assert.ok(
      strength > 0.88,
      `expected strength > 0.88 after 50d with halfLife=365, got ${strength.toFixed(4)}`
    );

    // Im Pipeline-Kontext: der Strength-Boost ist 0.65 + 0.35 * strength
    const expectedBoost = 0.65 + 0.35 * strength;
    assert.ok(
      expectedBoost > 0.958,
      `expected strength boost > 0.958 in pipeline, got ${expectedBoost.toFixed(4)}`
    );
  });

  // ─── Szenario 3: canonical + episodic gemischt ────────────────────────────
  it("budget allocation prefers core and canonical over episodic", () => {
    const core = [
      { entry: { id: "c1", memoryClass: "core" } },
      { entry: { id: "c2", memoryClass: "core" } },
    ];
    const canonical = [
      { entry: { id: "k1", category: "canonical" } },
      { entry: { id: "k2", category: "canonical" } },
    ];
    const episodic = Array.from({ length: 10 }, (_, i) => ({
      entry: { id: `e${i}`, category: "other" },
    }));

    const { selected, tierCounts } = allocateMemoryTiers({
      core,
      canonical,
      episodic,
      budget: 5,
    });

    assert.strictEqual(tierCounts.core, 2, "core should get all 2 slots");
    assert.strictEqual(tierCounts.canonical, 2, "canonical should get all 2 slots");
    assert.strictEqual(tierCounts.episodic, 1, "episodic should get the remaining 1 slot");

    const order = selected.map((s) => s.entry.id);
    assert.deepStrictEqual(
      order,
      ["c1", "c2", "k1", "k2", "e0"],
      "priority order must be core > canonical > episodic"
    );
  });

  // ─── Szenario 4: Viele ähnliche Memories ──────────────────────────────────
  it("does not overly filter 10 similar memories with dedupJaccard=0.78", () => {
    // 5 fast identische Memories (hohe Jaccard-Überlappung ≥ 0.78)
    const similarBase = "Project Alpha is very important project for our";
    const similarWords = ["team", "company", "department", "group", "office"];
    const similarMemories = similarWords.map((word, i) => ({
      entry: { id: `s${i}`, text: `${similarBase} ${word} members` },
    }));

    // 5 deutlich unterschiedliche Memories
    const distinctTexts = [
      "Unique topic zero about completely different subject matter",
      "Unique topic one about totally different subject matter",
      "Unique topic two about entirely different subject matter",
      "Unique topic three about radically different subject matter",
      "Unique topic four about vastly different subject matter",
    ];
    const distinctMemories = distinctTexts.map((text, i) => ({
      entry: { id: `d${i}`, text },
    }));

    const allMemories = [...similarMemories, ...distinctMemories];

    // Die ähnlichen Memories haben untereinander Jaccard ≈ 0.8 (>0.78),
    // daher sollte nur das erste überleben. Die unterschiedlichen
    // Memories haben paarweise Jaccard ≈ 0.6 (<0.78) und kommen alle durch.
    const deduped = dedupResults(allMemories, 20, 0.78);

    const keptIds = deduped.map((d) => d.entry.id);
    const keptSimilar = keptIds.filter((id) => id.startsWith("s"));
    const keptDistinct = keptIds.filter((id) => id.startsWith("d"));

    assert.strictEqual(keptSimilar.length, 1, "only one very similar memory should survive dedup");
    assert.strictEqual(keptDistinct.length, 5, "all distinct memories should survive dedup");
    assert.strictEqual(deduped.length, 6, "total kept should be 6 (1 similar + 5 distinct)");

    // Expliziter Jaccard-Check für die ähnlichen Paare
    const j0 = jaccardSimilarity(
      similarMemories[0].entry.text,
      similarMemories[1].entry.text
    );
    assert.ok(j0 >= 0.78, `expected similar pair Jaccard >= 0.78, got ${j0.toFixed(3)}`);

    const jDistinct = jaccardSimilarity(
      distinctMemories[0].entry.text,
      distinctMemories[1].entry.text
    );
    assert.ok(jDistinct < 0.78, `expected distinct pair Jaccard < 0.78, got ${jDistinct.toFixed(3)}`);
  });

  // ─── Szenario 5: Embedding-Cache ──────────────────────────────────────────
  it("has embedding cache hit on second identical query", async () => {
    const cache = createEmbeddingCache({ maxEntries: 10, ttlMs: 60000 });
    const agentId = "agent-1";
    const modelVersion = "v1";
    const query = "machine learning API";
    const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");

    let embedCallCount = 0;
    const cachedEmbeddings = {
      dim: 3,
      embed: async () => [0.1, 0.2, 0.3],
      embedQuery: async (text) => {
        const norm = text.trim().toLowerCase().replace(/\s+/g, " ");
        const hit = cache.get(agentId, norm, modelVersion);
        if (hit) return hit.vector;
        embedCallCount++;
        const vec = [0.1, 0.2, 0.3];
        cache.set(agentId, norm, modelVersion, vec);
        return vec;
      },
    };

    const rows = [{ id: "a", text: "alpha", _distance: 0.1, importance: 0.8 }];
    const dbTable = makeDbTable(rows);

    // Erster Aufruf → Cache-Miss
    await runRecallPipeline({
      query,
      dbTable,
      embeddings: cachedEmbeddings,
      topN: 1,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger: { warn: () => {}, info: () => {} },
    });
    assert.strictEqual(embedCallCount, 1, "first call should miss cache and call embedQuery");

    // Zweiter Aufruf → Cache-Hit
    await runRecallPipeline({
      query,
      dbTable,
      embeddings: cachedEmbeddings,
      topN: 1,
      canonicalEnabled: false,
      dedupEnabled: false,
      logger: { warn: () => {}, info: () => {} },
    });
    assert.strictEqual(embedCallCount, 1, "second call should be a cache hit");

    // Direkter Cache-Check
    const cached = cache.get(agentId, normalizedQuery, modelVersion);
    assert.ok(cached, "cache should contain the normalized query");
    assert.deepStrictEqual(cached.vector, [0.1, 0.2, 0.3]);
  });
});
