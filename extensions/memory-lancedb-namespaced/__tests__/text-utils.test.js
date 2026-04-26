/**
 * Tests für lib/text-utils.js — tokenize, jaccard, cosine, summary.
 * Run: node --test __tests__/text-utils.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, jaccardSimilarity, cosineSimilarityVec, generateSummary } from "../lib/text-utils.js";

test("tokenize: lowercases, splits, filters short", () => {
  const t = tokenize("Hello World, This is a TEST!");
  assert.ok(t.has("hello"));
  assert.ok(t.has("world"));
  assert.ok(t.has("this"));
  assert.ok(t.has("test"));
  assert.ok(!t.has("is")); // <4 chars filtered
  assert.ok(!t.has("a"));
});

test("tokenize: handles umlauts via NFKD", () => {
  const t = tokenize("Müller ÄPFEL straße");
  assert.ok(t.size >= 2);
});

test("tokenize: empty/null input", () => {
  assert.equal(tokenize("").size, 0);
  assert.equal(tokenize(null).size, 0);
  assert.equal(tokenize(undefined).size, 0);
});

test("jaccardSimilarity: identical texts → 1", () => {
  const t = "der Nutzer mag Kaffee mit viel Milch";
  assert.equal(jaccardSimilarity(t, t), 1);
});

test("jaccardSimilarity: completely different → 0", () => {
  assert.equal(jaccardSimilarity("Apfel Birne", "Auto Bahn"), 0);
});

test("jaccardSimilarity: half overlap → 0.33-0.5 range", () => {
  const sim = jaccardSimilarity("der Nutzer mag Kaffee", "der Nutzer mag Tee");
  assert.ok(sim > 0.3 && sim < 0.6, `expected partial overlap, got ${sim}`);
});

test("jaccardSimilarity: empty texts → 0 (avoid div-by-zero)", () => {
  assert.equal(jaccardSimilarity("", "anything"), 0);
  assert.equal(jaccardSimilarity("anything", ""), 0);
});

test("cosineSimilarityVec: identical vectors → 1", () => {
  const v = [1, 2, 3, 4];
  assert.ok(Math.abs(cosineSimilarityVec(v, v) - 1) < 1e-9);
});

test("cosineSimilarityVec: orthogonal vectors → 0", () => {
  assert.equal(cosineSimilarityVec([1, 0], [0, 1]), 0);
});

test("cosineSimilarityVec: opposite vectors → -1", () => {
  assert.ok(Math.abs(cosineSimilarityVec([1, 0], [-1, 0]) - (-1)) < 1e-9);
});

test("cosineSimilarityVec: different lengths → 0 (graceful)", () => {
  assert.equal(cosineSimilarityVec([1, 2], [1, 2, 3]), 0);
});

test("cosineSimilarityVec: zero vector → 0 (no NaN)", () => {
  assert.equal(cosineSimilarityVec([0, 0], [1, 1]), 0);
});

test("generateSummary: short text returned unchanged", () => {
  const t = "Kurzer Text hier.";
  assert.equal(generateSummary(t, 100), t);
});

test("generateSummary: long text truncated to maxWords", () => {
  const long = Array(200).fill("word").join(" ");
  const sum = generateSummary(long, 50);
  assert.ok(sum.split(/\s+/).length <= 51); // 50 + ellipsis
});

test("generateSummary: prefers sentence boundary", () => {
  const t = "Erste Aussage hier. Zweite Aussage hier. Dritte Aussage hier. Vierte Aussage hier. Fünfte Aussage hier ohne Ende";
  const sum = generateSummary(t, 12);
  assert.ok(sum.endsWith(". ") || sum.endsWith("."), `expected to end on sentence boundary, got: ${sum}`);
});

test("generateSummary: defaults to ellipsis when no nearby sentence", () => {
  const t = Array(100).fill("wortohnesatz").join(" ");
  const sum = generateSummary(t, 20);
  assert.ok(sum.endsWith("…"));
});
