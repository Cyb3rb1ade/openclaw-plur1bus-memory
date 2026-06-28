import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createOpenClawMemoryEmbeddingProviderAdapters } from "../lib/providers/openclaw-memory-embedding-adapters.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonFetch(body) {
  return async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  });
}

async function createCompatibleProvider(dim = 3) {
  const adapters = createOpenClawMemoryEmbeddingProviderAdapters({
    embedding: {
      apiKey: "sk-test",
      baseUrl: "https://embedding.example.test",
      dimensions: dim,
      model: "custom-embedding-model",
    },
  });
  const adapter = adapters.find((item) => item.id === "plur1bus-openai-compatible");
  const result = await adapter.create({});
  return result.provider;
}

describe("OpenClaw memory embedding provider adapters", () => {
  it("rejects remote embedding vectors with the wrong dimension", async () => {
    globalThis.fetch = jsonFetch({ data: [{ embedding: [0.1, 0.2] }] });
    const provider = await createCompatibleProvider(3);

    await assert.rejects(
      () => provider.embedQuery("dimension check"),
      /dimension mismatch.*expected 3.*got 2/i,
    );
  });

  it("accepts remote embedding vectors with the configured dimension", async () => {
    globalThis.fetch = jsonFetch({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const provider = await createCompatibleProvider(3);

    assert.deepStrictEqual(await provider.embedQuery("dimension check"), [0.1, 0.2, 0.3]);
  });
});
