/**
 * Tests für lib/recall-pipeline.js — Pure Pipeline-Funktionen.
 * Run: node --test __tests__/recall-pipeline.test.js
 *
 * Tests die Recall-Pipeline ohne LanceDB-Dependency via Mock-dbTable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyImportanceBoost,
  dedupResults,
  parseKnowledgeMd,
  runRecallPipeline,
} from "../lib/recall-pipeline.js";

// ─── applyImportanceBoost ──────────────────────────────────────────────────

test("applyImportanceBoost: boost=0 → unverändert", () => {
  const results = [
    { entry: { importance: 0.9 }, score: 0.5 },
    { entry: { importance: 0.5 }, score: 0.6 },
  ];
  const out = applyImportanceBoost(results, 0);
  assert.deepEqual(out, results);
});

test("applyImportanceBoost: high-importance steigt im Ranking", () => {
  const results = [
    { entry: { id: "a", importance: 0.5 }, score: 0.6 },  // base higher
    { entry: { id: "b", importance: 0.95 }, score: 0.55 }, // base lower aber high importance
  ];
  const out = applyImportanceBoost(results, 0.5);
  assert.equal(out[0].entry.id, "b", "high-importance should rank first");
});

test("applyImportanceBoost: leere Liste → leer", () => {
  assert.deepEqual(applyImportanceBoost([], 0.3), []);
});

test("applyImportanceBoost: importance=null → 0.5 default", () => {
  const results = [{ entry: { importance: null }, score: 1 }];
  const out = applyImportanceBoost(results, 1);
  assert.equal(out[0].score, 1 * (1 + 0.5));
});

// ─── dedupResults ──────────────────────────────────────────────────────────

test("dedupResults: keine Duplikate → alle behalten (bis maxOut)", () => {
  const results = [
    { entry: { summary: "Apfel und Birne sind Obst" }, score: 0.9 },
    { entry: { summary: "Auto und Motorrad sind Fahrzeuge" }, score: 0.8 },
    { entry: { summary: "Berlin ist die Hauptstadt von Deutschland" }, score: 0.7 },
  ];
  const out = dedupResults(results, 5, 0.6);
  assert.equal(out.length, 3);
});

test("dedupResults: nahe Duplikate werden suppimiert", () => {
  const results = [
    { entry: { summary: "Christian mag Kaffee morgens" }, score: 0.9 },
    { entry: { summary: "Christian mag Kaffee morgens immer" }, score: 0.8 },
    { entry: { summary: "Auto und Bahn ganz anderes Thema" }, score: 0.7 },
  ];
  const out = dedupResults(results, 5, 0.6);
  assert.equal(out.length, 2, "Christian-mag-Kaffee-Variante sollte gefiltert sein");
  assert.equal(out[0].entry.summary, "Christian mag Kaffee morgens");
  assert.equal(out[1].entry.summary, "Auto und Bahn ganz anderes Thema");
});

test("dedupResults: respect maxOut bei wirklich unterschiedlichen Texten", () => {
  // Komplett verschiedene Wörter, damit Jaccard nicht greift
  const distinct = [
    "Apfel Birne Kirsche Orange",
    "Auto Motorrad Fahrrad Roller",
    "Berlin Hamburg München Köln",
    "Sonne Mond Sterne Planet",
    "Wasser Erde Feuer Luft",
  ];
  const results = distinct.map((text, i) => ({
    entry: { summary: text },
    score: 1 - i * 0.1,
  }));
  const out = dedupResults(results, 3, 0.6);
  assert.equal(out.length, 3);
});

test("dedupResults: maxOut=0 → leer", () => {
  const results = [{ entry: { summary: "anything goes here as text" }, score: 1 }];
  assert.deepEqual(dedupResults(results, 0, 0.6), []);
});

// ─── parseKnowledgeMd ──────────────────────────────────────────────────────

test("parseKnowledgeMd: H1/H2/H3 Sections", () => {
  const md = `# Top Heading\n\nSome intro text that is long enough to count as a section\n\n## Sub Section\n\nWith some content that is also long enough\n\n### Sub Sub\n\nMore content here yes indeed`;
  const sections = parseKnowledgeMd(md);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].heading, "Top Heading");
  assert.equal(sections[1].heading, "Sub Section");
  assert.equal(sections[2].heading, "Sub Sub");
});

test("parseKnowledgeMd: strippt Frontmatter", () => {
  const md = `---\nfoo: bar\n---\n\n# Heading\n\nContent that is sufficiently long to count`;
  const sections = parseKnowledgeMd(md);
  assert.equal(sections.length, 1);
  assert.ok(!sections[0].text.includes("foo: bar"));
});

test("parseKnowledgeMd: zu kurze Sections gefiltert", () => {
  const md = `# Short\n\nx\n\n# Long enough\n\nThis section has enough text to pass the 30-char filter for sure`;
  const sections = parseKnowledgeMd(md);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, "Long enough");
});

test("parseKnowledgeMd: leere Datei → []", () => {
  assert.deepEqual(parseKnowledgeMd(""), []);
});

// ─── runRecallPipeline (mit Mock-dbTable) ─────────────────────────────────

class MockDbTable {
  constructor(rows) { this.rows = rows; }
  vectorSearch(_vec) {
    return {
      limit: (n) => ({
        toArray: async () => this.rows.slice(0, n),
      }),
    };
  }
}

const mockEmbeddings = {
  dim: 4,
  async embed(text) {
    // Deterministisches Mock-Embedding aus String-Hash
    const v = [0, 0, 0, 0];
    for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) / 1000;
    return v;
  },
};

test("runRecallPipeline: leere DB → leer ohne Crash", async () => {
  const r = await runRecallPipeline({
    query: "test",
    dbTable: new MockDbTable([]),
    embeddings: mockEmbeddings,
    canonicalEnabled: false,
  });
  assert.deepEqual(r.memories, []);
  assert.deepEqual(r.canonical, []);
  assert.equal(r.queryVector.length, 4);
});

test("runRecallPipeline: filtert unter recallMinScore", async () => {
  // Mock returns a row with high distance → low score
  const rows = [{ id: "uuid-aaaa", text: "abc", _distance: 100, importance: 0.5, category: "fact" }];
  const r = await runRecallPipeline({
    query: "test",
    dbTable: new MockDbTable(rows),
    embeddings: mockEmbeddings,
    recallMinScore: 0.5,
    canonicalEnabled: false,
    importanceBoost: 0,
  });
  assert.equal(r.memories.length, 0, "score 1/(1+100) ≈ 0.01 sollte unter 0.5 sein");
});

test("runRecallPipeline: ohne reranker → fetchLimit = topN", async () => {
  let capturedLimit = null;
  const dbTable = {
    vectorSearch: () => ({
      limit: (n) => { capturedLimit = n; return { toArray: async () => [] }; },
    }),
  };
  await runRecallPipeline({
    query: "test", dbTable, embeddings: mockEmbeddings, topN: 5,
    canonicalEnabled: false, reranker: null,
  });
  assert.equal(capturedLimit, 5);
});

test("runRecallPipeline: mit reranker → fetchLimit ≥ rerankCandidates", async () => {
  let capturedLimit = null;
  const dbTable = {
    vectorSearch: () => ({
      limit: (n) => { capturedLimit = n; return { toArray: async () => [] }; },
    }),
  };
  const reranker = { rerank: async () => [] };
  await runRecallPipeline({
    query: "test", dbTable, embeddings: mockEmbeddings, topN: 5,
    canonicalEnabled: false, reranker, rerankCandidates: 20,
  });
  assert.ok(capturedLimit >= 20, `expected >=20, got ${capturedLimit}`);
});
