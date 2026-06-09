/**
 * mai/tests/tier1-classifier.test.js — Tier1LexiconClassifier unit tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { Tier1LexiconClassifier } from "../tier1-lexicon.js";

describe("Tier1LexiconClassifier", () => {
  const classifier = new Tier1LexiconClassifier();

  test("clear positive German text → joy, valence > 0.5, language === de", () => {
    const result = classifier.classify("Ich bin so glücklich und begeistert! Das ist wunderbar!");
    assert.ok(result);
    assert.strictEqual(result.primary_emotion, "joy");
    assert.ok(result.valence > 0.5, `valence was ${result.valence}`);
    assert.strictEqual(result.language, "de");
  });

  test("clear negative German text → sadness/anger, valence < -0.3", () => {
    const result = classifier.classify("Ich bin traurig und wütend. Das ist schrecklich und ich hasse es.");
    assert.ok(result);
    assert.ok(result.valence < -0.3, `valence was ${result.valence}`);
    assert.ok(["sadness", "anger"].includes(result.primary_emotion), `primary was ${result.primary_emotion}`);
    assert.strictEqual(result.language, "de");
  });

  test("clear positive English text → joy, valence > 0.5, language === en", () => {
    const result = classifier.classify("I am so happy and delighted! This is amazing and wonderful!");
    assert.ok(result);
    assert.strictEqual(result.primary_emotion, "joy");
    assert.ok(result.valence > 0.5, `valence was ${result.valence}`);
    assert.strictEqual(result.language, "en");
  });

  test("ambivalent text → returns null (fallback to tier 2)", () => {
    const result = classifier.classify("The weather is cloudy and the sky is grey.");
    assert.strictEqual(result, null);
  });

  test("performance: 100 classifications in < 500ms total", () => {
    const texts = [
      "I am happy",
      "Ich bin traurig",
      "This is amazing",
      "Das ist schrecklich",
      "I love this",
      "Ich hasse das",
    ];
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      classifier.classify(texts[i % texts.length]);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 500, `100 classifications took ${elapsed}ms`);
  });
});
