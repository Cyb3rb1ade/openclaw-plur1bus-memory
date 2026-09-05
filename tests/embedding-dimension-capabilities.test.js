import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  embeddingDimensionCapability,
  embeddingDimensionProfiles,
} from "../lib/providers/dimensions.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import {
  E5_EMBEDDING_PROFILE,
  JINA_EMBEDDING_PROFILE,
} from "../lib/providers/local-model-artifacts.js";

describe("embedding dimension capabilities", () => {
  it("publishes bounded selectable dimensions for both OpenAI v3 models", () => {
    assert.deepStrictEqual(
      embeddingDimensionCapability({ provider: "openai", model: "text-embedding-3-small" }),
      {
        mode: "selectable",
        defaultDimensions: 1536,
        minDimensions: 1,
        maxDimensions: 1536,
        presets: [256, 512, 768, 1024, 1536],
        verification: "runtime_vector",
      },
    );
    assert.deepStrictEqual(
      embeddingDimensionCapability({ provider: "openai", model: "text-embedding-3-large" }),
      {
        mode: "selectable",
        defaultDimensions: 3072,
        minDimensions: 1,
        maxDimensions: 3072,
        presets: [256, 512, 768, 1024, 1536, 2048, 3072],
        verification: "runtime_vector",
      },
    );
  });

  it("treats the pinned downloadable E5 model as fixed at its real output width", () => {
    assert.deepStrictEqual(
      embeddingDimensionCapability({
        provider: "local-transformers",
        model: E5_EMBEDDING_PROFILE.model,
      }),
      {
        mode: "fixed",
        defaultDimensions: 384,
        minDimensions: 384,
        maxDimensions: 384,
        presets: [384],
        verification: "runtime_vector",
      },
    );
  });

  it("does not invent dimensions for an unknown compatible provider model", () => {
    assert.deepStrictEqual(
      embeddingDimensionCapability({ provider: "openai-compatible", model: "vendor/model-x" }),
      {
        mode: "probe_required",
        defaultDimensions: null,
        minDimensions: null,
        maxDimensions: null,
        presets: [],
        verification: "runtime_vector",
      },
    );
  });

  it("offers only embedding models and marks the current selection", () => {
    const profiles = embeddingDimensionProfiles({
      provider: "local-transformers",
      model: E5_EMBEDDING_PROFILE.model,
      dimensions: 384,
    });
    assert.deepStrictEqual(profiles.map((entry) => entry.model), [
      "text-embedding-3-small",
      "text-embedding-3-large",
      E5_EMBEDDING_PROFILE.model,
      JINA_EMBEDDING_PROFILE.model,
      "jinaai/jina-embeddings-v5-text-nano-retrieval",
      "runtime-probed-model",
    ]);
    assert.equal(profiles.filter((entry) => entry.current).length, 1);
    assert.equal(profiles.find((entry) => entry.current).selectedDimensions, 384);
    assert.equal(profiles.some((entry) => /jina-reranker|bge-reranker/i.test(entry.model)), false);
  });

  it("rejects impossible known-model dimensions before provider or database access", () => {
    assert.throws(
      () => normalizeEmbeddingConfig({
        provider: "local-transformers",
        local: { model: E5_EMBEDDING_PROFILE.model, dimensions: 768 },
      }),
      /fixed 384 dimensions.*configured 768/i,
    );
    assert.throws(
      () => normalizeEmbeddingConfig({
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 3072,
      }),
      /supports dimensions from 1 through 1536/i,
    );
    assert.equal(normalizeEmbeddingConfig({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 512,
    }).dimensions, 512);
  });
});
