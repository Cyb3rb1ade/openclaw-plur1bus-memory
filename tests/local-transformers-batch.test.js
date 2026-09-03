import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { LocalTransformersRerankerProvider } from "../lib/providers/reranker-local-transformers.js";

describe("local-transformers batching", () => {
  it("sends embedding batches to the pipeline in one call", async () => {
    const provider = new LocalTransformersEmbeddingProvider({
      dimensions: 2,
      embeddingCacheEnabled: false,
    });
    const calls = [];
    provider._pipeline = async (input, options) => {
      calls.push({ input, options });
      assert.deepStrictEqual(input, ["passage: alpha", "passage: beta"]);
      return [[1, 0], [0, 1]];
    };

    const vectors = await provider.embedBatch(["alpha", "beta"]);

    assert.deepStrictEqual(vectors, [[1, 0], [0, 1]]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].options, { pooling: "mean", normalize: true });
  });

  it("disposes every native embedding output after copying its vectors", async () => {
    const provider = new LocalTransformersEmbeddingProvider({
      dimensions: 2,
      embeddingCacheEnabled: false,
    });
    const disposed = [];
    provider._pipeline = async (input) => {
      const batch = Array.isArray(input);
      return {
        data: new Float32Array(batch ? [1, 0, 0, 1] : [1, 0]),
        dims: batch ? [2, 2] : [1, 2],
        dispose() { disposed.push(batch ? "batch" : input); },
      };
    };

    assert.deepStrictEqual(await provider.embedBatch(["alpha", "beta"]), [[1, 0], [0, 1]]);
    assert.deepStrictEqual(await provider.embed("gamma"), [1, 0]);
    assert.deepStrictEqual(disposed, ["batch", "passage: gamma"]);
  });

  it("disposes per-text native outputs after batch fallback", async () => {
    const provider = new LocalTransformersEmbeddingProvider({
      dimensions: 2,
      embeddingCacheEnabled: false,
    });
    const disposed = [];
    provider._pipeline = async (input) => {
      if (Array.isArray(input)) throw new Error("batch unsupported");
      return {
        data: new Float32Array(input.endsWith("alpha") ? [1, 0] : [0, 1]),
        dims: [1, 2],
        dispose() { disposed.push(input); },
      };
    };

    assert.deepStrictEqual(await provider.embedBatch(["alpha", "beta"]), [[1, 0], [0, 1]]);
    assert.deepStrictEqual(disposed, ["passage: alpha", "passage: beta"]);
  });

  it("falls back to per-text embedding calls when a pipeline rejects batch input", async () => {
    const provider = new LocalTransformersEmbeddingProvider({
      dimensions: 2,
      embeddingCacheEnabled: false,
    });
    const calls = [];
    provider._pipeline = async (input) => {
      calls.push(input);
      if (Array.isArray(input)) throw new Error("batch unsupported");
      return input.endsWith("alpha") ? [1, 0] : [0, 1];
    };

    const vectors = await provider.embedBatch(["alpha", "beta"]);

    assert.deepStrictEqual(vectors, [[1, 0], [0, 1]]);
    assert.deepStrictEqual(calls, [
      ["passage: alpha", "passage: beta"],
      "passage: alpha",
      "passage: beta",
    ]);
  });

  it("sends reranker pairs to the classifier in one call", async () => {
    const provider = new LocalTransformersRerankerProvider();
    const calls = [];
    provider._pipeline = async (input) => {
      calls.push(input);
      assert.deepStrictEqual(input, [
        { text: "needle", text_pair: "first" },
        { text: "needle", text_pair: "second" },
      ]);
      return [{ score: 0.2 }, { score: 0.9 }];
    };

    const ranked = await provider.rerank("needle", ["first", "second"], 2);

    assert.deepStrictEqual(ranked, [
      { index: 1, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.2 },
    ]);
    assert.strictEqual(calls.length, 1);
  });

  it("falls back to per-pair reranker calls when batch scoring is unsupported", async () => {
    const provider = new LocalTransformersRerankerProvider();
    const calls = [];
    provider._pipeline = async (input) => {
      calls.push(input);
      if (Array.isArray(input)) throw new Error("batch unsupported");
      return input.text_pair === "first" ? { score: 0.2 } : { score: 0.9 };
    };

    const ranked = await provider.rerank("needle", ["first", "second"], 2);

    assert.deepStrictEqual(ranked, [
      { index: 1, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.2 },
    ]);
    assert.deepStrictEqual(calls, [
      [
        { text: "needle", text_pair: "first" },
        { text: "needle", text_pair: "second" },
      ],
      { text: "needle", text_pair: "first" },
      { text: "needle", text_pair: "second" },
    ]);
  });
});
