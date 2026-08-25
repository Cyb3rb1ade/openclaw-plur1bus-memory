import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JINA_RERANKER_MODEL,
  JINA_RERANKER_REVISION,
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
});
