/**
 * mai/tests/obsidian-tags.test.js — card-tags + obsidian-export unit tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { generateEmotionTags } from "../card-tags.js";
import { exportEngramToObsidian } from "../obsidian-export.js";
import { Engram } from "../engram-emotion.js";
import { EmotionScore } from "../emotion-score.js";

describe("card-tags + obsidian-export", () => {
  test("generateEmotionTags produces correct tag array", () => {
    const emotion = new EmotionScore({
      valence: 0.6,
      arousal: 0.4,
      dominance: 0.2,
      intensity: 0.7,
      primary_emotion: "joy",
      language: "en",
      source: "user",
    });
    const tags = generateEmotionTags(emotion);
    assert.ok(tags.includes("emotion/joy"));
    assert.ok(tags.includes("valence/positive"));
    assert.ok(tags.includes("arousal/high"));
    assert.ok(tags.includes("intensity/high"));
    assert.ok(tags.includes("lang/en"));
    assert.ok(tags.includes("source/user"));
  });

  test("generateEmotionTags handles neutral emotion", () => {
    const emotion = new EmotionScore({
      valence: 0,
      arousal: 0,
      dominance: 0,
      intensity: 0.2,
      primary_emotion: "neutral",
      language: "de",
      source: "assistant",
    });
    const tags = generateEmotionTags(emotion);
    assert.ok(tags.includes("emotion/neutral"));
    assert.ok(tags.includes("valence/neutral"));
    assert.ok(tags.includes("arousal/medium"));
    assert.ok(tags.includes("intensity/low"));
    assert.ok(tags.includes("lang/de"));
    assert.ok(tags.includes("source/assistant"));
  });

  test("generateEmotionTags returns empty array for null", () => {
    assert.deepStrictEqual(generateEmotionTags(null), []);
  });

  test("exportEngramToObsidian includes YAML frontmatter", () => {
    const engram = new Engram({
      id: "test-123",
      content: "This is a memory.",
      source: "user",
      session_id: "sess-456",
      created_at: new Date("2024-01-15T10:30:00Z"),
      emotion: new EmotionScore({
        valence: 0.5,
        arousal: 0.3,
        dominance: 0.2,
        intensity: 0.6,
        primary_emotion: "joy",
        language: "en",
        source: "user",
        tier_used: 1,
        confidence: 0.85,
      }),
    });
    const md = exportEngramToObsidian(engram);
    assert.ok(md.startsWith("---"));
    assert.ok(md.includes("engram_id: test-123"));
    assert.ok(md.includes("source: user"));
    assert.ok(md.includes("session_id: sess-456"));
    assert.ok(md.includes("valence: 0.5"));
    assert.ok(md.includes("primary_emotion: joy"));
    assert.ok(md.includes("created_at:"));
  });

  test("exportEngramToObsidian includes inline tags", () => {
    const engram = new Engram({
      id: "test-123",
      content: "This is a memory.",
      source: "user",
      emotion: new EmotionScore({
        valence: 0.5,
        arousal: 0.3,
        dominance: 0.2,
        intensity: 0.6,
        primary_emotion: "joy",
        language: "en",
        source: "user",
      }),
    });
    const md = exportEngramToObsidian(engram);
    assert.ok(md.includes("#emotion-joy"));
    assert.ok(md.includes("#valence-positive"));
    assert.ok(md.includes("#intensity-medium"));
  });

  test("exportEngramToObsidian returns empty string for null engram", () => {
    assert.strictEqual(exportEngramToObsidian(null), "");
  });
});
