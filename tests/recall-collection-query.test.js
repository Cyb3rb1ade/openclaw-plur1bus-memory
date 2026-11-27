/**
 * tests/recall-collection-query.test.js
 *
 * V0 (recall.collectionWidth) and recall.candidateHardLimitMax: the detector,
 * the config, the widths inside runRecallPipeline and their propagation
 * through runMergedNamespaceRecall (final cap and budget). DB-free.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  COLLECTION_DEFAULT_CANDIDATE_TOP_K,
  COLLECTION_DEFAULT_TOP_N,
  isCollectionQuery,
  normalizeCollectionWidthConfig,
  resolveCollectionWidth,
} from "../lib/recall-collection-query.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";
import { runMergedNamespaceRecall } from "../engine/recall/namespace-recall.js";
import { GOLDEN_NOW, goldenEmbeddings, goldenRow, goldenTable, unitVector } from "./helpers/arms-golden-scenarios.js";

const silent = { info() {}, warn() {}, debug() {}, error() {} };

function rows(count) {
  return Array.from({ length: count }, (_, i) => goldenRow({
    id: `r${String(i).padStart(3, "0")}`,
    text: `Melanie: activity number ${i}`,
    vector: unitVector([1, 0.004 * i, 0.002 * (i % 7)]),
  }));
}

/** goldenTable that records every vector-search limit. */
function recordingTable(data, limits) {
  const table = goldenTable(data);
  return {
    vectorSearch(v) {
      const builder = table.vectorSearch(v);
      return {
        where() { return this; },
        limit(n) { limits.push(n); return builder.limit(n); },
      };
    },
    query: () => table.query(),
  };
}

const embeddings = goldenEmbeddings({ activities: unitVector([1, 0, 0]), weather: unitVector([1, 0, 0]) });

function params(extra = {}) {
  return {
    agentId: "agent-a",
    topN: 30,
    budget: 30,
    candidateTopK: 100,
    rerankCandidates: 100,
    recallMinScore: 0.05,
    importanceBoost: 0,
    canonicalEnabled: false,
    associativeEnabled: false,
    dedupEnabled: false,
    deferFinalCap: true,
    candidateHardLimit: 100,
    logger: silent,
    now: GOLDEN_NOW,
    embeddings,
    ...extra,
  };
}

describe("isCollectionQuery", () => {
  const yes = [
    "What activities does Melanie partake in?",
    "What books has Melanie read?",
    "Which national parks did they visit?",
    "What kind of indoor activities has Andrew pursued?",
    "What are the names of Audrey's dogs?",
    "How many times did they hike together?",
    "How often does Audrey walk the dogs?",
    "What kinds of art does Caroline make?",
    "Wie oft war ich beim Arzt?",
    "Wie viele Bücher habe ich gelesen?",
    "Welche Filme haben wir alle gesehen?",
    "Was für Hobbys hat Eva?",
    "What are your hobbies?",
    "Zähl mal alle Orte auf, an denen wir waren.",
    "Did you get all the tickets?",
  ];
  const no = [
    "What is Caroline's identity?",
    "When did Melanie paint a sunrise?",
    "What kind of tattoo does Audrey have?",
    "What did Melanie's kids like?",
    "Where does Caroline live?",
    "Wann war ich beim Arzt?",
    "Was hat Eva gestern gesagt?",
    // Singular or idiomatic forms that look like a collection rule.
    "Was für ein Wetter ist morgen?",
    "Was für eine Idee hattest du?",
    "What are you doing tomorrow?",
    "What were they thinking?",
    "Ich zähle auf dich, oder?",
    "I was thinking about you all the time.",
    "",
    null,
  ];
  for (const q of yes) it(`detects: ${q}`, () => assert.equal(isCollectionQuery(q).collection, true));
  for (const q of no) it(`ignores: ${String(q)}`, () => assert.equal(isCollectionQuery(q).collection, false));

  it("ignores long prompts (pasted documents) even with a matching phrase", () => {
    assert.equal(isCollectionQuery(`${"Log line without a question. ".repeat(40)} How many errors?`).collection, false);
  });

  it("names the rule that matched", () => {
    assert.equal(isCollectionQuery("How many pets?").rule, "how-many");
    assert.equal(isCollectionQuery("What activities does Melanie do?").rule, "what-plural");
  });
});

