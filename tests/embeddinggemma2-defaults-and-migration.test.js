import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import { EMBEDDINGGEMMA2_EMBEDDING_PROFILE, E5_EMBEDDING_PROFILE } from "../lib/providers/local-model-artifacts.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyLegacyProviderDefaults } from "../lib/providers/legacy-provider-migration.js";
import { createReembeddingCoordinator } from "../lib/reembedding/coordinator.js";
import { compareEmbeddingFingerprints, embeddingFingerprintId } from "../lib/reembedding/fingerprint.js";
import { createReembeddingPlan } from "../lib/reembedding/planner.js";
import {
  embeddingConfigFromSelection,
  embeddingFingerprintFromNormalizedConfig,
  localEmbeddingOptionsFromFingerprint,
} from "../lib/reembedding/runtime-config.js";
import { createMigrationStateStore } from "../lib/reembedding/state-store.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const GEMMA = EMBEDDINGGEMMA2_EMBEDDING_PROFILE.model;
const local = (model, extra = {}) => ({ provider: "local-transformers", local: { model, ...extra } });
const fingerprintOf = (raw, opts) => embeddingFingerprintFromNormalizedConfig(normalizeEmbeddingConfig(raw, opts));

function storeWithMemoryData() {
  const root = makeTempDir("plur1bus-egemma2-store-");
  mkdirSync(join(root, "main", "memories.lance", "data"), { recursive: true });
  writeFileSync(join(root, "main", "memories.lance", "data", "fragment.lance"), "fragment");
  return root;
}

describe("EmbeddingGemma 2 is the default only for newly created stores", () => {
  it("an empty store with no provider configured gets pinned EmbeddingGemma 2 at 768d with its prompts", () => {
    const root = makeTempDir("plur1bus-egemma2-empty-");
    const result = applyLegacyProviderDefaults({ embedding: {}, reranker: { provider: "disabled", enabled: false } }, { baseDbPath: root });
    assert.equal(result.changed, true);
    const embedding = result.config.embedding;
    assert.equal(embedding.provider, "local-transformers");
    assert.equal(embedding.model, GEMMA);
    assert.equal(embedding.dimensions, 768);
    assert.equal(embedding.local.model, GEMMA);
    assert.equal(embedding.local.dimensions, 768);
    assert.equal(embedding.local.queryPrefix, "task: search result | query: ");
    assert.equal(embedding.local.passagePrefix, "title: none | text: ");
    // The result is a configuration the provider layer accepts, in the fingerprint of the pinned default.
    const normalized = normalizeEmbeddingConfig(embedding);
    assert.equal(normalized.model, GEMMA);
    assert.equal(normalized.dimensions, 768);
    assert.equal(normalized.local.revision, EMBEDDINGGEMMA2_EMBEDDING_PROFILE.revision);
    assert.equal(
      embeddingFingerprintId(embeddingFingerprintFromNormalizedConfig(normalized)),
      embeddingFingerprintId(fingerprintOf({ ...local(GEMMA), local: { ...local(GEMMA).local, dtype: "fp32", variant: "full" } })),
    );
  });

  it("keeps a custom model cache directory", () => {
    const root = makeTempDir("plur1bus-egemma2-empty-");
    const result = applyLegacyProviderDefaults({ embedding: { local: { cacheDir: "/models/here" } } }, { baseDbPath: root });
    assert.equal(result.config.embedding.provider, "local-transformers");
    assert.equal(result.config.embedding.local.cacheDir, "/models/here");
  });

  it("leaves a store that already holds memories untouched: no silent switch, no re-embedding", () => {
    const root = storeWithMemoryData();
    const config = { embedding: {} };
    const result = applyLegacyProviderDefaults(config, { baseDbPath: root });
    assert.equal(result.changed, false);
    assert.equal(result.reason, "existing-memory-data");
    assert.deepEqual(result.config.embedding, {});
  });

  it("leaves every explicit provider choice alone, including a bare local provider (still E5) and an explicit E5", () => {
    const root = makeTempDir("plur1bus-egemma2-empty-");
    for (const embedding of [
      { provider: "local-transformers" },
      local(E5_EMBEDDING_PROFILE.model, { dimensions: 384 }),
      { provider: "openai", model: "text-embedding-3-small" },
    ]) {
      const result = applyLegacyProviderDefaults({ embedding }, { baseDbPath: root });
      assert.deepEqual(result.config.embedding, embedding);
      assert.equal(result.migrations.includes("embedding"), false);
    }
    assert.equal(normalizeEmbeddingConfig({ provider: "local-transformers" }).model, E5_EMBEDDING_PROFILE.model);
  });

  it("E5 stays selectable: its configuration, fingerprint and 384d width are untouched", () => {
    const normalized = normalizeEmbeddingConfig(local(E5_EMBEDDING_PROFILE.model));
    assert.equal(normalized.dimensions, 384);
    assert.equal(normalized.local.queryPrefix, "query: ");
    assert.equal(normalized.local.passagePrefix, "passage: ");
  });
});

