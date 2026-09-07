import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmbeddingConfig, normalizeRequestTimeoutMs, DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS } from "../lib/providers/config-normalize.js";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";

describe("embedding request timeout", () => {
  it("defaults to 15 s and accepts overrides of at least one second", () => {
    assert.equal(DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS, 15_000);
    assert.equal(normalizeRequestTimeoutMs(undefined), 15_000);
    assert.equal(normalizeRequestTimeoutMs("abc"), 15_000);
    assert.equal(normalizeRequestTimeoutMs(200), 15_000);
    assert.equal(normalizeRequestTimeoutMs(8000), 8000);
    assert.equal(normalizeRequestTimeoutMs("9000.7"), 9000);
  });

  it("carries the value through normalizeEmbeddingConfig for remote providers", () => {
    assert.equal(normalizeEmbeddingConfig({ provider: "openai", dimensions: 1536 }).requestTimeoutMs, 15_000);
    assert.equal(normalizeEmbeddingConfig({ provider: "openai", dimensions: 1536, requestTimeoutMs: 8000 }).requestTimeoutMs, 8000);
  });

  it("hands the OpenAI SDK a bounded timeout and no retries of its own", () => {
    const provider = new OpenAIEmbeddingProvider({ model: "text-embedding-3-large", dimensions: 3072, apiKey: "sk-test", requestTimeoutMs: 8000, baseUrl: "https://example.invalid/v1" });
    assert.deepEqual(provider._clientOptions("sk-test"), { apiKey: "sk-test", baseURL: "https://example.invalid/v1", timeout: 8000, maxRetries: 0 });
    const fallback = new OpenAIEmbeddingProvider({ model: "text-embedding-3-large", dimensions: 3072, apiKey: "sk-test", requestTimeoutMs: 5 });
    assert.equal(fallback._clientOptions("sk-test").timeout, 15_000);
  });
});
