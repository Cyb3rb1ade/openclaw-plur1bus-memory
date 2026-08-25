import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRerankerConfig, normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";

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
  });
});
