import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import {
  BGE_RERANKER_PROFILE,
  E5_EMBEDDING_PROFILE,
  JINA_EMBEDDING_PROFILE,
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

function responseFrom(chunks, { ok = true, status = 200, contentLength, onCancel } = {}) {
  const body = Readable.from(chunks);
  if (onCancel) body.cancel = onCancel;
  return {
    ok,
    status,
    body,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-length" && contentLength !== undefined
          ? String(contentLength)
          : null;
      },
    },
  };
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

  it("reports bounded aggregate progress while preserving atomic publication", async () => {
    const bytes = Buffer.from("progress-visible-model-bytes");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-progress-"));
    const progress = [];

    await ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl: async () => responseFrom([
        bytes.subarray(0, 4),
        bytes.subarray(4, 11),
        bytes.subarray(11),
      ]),
      onProgress: async (entry) => progress.push(structuredClone(entry)),
    });

    assert.equal(progress[0].state, "downloading");
    assert.equal(progress.at(-1).state, "verified");
    assert.equal(progress.at(-1).bytesCompleted, bytes.length);
    assert.equal(progress.at(-1).bytesTotal, bytes.length);
    assert.equal(progress.at(-1).artifactsCompleted, 1);
    assert.equal(progress.at(-1).artifactsTotal, 1);
    assert.ok(progress.every((entry, index) => (
      index === 0 || entry.bytesCompleted >= progress[index - 1].bytesCompleted
    )));
    assert.ok(progress.every((entry) => !Object.hasOwn(entry, "url")));
  });

  it("coalesces concurrent preparation and provider downloads for one artifact", async () => {
    const bytes = Buffer.from("one-network-transfer-for-two-consumers");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-coalesced-"));
    let fetches = 0;
    let releaseFetch;
    const fetchReady = new Promise((resolve) => { releaseFetch = resolve; });
    const fetchImpl = async () => {
      fetches += 1;
      await fetchReady;
      return responseFrom([bytes]);
    };

    const first = ensurePinnedModelArtifacts(profile, cacheDir, { fetchImpl });
    const second = ensurePinnedModelArtifacts(profile, cacheDir, { fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFetch();
    const results = await Promise.all([first, second]);

    assert.equal(fetches, 1);
    assert.equal(results[0].downloaded + results[0].reused, 1);
    assert.equal(results[1].downloaded + results[1].reused, 1);
    assert.equal((await validatePinnedModelArtifacts(profile, cacheDir)).ok, true);
  });

  it("rechecks a completed artifact when a delayed subscriber misses the in-flight entry", async () => {
    const bytes = Buffer.from("late-subscriber-reuses-published-artifact");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-late-subscriber-"));
    let fetches = 0;
    let releaseFetch;
    let releaseSecondProgress;
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    const secondProgressGate = new Promise((resolve) => { releaseSecondProgress = resolve; });
    const fetchImpl = async () => {
      fetches += 1;
      await fetchGate;
      return responseFrom([bytes]);
    };

    const first = ensurePinnedModelArtifacts(profile, cacheDir, { fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    let delayed = true;
    const second = ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl,
      onProgress: async (entry) => {
        if (delayed && entry.state === "downloading" && entry.bytesCompleted === 0) {
          delayed = false;
          await secondProgressGate;
        }
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFetch();
    await first;
    releaseSecondProgress();
    const result = await second;

    assert.equal(fetches, 1);
    assert.equal(result.downloaded, 0);
    assert.equal(result.reused, 1);
    assert.equal((await validatePinnedModelArtifacts(profile, cacheDir)).ok, true);
  });

  it("gives every coalesced consumer progress and isolates one consumer abort", async () => {
    const bytes = Buffer.from("shared-transfer-survives-one-consumer-abort");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-subscriber-abort-"));
    const firstAbort = new AbortController();
    const secondProgress = [];
    let fetches = 0;
    let releaseFetch;
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    const fetchImpl = async (_url, { signal }) => {
      fetches += 1;
      await Promise.race([
        fetchGate,
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
      return responseFrom([bytes]);
    };

    const first = ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl,
      signal: firstAbort.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl,
      onProgress: async (entry) => secondProgress.push(structuredClone(entry)),
    });
    await new Promise((resolve) => setImmediate(resolve));

    firstAbort.abort();
    await assert.rejects(first, /abort/i);
    releaseFetch();
    const secondResult = await second;

    assert.equal(fetches, 1);
    assert.equal(secondResult.downloaded + secondResult.reused, 1);
    assert.ok(secondProgress.some((entry) => entry.state === "downloading" && entry.bytesCompleted > 0));
    assert.equal(secondProgress.at(-1).state, "verified");
    assert.equal((await validatePinnedModelArtifacts(profile, cacheDir)).ok, true);
  });

  it("isolates a failing coalesced progress subscriber without cancelling the shared transfer", async () => {
    const bytes = Buffer.from("shared-transfer-survives-progress-listener-failure");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-progress-failure-"));
    const survivorProgress = [];
    let fetches = 0;
    let releaseFetch;
    const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
    const fetchImpl = async () => {
      fetches += 1;
      await fetchGate;
      return responseFrom([bytes]);
    };

    let failOnChunk = false;
    const failing = ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl,
      onProgress: async (entry) => {
        if (failOnChunk && entry.state === "downloading" && entry.bytesCompleted > 0) {
          throw new Error("subscriber progress failed");
        }
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const survivor = ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl,
      onProgress: async (entry) => survivorProgress.push(structuredClone(entry)),
    });
    await new Promise((resolve) => setImmediate(resolve));
    failOnChunk = true;
    releaseFetch();

    await assert.rejects(failing, /subscriber progress failed/);
    const result = await survivor;
    assert.equal(fetches, 1);
    assert.equal(result.downloaded + result.reused, 1);
    assert.equal(survivorProgress.at(-1).state, "verified");
    assert.equal((await validatePinnedModelArtifacts(profile, cacheDir)).ok, true);
  });

  it("does not create or join a transfer after an awaited initial progress callback aborts", async () => {
    const bytes = Buffer.from("abort-after-initial-progress");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-progress-abort-"));
    const controller = new AbortController();
    let fetches = 0;

    await assert.rejects(
      ensurePinnedModelArtifacts(profile, cacheDir, {
        signal: controller.signal,
        fetchImpl: async () => {
          fetches += 1;
          return responseFrom([bytes]);
        },
        onProgress: async (entry) => {
          if (entry.state === "downloading" && entry.bytesCompleted === 0) controller.abort();
        },
      }),
      /abort/i,
    );

    assert.equal(fetches, 0);
  });

  it("aborts the shared transfer only after every coalesced consumer cancels", async () => {
    const bytes = Buffer.from("all-consumers-cancel");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-all-abort-"));
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    let sharedSignal;
    let fetches = 0;
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
    let markSecondProgress;
    const secondProgress = new Promise((resolve) => { markSecondProgress = resolve; });
    const fetchImpl = async (_url, { signal }) => {
      fetches += 1;
      sharedSignal = signal;
      markFetchStarted();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    };

    const first = ensurePinnedModelArtifacts(profile, cacheDir, { fetchImpl, signal: firstAbort.signal });
    await fetchStarted;
    const second = ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl,
      signal: secondAbort.signal,
      onProgress: async () => markSecondProgress(),
    });
    await secondProgress;
    await new Promise((resolve) => setImmediate(resolve));

    firstAbort.abort();
    await assert.rejects(first, /abort/i);
    assert.equal(sharedSignal.aborted, false);
    secondAbort.abort();
    await assert.rejects(second, /abort/i);
    assert.equal(sharedSignal.aborted, true);
    assert.equal(fetches, 1);
  });

  it("downloads a logical model from its pinned conversion repository and source path", async () => {
    const bytes = Buffer.from("verified converted model bytes");
    const profile = fixtureProfile(bytes, {
      artifactRepository: "converter/model-q8",
      artifactRevision: "fedcba9876543210fedcba9876543210fedcba98",
      artifacts: Object.freeze([Object.freeze({
        path: "onnx/model.onnx",
        sourcePath: "model.onnx",
        size: bytes.length,
        sha256: sha256(bytes),
      })]),
    });
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-converted-model-cache-"));
    const urls = [];

    await ensurePinnedModelArtifacts(profile, cacheDir, {
      fetchImpl: async (url) => {
        urls.push(url);
        return responseFrom([bytes]);
      },
    });

    assert.deepStrictEqual(urls, [
      "https://huggingface.co/converter/model-q8/resolve/fedcba9876543210fedcba9876543210fedcba98/model.onnx",
    ]);
    assert.deepStrictEqual(
      readFileSync(join(modelCacheRevisionDir(cacheDir, profile), "onnx/model.onnx")),
      bytes,
    );
  });

  it("declares the Jina embedding conversion and base revisions separately", () => {
    assert.equal(JINA_EMBEDDING_PROFILE.model, "jinaai/jina-embeddings-v3");
    assert.equal(JINA_EMBEDDING_PROFILE.baseModelRevision, "ab036b023d30b4d1138c4c3bfa9f0c445ab455d6");
    assert.equal(JINA_EMBEDDING_PROFILE.artifactRepository, "ldwformat/jina-embeddings-v3-Q8-onnx");
    assert.equal(JINA_EMBEDDING_PROFILE.artifactRevision, JINA_EMBEDDING_PROFILE.revision);
  });

  it("blocks a non-commercial Jina artifact before network or cache mutation without explicit acknowledgement", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-jina-license-gate-"));
    let fetches = 0;

    await assert.rejects(
      ensurePinnedModelArtifacts(JINA_EMBEDDING_PROFILE, cacheDir, {
        fetchImpl: async () => {
          fetches += 1;
          return responseFrom([]);
        },
      }),
      (error) => (
        error?.code === "non_commercial_license_acknowledgement_required"
        && /CC-BY-NC-4\.0/i.test(error.message)
        && /acknowledg/i.test(error.message)
      ),
    );

    assert.equal(fetches, 0);
    assert.deepStrictEqual(readdirSync(cacheDir), []);
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

    assert.equal(result.downloaded, 0);
    assert.equal(result.reused, 1);
    assert.deepStrictEqual(result.artifacts, [target]);
    assert.deepStrictEqual(result.receipts, [{
      path: target,
      expected: profile.artifacts[0],
      ok: true,
      size: bytes.length,
      sha256: sha256(bytes),
    }]);
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

  it("rejects an oversized Content-Length before writing and cancels the body", async () => {
    const expected = Buffer.from("bounded-artifact");
    const profile = fixtureProfile(expected);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-length-bound-"));
    const finalPath = join(modelCacheRevisionDir(cacheDir, profile), "onnx/model.onnx");
    let cancellations = 0;

    await assert.rejects(
      ensurePinnedModelArtifacts(profile, cacheDir, {
        fetchImpl: async () => responseFrom([expected], {
          contentLength: expected.length + 1,
          onCancel: async () => { cancellations += 1; },
        }),
      }),
      /content-length.*exceeds.*expected/i,
    );

    assert.equal(cancellations, 1);
    assert.equal(existsSync(finalPath), false);
  });

  it("stops an oversized stream before the excess chunk is written and removes partial files", async () => {
    const expected = Buffer.from("exact-size");
    const profile = fixtureProfile(expected);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-stream-bound-"));
    const revisionDir = modelCacheRevisionDir(cacheDir, profile);
    const finalPath = join(revisionDir, "onnx/model.onnx");
    let cancellations = 0;

    await assert.rejects(
      ensurePinnedModelArtifacts(profile, cacheDir, {
        fetchImpl: async () => responseFrom(
          [expected.subarray(0, 4), Buffer.from("far-too-many-bytes")],
          { onCancel: async () => { cancellations += 1; } },
        ),
      }),
      /stream exceeds.*expected size/i,
    );

    assert.equal(cancellations, 1);
    assert.equal(existsSync(finalPath), false);
    assert.deepStrictEqual(
      existsSync(join(revisionDir, "onnx"))
        ? readdirSync(join(revisionDir, "onnx")).filter((name) => name.includes(".part-"))
        : [],
      [],
    );
  });

  it("fails clearly on HTTP errors without creating a usable artifact", async () => {
    const bytes = Buffer.from("expected");
    const profile = fixtureProfile(bytes);
    const cacheDir = mkdtempSync(join(tmpdir(), "plur1bus-model-cache-"));

    let cancellations = 0;
    await assert.rejects(
      ensurePinnedModelArtifacts(profile, cacheDir, {
        fetchImpl: async () => responseFrom([], {
          ok: false,
          status: 404,
          onCancel: async () => { cancellations += 1; },
        }),
      }),
      /HTTP 404.*fixture\/model.*onnx\/model\.onnx/i,
    );
    assert.equal(cancellations, 1);
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
