import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JINA_RERANKER_MODEL,
  JINA_RERANKER_REVISION,
  LocalTransformersRerankerProvider,
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

describe("Jina local reranker compatibility", () => {
  it("normalizes the exact published Jina XLM-R sequence classifier before pipeline loading", async () => {
    const mod = fakeTransformers({
      architectures: ["XLMRobertaForSequenceClassification"],
      model_type: null,
      num_labels: 1,
      id2label: { 0: "LABEL_0" },
    });

    const options = await prepareLocalRerankerPipelineOptions(mod, {
      model: JINA_RERANKER_MODEL,
      cacheDir: "/lab/model-cache",
    });

    assert.equal(JINA_RERANKER_REVISION, "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9");
    assert.deepStrictEqual(mod.calls, [{
      model: JINA_RERANKER_MODEL,
      options: {
        cache_dir: "/lab/model-cache",
        revision: JINA_RERANKER_REVISION,
        local_files_only: true,
      },
    }]);
    assert.equal(options.revision, JINA_RERANKER_REVISION);
    assert.equal(options.dtype, "q8");
    assert.equal(options.cache_dir, "/lab/model-cache");
    assert.equal(options.config.model_type, "xlm-roberta");
    assert.equal(options.config.problem_type, "multi_label_classification");
  });

  it("rejects a drifted Jina architecture before model artifact loading", async () => {
    const mod = fakeTransformers({
      architectures: ["BertForSequenceClassification"],
      model_type: null,
      num_labels: 1,
    });

    await assert.rejects(
      prepareLocalRerankerPipelineOptions(mod, { model: JINA_RERANKER_MODEL }),
      /Jina.*XLMRobertaForSequenceClassification.*refusing/i,
    );
  });

  it("does not apply the Jina compatibility shim to arbitrary models", async () => {
    const mod = fakeTransformers({
      architectures: ["XLMRobertaForSequenceClassification"],
      model_type: null,
      num_labels: 1,
    });

    const options = await prepareLocalRerankerPipelineOptions(mod, {
      model: "owner/unrelated-model",
      cacheDir: "/lab/cache",
      revision: "exact-test-revision",
      dtype: "fp32",
    });

    assert.deepStrictEqual(options, {
      cache_dir: "/lab/cache",
      revision: "exact-test-revision",
      dtype: "fp32",
    });
    assert.deepStrictEqual(mod.calls, []);
  });

  it("scores real sequence-classifier pairs through tokenizer text_pair inputs", async () => {
    const provider = new LocalTransformersRerankerProvider({ model: JINA_RERANKER_MODEL });
    const calls = [];
    const classifier = Object.assign(
      async () => { throw new Error("the text-classification wrapper must not stringify pair objects"); },
      {
        tokenizer(text, options) {
          calls.push({ stage: "tokenizer", text, options });
          return { input_ids: "paired-inputs" };
        },
        async model(inputs) {
          calls.push({ stage: "model", inputs });
          return { logits: { dims: [2, 1], data: new Float32Array([-2, 2]) } };
        },
      },
    );
    provider._pipeline = classifier;

    const ranked = await provider.rerank("cobalt laboratory", ["red apples", "cobalt laboratory"], 2);

    assert.deepStrictEqual(calls, [
      {
        stage: "tokenizer",
        text: ["cobalt laboratory", "cobalt laboratory"],
        options: {
          text_pair: ["red apples", "cobalt laboratory"],
          padding: true,
          truncation: true,
        },
      },
      { stage: "model", inputs: { input_ids: "paired-inputs" } },
    ]);
    assert.deepStrictEqual(ranked.map((row) => row.index), [1, 0]);
    assert.ok(ranked[0].relevance_score > ranked[1].relevance_score);
  });
});
