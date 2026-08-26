import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import {
  BGE_RERANKER_PROFILE,
  E5_EMBEDDING_PROFILE,
  JINA_RERANKER_PROFILE,
  ensurePinnedModelArtifacts,
  modelCacheRevisionDir,
  validatePinnedModelArtifacts,
} from "../lib/providers/local-model-artifacts.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import { LocalTransformersRerankerProvider } from "../lib/providers/reranker-local-transformers.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixtureProfile(bytes, overrides = {}) {
  return Object.freeze({
    model: "fixture/model",
    revision: "0123456789abcdef0123456789abcdef01234567",
    artifacts: Object.freeze([Object.freeze({
      path: "onnx/model.onnx",
      size: bytes.length,
      sha256: sha256(bytes),
    })]),
    ...overrides,
  });
}

function responseFrom(chunks, { ok = true, status = 200 } = {}) {
  return { ok, status, body: Readable.from(chunks) };
}

describe("pinned local model artifacts", () => {
  it("declares immutable revisions and real ONNX identities for E5, Jina, and BGE", () => {
    assert.equal(E5_EMBEDDING_PROFILE.revision, "614241f622f53c4eeff9890bdc4f31cfecc418b3");
    assert.deepStrictEqual(E5_EMBEDDING_PROFILE.artifacts.find((entry) => entry.path === "onnx/model.onnx"), {
      path: "onnx/model.onnx",
      size: 470_268_510,
      sha256: "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665",
    });
    assert.deepStrictEqual(JINA_RERANKER_PROFILE.artifacts.find((entry) => entry.path.startsWith("onnx/")), {
      path: "onnx/model_quantized.onnx",
      size: 279_577_152,
      sha256: "c5220cf8fe023f8aa0ed2a3eb787d4451a7f17cf53f6b787e35718dd4b8815c3",
    });
    assert.deepStrictEqual(BGE_RERANKER_PROFILE.artifacts.find((entry) => entry.path.startsWith("onnx/")), {
      path: "onnx/model_quantized.onnx",
      size: 569_986_762,
      sha256: "1ed01a24f6e639dbd0a18e74e47b394abb78e6adb13dd23f34f94a79623fb3d3",
    });
  });

  it("downloads to a unique partial file and exposes only the verified final artifact", async () => {
    const bytes = Buffer.from("verified model bytes");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-cache-"));
    const urls = [];

    const result = await ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl: async (url) => {
        urls.push(url);
        return responseFrom([bytes.subarray(0, 5), bytes.subarray(5)]);
      },
    });

    assert.equal(result.downloaded, 1);
    assert.deepStrictEqual(urls, [
      "https://huggingface.co/fixture/model/resolve/0123456789abcdef0123456789abcdef01234567/onnx/model.onnx",
    ]);
    const revisionDir = modelCacheRevisionDir(cacheDir, profile);
    assert.deepStrictEqual(readFileSync(join(revisionDir, "onnx/model.onnx")), bytes);
    assert.equal(existsSync(join(revisionDir, "onnx/model.onnx.part")), false);
    assert.equal((await validatePinnedModelArtifacts(profile, cacheDir)).ok, true);
  });

  it("reuses a valid artifact without a network request", async () => {
    const bytes = Buffer.from("already valid");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-cache-"));
    const target = join(modelCacheRevisionDir(cacheDir, profile), "onnx/model.onnx");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(modelCacheRevisionDir(cacheDir, profile), "onnx"), { recursive: true });
    writeFileSync(target, bytes);

    const result = await ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl: async () => { throw new Error("network must not be used"); },
    });

    assert.deepStrictEqual(result, { downloaded: 0, reused: 1, artifacts: [target] });
  });

  it("never publishes a truncated or hash-mismatched download", async () => {
    const expected = Buffer.from("complete artifact");
    const profile = fixtureProfile(expected);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-cache-"));
    const finalPath = join(modelCacheRevisionDir(cacheDir, profile), "onnx/model.onnx");

    await assert.rejects(
      ensurePinnedModelArtifacts(profile, cacheDir, {
        fetchImpl: async () => responseFrom([Buffer.from("truncated")]),
      }),
      /artifact.*size mismatch.*onnx\/model\.onnx/i,
    );
    assert.equal(existsSync(finalPath), false);
    const revisionDir = modelCacheRevisionDir(cacheDir, profile);
    assert.deepStrictEqual(
      existsSync(revisionDir)
        ? (await import("node:fs")).readdirSync(join(revisionDir, "onnx")).filter((name) => name.includes(".part-"))
        : [],
      [],
    );
  });

  it("fails clearly on HTTP errors without creating a usable artifact", async () => {
    const bytes = Buffer.from("expected");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-cache-"));

    await assert.rejects(
      ensurePinnedModelArtifacts(profile, cacheDir, {
        fetchImpl: async () => responseFrom([], { ok: false, status: 404 }),
      }),
      /HTTP 404.*fixture\/model.*onnx\/model\.onnx/i,
    );
    assert.equal((await validatePinnedModelArtifacts(profile, cacheDir)).ok, false);
  });

  it("verifies E5 artifacts before constructing a revision-pinned offline pipeline", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-e5-order-"));
    const order = [];
    const provider = new LocalTransformersEmbeddingProvider({
      model: E5_EMBEDDING_PROFILE.model,
      dimensions: 384,
      cacheDir,
      embeddingCacheEnabled: false,
      ensureModelArtifacts: async (profile, receivedCacheDir) => {
        order.push(["artifacts", profile, receivedCacheDir]);
      },
      loadTransformers: async () => ({
        env: {},
        async pipeline(task, model, options) {
          order.push(["pipeline", task, model, options]);
          return async () => [1];
        },
      }),
    });

    await provider._getPipeline();

    assert.deepStrictEqual(order, [
      ["artifacts", E5_EMBEDDING_PROFILE, cacheDir],
      ["pipeline", "feature-extraction", E5_EMBEDDING_PROFILE.model, {
        cache_dir: cacheDir,
        revision: E5_EMBEDDING_PROFILE.revision,
        local_files_only: true,
      }],
    ]);
  });

  it("verifies Jina artifacts before config inspection and pipeline construction", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-jina-order-"));
    const order = [];
    const provider = new LocalTransformersRerankerProvider({
      model: JINA_RERANKER_PROFILE.model,
      cacheDir,
      ensureModelArtifacts: async (profile, receivedCacheDir) => {
        order.push(["artifacts", profile, receivedCacheDir]);
      },
      loadTransformers: async () => ({
        env: {},
        AutoConfig: {
          async from_pretrained(model, options) {
            order.push(["config", model, options]);
            return {
              architectures: ["XLMRobertaForSequenceClassification"],
              model_type: null,
              num_labels: 1,
              id2label: { 0: "LABEL_0" },
            };
          },
        },
        async pipeline(task, model, options) {
          order.push(["pipeline", task, model, options]);
          return async () => [{ score: 1 }];
        },
      }),
    });

    await provider._getPipeline();

    assert.equal(order[0][0], "artifacts");
    assert.equal(order[1][0], "config");
    assert.equal(order[2][0], "pipeline");
    assert.equal(order[2][3].revision, JINA_RERANKER_PROFILE.revision);
    assert.equal(order[2][3].local_files_only, true);
  });

  it("rejects revision drift for every verified built-in model before loading", () => {
    assert.throws(
      () => new LocalTransformersEmbeddingProvider({
        model: E5_EMBEDDING_PROFILE.model,
        revision: "main",
      }),
      /revision.*must be.*614241f/i,
    );
    assert.throws(
      () => new LocalTransformersRerankerProvider({
        model: BGE_RERANKER_PROFILE.model,
        revision: "main",
      }),
      /revision.*must be.*c44ebc43/i,
    );
  });
});
