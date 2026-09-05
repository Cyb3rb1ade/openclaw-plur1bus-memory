import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import { embeddingDimensionCapability } from "../lib/providers/dimensions.js";
import {
  JINA_V5_NANO_EMBEDDING_PROFILE,
  localEmbeddingPreparationTarget,
  pinnedLocalModelProfile,
} from "../lib/providers/local-model-artifacts.js";

const MODEL = "jinaai/jina-embeddings-v5-text-nano-retrieval";
const NANO_DIMENSIONS = [32, 64, 128, 256, 512, 768];

/**
 * Fake Transformers.js runtime shaped like the published nano-retrieval ONNX
 * export: EuroBERT config, input_ids + attention_mask, and both
 * `last_hidden_state` and the pre-pooled `sentence_embedding`.
 */
function fakeTransformersRuntime(calls, {
  architecture = "EuroBertModel",
  modelType = "eurobert",
  hiddenSize = 768,
  emitSentenceEmbedding = true,
  inputNames = ["input_ids", "attention_mask"],
} = {}) {
  class FakeTensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }

    async dispose() {
      calls.push(["tensor-dispose", this.type, [...this.dims]]);
    }
  }
  return {
    env: {},
    Tensor: FakeTensor,
    AutoConfig: {
      async from_pretrained(model, options) {
        calls.push(["config", model, options]);
        return { architectures: [architecture], model_type: modelType, hidden_size: hiddenSize };
      },
    },
    AutoTokenizer: {
      async from_pretrained(model, options) {
        calls.push(["tokenizer-load", model, options]);
        return async (texts) => {
          const input = Array.isArray(texts) ? texts : [texts];
          calls.push(["tokenize", [...input]]);
          // Row 0 is padded on the right: two real tokens, one pad.
          const mask = new BigInt64Array(input.length * 3).fill(1n);
          mask[2] = 0n;
          return {
            input_ids: new FakeTensor("int64", new BigInt64Array(input.length * 3), [input.length, 3]),
            attention_mask: new FakeTensor("int64", mask, [input.length, 3]),
          };
        };
      },
    },
    AutoModel: {
      async from_pretrained(model, options) {
        calls.push(["model-load", model, options]);
        const loaded = async (inputs) => {
          const batch = inputs.input_ids.dims[0];
          calls.push(["model-call", batch, Object.keys(inputs)]);
          // Hidden states: position p of row r carries (p + 1) in the first
          // two components, so last-token pooling must pick position 1 for
          // the padded row 0 and position 2 for every other row.
          const hidden = new Float32Array(batch * 3 * 768);
          for (let row = 0; row < batch; row += 1) {
            for (let position = 0; position < 3; position += 1) {
              hidden[(row * 3 + position) * 768] = 3 * (position + 1);
              hidden[(row * 3 + position) * 768 + 1] = 4 * (position + 1);
            }
          }
          const outputs = { last_hidden_state: new FakeTensor("float32", hidden, [batch, 3, 768]) };
          if (emitSentenceEmbedding) {
            const pooled = new Float32Array(batch * 768);
            for (let row = 0; row < batch; row += 1) {
              pooled[row * 768] = 0.6;
              pooled[row * 768 + 1] = 0.8;
            }
            outputs.sentence_embedding = new FakeTensor("float32", pooled, [batch, 768]);
          }
          return outputs;
        };
        loaded.sessions = { model: { inputNames: [...inputNames] } };
        loaded.dispose = async () => { calls.push(["dispose"]); };
        return loaded;
      },
    },
  };
}

function provider(calls, overrides = {}, runtimeOptions = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-jina-v5-"));
  return new LocalTransformersEmbeddingProvider({
    model: MODEL,
    dimensions: 768,
    cacheDir,
    acceptNonCommercialLicense: true,
    embeddingCacheEnabled: false,
    ensureModelArtifacts: async (profile, dir, options) => {
      calls.push(["artifacts", profile.model, dir === cacheDir, options.acceptNonCommercialLicense]);
    },
    loadTransformers: async () => fakeTransformersRuntime(calls, runtimeOptions),
    ...overrides,
  });
}

