import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCAL_RERANKER_MODEL, DEFAULT_LOCAL_E5_MODEL } from "../lib/providers/dimensions.js";

describe("provider defaults", () => {
  it("DEFAULT_LOCAL_RERANKER_MODEL ist der verifizierte BGE-ONNX-Export", () => {
    assert.strictEqual(DEFAULT_LOCAL_RERANKER_MODEL, "woxpas-ai/bge-reranker-v2-m3-onnx");
  });
  it("Alibaba ist NICHT mehr der Default", () => {
    assert.notEqual(DEFAULT_LOCAL_RERANKER_MODEL, "Alibaba-NLP/gte-reranker-modernbert-base");
  });
  it("DEFAULT_LOCAL_E5_MODEL bleibt intfloat/multilingual-e5-small", () => {
    assert.strictEqual(DEFAULT_LOCAL_E5_MODEL, "intfloat/multilingual-e5-small");
  });
});
