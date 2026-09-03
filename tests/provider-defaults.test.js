import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_LOCAL_RERANKER_MODEL, DEFAULT_LOCAL_E5_MODEL } from "../lib/providers/dimensions.js";

const installerSource = readFileSync(new URL("../scripts/install-memory-system.sh", import.meta.url), "utf8");

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
  it("der Bash-Fallback-Installer verwendet denselben verifizierten BGE-Default", () => {
    assert.match(installerSource, /RERANKER_LOCAL_MODEL="woxpas-ai\/bge-reranker-v2-m3-onnx"/);
    assert.doesNotMatch(installerSource, /RERANKER_LOCAL_MODEL="Alibaba-NLP\/gte-reranker-modernbert-base"/);
  });
});