describe("EmbeddingGemma 2 in the vector-space fingerprint", () => {
  it("records provider, model, pinned revision, width, prompts, pooling, dtype and the pinned artifacts", () => {
    const fingerprint = fingerprintOf(local(GEMMA));
    assert.equal(fingerprint.provider, "local-transformers");
    assert.equal(fingerprint.model, GEMMA);
    assert.equal(fingerprint.revision, EMBEDDINGGEMMA2_EMBEDDING_PROFILE.revision);
    assert.equal(fingerprint.dimensions, 768);
    // The fingerprint stores prompts trimmed (as it always has); `localEmbeddingOptionsFromFingerprint` restores the canonical ones.
    assert.equal(fingerprint.queryPrefix, "task: search result | query:");
    assert.equal(fingerprint.passagePrefix, "title: none | text:");
    assert.equal(fingerprint.pooling, "mean");
    assert.equal(fingerprint.normalize, true);
    assert.equal(fingerprint.dtype, "q8");
    assert.deepEqual(
      fingerprint.artifacts.map(({ path }) => path),
      // The fingerprint sorts its artifacts itself (locale order), whatever order the profile lists them in.
      ["config.json", "onnx/model_quantized.onnx", "onnx/model_quantized.onnx_data", "tokenizer_config.json", "tokenizer.json"],
    );
    assert.match(embeddingFingerprintId(fingerprint), /^embedding:v1:sha256:[a-f0-9]{64}$/);
  });

  it("is another vector space for another width or another dtype, and the same for the same configuration", () => {
    const q8 = embeddingFingerprintId(fingerprintOf(local(GEMMA)));
    assert.equal(embeddingFingerprintId(fingerprintOf(local(GEMMA, { dtype: "q8" }))), q8);
    assert.notEqual(embeddingFingerprintId(fingerprintOf(local(GEMMA, { dimensions: 256 }))), q8);
    assert.notEqual(embeddingFingerprintId(fingerprintOf(local(GEMMA, { dtype: "q4" }))), q8);
    assert.notEqual(embeddingFingerprintId(fingerprintOf(local(GEMMA, { dtype: "fp32" }))), q8);
    assert.equal(fingerprintOf(local(GEMMA, { dtype: "q4" })).dtype, "q4");
  });

  it("round-trips through a migration selection back to the same fingerprint", () => {
    for (const extra of [{}, { dimensions: 256 }, { dimensions: 128 }, { dtype: "q4" }, { dtype: "fp32", dimensions: 512 }]) {
      const fingerprint = fingerprintOf(local(GEMMA, extra));
      const projected = embeddingConfigFromSelection({ fingerprint });
      assert.equal(projected.local.model, GEMMA);
      assert.equal(projected.local.dimensions, fingerprint.dimensions);
      assert.equal("dtype" in projected.local, extra.dtype !== undefined && extra.dtype !== "q8", JSON.stringify(extra));
      assert.equal(embeddingFingerprintId(fingerprintOf(projected)), embeddingFingerprintId(fingerprint), JSON.stringify(extra));
    }
    // Models without dtype variants project exactly as before.
    const e5 = fingerprintOf(local(E5_EMBEDDING_PROFILE.model));
    assert.equal("dtype" in embeddingConfigFromSelection({ fingerprint: e5 }).local, false);
  });

  it("leaves the E5 fingerprint exactly as it was", () => {
    const e5 = fingerprintOf({ provider: "local-transformers" });
    assert.equal(e5.model, E5_EMBEDDING_PROFILE.model);
    assert.equal(e5.dimensions, 384);
    assert.equal(e5.dtype, undefined);
    assert.equal(e5.queryPrefix, "query:");
    assert.equal(e5.passagePrefix, "passage:");
    // ... and a target E5 is handed the canonical prompts too, the ones its active configuration uses.
    const options = localEmbeddingOptionsFromFingerprint(e5);
    assert.equal(options.queryPrefix, "query: ");
    assert.equal(options.passagePrefix, "passage: ");
    assert.equal("dtype" in options, false);
  });
});

