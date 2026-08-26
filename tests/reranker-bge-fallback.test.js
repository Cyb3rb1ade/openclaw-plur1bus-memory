import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_LOCAL_RERANKER_MODEL } from "../lib/providers/dimensions.js";
import {
  BGE_RERANKER_ONNX_ARTIFACT,
  BGE_RERANKER_ONNX_MODEL,
  BGE_RERANKER_ONNX_REVISION,
  prepareLocalRerankerPipelineOptions,
} from "../lib/providers/reranker-local-transformers.js";

function fakeTransformers(config) {
  const calls = [];
  return {
    calls,
    AutoConfig: {
      async from_pretrained(model, options) {
        calls.push({ model, options });
        return { ...config };
      },
    },
  };
}

describe("free local BGE reranker fallback", () => {
  it("pins the default to the verified Transformers.js ONNX export", async () => {
    const mod = fakeTransformers({
      architectures: ["XLMRobertaForSequenceClassification"],
      model_type: "xlm-roberta",
      num_labels: 1,
      id2label: { 0: "LABEL_0" },
    });

    assert.equal(DEFAULT_LOCAL_RERANKER_MODEL, BGE_RERANKER_ONNX_MODEL);
    assert.equal(BGE_RERANKER_ONNX_MODEL, "woxpas-ai/bge-reranker-v2-m3-onnx");
    assert.equal(BGE_RERANKER_ONNX_REVISION, "c44ebc43de724ae8816668bb44d2e728e17faa18");
    assert.deepStrictEqual(BGE_RERANKER_ONNX_ARTIFACT, {
      path: "onnx/model_quantized.onnx",
      size: 569_986_762,
      sha256: "1ed01a24f6e639dbd0a18e74e47b394abb78e6adb13dd23f34f94a79623fb3d3",
    });

    const options = await prepareLocalRerankerPipelineOptions(mod, {
      model: DEFAULT_LOCAL_RERANKER_MODEL,
      cacheDir: "/lab/model-cache",
    });

    assert.deepStrictEqual(mod.calls, [{
      model: BGE_RERANKER_ONNX_MODEL,
      options: {
        cache_dir: "/lab/model-cache",
        revision: BGE_RERANKER_ONNX_REVISION,
      },
    }]);
    assert.equal(options.revision, BGE_RERANKER_ONNX_REVISION);
    assert.equal(options.dtype, "q8");
    assert.equal(options.config.problem_type, "multi_label_classification");
  });

  it("rejects the original BAAI source repository before a missing ONNX download", async () => {
    const mod = fakeTransformers({});
    await assert.rejects(
      prepareLocalRerankerPipelineOptions(mod, { model: "BAAI/bge-reranker-v2-m3" }),
      /source repository.*does not publish.*onnx\/model.*woxpas-ai/i,
    );
    assert.deepStrictEqual(mod.calls, []);
  });

  it("accepts the pinned export's real one-label config when num_labels is omitted", async () => {
    const mod = fakeTransformers({
      architectures: ["XLMRobertaForSequenceClassification"],
      model_type: "xlm-roberta",
      id2label: { 0: "LABEL_0" },
      label2id: { LABEL_0: 0 },
    });

    const options = await prepareLocalRerankerPipelineOptions(mod, {
      model: BGE_RERANKER_ONNX_MODEL,
    });

    assert.equal(options.config.num_labels, 1);
    assert.equal(options.config.problem_type, "multi_label_classification");
  });

  it("rejects drift in the pinned export's sequence-classifier structure", async () => {
    const mod = fakeTransformers({
      architectures: ["XLMRobertaModel"],
      model_type: "xlm-roberta",
      num_labels: 1,
    });
    await assert.rejects(
      prepareLocalRerankerPipelineOptions(mod, { model: BGE_RERANKER_ONNX_MODEL }),
      /BGE.*XLMRobertaForSequenceClassification.*refusing/i,
    );
  });
});
