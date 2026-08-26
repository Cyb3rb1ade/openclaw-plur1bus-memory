import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRerankerConfig, normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import {
  BGE_RERANKER_PROFILE,
  E5_EMBEDDING_PROFILE,
  JINA_RERANKER_PROFILE,
} from "../lib/providers/local-model-artifacts.js";

describe("provider-wizard config output", () => {
  it("Cohere ohne Fallback → fallbackProvider=disabled", () => {
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "COHERE_API_KEY" });
    assert.strictEqual(cfg.fallbackProvider, "disabled");
    assert.strictEqual(cfg.fallbackModel, null);
  });

  it("Cohere mit lokalem Fallback → fallbackProvider=local-transformers", () => {
    const cfg = normalizeRerankerConfig({
      provider: "cohere",
      apiKeyEnv: "COHERE_API_KEY",
      fallbackProvider: "local-transformers",
      fallbackModel: "woxpas-ai/bge-reranker-v2-m3-onnx",
    });
    assert.strictEqual(cfg.fallbackProvider, "local-transformers");
    assert.strictEqual(cfg.fallbackModel, "woxpas-ai/bge-reranker-v2-m3-onnx");
  });

  it("Disabled produziert enabled=false", () => {
    const cfg = normalizeRerankerConfig({ provider: "disabled" });
    assert.strictEqual(cfg.enabled, false);
  });

  it("Embedding apiKeyEnv=OPENAI_API_KEY bleibt als String in Config", () => {
    const cfg = normalizeEmbeddingConfig({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY", dimensions: 3072 });
    assert.strictEqual(cfg.apiKeyEnv, "OPENAI_API_KEY");
  });

  it("Local BGE Config enthält local.model oder model", () => {
    const cfg = normalizeRerankerConfig({
      provider: "local-transformers",
      model: "woxpas-ai/bge-reranker-v2-m3-onnx",
    });
    assert.strictEqual(cfg.local?.model ?? cfg.model, "woxpas-ai/bge-reranker-v2-m3-onnx");
    assert.strictEqual(cfg.local.revision, BGE_RERANKER_PROFILE.revision);
  });

  it("pinnt E5 auf die verifizierte Revision", () => {
    const cfg = normalizeEmbeddingConfig({ provider: "local-transformers" });
    assert.strictEqual(cfg.local.model, E5_EMBEDDING_PROFILE.model);
    assert.strictEqual(cfg.local.revision, E5_EMBEDDING_PROFILE.revision);
  });

  it("konfiguriert Jina als Primary mit verifiziertem freien BGE-Fallback", () => {
    const cfg = normalizeRerankerConfig({
      provider: "local-transformers",
      model: JINA_RERANKER_PROFILE.model,
      fallbackProvider: "local-transformers",
      fallbackModel: BGE_RERANKER_PROFILE.model,
      fallbackOnError: true,
    });
    assert.strictEqual(cfg.local.revision, JINA_RERANKER_PROFILE.revision);
    assert.strictEqual(cfg.fallbackProvider, "local-transformers");
    assert.strictEqual(cfg.fallbackModel, BGE_RERANKER_PROFILE.model);
    assert.strictEqual(cfg.fallbackRevision, BGE_RERANKER_PROFILE.revision);
  });
});