// ---- migration E5 -> EmbeddingGemma 2 with a fake runtime and a fake backend ----

function fakeRuntime(calls) {
  class FakeTensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
    async dispose() {}
  }
  return {
    env: {},
    Tensor: FakeTensor,
    AutoConfig: {
      async from_pretrained() {
        return { architectures: ["EmbeddingGemma2Model"], model_type: "embedding_gemma2", text_config: { embedding_dim: 768 }, vision_config: {}, audio_config: {} };
      },
    },
    AutoTokenizer: {
      async from_pretrained() {
        return async (texts) => {
          const input = Array.isArray(texts) ? texts : [texts];
          calls.push(input);
          return {
            input_ids: new FakeTensor("int64", new BigInt64Array(input.length), [input.length, 1]),
            attention_mask: new FakeTensor("int64", new BigInt64Array(input.length).fill(1n), [input.length, 1]),
          };
        };
      },
    },
    AutoModel: {
      async from_pretrained(_model, options) {
        calls.push({ dtype: options.dtype });
        const loaded = async (inputs) => {
          const batch = inputs.input_ids.dims[0];
          const pooled = new Float32Array(batch * 768);
          for (let row = 0; row < batch; row += 1) pooled[row * 768 + (row % 768)] = 1;
          return { sentence_embedding: new FakeTensor("float32", pooled, [batch, 768]) };
        };
        loaded.sessions = { model: { inputNames: ["input_ids", "attention_mask"] } };
        loaded.dispose = async () => {};
        return loaded;
      },
    },
  };
}

function targetProviderFactory(events) {
  return async ({ fingerprint }) => {
    const options = localEmbeddingOptionsFromFingerprint(fingerprint);
    events.push(options);
    return new LocalTransformersEmbeddingProvider({
      ...options,
      cacheDir: makeTempDir("plur1bus-egemma2-migration-cache-"),
      embeddingCacheEnabled: false,
      ensureModelArtifacts: async () => {},
      loadTransformers: async () => fakeRuntime(events),
    });
  };
}

const ROWS = [
  { id: "11111111-1111-4111-8111-111111111111", text: "alpha", status: "active", vector: new Array(384).fill(0.1) },
  { id: "22222222-2222-4222-8222-222222222222", text: "beta", status: "active", vector: new Array(384).fill(0.2) },
  { id: "33333333-3333-4333-8333-333333333333", text: "gamma", status: "archived", vector: new Array(384).fill(0.3) },
];

function fakeBackend(sourceFingerprint, targetDimensions) {
  const target = new Map();
  let created = false;
  return {
    target,
    async inventoryActiveGeneration() {
      return [{
        generation: "generation-active",
        configRevision: "config-a",
        fingerprint: sourceFingerprint,
        tables: [{ tableId: "agent-a/memories", version: "v1", rowCount: ROWS.length, estimatedBytes: 1_000, dimensions: 384 }],
      }];
    },
    async createQuarantinedGeneration() { created = true; },
    async describeGeneration() { return created ? { generation: "generation-target", dimensions: targetDimensions } : null; },
    async readSourceBatch(_tableId, { offset, limit }) { return ROWS.slice(offset, offset + limit); },
    async writeTargetBatch(_generation, _tableId, rows) {
      for (const row of rows) target.set(row.id, structuredClone(row));
      return { added: rows.length, existing: 0 };
    },
    async readBackTargetRows(_generation, _tableId, ids) { return ids.flatMap((id) => target.has(id) ? [structuredClone(target.get(id))] : []); },
    async validateGeneration() { return { tables: 1, rows: target.size, dimensions: targetDimensions }; },
    async close() {},
  };
}

