/**
 * mai/tests/bus-guard-modulator.test.js — EmotionBus + ContagionGuard + ResponseModulator unit tests.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { EmotionalMemoryBus, emotionBus } from "../emotion-bus.js";
import { EmotionalContagionGuard } from "../contagion-guard.js";
import { ResponseModulator } from "../response-modulator.js";
import { EmotionScore } from "../emotion-score.js";

describe("EmotionBus + ContagionGuard + ResponseModulator", () => {
  test("Bus subscribe/publish works", () => {
    const bus = new EmotionalMemoryBus();
    const received = [];
    bus.subscribe("mood_shift", (data) => received.push(data));
    bus.publish("mood_shift", { valence: 0.5 });
    assert.deepStrictEqual(received, [{ valence: 0.5 }]);
  });

  test("Bus errors in callbacks are caught", () => {
    const bus = new EmotionalMemoryBus();
    const received = [];
    bus.subscribe("mood_shift", () => {
      throw new Error("boom");
    });
    bus.subscribe("mood_shift", (data) => received.push(data));
    // Should not throw
    bus.publish("mood_shift", { valence: 0.5 });
    assert.deepStrictEqual(received, [{ valence: 0.5 }]);
  });

  test("Guard returns ok for mixed emotions", () => {
    const guard = new EmotionalContagionGuard({ consecutiveLimit: 3, negativeThreshold: -0.4 });
    assert.strictEqual(guard.check(new EmotionScore({ valence: -0.5 })).status, "ok");
    assert.strictEqual(guard.check(new EmotionScore({ valence: 0.2 })).status, "ok");
    assert.strictEqual(guard.check(new EmotionScore({ valence: -0.5 })).status, "ok");
  });

  test("Guard returns warning for consecutive negative emotions", () => {
    const guard = new EmotionalContagionGuard({ consecutiveLimit: 3, negativeThreshold: -0.4 });
    guard.check(new EmotionScore({ valence: -0.5 }));
    guard.check(new EmotionScore({ valence: -0.5 }));
    const result = guard.check(new EmotionScore({ valence: -0.5 }));
    assert.strictEqual(result.status, "warning");
    assert.strictEqual(result.action, "reset");
    assert.ok(result.message);
  });

  test("Guard returns critical for deepening negative trend", () => {
    const guard = new EmotionalContagionGuard({ consecutiveLimit: 3, negativeThreshold: -0.4 });
    guard.check(new EmotionScore({ valence: -0.5 }));
    guard.check(new EmotionScore({ valence: -0.85 }));
    const result = guard.check(new EmotionScore({ valence: -0.95 }));
    assert.strictEqual(result.status, "critical");
    assert.strictEqual(result.action, "reframe");
    assert.ok(result.suggested_prefix);
  });

  test("Guard reset clears state", () => {
    const guard = new EmotionalContagionGuard({ consecutiveLimit: 3, negativeThreshold: -0.4 });
    guard.check(new EmotionScore({ valence: -0.5 }));
    guard.check(new EmotionScore({ valence: -0.5 }));
    guard.reset();
    const result = guard.check(new EmotionScore({ valence: -0.5 }));
    assert.strictEqual(result.status, "ok");
  });

  test("Response modulator prepends prefix for anger", () => {
    const mod = new ResponseModulator();
    const emotion = new EmotionScore({ primary_emotion: "anger", valence: -0.6, arousal: 0.6 });
    const prompt = mod.modulate(emotion, "Be helpful.");
    assert.ok(prompt.includes("angry"));
    assert.ok(prompt.startsWith("The user is feeling angry."));
  });

  test("Response modulator prepends prefix for sadness", () => {
    const mod = new ResponseModulator();
    const emotion = new EmotionScore({ primary_emotion: "sadness", valence: -0.6, arousal: -0.2 });
    const prompt = mod.modulate(emotion, "Be helpful.");
    assert.ok(prompt.includes("sad"));
    assert.ok(prompt.startsWith("The user is feeling sad."));
  });

  test("Temperature modulation: lower for anger", () => {
    const mod = new ResponseModulator();
    const anger = new EmotionScore({ primary_emotion: "anger" });
    assert.ok(Math.abs(mod.modulateTemperature(anger, 0.7) - 0.5) < 1e-10);
  });

  test("Temperature modulation: lower for fear", () => {
    const mod = new ResponseModulator();
    const fear = new EmotionScore({ primary_emotion: "fear" });
    assert.ok(Math.abs(mod.modulateTemperature(fear, 0.7) - 0.5) < 1e-10);
  });

  test("Temperature modulation: higher for joy", () => {
    const mod = new ResponseModulator();
    const joy = new EmotionScore({ primary_emotion: "joy" });
    assert.ok(Math.abs(mod.modulateTemperature(joy, 0.7) - 0.8) < 1e-10);
  });

  test("Temperature modulation: higher for surprise", () => {
    const mod = new ResponseModulator();
    const surprise = new EmotionScore({ primary_emotion: "surprise" });
    assert.ok(Math.abs(mod.modulateTemperature(surprise, 0.7) - 0.8) < 1e-10);
  });

  test("Temperature modulation: unchanged for neutral", () => {
    const mod = new ResponseModulator();
    const neutral = new EmotionScore({ primary_emotion: "neutral" });
    assert.strictEqual(mod.modulateTemperature(neutral, 0.7), 0.7);
  });

  test("Temperature modulation clamps at bounds", () => {
    const mod = new ResponseModulator();
    const anger = new EmotionScore({ primary_emotion: "anger" });
    assert.strictEqual(mod.modulateTemperature(anger, 0.1), 0.1);
    const joy = new EmotionScore({ primary_emotion: "joy" });
    assert.strictEqual(mod.modulateTemperature(joy, 0.95), 1.0);
  });
});