describe("collection width config", () => {
  it("is off unless enabled is true, with the design defaults", () => {
    assert.deepEqual(normalizeCollectionWidthConfig(undefined), { enabled: false, topN: COLLECTION_DEFAULT_TOP_N, candidateTopK: COLLECTION_DEFAULT_CANDIDATE_TOP_K });
    assert.equal(COLLECTION_DEFAULT_TOP_N, 45);
    assert.equal(COLLECTION_DEFAULT_CANDIDATE_TOP_K, 200);
    assert.equal(resolveCollectionWidth("What activities does Melanie do?", { enabled: "yes" }), null);
    assert.deepEqual(resolveCollectionWidth("What activities does Melanie do?", { enabled: true, topN: 40.7, candidateTopK: 9_999 }), { topN: 40, candidateTopK: 500, rule: "what-plural" });
    assert.equal(resolveCollectionWidth("Where does Melanie live?", { enabled: true }), null);
  });
});

describe("collection width in runRecallPipeline", () => {
  it("a collection question gets topN 45 and, with candidateHardLimitMax 200, 200 candidates and rerank documents", async () => {
    const limits = [];
    const rerankSizes = [];
    const result = await runRecallPipeline(params({
      query: "What activities does Melanie partake in?",
      dbTable: recordingTable(rows(250), limits),
      reranker: { async rerank(_q, docs, limit) { rerankSizes.push(docs.length); return docs.map((_, index) => ({ index, relevance_score: 1 - index / 1000 })).slice(0, limit); } },
      collectionWidth: { enabled: true },
      candidateHardLimitMax: 200,
    }));
    assert.deepEqual(limits, [200]);
    assert.deepEqual(rerankSizes, [200]);
    assert.equal(result.memories.length, 200, "deferFinalCap: the caller caps");
    assert.deepEqual(result.collection, { applied: true, rule: "what-plural", topN: 45, candidateTopK: 200, hardCandidateLimit: 200 });
  });

  it("without a higher candidateHardLimitMax the pool stays at 100 (only topN widens)", async () => {
    const limits = [];
    const result = await runRecallPipeline(params({
      query: "What activities does Melanie partake in?",
      dbTable: recordingTable(rows(250), limits),
      collectionWidth: { enabled: true },
    }));
    assert.deepEqual(limits, [100]);
    assert.deepEqual(result.collection, { applied: true, rule: "what-plural", topN: 45, candidateTopK: 100, hardCandidateLimit: 100 });
  });

  it("a lookup question keeps every width, the result only says so", async () => {
    const limits = [];
    const on = await runRecallPipeline(params({
      query: "How is the weather?",
      dbTable: recordingTable(rows(250), limits),
      collectionWidth: { enabled: true },
      candidateHardLimitMax: 200,
    }));
    const off = await runRecallPipeline(params({ query: "How is the weather?", dbTable: goldenTable(rows(250)) }));
    assert.deepEqual(limits, [100]);
    assert.deepEqual(on.collection, { applied: false, rule: null });
    assert.equal(JSON.stringify(on.memories), JSON.stringify(off.memories));
    assert.equal(Object.hasOwn(off, "collection"), false);
  });

  it("without deferFinalCap the pipeline itself caps at the collection topN", async () => {
    const result = await runRecallPipeline(params({
      query: "What activities does Melanie partake in?",
      dbTable: goldenTable(rows(80)),
      deferFinalCap: false,
      collectionWidth: { enabled: true, topN: 40 },
    }));
    assert.equal(result.memories.length, 40);
  });

  it("candidateHardLimitMax alone changes nothing for ordinary calls", async () => {
    const limits = [];
    await runRecallPipeline(params({ query: "What activities does Melanie partake in?", dbTable: recordingTable(rows(250), limits), candidateHardLimitMax: 300 }));
    assert.deepEqual(limits, [100]);
  });
});

describe("collection width through runMergedNamespaceRecall", () => {
  const readDbs = () => [{ namespace: null, sourceKind: "private", optional: false, db: { table: goldenTable(rows(120)), identity: null } }];
  const base = (extra) => ({
    ...params({ deferFinalCap: undefined, candidateHardLimit: undefined }),
    canonicalOutsideLimit: true,
    canonicalMaxItems: 5,
    ...extra,
  });

  it("caps the merged result at the collection topN and lifts the budget", async () => {
    const merged = await runMergedNamespaceRecall(readDbs(), base({ query: "What activities does Melanie partake in?", collectionWidth: { enabled: true } }), null, null);
    assert.equal(merged.memories.length, 45);
  });

  it("keeps topN for lookups and with the switch off", async () => {
    const lookup = await runMergedNamespaceRecall(readDbs(), base({ query: "How is the weather?", collectionWidth: { enabled: true } }), null, null);
    assert.equal(lookup.memories.length, 30);
    const off = await runMergedNamespaceRecall(readDbs(), base({ query: "What activities does Melanie partake in?" }), null, null);
    assert.equal(off.memories.length, 30);
  });
});