describe("migration from E5 to EmbeddingGemma 2 (fake runtime)", () => {
  const e5 = fingerprintOf({ provider: "local-transformers" });

  it("the planner sees a changed vector space and accepts a 768d probe, but rejects a 384d one", async () => {
    const target = fingerprintOf(local(GEMMA));
    assert.equal(compareEmbeddingFingerprints(e5, target).requiresMigration, true);
    const deps = (probe) => ({
      now: () => 1_000,
      randomBytes: () => Buffer.alloc(32, 9),
      inventoryActiveGeneration: async () => [{
        generation: "generation-active",
        selection: { mode: "legacy" },
        fingerprint: e5,
        tables: [{ tableId: "agent-a/memories", version: "v1", rowCount: 3, estimatedBytes: 1_000 }],
      }],
      statDisk: async () => ({ freeBytes: 10_000_000 }),
      inspectTargetArtifacts: async () => ({ ready: true, verified: true }),
      probeTargetProvider: async () => probe,
    });
    const planned = await createReembeddingPlan({ id: "m-1", targetGeneration: "generation-target", target: { fingerprint: target } }, deps(new Array(768).fill(0.5)));
    assert.equal(planned.plan.target.probeStatus, "passed");
    assert.equal(planned.plan.target.fingerprint.dimensions, 768);
    assert.equal(planned.plan.target.fingerprint.model, GEMMA);
    await assert.rejects(
      () => createReembeddingPlan({ id: "m-2", targetGeneration: "generation-target-2", target: { fingerprint: target } }, deps(new Array(384).fill(0.5))),
      /dimensions|invalid|probe/i,
    );
    // The same space is no migration.
    await assert.rejects(
      () => createReembeddingPlan({ id: "m-3", targetGeneration: "generation-target-3", target: { fingerprint: e5 } }, deps(new Array(384).fill(0.5))),
      /does not change the embedding fingerprint/,
    );
  });

  it("plan, apply and resume re-embed every row with the document prompt into 768d vectors", async () => {
    for (const [extra, dimensions, dtype] of [[{}, 768, "q8"], [{ dimensions: 256 }, 256, "q8"], [{ dtype: "q4" }, 768, "q4"]]) {
      const target = fingerprintOf(local(GEMMA, extra));
      const events = [];
      const backend = fakeBackend(e5, dimensions);
      const stateRoot = makeTempDir("plur1bus-egemma2-migration-");
      const coordinator = createReembeddingCoordinator({
        stateStore: createMigrationStateStore({ stateRoot, now: () => 1_000 }),
        backend,
        createTargetProvider: targetProviderFactory(events),
        plannerDependencies: {
          now: () => 1_000,
          randomBytes: () => Buffer.alloc(32, 8),
          statDisk: async () => ({ freeBytes: 10_000_000 }),
          inspectTargetArtifacts: async () => ({ ready: true, verified: true }),
          probeTargetProvider: async ({ target: request }) => {
            const provider = await targetProviderFactory(events)(request);
            try { return await provider.embedPassage("probe"); } finally { await provider.shutdown(); }
          },
        },
        runValidationProbes: async () => ({ semanticRecall: true }),
      });
      const planned = await coordinator.plan({ id: `migration-${dimensions}-${dtype}`, targetGeneration: "generation-target", target: { fingerprint: target } });
      assert.equal(planned.record.state, "planned");
      await coordinator.apply({ id: planned.record.id, token: planned.confirmation.token });
      const copied = await coordinator.resume({ id: planned.record.id, token: planned.confirmation.token });
      assert.ok(["validating", "ready_to_switch"].includes(copied.state), copied.state);
      assert.equal(backend.target.size, ROWS.length);
      for (const row of backend.target.values()) assert.equal(row.vector.length, dimensions);
      const options = events.find((event) => event.model === GEMMA);
      assert.equal(options.dimensions, dimensions);
      assert.equal(options.revision, EMBEDDINGGEMMA2_EMBEDDING_PROFILE.revision);
      assert.equal(options.queryPrefix, "task: search result | query: ");
      assert.equal(options.passagePrefix, "title: none | text: ");
      assert.equal(options.dtype, dtype === "q8" ? undefined : dtype);
      const tokenized = events.filter(Array.isArray).flat();
      assert.ok(tokenized.length >= ROWS.length);
      assert.ok(tokenized.every((text) => text.startsWith("title: none | text: ")), "rows are embedded as documents");
      assert.ok(events.some((event) => event.dtype === dtype), `the runtime loaded the ${dtype} graph`);
    }
  });
});
