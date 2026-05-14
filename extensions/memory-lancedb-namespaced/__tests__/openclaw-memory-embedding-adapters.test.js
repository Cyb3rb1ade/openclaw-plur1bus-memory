import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENCLAW_MEMORY_EMBEDDING_PROVIDER_IDS,
  createOpenClawMemoryEmbeddingProviderAdapters,
  registerOpenClawMemoryEmbeddingProviders,
} from "../lib/providers/openclaw-memory-embedding-adapters.js";

function createOptions(overrides = {}) {
  return {
    config: {},
    model: "",
    ...overrides,
  };
}

test("adapter factory exposes exactly the PLUR1BUS provider ids", () => {
  const adapters = createOpenClawMemoryEmbeddingProviderAdapters();
  assert.deepEqual(adapters.map(adapter => adapter.id), OPENCLAW_MEMORY_EMBEDDING_PROVIDER_IDS);
  assert.deepEqual(OPENCLAW_MEMORY_EMBEDDING_PROVIDER_IDS, [
    "plur1bus-openai",
    "plur1bus-openai-compatible",
    "plur1bus-e5-small",
  ]);
});

test("register helper is gated on OpenClaw API availability", () => {
  const warnings = [];
  const missing = registerOpenClawMemoryEmbeddingProviders({
    logger: { warn(message) { warnings.push(message); } },
  });
  assert.deepEqual(missing, []);
  assert.equal(warnings.length, 1);

  const registered = [];
  const adapters = registerOpenClawMemoryEmbeddingProviders({
    registerMemoryEmbeddingProvider(adapter) { registered.push(adapter); },
    logger: { warn() {} },
  });
  assert.equal(adapters.length, 3);
  assert.deepEqual(registered.map(adapter => adapter.id), OPENCLAW_MEMORY_EMBEDDING_PROVIDER_IDS);
});

test("remote create returns provider result and cache metadata without secrets", async () => {
  const [openai, compatible] = createOpenClawMemoryEmbeddingProviderAdapters({
    embedding: {
      apiKey: "config-key",
      baseUrl: "https://compatible.example/v1",
      dimensions: 1024,
    },
  });

  const openaiResult = await openai.create(createOptions({ outputDimensionality: 768 }));
  assert.ok(openaiResult.provider);
  assert.equal(openaiResult.provider.id, "plur1bus-openai");
  assert.equal(openaiResult.provider.model, "text-embedding-3-large");
  assert.deepEqual(openaiResult.runtime.cacheKeyData, {
    provider: "plur1bus-openai",
    model: "text-embedding-3-large",
    dimensions: 768,
  });
  assert.doesNotMatch(JSON.stringify(openaiResult.runtime.cacheKeyData), /config-key/);

  const compatibleResult = await compatible.create(createOptions({
    model: "custom-embed",
    remote: {
      apiKey: "remote-key",
      baseUrl: "https://remote.example/v1",
      headers: { "X-Test": "yes" },
    },
  }));
  assert.ok(compatibleResult.provider);
  assert.equal(compatibleResult.provider.id, "plur1bus-openai-compatible");
  assert.equal(compatibleResult.runtime.cacheKeyData.dimensions, 1024);
  assert.doesNotMatch(JSON.stringify(compatibleResult.runtime.cacheKeyData), /remote-key/);
});

test("remote register and create do not require keys; runtime error is clear", async () => {
  const compatible = createOpenClawMemoryEmbeddingProviderAdapters()[1];
  const result = await compatible.create(createOptions({ model: "custom-embed" }));
  assert.ok(result.provider);
  await assert.rejects(
    result.provider.embedBatch(["hello"]),
    /plur1bus-openai-compatible API key is not configured/
  );
});

test("remote embedBatch returns exactly one vector per input", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true,
      async json() {
        return {
          data: [
            { embedding: [1, 2, 3] },
            { embedding: [4, 5, 6] },
          ],
        };
      },
    };
  };
  try {
    const adapter = createOpenClawMemoryEmbeddingProviderAdapters()[0];
    const result = await adapter.create(createOptions({ remote: { apiKey: "key" } }));
    const vectors = await result.provider.embedBatch(["a", "b"]);
    assert.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
    assert.equal(calls[0].input.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local E5 create is lazy and returns provider result before model import", async () => {
  const adapter = createOpenClawMemoryEmbeddingProviderAdapters()[2];
  const result = await adapter.create(createOptions({
    local: { modelCacheDir: "/tmp/plur1bus-model-cache" },
  }));
  assert.ok(result.provider);
  assert.equal(result.provider.id, "plur1bus-e5-small");
  assert.equal(result.provider.model, "intfloat/multilingual-e5-small");
  assert.deepEqual(result.runtime.cacheKeyData, {
    provider: "plur1bus-e5-small",
    model: "intfloat/multilingual-e5-small",
    dimensions: 384,
  });
});
