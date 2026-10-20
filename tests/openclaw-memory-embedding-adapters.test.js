import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenClawMemoryEmbeddingProviderAdapters,
  registerOpenClawMemoryEmbeddingProviders,
} from "../lib/providers/openclaw-memory-embedding-adapters.js";
import { createScopedEmbeddingIpcServer } from "../lib/providers/scoped-embedding-ipc.js";
import { makeClaimableStateRoot } from "./helpers/claimable-state-root.js";

const originalFetch = globalThis.fetch;
const ACTIVE_FINGERPRINT_ID = `embedding:v1:sha256:${"a".repeat(64)}`;

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
  it("registers the target OpenClaw generic embedding-provider contract", async () => {
    const registered = [];
    const api = {
      registerEmbeddingProvider(adapter) { registered.push(adapter); },
      logger: { info() {}, warn() {} },
    };

    const adapters = registerOpenClawMemoryEmbeddingProviders(api, {
      embedding: { dimensions: 3, model: "custom-embedding-model" },
    });
    assert.equal(adapters.length, 4);
    assert.deepEqual(registered.map((adapter) => adapter.id), [
      "plur1bus-embeddinggemma-2",
      "plur1bus-openai",
      "plur1bus-openai-compatible",
      "plur1bus-e5-small",
    ]);
    const compatible = await registered[2].create({
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

  it("exposes the target OpenClaw close contract for the native local provider", async () => {
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

  it("keeps a tool-discovery local adapter usable across activation-owner rotation", async () => {
    // Short POSIX root for the owner.sock path; win32 has no /tmp (named pipe there).
    // Off Linux the owner claim port derives from the path; a port the host
    // reserves (Windows excluded ranges: listen EACCES) re-rolls the directory.
    const stateRoot = await makeClaimableStateRoot("plur1bus-adapter-ipc-", process.platform === "win32" ? tmpdir() : "/tmp");
    const calls = [];
    const embeddings = {
      model: "intfloat/multilingual-e5-small",
      dimensions: () => 384,
      async embedQuery(text) { calls.push(["query", text]); return Array(384).fill(0.01); },
      async embedPassage(text) { calls.push(["passage", text]); return Array(384).fill(0.01); },
      async embedBatch(texts) { calls.push(["batch", texts]); return texts.map(() => Array(384).fill(0.01)); },
    };
    let server = createScopedEmbeddingIpcServer({
      stateRoot,
      embeddings,
      fingerprintId: ACTIVE_FINGERPRINT_ID,
    });
    let created = null;

    try {
      await server.start();
      const adapter = createOpenClawMemoryEmbeddingProviderAdapters({}, {
        scopedEmbeddingIpc: { stateRoot, fingerprintId: ACTIVE_FINGERPRINT_ID },
      })
        .find((item) => item.id === "plur1bus-e5-small");
      created = await adapter.create({
        config: {},
        model: "intfloat/multilingual-e5-small",
        local: {},
      });
      const vector = await created.provider.embed("scoped query", { inputType: "query" });
      assert.equal(vector.length, 384);
      assert.deepEqual(calls, [["query", "scoped query"]]);

      await server.shutdown();
      const replacementEmbeddings = {
        model: "intfloat/multilingual-e5-small",
        dimensions: () => 384,
        async embedQuery(text) { calls.push(["replacement-query", text]); return Array(384).fill(0.02); },
        async embedPassage(text) { calls.push(["replacement-passage", text]); return Array(384).fill(0.02); },
        async embedBatch(texts) {
          calls.push(["replacement-batch", texts]);
          return texts.map(() => Array(384).fill(0.02));
        },
      };
      server = createScopedEmbeddingIpcServer({
        stateRoot,
        embeddings: replacementEmbeddings,
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });
      await server.start();
      const replacementVector = await created.provider.embed("after hot reload", { inputType: "query" });
      assert.equal(replacementVector.length, 384);
      assert.equal(replacementVector[0], 0.02);
      assert.deepEqual(calls, [
        ["query", "scoped query"],
        ["replacement-query", "after hot reload"],
      ]);
    } finally {
      await created?.provider.close();
      await server.shutdown();
      await rm(stateRoot, { recursive: true, force: true });
    }
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

  describe("plur1bus-embeddinggemma-2 adapter", () => {
    it("exposes the default configuration and properties of plur1bus-embeddinggemma-2", () => {
      const adapters = createOpenClawMemoryEmbeddingProviderAdapters({});
      const adapter = adapters.find((item) => item.id === "plur1bus-embeddinggemma-2");
      assert.ok(adapter);
      assert.equal(adapter.id, "plur1bus-embeddinggemma-2");
      assert.equal(adapter.defaultModel, "google/embeddinggemma-2");
      assert.equal(adapter.transport, "local");
      assert.equal(typeof adapter.create, "function");
      assert.equal(adapter.shouldContinueAutoSelection(), false);
      assert.equal(adapter.formatSetupError(new Error("test")), "test");
    });

    it("creates an EmbeddingGemma 2 provider with default 768d and q8 dtype", async () => {
      const adapters = createOpenClawMemoryEmbeddingProviderAdapters({});
      const adapter = adapters.find((item) => item.id === "plur1bus-embeddinggemma-2");
      const created = await adapter.create({ config: {}, local: {} });

      assert.equal(created.runtime.id, "plur1bus-embeddinggemma-2");
      assert.equal(created.runtime.cacheKeyData.provider, "plur1bus-embeddinggemma-2");
      assert.equal(created.runtime.cacheKeyData.model, "google/embeddinggemma-2");
      assert.equal(created.runtime.cacheKeyData.dimensions, 768);
      assert.equal(created.runtime.cacheKeyData.dtype, "q8");

      assert.equal(created.provider.id, "plur1bus-embeddinggemma-2");
      assert.equal(created.provider.model, "google/embeddinggemma-2");
      assert.equal(created.provider.dimensions, 768);
      assert.equal(created.provider.maxInputTokens, 8192);
      assert.equal(typeof created.provider.embed, "function");
      assert.equal(typeof created.provider.embedBatch, "function");
      assert.equal(typeof created.provider.close, "function");

      await created.provider.close();
    });

    it("validates selectable Matryoshka dimensions (128, 256, 512, 768) and rejects unadvertised dimensions", async () => {
      const adapters = createOpenClawMemoryEmbeddingProviderAdapters({});
      const adapter = adapters.find((item) => item.id === "plur1bus-embeddinggemma-2");

      for (const dim of [128, 256, 512, 768]) {
        const created = await adapter.create({ dimensions: dim });
        assert.equal(created.provider.dimensions, dim);
        assert.equal(created.runtime.cacheKeyData.dimensions, dim);
        await created.provider.close();
      }

      await assert.rejects(
        () => adapter.create({ dimensions: 384 }),
        /google\/embeddinggemma-2 supports only its declared dimensions: 128, 256, 512, 768; configured 384/,
      );
      await assert.rejects(
        () => adapter.create({ dimensions: 1024 }),
        /google\/embeddinggemma-2 supports only its declared dimensions: 128, 256, 512, 768; configured 1024/,
      );
    });

    it("accepts selectable dtypes (q8, q4, fp32) and rejects unknown dtype", async () => {
      const adapters = createOpenClawMemoryEmbeddingProviderAdapters({});
      const adapter = adapters.find((item) => item.id === "plur1bus-embeddinggemma-2");

      for (const dtype of ["q8", "q4", "fp32"]) {
        const created = await adapter.create({ local: { dtype } });
        assert.equal(created.runtime.cacheKeyData.dtype, dtype);
        await created.provider.close();
      }

      await assert.rejects(
        () => adapter.create({ local: { dtype: "int4" } }),
        /dtype "int4" is not a pinned dtype of google\/embeddinggemma-2/,
      );
    });

    it("does not require non-commercial license acknowledgement (Apache-2.0)", async () => {
      const adapters = createOpenClawMemoryEmbeddingProviderAdapters({
        modelPreparation: { acceptNonCommercialLicense: false },
      });
      const adapter = adapters.find((item) => item.id === "plur1bus-embeddinggemma-2");
      const created = await adapter.create({ local: {} });
      assert.ok(created.provider);
      await created.provider.close();
    });

    it("routes embed and embedBatch with query and passage prompts using fake runtime", async () => {
      const calls = [];
      const fake = {
        async embedQuery(text) { calls.push(["query", text]); return Array(768).fill(0.1); },
        async embedPassage(text) { calls.push(["passage", text]); return Array(768).fill(0.2); },
        async embedBatch(texts) { calls.push(["batch", texts]); return texts.map(() => Array(768).fill(0.2)); },
        async shutdown() { calls.push(["shutdown"]); },
      };

      const stateRoot = await makeClaimableStateRoot("plur1bus-gemma2-ipc-", process.platform === "win32" ? tmpdir() : "/tmp");
      const server = createScopedEmbeddingIpcServer({
        stateRoot,
        embeddings: {
          model: "google/embeddinggemma-2",
          dimensions: () => 768,
          ...fake,
        },
        fingerprintId: ACTIVE_FINGERPRINT_ID,
      });

      let created = null;
      try {
        await server.start();
        const adapter = createOpenClawMemoryEmbeddingProviderAdapters({}, {
          scopedEmbeddingIpc: { stateRoot, fingerprintId: ACTIVE_FINGERPRINT_ID },
        }).find((item) => item.id === "plur1bus-embeddinggemma-2");

        created = await adapter.create({});
        const qVec = await created.provider.embed("test query", { inputType: "query" });
        assert.equal(qVec.length, 768);
        assert.equal(qVec[0], 0.1);

        const pVec = await created.provider.embed("test passage");
        assert.equal(pVec.length, 768);
        assert.equal(pVec[0], 0.2);

        const bVecs = await created.provider.embedBatch(["b1", "b2"]);
        assert.equal(bVecs.length, 2);

        assert.deepEqual(calls.slice(0, 3), [
          ["query", "test query"],
          ["passage", "test passage"],
          ["batch", ["b1", "b2"]],
        ]);
      } finally {
        await created?.provider?.close();
        await server.shutdown();
        await rm(stateRoot, { recursive: true, force: true });
      }
    });

    it("opt-in real-model embedding test with q8 model (skipped by default)", {
      skip: process.env.PLUR1BUS_REAL_EGEMMA2 !== "1" && "set PLUR1BUS_REAL_EGEMMA2=1 to run real-model test",
      timeout: 20 * 60_000,
    }, async () => {
      const adapter = createOpenClawMemoryEmbeddingProviderAdapters({})
        .find((item) => item.id === "plur1bus-embeddinggemma-2");
      const created = await adapter.create({});
      try {
        const queryVec = await created.provider.embed("Which planet is known as the Red Planet?", { inputType: "query" });
        assert.equal(queryVec.length, 768);
        const norm = Math.hypot(...queryVec);
        assert.ok(Math.abs(norm - 1) < 1e-3, "query vector is unit-normalized");

        const batchVecs = await created.provider.embedBatch([
          "Mars, known for its reddish appearance, is often referred to as the Red Planet.",
        ]);
        assert.equal(batchVecs.length, 1);
        assert.equal(batchVecs[0].length, 768);
      } finally {
        await created.provider.close();
      }
    });
  });
});