describe("downloadable Jina v5 Text Nano embedding", () => {
  it("pins the upstream q8 ONNX export, its prefixes, and its non-commercial license", () => {
    const profile = pinnedLocalModelProfile(MODEL);
    assert.equal(profile, JINA_V5_NANO_EMBEDDING_PROFILE);
    assert.equal(profile.runtime, "jina-v5");
    assert.equal(profile.dtype, "q8");
    assert.equal(profile.revision, "ac5d898c8d382b17167c33e5c8af644a3519b47d");
    assert.equal(profile.outputDimensions, 768);
    assert.deepEqual([...profile.matryoshkaDimensions], NANO_DIMENSIONS);
    assert.equal(profile.queryPrefix, "Query: ");
    assert.equal(profile.passagePrefix, "Document: ");
    assert.equal(profile.license, "CC-BY-NC-4.0");
    assert.equal(profile.commercialUse, false);
    assert.deepEqual(profile.artifacts.map((entry) => entry.path), [
      "config.json",
      "onnx/model_quantized.onnx",
      "onnx/model_quantized.onnx_data",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
    const weights = profile.artifacts.find((entry) => entry.path === "onnx/model_quantized.onnx_data");
    assert.equal(weights.size, 247_006_208);
    assert.match(weights.sha256, /^[0-9a-f]{64}$/);
    const total = profile.artifacts.reduce((sum, entry) => sum + entry.size, 0);
    assert.ok(total < 300 * 1024 * 1024, "the nano download stays well under the host's memory alarm");
  });

  it("offers only the model's declared Matryoshka dimensions as preparation targets", () => {
    const capability = embeddingDimensionCapability({ provider: "local-transformers", model: MODEL });
    assert.equal(capability.mode, "selectable");
    assert.equal(capability.presetOnly, true);
    assert.deepEqual(capability.presets, NANO_DIMENSIONS);
    for (const dimensions of NANO_DIMENSIONS) {
      const target = localEmbeddingPreparationTarget(`jina-v5-nano-${dimensions}`);
      assert.equal(target?.model, MODEL);
      assert.equal(target?.dimensions, dimensions);
      assert.equal(target?.commercialUse, false);
    }
    assert.equal(localEmbeddingPreparationTarget("jina-v5-nano-1024"), null);
    assert.throws(
      () => normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: MODEL, dimensions: 300 } }),
      /300/,
    );
  });

  it("loads the pinned model offline, applies the published prefixes, uses sentence_embedding, truncates and normalizes", async () => {
    const calls = [];
    const embedding = provider(calls, { dimensions: 256 });
    const query = await embedding.embedQuery("Wann hat die Tante Geburtstag?");
    const passages = await embedding.embedBatch(["Die Tante hat am 16.08. Geburtstag.", "Anne und Wolfgang sind Freunde."]);

    assert.equal(query.length, 256);
    assert.equal(passages.length, 2);
    assert.equal(passages[1].length, 256);
    assert.ok(Math.abs(Math.hypot(...query) - 1) < 1e-6, "vector is renormalized after truncation");
    assert.ok(Math.abs(query[0] - 0.6) < 1e-6 && Math.abs(query[1] - 0.8) < 1e-6, "sentence_embedding is used as published");

    const tokenized = calls.filter(([kind]) => kind === "tokenize").map(([, texts]) => texts);
    assert.deepEqual(tokenized[0], ["Query: Wann hat die Tante Geburtstag?"]);
    assert.deepEqual(tokenized[1], ["Document: Die Tante hat am 16.08. Geburtstag.", "Document: Anne und Wolfgang sind Freunde."]);

    const modelLoad = calls.find(([kind]) => kind === "model-load");
    assert.equal(modelLoad[2].dtype, "q8");
    assert.equal(modelLoad[2].local_files_only, true);
    assert.equal(modelLoad[2].revision, JINA_V5_NANO_EMBEDDING_PROFILE.revision);
    assert.deepEqual(modelLoad[2].session_options, { graphOptimizationLevel: "disabled" });
    assert.ok(calls.some(([kind, model, sameDir, accepted]) => kind === "artifacts" && model === MODEL && sameDir && accepted));
    assert.ok(calls.some(([kind, type, dims]) => kind === "tensor-dispose" && type === "float32" && dims[1] === 768), "outputs are disposed");
    await embedding.shutdown();
    assert.ok(calls.some(([kind]) => kind === "dispose"));
  });

  it("falls back to mask-based last-token pooling when the graph emits only hidden states", async () => {
    const calls = [];
    const embedding = provider(calls, {}, { emitSentenceEmbedding: false });
    const [padded, full] = await embedding.embedBatch(["kurz", "etwas länger"]);
    // Row 0 has its last attended token at position 1 (hidden 6, 8), row 1 at
    // position 2 (hidden 9, 12); both normalize to the same direction, so the
    // proof is in the identical unit vectors rather than in raw magnitudes.
    assert.ok(Math.abs(padded[0] - 0.6) < 1e-6 && Math.abs(padded[1] - 0.8) < 1e-6);
    assert.ok(Math.abs(full[0] - 0.6) < 1e-6 && Math.abs(full[1] - 0.8) < 1e-6);
    await embedding.shutdown();
  });

  it("refuses prefixes that differ from the profile, so a copied v3 block cannot embed untyped text", () => {
    assert.throws(
      () => provider([], { queryPrefix: "", passagePrefix: "" }),
      /requires queryPrefix "Query: " and passagePrefix "Document: "/,
    );
    assert.throws(
      () => provider([], { queryPrefix: "query: " }),
      /requires queryPrefix/,
    );
  });

  it("fails closed before artifact or Transformers loading without explicit license acknowledgement", async () => {
    const calls = [];
    const embedding = provider(calls, { acceptNonCommercialLicense: false });
    await assert.rejects(
      () => embedding.embedQuery("x"),
      (error) => error.code === "non_commercial_license_acknowledgement_required",
    );
    assert.equal(calls.length, 0, "nothing was downloaded or loaded");
  });

  it("fails closed before model loading when the pinned structure drifts", async () => {
    for (const runtimeOptions of [
      { architecture: "XLMRobertaModel" },
      { modelType: "llama" },
      { hiddenSize: 1024 },
    ]) {
      const calls = [];
      const embedding = provider(calls, {}, runtimeOptions);
      await assert.rejects(() => embedding.embedQuery("x"), /refusing model drift/);
      assert.ok(!calls.some(([kind]) => kind === "model-load"), "the weights were never loaded");
    }
    const calls = [];
    const embedding = provider(calls, {}, { inputNames: ["input_ids"] });
    await assert.rejects(() => embedding.embedQuery("x"), /must expose input_ids and attention_mask/);
    assert.ok(calls.some(([kind]) => kind === "dispose"), "a rejected model is disposed");
  });
});
