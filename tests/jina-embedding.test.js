import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { normalizeEmbeddingConfig } from "../lib/providers/config-normalize.js";
import { embeddingDimensionCapability } from "../lib/providers/dimensions.js";
import { JINA_EMBEDDING_PROFILE } from "../lib/providers/local-model-artifacts.js";

const JINA_TASKS = [
  "retrieval.query",
  "retrieval.passage",
  "separation",
  "classification",
  "text-matching",
];
const JINA_DIMENSIONS = [32, 64, 128, 256, 512, 768, 1024];

function fakeTransformersRuntime(calls, {
  architecture = "XLMRobertaModel",
  taskShape = [1],
} = {}) {
  class FakeTensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
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
          model_type: null,
          hidden_size: 1024,
          lora_adaptations: [...JINA_TASKS],
          matryoshka_dimensions: [...JINA_DIMENSIONS],
        };
      },
    },
    AutoTokenizer: {
      async from_pretrained(model, options) {
        calls.push(["tokenizer-load", model, options]);
        return async (texts) => {
          const input = Array.isArray(texts) ? texts : [texts];
          calls.push(["tokenize", [...input]]);
          return {
            input_ids: new FakeTensor("int64", new BigInt64Array(input.length * 2), [input.length, 2]),
            attention_mask: new FakeTensor("int64", new BigInt64Array(input.length * 2).fill(1n), [input.length, 2]),
          };
        };
      },
    },
    AutoModel: {
      async from_pretrained(model, options) {
        calls.push(["model-load", model, options]);
        const loaded = async (inputs) => {
          calls.push(["model-call", Number(inputs.task_id.data[0]), inputs.task_id.dims]);
          return {
            text_embeds: new FakeTensor("float32", new Float32Array(1), [inputs.input_ids.dims[0], 2, 1024]),
          };
        };
        loaded.sessions = {
          model: {
            inputNames: ["input_ids", "attention_mask", "task_id"],
            inputMetadata: [
              { name: "input_ids", isTensor: true, type: "int64", shape: ["batch", "sequence"] },
              { name: "attention_mask", isTensor: true, type: "int64", shape: ["batch", "sequence"] },
              { name: "task_id", isTensor: true, type: "int64", shape: taskShape },
            ],
          },
        };
        loaded.dispose = async () => { calls.push(["dispose"]); };
        return loaded;
      },
    },
    mean_pooling(_hidden, attentionMask) {
      const rows = attentionMask.dims[0];
      const data = new Float32Array(rows * 1024);
      for (let row = 0; row < rows; row += 1) {
        data[row * 1024] = 3;
        data[row * 1024 + 1] = 4;
      }
      return new FakeTensor("float32", data, [rows, 1024]);
    },
  };
}

