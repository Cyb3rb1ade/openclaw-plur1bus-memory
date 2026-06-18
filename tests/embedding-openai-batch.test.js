import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenAIEmbeddingProvider } from "../lib/providers/embedding-openai.js";

function makeFakeOpenAI(responses) {
  let callIndex = 0;
  return class FakeOpenAI {
    constructor() {}
    get embeddings() {
      return {
        create: async (req) => {
          const response = responses[callIndex++];
          if (response instanceof Error) throw response;
          return response;
        },
      };
    }
  };
}

describe("OpenAIEmbeddingProvider embedBatch", () => {
  it("calls client.embeddings.create with input: string[]", async () => {
    const captured = [];
    const provider = new OpenAIEmbeddingProvider({ model: "text-embedding-3-small", dimensions: 3, apiKey: "test-key" });
    provider._client = {
      embeddings: {
        create: async (req) => {
          captured.push(req);
          return {
            data: [
              { embedding: [0.1, 0.2, 0.3] },
              { embedding: [0.4, 0.5, 0.6] },
            ],
          };
        },
      },
    };

    const vectors = await provider.embedBatch(["hello", "world"]);
    assert.strictEqual(captured.length, 1);
    assert.deepStrictEqual(captured[0].input, ["hello", "world"]);
    assert.strictEqual(vectors.length, 2);
    assert.deepStrictEqual(vectors[0], [0.1, 0.2, 0.3]);
    assert.deepStrictEqual(vectors[1], [0.4, 0.5, 0.6]);
  });

  it("embed(text) remains compatible and returns a single vector", async () => {
    const provider = new OpenAIEmbeddingProvider({ model: "text-embedding-3-small", dimensions: 3, apiKey: "test-key" });
    provider._client = {
      embeddings: {
        create: async (req) => {
          assert.deepStrictEqual(req.input, ["single text"]);
          return { data: [{ embedding: [0.7, 0.8, 0.9] }] };
        },
      },
    };

    const vector = await provider.embed("single text");
    assert.deepStrictEqual(vector, [0.7, 0.8, 0.9]);
  });

  it("falls back to individual embeddings when batch fails", async () => {
    const provider = new OpenAIEmbeddingProvider({ model: "text-embedding-3-small", dimensions: 3, apiKey: "test-key" });
    let calls = 0;
    provider._client = {
      embeddings: {
        create: async (req) => {
          calls++;
          if (Array.isArray(req.input)) {
            throw new Error("batch not supported");
          }
          return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
        },
      },
    };
    provider._detectedDim = 3;

    const vectors = await provider.embedBatch(["a", "b"], 0);
    assert.strictEqual(calls, 3, "batch + 2 individual calls");
    assert.strictEqual(vectors.length, 2);
    assert.deepStrictEqual(vectors[0], [0.1, 0.2, 0.3]);
    assert.deepStrictEqual(vectors[1], [0.1, 0.2, 0.3]);
  });

  it("returns empty array for empty input", async () => {
    const provider = new OpenAIEmbeddingProvider({ model: "text-embedding-3-small", dimensions: 3, apiKey: "test-key" });
    const vectors = await provider.embedBatch([]);
    assert.deepStrictEqual(vectors, []);
  });

  it("uses cached vectors and skips API call for all cached", async () => {
    const provider = new OpenAIEmbeddingProvider({ model: "text-embedding-3-small", dimensions: 3, apiKey: "test-key" });
    let calls = 0;
    provider._client = {
      embeddings: {
        create: async () => {
          calls++;
          return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
        },
      },
    };

    await provider.embed("cached text");
    assert.strictEqual(calls, 1);
    const vectors = await provider.embedBatch(["cached text"]);
    assert.strictEqual(calls, 1, "no additional API call for cached text");
    assert.strictEqual(vectors.length, 1);
  });
});
