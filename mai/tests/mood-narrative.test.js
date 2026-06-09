/**
 * mai/tests/mood-narrative.test.js — MoodTracker + NarrativeEngine unit tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MoodTracker } from "../mood-tracker.js";
import { NarrativeEngine } from "../narrative-engine.js";
import { EmotionScore } from "../emotion-score.js";

describe("MoodTracker + NarrativeEngine", () => {
  let tmpDir;

  function makeTracker(windowSize = 50) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mood-test-"));
    const storagePath = path.join(tmpDir, "mood_log.jsonl");
    return new MoodTracker({ windowSize, storagePath });
  }

  function cleanup() {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  test("empty tracker returns null currentMood", () => {
    const tracker = makeTracker();
    try {
      assert.strictEqual(tracker.currentMood, null);
    } finally {
      cleanup();
    }
  });

  test("adding scores updates currentMood", () => {
    const tracker = makeTracker();
    try {
      tracker.add(new EmotionScore({ valence: 0.8, arousal: 0.5, dominance: 0.3, intensity: 0.7, primary_emotion: "joy" }));
      tracker.add(new EmotionScore({ valence: 0.6, arousal: 0.4, dominance: 0.2, intensity: 0.5, primary_emotion: "joy" }));
      const mood = tracker.currentMood;
      assert.ok(mood);
      assert.ok(mood.valence > 0);
      assert.ok(mood.topEmotions.includes("joy"));
    } finally {
      cleanup();
    }
  });

  test("trend detection: improving", () => {
    const tracker = makeTracker();
    try {
      tracker.add(new EmotionScore({ valence: -0.6, arousal: 0.2, dominance: -0.3, intensity: 0.5 }));
      tracker.add(new EmotionScore({ valence: -0.4, arousal: 0.2, dominance: -0.2, intensity: 0.5 }));
      tracker.add(new EmotionScore({ valence: 0.2, arousal: 0.3, dominance: 0.1, intensity: 0.5 }));
      tracker.add(new EmotionScore({ valence: 0.5, arousal: 0.4, dominance: 0.2, intensity: 0.5 }));
      assert.strictEqual(tracker.moodTrend, "improving");
    } finally {
      cleanup();
    }
  });

  test("trend detection: declining", () => {
    const tracker = makeTracker();
    try {
      tracker.add(new EmotionScore({ valence: 0.5, arousal: 0.2, dominance: 0.3, intensity: 0.5 }));
      tracker.add(new EmotionScore({ valence: 0.2, arousal: 0.2, dominance: 0.1, intensity: 0.5 }));
      tracker.add(new EmotionScore({ valence: -0.3, arousal: 0.1, dominance: -0.1, intensity: 0.5 }));
      tracker.add(new EmotionScore({ valence: -0.6, arousal: 0.0, dominance: -0.3, intensity: 0.5 }));
      assert.strictEqual(tracker.moodTrend, "declining");
    } finally {
      cleanup();
    }
  });

  test("trend detection: stable", () => {
    const tracker = makeTracker();
    try {
      for (let i = 0; i < 6; i++) {
        tracker.add(new EmotionScore({ valence: 0.1, arousal: 0.0, dominance: 0.0, intensity: 0.3 }));
      }
      assert.strictEqual(tracker.moodTrend, "stable");
    } finally {
      cleanup();
    }
  });

  test("trend detection: volatile", () => {
    const tracker = makeTracker();
    try {
      tracker.add(new EmotionScore({ valence: 0.9, arousal: 0.8, dominance: 0.5, intensity: 0.9 }));
      tracker.add(new EmotionScore({ valence: -0.9, arousal: 0.8, dominance: -0.5, intensity: 0.9 }));
      tracker.add(new EmotionScore({ valence: 0.9, arousal: 0.8, dominance: 0.5, intensity: 0.9 }));
      tracker.add(new EmotionScore({ valence: -0.9, arousal: 0.8, dominance: -0.5, intensity: 0.9 }));
      assert.strictEqual(tracker.moodTrend, "volatile");
    } finally {
      cleanup();
    }
  });

  test("arc detection: rags_to_riches", () => {
    const engine = new NarrativeEngine();
    const session = [
      new EmotionScore({ valence: -0.6, arousal: 0.2, dominance: -0.3, intensity: 0.5 }),
      new EmotionScore({ valence: -0.5, arousal: 0.1, dominance: -0.2, intensity: 0.4 }),
      new EmotionScore({ valence: -0.4, arousal: 0.0, dominance: -0.1, intensity: 0.3 }),
      new EmotionScore({ valence: 0.0, arousal: 0.1, dominance: 0.0, intensity: 0.3 }),
      new EmotionScore({ valence: 0.3, arousal: 0.2, dominance: 0.1, intensity: 0.4 }),
      new EmotionScore({ valence: 0.5, arousal: 0.3, dominance: 0.2, intensity: 0.5 }),
    ];
    const arc = engine.detectArc(session);
    assert.strictEqual(arc.arc, "rags_to_riches");
    assert.ok(arc.confidence > 0);
  });

  test("arc detection: riches_to_rags", () => {
    const engine = new NarrativeEngine();
    const session = [
      new EmotionScore({ valence: 0.6, arousal: 0.3, dominance: 0.2, intensity: 0.5 }),
      new EmotionScore({ valence: 0.5, arousal: 0.2, dominance: 0.1, intensity: 0.4 }),
      new EmotionScore({ valence: 0.3, arousal: 0.1, dominance: 0.0, intensity: 0.3 }),
      new EmotionScore({ valence: -0.1, arousal: 0.0, dominance: -0.1, intensity: 0.3 }),
      new EmotionScore({ valence: -0.4, arousal: -0.1, dominance: -0.2, intensity: 0.4 }),
      new EmotionScore({ valence: -0.6, arousal: -0.2, dominance: -0.3, intensity: 0.5 }),
    ];
    const arc = engine.detectArc(session);
    assert.strictEqual(arc.arc, "riches_to_rags");
    assert.ok(arc.confidence > 0);
  });

  test("arc detection: flat", () => {
    const engine = new NarrativeEngine();
    const session = [
      new EmotionScore({ valence: 0.05, arousal: 0.0, dominance: 0.0, intensity: 0.2 }),
      new EmotionScore({ valence: 0.0, arousal: 0.0, dominance: 0.0, intensity: 0.2 }),
      new EmotionScore({ valence: -0.05, arousal: 0.0, dominance: 0.0, intensity: 0.2 }),
    ];
    const arc = engine.detectArc(session);
    assert.strictEqual(arc.arc, "flat");
  });
});
