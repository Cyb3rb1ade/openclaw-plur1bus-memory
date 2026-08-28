import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createOpenClawEmbeddingSelectionMutator,
  embeddingConfigFromSelection,
  embeddingFingerprintFromNormalizedConfig,
  redactedEmbeddingSecretRef,
} from "../lib/reembedding/runtime-config.js";
import {
  normalizeEmbeddingConfig,
  resolveLocalModelCacheDir,
} from "../lib/providers/config-normalize.js";
import {
  E5_EMBEDDING_PROFILE,
  JINA_EMBEDDING_PROFILE,
  JINA_RERANKER_PROFILE,
} from "../lib/providers/local-model-artifacts.js";

describe("reembedding runtime configuration", () => {
  it("binds the pinned E5 revision and artifact hashes into the active fingerprint", () => {
    const fingerprint = embeddingFingerprintFromNormalizedConfig({
      provider: "local-transformers",
      model: E5_EMBEDDING_PROFILE.model,
      dimensions: 384,
      local: {
        model: E5_EMBEDDING_PROFILE.model,
        revision: E5_EMBEDDING_PROFILE.revision,
        queryPrefix: "query: ",
        passagePrefix: "passage: ",
      },
    });
    assert.equal(fingerprint.revision, E5_EMBEDDING_PROFILE.revision);
    assert.equal(fingerprint.pooling, "mean");
    assert.equal(fingerprint.normalize, true);
    assert.deepStrictEqual(
      fingerprint.artifacts,
      E5_EMBEDDING_PROFILE.artifacts
        .map(({ path, sha256 }) => ({ path, sha256 }))
        .toSorted((left, right) => left.path.localeCompare(right.path)),
    );
  });

  it("binds Jina v3 dtype and task-adapted vector space without empty prefix fields", () => {
    const fingerprint = embeddingFingerprintFromNormalizedConfig({
      provider: "local-transformers",
      model: JINA_EMBEDDING_PROFILE.model,
      dimensions: 256,
      local: {
        model: JINA_EMBEDDING_PROFILE.model,
        revision: JINA_EMBEDDING_PROFILE.revision,
        queryPrefix: "",
        passagePrefix: "",
      },
    });
    assert.equal(fingerprint.revision, JINA_EMBEDDING_PROFILE.revision);
    assert.equal(fingerprint.dtype, "q8");
    assert.equal(fingerprint.dimensions, 256);
    assert.equal(Object.hasOwn(fingerprint, "queryPrefix"), false);
    assert.equal(Object.hasOwn(fingerprint, "passagePrefix"), false);

    const projected = embeddingConfigFromSelection({ fingerprint });
    assert.deepStrictEqual(projected.local, {
      model: JINA_EMBEDDING_PROFILE.model,
      dimensions: 256,
      revision: JINA_EMBEDDING_PROFILE.revision,
    });
  });

  it("uses one custom local cache from remote-active preparation through the local target switch", () => {
    const customCacheDir = "/tmp/plur1bus-custom-local-model-cache";
    const remoteActive = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      local: { cacheDir: customCacheDir },
    };
    assert.equal(normalizeEmbeddingConfig(remoteActive).provider, "openai");
    assert.equal(resolveLocalModelCacheDir(remoteActive), customCacheDir);

    const fingerprint = embeddingFingerprintFromNormalizedConfig(normalizeEmbeddingConfig({
      provider: "local-transformers",
      local: {
        model: JINA_EMBEDDING_PROFILE.model,
        revision: JINA_EMBEDDING_PROFILE.revision,
        dimensions: 256,
        cacheDir: customCacheDir,
      },
    }, { acceptNonCommercialLicense: true }));
    const switched = embeddingConfigFromSelection({ fingerprint }, remoteActive);
    const normalizedTarget = normalizeEmbeddingConfig(switched, {
      acceptNonCommercialLicense: true,
    });

    assert.equal(switched.local.cacheDir, customCacheDir);
    assert.equal(normalizedTarget.local.cacheDir, customCacheDir);
    assert.equal(normalizedTarget.local.acceptNonCommercialLicense, true);
  });

  it("preserves the legacy programmatic embedding.cacheDir fallback", () => {
    assert.equal(
      resolveLocalModelCacheDir({ cacheDir: "/tmp/plur1bus-legacy-local-model-cache" }),
      "/tmp/plur1bus-legacy-local-model-cache",
    );
  });

  it("rejects a pinned reranker as an embedding fingerprint", () => {
    assert.throws(() => embeddingFingerprintFromNormalizedConfig({
      provider: "local-transformers",
      model: JINA_RERANKER_PROFILE.model,
      dimensions: 1024,
      local: {
        model: JINA_RERANKER_PROFILE.model,
        revision: JINA_RERANKER_PROFILE.revision,
      },
    }), /not a pinned embedding model/);
  });

  it("projects a target fingerprint and SecretRef into the closed embedding config", () => {
    const result = embeddingConfigFromSelection({
      fingerprint: {
        schemaVersion: 1,
        provider: "openai-compatible",
        model: "provider/model",
        dimensions: 768,
        endpoint: "https://embed.example/v1/",
        artifacts: [],
      },
      secretRef: { source: "store", provider: "default", id: "PLUR1BUS_EMBEDDING" },
    }, {
      fallback: { model: "fallback-model" },
    });
    assert.deepStrictEqual(result, {
      provider: "openai-compatible",
      model: "provider/model",
      dimensions: 768,
      baseUrl: "https://embed.example/v1/",
      apiKey: { source: "store", provider: "default", id: "PLUR1BUS_EMBEDDING" },
      fallback: { model: "fallback-model" },
    });
  });

  it("preserves only an explicit or env-backed source credential reference for rollback", () => {
    assert.deepStrictEqual(redactedEmbeddingSecretRef({
      provider: "openai",
      apiKey: { source: "store", provider: "default", id: "PLUR1BUS_KEY" },
    }), { source: "store", provider: "default", id: "PLUR1BUS_KEY" });
    assert.deepStrictEqual(redactedEmbeddingSecretRef({
      provider: "openai-compatible",
      apiKey: "${LAB_EMBEDDING_KEY}",
    }), { source: "env", provider: "default", id: "LAB_EMBEDDING_KEY" });
    assert.deepStrictEqual(redactedEmbeddingSecretRef({
      provider: "openai",
      apiKeyEnv: "CUSTOM_EMBEDDING_KEY",
    }), { source: "env", provider: "default", id: "CUSTOM_EMBEDDING_KEY" });
    assert.deepStrictEqual(redactedEmbeddingSecretRef({ provider: "openai" }), {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    assert.equal(redactedEmbeddingSecretRef({ provider: "openai", apiKey: "literal-secret" }), null);
    assert.equal(redactedEmbeddingSecretRef({ provider: "local-transformers" }), null);
  });

  it("mutates only the plugin embedding selection through the public OpenClaw config API", async () => {
    const calls = [];
    const api = {
      runtime: {
        config: {
          async mutateConfigFile(options) {
            const draft = {
              plugins: { entries: { "memory-lancedb-namespaced": { enabled: true, config: { autoCapture: true } } } },
              gateway: { port: 18789 },
            };
            const result = await options.mutate(draft, { previousHash: "before" });
            calls.push({ options, draft, result });
            return { persistedHash: "after", result };
          },
        },
      },
    };
    const mutate = createOpenClawEmbeddingSelectionMutator({ api });
    await mutate({
      generation: "generation-a",
      fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}`,
      fingerprint: {
        schemaVersion: 1,
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 768,
        artifacts: [],
      },
      secretRef: { source: "env", provider: "default", id: "LAB_EMBEDDING_KEY" },
    });
    assert.deepStrictEqual(calls[0].options.afterWrite, { mode: "auto" });
    assert.deepStrictEqual(calls[0].draft.gateway, { port: 18789 });
    assert.equal(calls[0].draft.plugins.entries["memory-lancedb-namespaced"].config.autoCapture, true);
    assert.deepStrictEqual(calls[0].draft.plugins.entries["memory-lancedb-namespaced"].config.reembedding, {
      activeGeneration: "generation-a",
      fingerprintId: `embedding:v1:sha256:${"b".repeat(64)}`,
      dimensions: 768,
    });
  });
});
