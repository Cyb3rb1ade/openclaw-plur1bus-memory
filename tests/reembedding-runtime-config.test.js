import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createOpenClawEmbeddingSelectionMutator,
  embeddingConfigFromSelection,
  embeddingFingerprintFromNormalizedConfig,
  redactedEmbeddingSecretRef,
} from "../lib/reembedding/runtime-config.js";
import { E5_EMBEDDING_PROFILE } from "../lib/providers/local-model-artifacts.js";

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
