/**
 * test/emotion-tier-config.test.js — Tests für Emotion Tier-Config, Budget-Gates
 * und Fallback-Kette.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { EmotionEngine } from "../lib/emotion-engine.js";
import { setEmotionConfig, getEmotionConfig, inferEmotionalValenceAsync, inferEmotionalValence } from "../lib/emotion.js";
import { Tier3LLMClassifier } from "../lib/tier3-llm.js";

const TIER3_RESPONSE = JSON.stringify({
  valence: 0.8,
  arousal: 0.4,
  dominance: 0.3,
  intensity: 0.9,
  primary_emotion: "joy",
  secondary_emotion: null,
  emotion_labels: { joy: 0.95 },
  confidence: 0.9,
  language: "en",
});

function interceptOpenAiPost(t, calls) {
  const original = OpenAI.prototype.post;
  OpenAI.prototype.post = async (path, options) => {
    calls.push({ path, body: options?.body });
    return { choices: [{ message: { content: TIER3_RESPONSE } }] };
  };
  t.after(() => {
    OpenAI.prototype.post = original;
  });
}

describe("EmotionEngine Budget-Gate", () => {
  it("passes no named model to injected Tier-3 completion", async () => {
    let calls = 0;
    const engine = new EmotionEngine({
      tier3: {
        enabled: true,
        callLlm: async () => {
          calls += 1;
          return TIER3_RESPONSE;
        },
      },
    });

    assert.strictEqual(engine._t3.model, undefined);
    const score = await engine.analyze("I am happy.", "user", 3);
    assert.strictEqual(calls, 1);
    assert.strictEqual(score.tier_used, 3);
    assert.strictEqual(score.primary_emotion, "joy");
  });

  it("keeps injected completion authoritative over a stray model option", () => {
    const engine = new EmotionEngine({
      tier3: {
        enabled: true,
        model: "foreign/model-that-belongs-to-the-router",
        callLlm: async () => TIER3_RESPONSE,
      },
    });

    assert.strictEqual(engine._t3.model, undefined);
  });

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

  it("commits no context or stats after an abort-ignoring Tier-3 call", async () => {
    const controller = new AbortController();
    let resolveLlm;
    const engine = new EmotionEngine({
      tier3: {
        enabled: true,
        callLlm: async () => new Promise((resolve) => {
          resolveLlm = resolve;
        }),
      },
    });

    const pending = engine.analyze("I am happy.", "user", 3, {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new DOMException("cancelled", "AbortError"));
    resolveLlm(TIER3_RESPONSE);

    await assert.rejects(pending, { name: "AbortError" });
    assert.strictEqual(engine._context.previous_top_emotion, null);
    assert.strictEqual(engine._context.previous_timestamp, null);
    assert.strictEqual(engine.stats.total, 0);
    assert.strictEqual(engine.stats.tier3, 0);
  });

  it("forwards the caller signal to the direct Tier-3 provider", async () => {
    const controller = new AbortController();
    let requestOptions;
    const engine = new EmotionEngine({
      tier3: {
        enabled: true,
        model: "vendor/emotion-model",
        openaiClient: {
          chat: {
            completions: {
              create: async (_body, options) => {
                requestOptions = options;
                return { choices: [{ message: { content: TIER3_RESPONSE } }] };
              },
            },
          },
        },
      },
    });

    const score = await engine.analyze("I am happy.", "user", 3, {
      signal: controller.signal,
    });

    assert.strictEqual(score.primary_emotion, "joy");
    assert.strictEqual(requestOptions.signal, controller.signal);
  });
});

describe("Tier3LLMClassifier provider ownership", () => {
  it("classifies through injected callLlm without a model", async () => {
    const classifier = new Tier3LLMClassifier({
      callLlm: async () => TIER3_RESPONSE,
    });

    const score = await classifier.classify("I am happy.");
    assert.strictEqual(classifier.model, undefined);
    assert.strictEqual(score.tier_used, 3);
    assert.strictEqual(score.primary_emotion, "joy");
  });

  it("does not issue a direct request with an API key but no explicit model", async (t) => {
    const directCalls = [];
    interceptOpenAiPost(t, directCalls);
    const classifier = new Tier3LLMClassifier({
      apiKey: "test-secret",
    });
    const tier1Result = { tier_used: 1, primary_emotion: "trust" };

    const result = await classifier.classify("Maybe.", "user", tier1Result);
    assert.strictEqual(result, tier1Result);
    assert.strictEqual(directCalls.length, 0);
  });

  it("returns a neutral result without a direct model and without Tier-1 fallback", async (t) => {
    const directCalls = [];
    interceptOpenAiPost(t, directCalls);
    const classifier = new Tier3LLMClassifier({
      apiKey: "test-secret",
    });

    const result = await classifier.classify("Maybe.");
    assert.strictEqual(directCalls.length, 0);
    assert.strictEqual(result.primary_emotion, "neutral");
    assert.strictEqual(result.confidence, 0);
  });

  it("uses the exact explicitly configured direct model", async () => {
    const requests = [];
    const classifier = new Tier3LLMClassifier({
      apiKey: "test-secret",
      model: "vendor/emotion-model",
      openaiClient: {
        chat: {
          completions: {
            create: async (request) => {
              requests.push(request);
              return { choices: [{ message: { content: TIER3_RESPONSE } }] };
            },
          },
        },
      },
    });

    const score = await classifier.classify("I am happy.");
    assert.strictEqual(score.tier_used, 3);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].model, "vendor/emotion-model");
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

describe("pure emotion and overlay module model ownership", () => {
  it("contains no hard-coded runtime chat model fallback", () => {
    for (const relativePath of [
      "../lib/emotion.js",
      "../lib/emotion-engine.js",
      "../lib/tier3-llm.js",
      "../lib/overlay-generator.js",
      "../lib/interpretation-overlay.js",
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      assert.doesNotMatch(source, /kimi-for-coding|gpt-4o-mini/, relativePath);
    }
  });
});
