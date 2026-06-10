/**
 * test/emotion-tier-config.test.js — Tests für Emotion Tier-Config, Budget-Gates
 * und Fallback-Kette.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { EmotionEngine } from "../lib/emotion-engine.js";
import { setEmotionConfig, getEmotionConfig, inferEmotionalValenceAsync, inferEmotionalValence } from "../lib/emotion.js";

describe("EmotionEngine Budget-Gate", () => {
  it("tier-3 läuft nicht wenn nicht enabled", async () => {
    const engine = new EmotionEngine({
      tier3: { enabled: false, model: "gpt-4o-mini" },
    });
    const score = await engine.analyze("I am so happy today!", "user", 3);
    assert.strictEqual(score.tier_used, 1, "Sollte auf Tier-1 fallbacken");
    assert.strictEqual(score.primary_emotion, "neutral");
    assert.strictEqual(score.confidence, 0.0);
  });

  it("tier-3 läuft nicht wenn enabled aber kein Client", async () => {
    const engine = new EmotionEngine({
      tier3: { enabled: true, model: "gpt-4o-mini", openaiClient: null },
    });
    const score = await engine.analyze("I am so happy today!", "user", 3);
    assert.strictEqual(score.tier_used, 1, "Sollte auf Tier-1 fallbacken");
  });

  it("tier-2 disabled → fallback zu tier-1", async () => {
    const engine = new EmotionEngine({
      tier2: { enabled: false },
    });
    const score = await engine.analyze("I am so happy today!", "user", 2);
    assert.strictEqual(score.tier_used, 1, "Sollte auf Tier-1 fallbacken");
  });

  it("default routing eskaliert nicht zu t3 wenn nicht enabled", async () => {
    const engine = new EmotionEngine({
      tier3: { enabled: false },
    });
    // Ambivalenter Text → würde normalerweise zu t3 eskalieren
    const score = await engine.analyze("I feel mixed emotions", "user");
    // Sollte bei t1 bleiben oder t2 verwenden, aber NICHT t3
    assert.ok(score.tier_used !== 3, `Sollte nicht Tier-3 verwenden, ist ${score.tier_used}`);
  });

  it("tier-3 läuft wenn enabled und Client vorhanden", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  valence: 0.8, arousal: 0.4, dominance: 0.3,
                  intensity: 0.9, primary_emotion: "joy", secondary_emotion: null,
                  emotion_labels: { joy: 0.95 }, confidence: 0.9, language: "en"
                })
              }
            }]
          })
        }
      }
    };
    const engine = new EmotionEngine({
      tier3: { enabled: true, model: "gpt-4o-mini", openaiClient: mockClient },
    });
    const score = await engine.analyze("I am so happy today!", "user", 3);
    assert.strictEqual(score.tier_used, 3);
    assert.strictEqual(score.primary_emotion, "joy");
  });
});

describe("setEmotionConfig + resolveForceTier", () => {
  it("setEmotionConfig speichert Config", () => {
    setEmotionConfig({ tier: "t1", t2: { enabled: true }, t3: { enabled: false } });
    const cfg = getEmotionConfig();
    assert.strictEqual(cfg.tier, "t1");
    assert.strictEqual(cfg.t2.enabled, true);
    assert.strictEqual(cfg.t3.enabled, false);
  });

  it("forceTier überschreibt config.tier", async () => {
    setEmotionConfig({ tier: "t1" });
    // forceTier=null → Engine nutzt config.tier → t1
    const legacy = await inferEmotionalValenceAsync("I am happy!");
    assert.strictEqual(typeof legacy.emotionalDominant, "string");
    // forceTier=3 explizit → sollte versuchen t3 (aber disabled → fallback)
    setEmotionConfig({ tier: "auto", t3: { enabled: false } });
    const legacy2 = await inferEmotionalValenceAsync("I am happy!", "user", 3);
    assert.ok(legacy2.emotionalDominant);
  });

  it("inferEmotionalValence bleibt synchron und funktioniert", () => {
    // Legacy-API darf nicht gebrochen werden
    const r = inferEmotionalValence("Das ist wunderbar!");
    assert.strictEqual(typeof r.emotionalDominant, "string");
    assert.ok(typeof r.joy === "number");
  });
});

describe("Feature-Toggle emotionTier", () => {
  it("FEATURE_WHITELIST enthält emotionTier", async () => {
    const { FEATURE_WHITELIST } = await import("../lib/telegram-commands/feature-toggle.js");
    assert.ok(FEATURE_WHITELIST.emotionTier, "Sollte emotionTier enthalten");
    assert.deepStrictEqual(
      FEATURE_WHITELIST.emotionTier.configPath,
      ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'emotion', 't3', 'enabled']
    );
  });
});
