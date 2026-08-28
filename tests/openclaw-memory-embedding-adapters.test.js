import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createOpenClawMemoryEmbeddingProviderAdapters,
  registerOpenClawMemoryEmbeddingProviders,
} from "../lib/providers/openclaw-memory-embedding-adapters.js";

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
  it("registers the Beta-3 generic embedding-provider contract", async () => {
    const registered = [];
    const api = {
      registerEmbeddingProvider(adapter) { registered.push(adapter); },
      logger: { info() {}, warn() {} },
    };

    const adapters = registerOpenClawMemoryEmbeddingProviders(api, {
      embedding: { dimensions: 3, model: "custom-embedding-model" },
    });
    assert.equal(adapters.length, 3);
    assert.deepEqual(registered.map((adapter) => adapter.id), [
      "plur1bus-openai",
      "plur1bus-openai-compatible",
      "plur1bus-e5-small",
    ]);
    const compatible = await registered[1].create({
      model: "custom-embedding-model",
      dimensions: 3,
      config: {},
    });
    assert.equal(compatible.provider.dimensions, 3);
    assert.equal(typeof compatible.provider.embed, "function");
    assert.equal(typeof compatible.provider.embedBatch, "function");
    assert.equal("embedQuery" in compatible.provider, false);
  });

  it("reports the optional generic provider bridge as informational when the host capability is absent", () => {
    const messages = { info: [], warn: [] };
    const api = {
      logger: {
        info(message) { messages.info.push(message); },
        warn(message) { messages.warn.push(message); },
      },
    };

    assert.deepStrictEqual(registerOpenClawMemoryEmbeddingProviders(api), []);
    assert.equal(messages.warn.length, 0);
    assert.equal(messages.info.length, 1);
    assert.match(messages.info[0], /registerEmbeddingProvider.*unavailable/i);
  });

  it("exposes the Beta-3 close contract for the native local provider", async () => {
    const resources = [];
    const localModelGeneration = {
      registerResource(resource, label) { resources.push([resource, label]); },
      async beforeAcquire() {},
    };
    const adapter = createOpenClawMemoryEmbeddingProviderAdapters({}, { localModelGeneration })
      .find((item) => item.id === "plur1bus-e5-small");
    const created = await adapter.create({
      config: {},
      model: "intfloat/multilingual-e5-small",
      local: {},
    });

    assert.equal(typeof created.provider.close, "function");
    assert.deepEqual(resources, [], "OpenClaw owns adapter-provider close and reuse across plugin registries");
    await created.provider.close();
    await created.provider.close();
  });

  it("rejects remote embedding vectors with the wrong dimension", async () => {
    globalThis.fetch = jsonFetch({ data: [{ embedding: [0.1, 0.2] }] });
    const provider = await createCompatibleProvider(3);

    await assert.rejects(
      () => provider.embed("dimension check", { inputType: "query" }),
      /dimension mismatch.*expected 3.*got 2/i,
    );
  });

  it("accepts remote embedding vectors with the configured dimension", async () => {
    globalThis.fetch = jsonFetch({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    const provider = await createCompatibleProvider(3);

    assert.deepStrictEqual(
      await provider.embed("dimension check", { inputType: "query" }),
      [0.1, 0.2, 0.3],
    );
  });
});
