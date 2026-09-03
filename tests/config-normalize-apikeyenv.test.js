import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmbeddingConfig, normalizeRerankerConfig } from "../lib/providers/config-normalize.js";

describe("config-normalize apiKeyEnv", () => {
  it("normalizeEmbeddingConfig übergibt apiKeyEnv unverändert", () => {
    const cfg = normalizeEmbeddingConfig({ provider: "openai", apiKeyEnv: "OPENAI_API_KEY", dimensions: 1536 });
    assert.strictEqual(cfg.apiKeyEnv, "OPENAI_API_KEY");
    assert.strictEqual(cfg.apiKey, undefined);
  });

  it("normalizeEmbeddingConfig behält apiKey wenn gesetzt", () => {
    const cfg = normalizeEmbeddingConfig({ provider: "openai", apiKey: "sk-test", dimensions: 1536 });
    assert.strictEqual(cfg.apiKey, "sk-test");
  });

  it("normalizeRerankerConfig übergibt apiKeyEnv unverändert für cohere", () => {
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "COHERE_API_KEY", model: "rerank-v3.5" });
    assert.strictEqual(cfg.apiKeyEnv, "COHERE_API_KEY");
    assert.strictEqual(cfg.apiKey, undefined);
  });

  it("normalizeRerankerConfig übergibt fallbackProvider + fallbackModel", () => {
    const cfg = normalizeRerankerConfig({
      provider: "cohere",
      apiKeyEnv: "COHERE_API_KEY",
      fallbackProvider: "local-transformers",
      fallbackModel: "BAAI/bge-reranker-v2-m3",
    });
    assert.strictEqual(cfg.fallbackProvider, "local-transformers");
    assert.strictEqual(cfg.fallbackModel, "BAAI/bge-reranker-v2-m3");
  });

  it("normalizeRerankerConfig setzt fallbackProvider=disabled als Default", () => {
    const cfg = normalizeRerankerConfig({ provider: "cohere", apiKeyEnv: "COHERE_API_KEY" });
    assert.strictEqual(cfg.fallbackProvider, "disabled");
  });

  it("normalizeRerankerConfig leitet provider=cohere aus apiKeyEnv ab, wenn provider fehlt", () => {
    // Regression: enabled:true + apiKeyEnv (ohne explizites provider-Feld) wurde
    // bisher stillschweigend zu provider="disabled", weil die Inferenz nur
    // raw.apiKey prüfte, nicht raw.apiKeyEnv — obwohl beide im Rest der
    // Codebase (resolveApiKey) gleichwertige Credential-Quellen sind.
    const cfg = normalizeRerankerConfig({ enabled: true, apiKeyEnv: "COHERE_API_KEY", fallbackOnError: true, timeoutMs: 2500 });
    assert.strictEqual(cfg.provider, "cohere");
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.apiKeyEnv, "COHERE_API_KEY");
  });
});
