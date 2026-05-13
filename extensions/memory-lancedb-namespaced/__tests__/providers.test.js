import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmbeddingConfig, normalizeRerankerConfig } from "../lib/providers/config-normalize.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { DEFAULT_LOCAL_E5_MODEL, FRESH_OPENAI_DEFAULT_MODEL, LEGACY_DEFAULT_MODEL } from "../lib/providers/dimensions.js";

test("embedding config normalizer separates fresh OpenAI default from legacy missing model default", () => {
  const fresh = normalizeEmbeddingConfig({ provider: "openai", apiKey: "${OPENAI_API_KEY}" }, { mode: "fresh" });
  assert.equal(fresh.model, FRESH_OPENAI_DEFAULT_MODEL);
  assert.equal(fresh.dimensions, 3072);

  const legacy = normalizeEmbeddingConfig({ apiKey: "${OPENAI_API_KEY}" }, { mode: "existing" });
  assert.equal(legacy.provider, "openai-compatible");
  assert.equal(legacy.model, LEGACY_DEFAULT_MODEL);
  assert.equal(legacy.dimensions, 1536);
});

test("local embedding config requires no api key and carries E5 defaults", () => {
  const cfg = normalizeEmbeddingConfig({ provider: "local-transformers" }, { mode: "fresh" });
  assert.equal(cfg.provider, "local-transformers");
  assert.equal(cfg.local.model, DEFAULT_LOCAL_E5_MODEL);
  assert.equal(cfg.local.dimensions, 384);
  assert.equal(cfg.local.queryPrefix, "query: ");
  assert.equal(cfg.local.passagePrefix, "passage: ");
});

test("reranker config normalizes v3 and disabled configs", () => {
  const cohere = normalizeRerankerConfig({ apiKey: "${COHERE_API_KEY}" });
  assert.equal(cohere.provider, "cohere");
  assert.equal(cohere.enabled, true);
  assert.equal(cohere.model, "rerank-v3.5");

  const disabled = normalizeRerankerConfig({ enabled: false });
  assert.equal(disabled.provider, "disabled");
  assert.equal(disabled.enabled, false);
});

test("local embedding provider is lazy and exposes dimensions before model import", () => {
  const provider = new LocalTransformersEmbeddingProvider({
    model: DEFAULT_LOCAL_E5_MODEL,
    dimensions: 384,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
  });
  assert.equal(provider.id, "local-transformers");
  assert.equal(provider.dimensions(), 384);
});