describe("downloadable multilingual JinaAI embedding", () => {
  it("pins a memory-safe real Jina v3 Q8 ONNX export and its non-commercial license", () => {
    assert.equal(JINA_EMBEDDING_PROFILE.model, "jinaai/jina-embeddings-v3");
    assert.equal(JINA_EMBEDDING_PROFILE.baseModelRevision, "ab036b023d30b4d1138c4c3bfa9f0c445ab455d6");
    assert.equal(JINA_EMBEDDING_PROFILE.artifactRepository, "ldwformat/jina-embeddings-v3-Q8-onnx");
    assert.equal(JINA_EMBEDDING_PROFILE.revision, "68ed94909d564380f954be27ae2e133214c1adc9");
    assert.equal(JINA_EMBEDDING_PROFILE.dtype, "q8");
    assert.equal(JINA_EMBEDDING_PROFILE.license, "CC-BY-NC-4.0");
    assert.equal(JINA_EMBEDDING_PROFILE.commercialUse, false);
    assert.deepStrictEqual(JINA_EMBEDDING_PROFILE.matryoshkaDimensions, JINA_DIMENSIONS);
    assert.deepStrictEqual(
      JINA_EMBEDDING_PROFILE.artifacts.find((entry) => entry.path === "onnx/model_quantized.onnx"),
      {
        path: "onnx/model_quantized.onnx",
        sourcePath: "model.onnx",
        size: 563_568_622,
        sha256: "69696107398fa52aad80bd38ca4a3972cf6e8293d2e1883231fcf7228fcb1c21",
      },
    );
  });

  it("offers only the model's declared Matryoshka dimensions", () => {
    assert.deepStrictEqual(
      embeddingDimensionCapability({
        provider: "local-transformers",
        model: JINA_EMBEDDING_PROFILE.model,
      }),
      {
        mode: "selectable",
        defaultDimensions: 1024,
        minDimensions: 32,
        maxDimensions: 1024,
        presets: JINA_DIMENSIONS,
        presetOnly: true,
        verification: "runtime_vector",
      },
    );
    assert.equal(normalizeEmbeddingConfig({
      provider: "local-transformers",
      local: { model: JINA_EMBEDDING_PROFILE.model, dimensions: 256 },
    }).dimensions, 256);
    assert.throws(
      () => normalizeEmbeddingConfig({
        provider: "local-transformers",
        local: { model: JINA_EMBEDDING_PROFILE.model, dimensions: 33 },
      }),
      /declared dimensions.*32.*64.*1024/i,
    );
  });

  it("loads the pinned model offline, selects query/passage adapters, truncates, then normalizes", async () => {
    const calls = [];
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-jina-embedding-"));
    const provider = new LocalTransformersEmbeddingProvider({
      model: JINA_EMBEDDING_PROFILE.model,
      dimensions: 256,
      cacheDir,
      embeddingCacheEnabled: false,
      ensureModelArtifacts: async (profile, receivedCacheDir) => {
        calls.push(["artifacts", profile, receivedCacheDir]);
      },
      loadTransformers: async () => fakeTransformersRuntime(calls),
    });

    const query = await provider.embedQuery("Wo ist der weisse Hase?");
    const passage = await provider.embedPassage("Der weisse Hase ist im Garten.");

    assert.equal(query.length, 256);
    assert.equal(passage.length, 256);
    assert.ok(Math.abs(Math.hypot(...query) - 1) < 1e-6);
    assert.deepStrictEqual(query.slice(0, 3), [0.6, 0.8, 0]);
    assert.deepStrictEqual(
      calls.filter(([name]) => name === "model-call"),
      [["model-call", 0, [1]], ["model-call", 1, [1]]],
    );
    assert.deepStrictEqual(
      calls.filter(([name]) => name === "tokenize").map(([, texts]) => texts),
      [["Wo ist der weisse Hase?"], ["Der weisse Hase ist im Garten."]],
    );
    const modelLoad = calls.find(([name]) => name === "model-load");
    assert.equal(modelLoad[2].dtype, "q8");
    assert.equal(modelLoad[2].revision, JINA_EMBEDDING_PROFILE.revision);
    assert.equal(modelLoad[2].local_files_only, true);
    assert.equal(modelLoad[2].config.model_type, "xlm-roberta");
    assert.deepStrictEqual(modelLoad[2].session_options, { graphOptimizationLevel: "disabled" });
    await provider.shutdown();
    assert.equal(calls.filter(([name]) => name === "dispose").length, 1);
  });

  it("fails closed before model loading when the pinned Jina structure drifts", async () => {
    const calls = [];
    const provider = new LocalTransformersEmbeddingProvider({
      model: JINA_EMBEDDING_PROFILE.model,
      dimensions: 1024,
      cacheDir: mkdtempSync(join(tmpdir(), "plur1bus-jina-embedding-drift-")),
      embeddingCacheEnabled: false,
      ensureModelArtifacts: async () => {},
      loadTransformers: async () => fakeTransformersRuntime(calls, { architecture: "UnknownModel" }),
    });

    await assert.rejects(provider.embed("probe"), /Jina embedding config.*XLMRobertaModel.*refusing/i);
    assert.equal(calls.some(([name]) => name === "model-load"), false);
  });

  it("fails closed when the pinned Q8 task_id input is not rank one", async () => {
    const calls = [];
    const provider = new LocalTransformersEmbeddingProvider({
      model: JINA_EMBEDDING_PROFILE.model,
      dimensions: 256,
      cacheDir: mkdtempSync(join(tmpdir(), "plur1bus-jina-embedding-signature-")),
      embeddingCacheEnabled: false,
      ensureModelArtifacts: async () => {},
      loadTransformers: async () => fakeTransformersRuntime(calls, { taskShape: [] }),
    });

    await assert.rejects(provider.embed("probe"), /task_id.*rank-1 int64/i);
    assert.equal(calls.filter(([name]) => name === "dispose").length, 1);
  });
});
