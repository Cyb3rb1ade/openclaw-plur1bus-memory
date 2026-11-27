import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import { embeddingDimensionCapability, embeddingDimensionProfiles } from "../lib/providers/dimensions.js";
import {
  EMBEDDINGGEMMA2_EMBEDDING_PROFILE,
  E5_EMBEDDING_PROFILE,
  localEmbeddingPreparationTarget,
  modelCacheRevisionDir,
  pinnedLocalModelProfile,
  validatePinnedModelArtifacts,
} from "../lib/providers/local-model-artifacts.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const MODEL = "google/embeddinggemma-2";
const MRL = [128, 256, 512, 768];
const QUERY_PREFIX = "task: search result | query: ";
const DOCUMENT_PREFIX = "title: none | text: ";

/**
 * Fake Transformers.js runtime shaped like onnx-community/embeddinggemma-2-ONNX:
 * a multimodal embedding_gemma2 config (text, vision and audio parts), a graph
 * that takes input_ids + attention_mask and emits the mean-pooled, normalized
 * `sentence_embedding` next to the token states.
 */
function fakeTransformersRuntime(calls, {
  architecture = "EmbeddingGemma2Model",
  modelType = "embedding_gemma2",
  embeddingDim = 768,
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
        return {
          architectures: [architecture],
          model_type: modelType,
          text_config: { model_type: "embedding_gemma2_text", embedding_dim: embeddingDim, hidden_size: 512 },
          vision_config: { model_type: "gemma4_vision" },
          audio_config: { model_type: "gemma4_audio" },
        };
      },
    },
    AutoTokenizer: {
      async from_pretrained(model, options) {
        calls.push(["tokenizer-load", model, options]);
        return async (texts, tokenizerOptions) => {
          const input = Array.isArray(texts) ? texts : [texts];
          calls.push(["tokenize", [...input], tokenizerOptions]);
          // Right padding: two real tokens and one pad in row 0, three real tokens elsewhere.
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
          // Token states: component 0 is 3 * (position + 1), component 1 is 4 * (position + 1).
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
  const cacheDir = makeTempDir("plur1bus-egemma2-");
  return new LocalTransformersEmbeddingProvider({
    model: MODEL,
    dimensions: 768,
    cacheDir,
    embeddingCacheEnabled: false,
    ensureModelArtifacts: async (profile, dir) => {
      calls.push(["artifacts", profile.model, profile.dtype, profile.artifacts.map(({ path }) => path), dir === cacheDir]);
    },
    loadTransformers: async () => fakeTransformersRuntime(calls, runtimeOptions),
    ...overrides,
  });
}

describe("EmbeddingGemma 2 as a pinned local embedding model", () => {
  it("pins the ONNX export of the verified revisions with size and SHA-256 per file (Apache-2.0)", () => {
    const profile = pinnedLocalModelProfile(MODEL);
    assert.equal(profile, EMBEDDINGGEMMA2_EMBEDDING_PROFILE);
    assert.equal(profile.role, "embedding");
    assert.equal(profile.runtime, "embeddinggemma-2");
    assert.equal(profile.baseModelRevision, "914f7f89142e33e77833254d9c9b90c3cef7303b");
    assert.equal(profile.artifactRepository, "onnx-community/embeddinggemma-2-ONNX");
    assert.equal(profile.artifactRevision, "daa72c51243991dfcaf9f9137d2c573d8f7790c0");
    assert.equal(profile.revision, profile.artifactRevision);
    assert.equal(profile.dtype, "q8");
    assert.equal(profile.outputDimensions, 768);
    assert.deepEqual([...profile.matryoshkaDimensions], MRL);
    assert.equal(profile.queryPrefix, QUERY_PREFIX);
    assert.equal(profile.passagePrefix, DOCUMENT_PREFIX);
    assert.equal(profile.license, "Apache-2.0");
    assert.notEqual(profile.commercialUse, false, "Apache-2.0 needs no non-commercial acknowledgement");
    assert.deepEqual(profile.artifacts.map((entry) => entry.path), [
      "config.json",
      "onnx/model_quantized.onnx",
      "onnx/model_quantized.onnx_data",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
    const byPath = Object.fromEntries(profile.artifacts.map((entry) => [entry.path, entry]));
    assert.deepEqual(byPath["onnx/model_quantized.onnx_data"], {
      path: "onnx/model_quantized.onnx_data",
      size: 313_724_928,
      sha256: "278a7ff1248c3618e4bd11a607fc54f7bdc7778854230f3956d3f86bd9db4f3b",
    });
    assert.deepEqual(byPath["tokenizer.json"], {
      path: "tokenizer.json",
      size: 32_170_510,
      sha256: "4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4",
    });
    assert.equal(byPath["onnx/model_quantized.onnx"].sha256, "d06edd601f851c633a2519304cbeb8dc6170d7ceb61b436625c17fb9b6e74953");
    assert.equal(byPath["config.json"].sha256, "8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d");
    assert.equal(byPath["tokenizer_config.json"].sha256, "17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874");
    const total = profile.artifacts.reduce((sum, entry) => sum + entry.size, 0);
    assert.ok(total < 400 * 1024 * 1024, "the default q8 download stays below 400 MB");
  });

  it("offers fp32 and q4 as pinned alternatives with their own artifacts, and nothing else", () => {
    const q4 = pinnedLocalModelProfile(MODEL, { dtype: "q4" });
    assert.equal(q4.dtype, "q4");
    assert.deepEqual(q4.artifacts.map((entry) => entry.path), [
      "config.json",
      "onnx/model_q4.onnx",
      "onnx/model_q4.onnx_data",
      "tokenizer.json",
      "tokenizer_config.json",
    ]);
    assert.equal(q4.artifacts.find((entry) => entry.path === "onnx/model_q4.onnx_data").sha256,
      "c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49");
    const fp32 = pinnedLocalModelProfile(MODEL, { dtype: "fp32" });
    assert.equal(fp32.dtype, "fp32");
    assert.ok(fp32.artifacts.some((entry) => entry.path === "onnx/model.onnx_data" && entry.size === 1_084_170_240));
    assert.equal(pinnedLocalModelProfile(MODEL, { dtype: "q8" }).artifacts.length, 5);
    assert.equal(pinnedLocalModelProfile(MODEL, { dtype: "fp16" }), null);
    assert.equal(pinnedLocalModelProfile(MODEL, { dtype: "../q8" }), null);
    assert.equal(pinnedLocalModelProfile(MODEL), EMBEDDINGGEMMA2_EMBEDDING_PROFILE);
    for (const variant of [q4, fp32]) {
      assert.equal(variant.revision, EMBEDDINGGEMMA2_EMBEDDING_PROFILE.revision);
      assert.equal(variant.queryPrefix, QUERY_PREFIX);
      assert.equal(variant.runtime, "embeddinggemma-2");
    }
    // A model without dtype variants keeps its single profile and refuses a dtype it never had.
    assert.equal(pinnedLocalModelProfile(E5_EMBEDDING_PROFILE.model), E5_EMBEDDING_PROFILE);
    assert.equal(pinnedLocalModelProfile(E5_EMBEDDING_PROFILE.model, { dtype: "q8" }), null);
  });

  it("exposes exactly the declared Matryoshka widths as dimensions and preparation targets", () => {
    const capability = embeddingDimensionCapability({ provider: "local-transformers", model: MODEL });
    assert.equal(capability.mode, "selectable");
    assert.equal(capability.presetOnly, true);
    assert.equal(capability.defaultDimensions, 768);
    assert.deepEqual(capability.presets, MRL);
    for (const dimensions of MRL) {
      const target = localEmbeddingPreparationTarget(`embeddinggemma-2-${dimensions}`);
      assert.equal(target?.model, MODEL);
      assert.equal(target?.dimensions, dimensions);
      assert.equal(target?.revision, EMBEDDINGGEMMA2_EMBEDDING_PROFILE.revision);
      assert.equal(target?.license, "Apache-2.0");
      assert.equal(target?.commercialUse, undefined);
    }
    assert.equal(localEmbeddingPreparationTarget("embeddinggemma-2-1024"), null);
    const catalog = embeddingDimensionProfiles({ provider: "local-transformers", model: MODEL, dimensions: 256 });
    const entry = catalog.find((item) => item.model === MODEL);
    assert.equal(entry.id, "local-embeddinggemma-2");
    assert.equal(entry.current, true);
    assert.equal(entry.selectedDimensions, 256);
    assert.equal(entry.license, "Apache-2.0");
  });

  it("normalizes the configuration: 768d by default, MRL widths only, dtype and batch size validated, prefixes from the profile", () => {
    const base = normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: MODEL } });
    assert.equal(base.dimensions, 768);
    assert.equal(base.local.revision, EMBEDDINGGEMMA2_EMBEDDING_PROFILE.revision);
    assert.equal(base.local.queryPrefix, QUERY_PREFIX);
    assert.equal(base.local.passagePrefix, DOCUMENT_PREFIX);
    assert.equal("dtype" in base.local, false);
    for (const dimensions of MRL) {
      assert.equal(normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: MODEL, dimensions } }).dimensions, dimensions);
    }
    for (const dimensions of [64, 300, 1024]) {
      assert.throws(() => normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: MODEL, dimensions } }), /dimensions/);
    }
    assert.equal(normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: MODEL, dtype: "q4" } }).local.dtype, "q4");
    assert.throws(
      () => normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: MODEL, dtype: "fp16" } }),
      /dtype/,
    );
    assert.throws(
      () => normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: E5_EMBEDDING_PROFILE.model, dtype: "q8" } }),
      /dtype/,
    );
    assert.equal(normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: MODEL, maxBatchSize: 4 } }).local.maxBatchSize, 4);
    assert.throws(() => normalizeEmbeddingConfig({ provider: "local-transformers", local: { model: MODEL, maxBatchSize: 0 } }), /maxBatchSize/);
  });

  it("loads the pinned model offline, puts the role prompts in front, uses sentence_embedding, truncates (MRL) and renormalizes", async () => {
    const calls = [];
    const embedding = provider(calls, { dimensions: 256 });
    const query = await embedding.embedQuery("Wann hat die Tante Geburtstag?");
    const passages = await embedding.embedBatch(["Die Tante hat am 16.08. Geburtstag.", "Anne und Wolfgang sind Freunde."]);

    assert.equal(query.length, 256);
    assert.equal(passages.length, 2);
    assert.equal(passages[1].length, 256);
    assert.ok(Math.abs(Math.hypot(...query) - 1) < 1e-6, "vector is renormalized after truncation");
    assert.ok(Math.abs(query[0] - 0.6) < 1e-6 && Math.abs(query[1] - 0.8) < 1e-6);

    const tokenized = calls.filter(([kind]) => kind === "tokenize").map(([, texts]) => texts);
    assert.deepEqual(tokenized[0], [`${QUERY_PREFIX}Wann hat die Tante Geburtstag?`]);
    assert.deepEqual(tokenized[1], [
      `${DOCUMENT_PREFIX}Die Tante hat am 16.08. Geburtstag.`,
      `${DOCUMENT_PREFIX}Anne und Wolfgang sind Freunde.`,
    ]);
    assert.deepEqual(calls.find(([kind]) => kind === "tokenize")[2], { padding: true, truncation: true, max_length: 512 });

    const modelLoad = calls.find(([kind]) => kind === "model-load");
    assert.equal(modelLoad[1], MODEL);
    assert.equal(modelLoad[2].dtype, "q8");
    assert.equal(modelLoad[2].local_files_only, true);
    assert.equal(modelLoad[2].revision, EMBEDDINGGEMMA2_EMBEDDING_PROFILE.revision);
    assert.equal(modelLoad[2].config.vision_config, null, "the vision tower is not loaded");
    assert.equal(modelLoad[2].config.audio_config, null, "the audio tower is not loaded");
    assert.equal(modelLoad[2].config.architectures[0], "EmbeddingGemma2Model");
    assert.ok(calls.some(([kind, model, dtype, paths, sameDir]) => kind === "artifacts" && model === MODEL && dtype === "q8" && paths.length === 5 && sameDir));
    assert.ok(calls.some(([kind, type, dims]) => kind === "tensor-dispose" && type === "float32" && dims[1] === 768), "outputs are disposed");
    await embedding.shutdown();
    assert.ok(calls.some(([kind]) => kind === "dispose"));
  });

  it("serves every Matryoshka width with a unit vector", async () => {
    for (const dimensions of MRL) {
      const calls = [];
      const embedding = provider(calls, { dimensions });
      const [vector] = await embedding.embedBatch(["ein Satz"]);
      assert.equal(vector.length, dimensions);
      assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-6, `${dimensions}d is normalized`);
      await embedding.shutdown();
    }
  });

  it("pools the token states over the attention mask itself when the graph emits no sentence_embedding", async () => {
    const calls = [];
    const embedding = provider(calls, {}, { emitSentenceEmbedding: false });
    const [padded, full] = await embedding.embedBatch(["kurz", "etwas länger"]);
    // Row 0 attends positions 0-1: mean of (3,4) and (6,8) = (4.5, 6) -> direction (0.6, 0.8).
    // Row 1 attends 0-2: mean of (3,4), (6,8), (9,12) = (6, 8) -> the same direction. The padded token must not enter the mean.
    for (const row of [padded, full]) {
      assert.ok(Math.abs(row[0] - 0.6) < 1e-6 && Math.abs(row[1] - 0.8) < 1e-6);
      assert.ok(Math.abs(Math.hypot(...row) - 1) < 1e-6);
    }
    await embedding.shutdown();
  });

  it("selects the dtype and its pinned artifacts: q8 by default, q4 and fp32 on request", async () => {
    for (const dtype of ["q4", "fp32"]) {
      const calls = [];
      const embedding = provider(calls, { dtype });
      await embedding.embedQuery("x");
      assert.equal(calls.find(([kind]) => kind === "model-load")[2].dtype, dtype);
      const artifacts = calls.find(([kind]) => kind === "artifacts");
      assert.equal(artifacts[2], dtype);
      assert.ok(artifacts[3].some((path) => path.startsWith("onnx/model")), "the variant's own graph is the one ensured");
      await embedding.shutdown();
    }
    assert.throws(() => provider([], { dtype: "fp16" }), /dtype/);
    assert.throws(() => provider([], { model: E5_EMBEDDING_PROFILE.model, dimensions: 384, dtype: "q8" }), /dtype/);
  });

  it("binds the provider to the dtype's own profile, so a shared pipeline can never mix dtypes", () => {
    const a = provider([], { dtype: "q8" });
    const b = provider([], { dtype: "q4" });
    assert.equal(a.profile.dtype, "q8");
    assert.equal(b.profile.dtype, "q4");
    assert.notDeepEqual(a.profile.artifacts, b.profile.artifacts);
  });

  it("caps every text at the configured token count (up to the model's 8K) and refuses other caps", async () => {
    const calls = [];
    const embedding = provider(calls, { maxTokens: 8192 });
    await embedding.embedPassage("x");
    assert.equal(calls.find(([kind]) => kind === "tokenize")[2].max_length, 8192);
    await embedding.shutdown();
    assert.throws(() => provider([], { maxTokens: 16 }), /between 32 and 8192/);
    assert.throws(() => provider([], { maxTokens: 8193 }), /between 32 and 8192/);
  });

  it("splits a large batch into bounded sub-batches in order", async () => {
    const calls = [];
    const embedding = provider(calls, { maxBatchSize: 2 });
    const texts = ["a", "b", "c", "d", "e"];
    const vectors = await embedding.embedBatch(texts);
    assert.equal(vectors.length, 5);
    assert.deepEqual(calls.filter(([kind]) => kind === "model-call").map(([, batch]) => batch), [2, 2, 1]);
    assert.deepEqual(
      calls.filter(([kind]) => kind === "tokenize").map(([, input]) => input.map((text) => text.slice(DOCUMENT_PREFIX.length))),
      [["a", "b"], ["c", "d"], ["e"]],
    );
    await embedding.shutdown();
    assert.throws(() => provider([], { maxBatchSize: 0 }), /maxBatchSize/);
    assert.throws(() => provider([], { maxBatchSize: 65 }), /maxBatchSize/);
    assert.throws(() => provider([], { maxBatchSize: 1.5 }), /maxBatchSize/);
  });

  it("refuses prefixes that differ from the profile and a revision other than the pinned one", () => {
    assert.throws(() => provider([], { queryPrefix: "query: ", passagePrefix: "passage: " }), /requires queryPrefix/);
    assert.throws(() => provider([], { queryPrefix: QUERY_PREFIX, passagePrefix: "" }), /requires queryPrefix/);
    assert.throws(() => provider([], { revision: "main" }), /verified local model revision/);
  });

  it("refuses config drift: another architecture or a different embedding width", async () => {
    await assert.rejects(
      () => provider([], {}, { architecture: "BertModel", modelType: "bert" }).embedQuery("x"),
      /refusing model drift/,
    );
    await assert.rejects(
      () => provider([], {}, { embeddingDim: 1024 }).embedQuery("x"),
      /refusing model drift/,
    );
    await assert.rejects(
      () => provider([], {}, { inputNames: ["input_ids"] }).embedQuery("x"),
      /must expose input_ids and attention_mask/,
    );
  });

  it("rejects a degenerate vector instead of storing it", async () => {
    const calls = [];
    const runtime = fakeTransformersRuntime(calls);
    const original = runtime.AutoModel.from_pretrained;
    runtime.AutoModel.from_pretrained = async (...args) => {
      const loaded = await original(...args);
      const zero = async (inputs) => ({
        sentence_embedding: new runtime.Tensor("float32", new Float32Array(inputs.input_ids.dims[0] * 768), [inputs.input_ids.dims[0], 768]),
      });
      zero.sessions = loaded.sessions;
      zero.dispose = loaded.dispose;
      return zero;
    };
    const embedding = provider(calls, { loadTransformers: async () => runtime });
    await assert.rejects(() => embedding.embedPassage("x"), /zero or non-finite/);
    await embedding.shutdown();
  });

  it("does not need a license acknowledgement (Apache-2.0) and still ensures the pinned artifacts", async () => {
    const calls = [];
    const embedding = provider(calls, { acceptNonCommercialLicense: false });
    await embedding.embedQuery("x");
    assert.ok(calls.some(([kind]) => kind === "artifacts"));
    await embedding.shutdown();
  });

  it("rejects a cached artifact whose SHA-256 does not match the pin", async () => {
    const cacheDir = makeTempDir("plur1bus-egemma2-cache-");
    const profile = EMBEDDINGGEMMA2_EMBEDDING_PROFILE;
    const config = profile.artifacts.find((entry) => entry.path === "config.json");
    const target = join(modelCacheRevisionDir(cacheDir, profile), config.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(config.size, 7)); // right size, wrong content
    const report = await validatePinnedModelArtifacts(profile, cacheDir);
    assert.equal(report.ok, false);
    const entry = report.artifacts.find((item) => item.expected.path === "config.json");
    assert.equal(entry.ok, false);
    assert.equal(entry.reason, "sha256");
    assert.equal(report.artifacts.find((item) => item.expected.path === "tokenizer.json").reason, "missing");
  });
});
