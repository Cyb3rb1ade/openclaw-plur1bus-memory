// tests/provider-factory.test.js (NEU)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingProvider, createRerankerProvider } from "../lib/providers/factory.js";
import { normalizeEmbeddingConfig, normalizeRerankerConfig } from "../lib/providers/config-normalize.js";
import { DEFAULT_LOCAL_RERANKER_MODEL } from "../lib/providers/dimensions.js";
import {
  BGE_RERANKER_PROFILE,
  JINA_RERANKER_PROFILE,
} from "../lib/providers/local-model-artifacts.js";

describe("provider-factory", () => {
  before(() => {
    process.env._FACTORY_TEST_KEY = "sk-test-factory-key";
  });
  after(() => {
    delete process.env._FACTORY_TEST_KEY;
  });

  it("DEFAULT_LOCAL_RERANKER_MODEL ist der verifizierte BGE-ONNX-Export", () => {
    assert.strictEqual(DEFAULT_LOCAL_RERANKER_MODEL, "woxpas-ai/bge-reranker-v2-m3-onnx");
  });

  it("createEmbeddingProvider mit local-transformers gibt LocalTransformersEmbeddingProvider", async () => {
    const { LocalTransformersEmbeddingProvider } = await import("../lib/providers/embedding-local-transformers.js");
    const cfg = normalizeEmbeddingConfig({ provider: "local-transformers" });
    const provider = createEmbeddingProvider(cfg);
    assert.ok(provider instanceof LocalTransformersEmbeddingProvider);
  });

  it("createEmbeddingProvider mit openai + apiKeyEnv instanziiert OpenAIEmbeddingProvider", async () => {
    const { OpenAIEmbeddingProvider } = await import("../lib/providers/embedding-openai.js");
    const cfg = normalizeEmbeddingConfig({ provider: "openai", apiKeyEnv: "_FACTORY_TEST_KEY", dimensions: 3072 });
    const provider = createEmbeddingProvider(cfg);
    assert.ok(provider instanceof OpenAIEmbeddingProvider);
  });

  it("createRerankerProvider mit disabled gibt null", () => {
    const cfg = normalizeRerankerConfig({ provider: "disabled" });
    const provider = createRerankerProvider(cfg, null);
    assert.strictEqual(provider, null);
  });

  it("createRerankerProvider mit cohere + fallbackProvider=disabled gibt ChainedRerankerProvider ohne lokalen Fallback", async () => {
    const { ChainedRerankerProvider } = await import("../lib/providers/reranker-chained.js");
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "_FACTORY_TEST_KEY", fallbackProvider: "disabled" });
    const provider = createRerankerProvider(cfg, null);
    assert.ok(provider instanceof ChainedRerankerProvider);
    assert.strictEqual(provider.fallback, null);
  });

  it("createRerankerProvider mit cohere + fallbackProvider=local-transformers gibt ChainedRerankerProvider mit Fallback", async () => {
    const { ChainedRerankerProvider } = await import("../lib/providers/reranker-chained.js");
    const { LocalTransformersRerankerProvider } = await import("../lib/providers/reranker-local-transformers.js");
    const cfg = normalizeRerankerConfig({
      provider: "cohere",
      apiKeyEnv: "_FACTORY_TEST_KEY",
      fallbackProvider: "local-transformers",
      fallbackModel: "woxpas-ai/bge-reranker-v2-m3-onnx",
    });
    const provider = createRerankerProvider(cfg, null);
    assert.ok(provider instanceof ChainedRerankerProvider);
    assert.ok(provider.fallback instanceof LocalTransformersRerankerProvider);
  });

  it("createRerankerProvider mit local-transformers gibt LocalTransformersRerankerProvider", async () => {
    const { LocalTransformersRerankerProvider } = await import("../lib/providers/reranker-local-transformers.js");
    const cfg = normalizeRerankerConfig({ provider: "local-transformers" });
    const provider = createRerankerProvider(cfg, null);
    assert.ok(provider instanceof LocalTransformersRerankerProvider);
  });

  it("falls from a failing local Jina primary to the configured free BGE provider exactly once", async () => {
    const { ChainedRerankerProvider } = await import("../lib/providers/reranker-chained.js");
    const cfg = normalizeRerankerConfig({
      provider: "local-transformers",
      model: JINA_RERANKER_PROFILE.model,
      fallbackProvider: "local-transformers",
      fallbackModel: BGE_RERANKER_PROFILE.model,
      fallbackOnError: true,
    });
    const provider = createRerankerProvider(cfg, null);
    assert.ok(provider instanceof ChainedRerankerProvider);
    assert.equal(provider.primary.model, JINA_RERANKER_PROFILE.model);
    assert.equal(provider.fallback.model, BGE_RERANKER_PROFILE.model);
    let primaryCalls = 0;
    let fallbackCalls = 0;
    provider.primary._pipeline = async () => {
      primaryCalls += 1;
      throw new Error("injected Jina failure");
    };
    provider.fallback._pipeline = async () => {
      fallbackCalls += 1;
      return [{ score: 0.1 }, { score: 0.9 }];
    };

    const ranked = await provider.rerank("needle", ["other", "needle"], 2);

    assert.deepStrictEqual(ranked.map((row) => row.index), [1, 0]);
    assert.ok(primaryCalls >= 1, "the primary is attempted before fallback");
    assert.equal(fallbackCalls, 1);
  });
});
