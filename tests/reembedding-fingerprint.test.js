import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareEmbeddingFingerprints,
  embeddingFingerprintId,
  normalizeEmbeddingFingerprint,
} from "../lib/reembedding/fingerprint.js";

const artifacts = [
  { path: "tokenizer.json", sha256: "b".repeat(64) },
  { path: "onnx/model.onnx", sha256: "a".repeat(64) },
];

describe("immutable embedding fingerprints", () => {
  it("canonicalizes endpoint and artifact order into one stable id", () => {
    const config = {
      provider: "local-transformers",
      model: "org/model",
      revision: "0123456789abcdef",
      dimensions: 768,
      endpoint: "https://user:password@example.invalid/v1/?token=secret#fragment",
      queryPrefix: "query: ",
      passagePrefix: "passage: ",
      pooling: "mean",
      normalize: true,
    };
    const left = normalizeEmbeddingFingerprint(config, artifacts);
    const right = normalizeEmbeddingFingerprint(config, artifacts.toReversed());

    assert.deepStrictEqual(left, right);
    assert.equal(left.endpoint, "https://example.invalid/v1/");
    assert.equal(embeddingFingerprintId(left), embeddingFingerprintId(right));
    assert.doesNotMatch(JSON.stringify(left), /password|token=secret|user:/);
  });

  it("requires migration for every vector-space input including equal-dimension changes", () => {
    const base = normalizeEmbeddingFingerprint({
      provider: "local-transformers",
      model: "org/model",
      revision: "revision-a",
      dimensions: 768,
      normalize: true,
    }, artifacts);

    for (const changed of [
      { ...base, model: "org/model-b" },
      { ...base, revision: "revision-b" },
      { ...base, queryPrefix: "query: " },
      { ...base, normalize: false },
      { ...base, dimensions: 1024 },
      { ...base, artifacts: [{ path: "onnx/model.onnx", sha256: "c".repeat(64) }] },
    ]) {
      assert.equal(compareEmbeddingFingerprints(base, changed).requiresMigration, true);
    }
  });

  it("ignores credential rotation while preserving a closed fingerprint schema", () => {
    const config = {
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1536,
      endpoint: "https://api.openai.com/v1",
      apiKey: "first-secret",
      apiKeyEnv: "OPENAI_API_KEY",
      credentialGeneration: "generation-a",
    };
    const first = normalizeEmbeddingFingerprint(config, []);
    const second = normalizeEmbeddingFingerprint({
      ...config,
      apiKey: "second-secret",
      credentialGeneration: "generation-b",
    }, []);

    assert.equal(compareEmbeddingFingerprints(first, second).requiresMigration, false);
    assert.equal(embeddingFingerprintId(first), embeddingFingerprintId(second));
    assert.doesNotMatch(JSON.stringify(first), /secret|credentialGeneration|apiKey/);
    assert.throws(
      () => normalizeEmbeddingFingerprint({ ...config, unknownVectorOption: true }, []),
      /unknown embedding fingerprint field/,
    );
  });

  it("rejects mutable revisions and unsafe artifact identities", () => {
    assert.throws(
      () => normalizeEmbeddingFingerprint({ provider: "local-transformers", model: "m", revision: "main", dimensions: 3 }, []),
      /immutable revision/,
    );
    assert.throws(
      () => normalizeEmbeddingFingerprint({ provider: "local-transformers", model: "m", revision: "abc", dimensions: 3 }, [
        { path: "../model.onnx", sha256: "a".repeat(64) },
      ]),
      /artifact path/,
    );
  });
});
