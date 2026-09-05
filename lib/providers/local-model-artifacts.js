import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { safeWarn } from "../safe-logging.js";
import { resolveInside } from "../sql-safety.js";

const artifactDownloads = new Map();

const artifact = (path, size, sha256, sourcePath) => Object.freeze({
  path,
  ...(sourcePath ? { sourcePath } : {}),
  size,
  sha256,
});

export const E5_EMBEDDING_PROFILE = Object.freeze({
  role: "embedding",
  model: "intfloat/multilingual-e5-small",
  revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
  artifacts: Object.freeze([
    artifact("config.json", 655, "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959"),
    artifact("onnx/model.onnx", 470_268_510, "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665"),
    artifact("tokenizer.json", 17_082_730, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
    artifact("tokenizer_config.json", 443, "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b"),
  ]),
});

/** Pinned optional multilingual Jina v3 embedding and its immutable runtime contract. */
export const JINA_EMBEDDING_PROFILE = Object.freeze({
  role: "embedding",
  runtime: "jina-v3",
  model: "jinaai/jina-embeddings-v3",
  baseModelRevision: "ab036b023d30b4d1138c4c3bfa9f0c445ab455d6",
  artifactRepository: "ldwformat/jina-embeddings-v3-Q8-onnx",
  artifactRevision: "68ed94909d564380f954be27ae2e133214c1adc9",
  revision: "68ed94909d564380f954be27ae2e133214c1adc9",
  dtype: "q8",
  outputDimensions: 1024,
  matryoshkaDimensions: Object.freeze([32, 64, 128, 256, 512, 768, 1024]),
  taskAdaptations: Object.freeze([
    "retrieval.query",
    "retrieval.passage",
    "separation",
    "classification",
    "text-matching",
  ]),
  queryPrefix: "",
  passagePrefix: "",
  license: "CC-BY-NC-4.0",
  commercialUse: false,
  artifacts: Object.freeze([
    artifact("config.json", 1_817, "9f62014fc8912befc019229c008f750a5059d5f83687b04854971914280c0adb"),
    artifact("onnx/model_quantized.onnx", 563_568_622, "69696107398fa52aad80bd38ca4a3972cf6e8293d2e1883231fcf7228fcb1c21", "model.onnx"),
    artifact("special_tokens_map.json", 964, "8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835"),
    artifact("tokenizer.json", 17_082_734, "3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20"),
    artifact("tokenizer_config.json", 1_182, "06b31b8051d8fe3486a7242fa1039d41ca9d5b69ad314dbf97df4b2ace7621d0"),
  ]),
});

/**
 * Pinned optional Jina v5 Text Nano embedding (retrieval adapter merged into the
 * weights). EuroBERT-210m encoder, 12 layers, last-token pooling; the ONNX graph
 * already emits the normalized `sentence_embedding`. Queries and documents are
 * told apart by the published text prefixes, not by task ids as in v3. The
 * upstream repository publishes the quantized export itself, so artifacts and
 * runtime identity come from the same revision.
 */
export const JINA_V5_NANO_EMBEDDING_PROFILE = Object.freeze({
  role: "embedding",
  runtime: "jina-v5",
  model: "jinaai/jina-embeddings-v5-text-nano-retrieval",
  revision: "ac5d898c8d382b17167c33e5c8af644a3519b47d",
  dtype: "q8",
  outputDimensions: 768,
  matryoshkaDimensions: Object.freeze([32, 64, 128, 256, 512, 768]),
  queryPrefix: "Query: ",
  passagePrefix: "Document: ",
  license: "CC-BY-NC-4.0",
  commercialUse: false,
  artifacts: Object.freeze([
    artifact("config.json", 1_361, "367857e3a726df6f1997bcb8443a4351e68b29c65f996e5874a4b3e7c5661a16"),
    artifact("onnx/model_quantized.onnx", 131_365, "ac93a7417c216e5076e37da2b3599f7ef16513934098a477680440c09f735a08"),
    artifact("onnx/model_quantized.onnx_data", 247_006_208, "ee7870eb143a7353be08b33f79992a51de3e32b41f684ccd82953a710c2f2f9c"),
    artifact("tokenizer.json", 17_210_235, "98d4a1d32152d6cedf85b5e88f3b205106dca1fe72aaab34e0ac13c238421069"),
    artifact("tokenizer_config.json", 487, "6c4640d432db970b2436a4386d3ee992b99e756b62c37446c3f581c8d09cbb05"),
  ]),
});

export const JINA_RERANKER_PROFILE = Object.freeze({
  role: "reranker",
  model: "jinaai/jina-reranker-v2-base-multilingual",
  revision: "9cfeff2df7d40d1b78e75e5e9cebec92a99813c9",
  artifacts: Object.freeze([
    artifact("config.json", 1_102, "af16fe07e9b623d5a47b42bde0daba1b6510344212c03363145c51a81e9e4572"),
    artifact("onnx/model_quantized.onnx", 279_577_152, "c5220cf8fe023f8aa0ed2a3eb787d4451a7f17cf53f6b787e35718dd4b8815c3"),
    artifact("tokenizer.json", 17_082_734, "3a56def25aa40facc030ea8b0b87f3688e4b3c39eb8b45d5702b3a1300fe2a20"),
    artifact("tokenizer_config.json", 1_148, "4bf8eb7ce5367af6f7bcef4bef6fa5945c345ee5a7ecbe6464712a7d96f98015"),
  ]),
});

export const BGE_RERANKER_PROFILE = Object.freeze({
  role: "reranker",
  model: "woxpas-ai/bge-reranker-v2-m3-onnx",
  revision: "c44ebc43de724ae8816668bb44d2e728e17faa18",
  artifacts: Object.freeze([
    artifact("config.json", 820, "36282ea6f54579cb2fdb2c64718407ac0c26fde2f9e87e51a6588c48425f8350"),
    artifact("onnx/model_quantized.onnx", 569_986_762, "1ed01a24f6e639dbd0a18e74e47b394abb78e6adb13dd23f34f94a79623fb3d3"),
    artifact("tokenizer.json", 17_082_900, "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3"),
    artifact("tokenizer_config.json", 1_203, "b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80"),
  ]),
});

const PINNED_PROFILES = new Map([
  [E5_EMBEDDING_PROFILE.model, E5_EMBEDDING_PROFILE],
  [JINA_EMBEDDING_PROFILE.model, JINA_EMBEDDING_PROFILE],
  [JINA_V5_NANO_EMBEDDING_PROFILE.model, JINA_V5_NANO_EMBEDDING_PROFILE],
  [JINA_RERANKER_PROFILE.model, JINA_RERANKER_PROFILE],
  [BGE_RERANKER_PROFILE.model, BGE_RERANKER_PROFILE],
]);

const embeddingPreparationTarget = (id, profile, dimensions) => Object.freeze({
  id,
  model: profile.model,
  revision: profile.revision,
  dimensions,
  artifactBytes: profile.artifacts.reduce((sum, entry) => sum + entry.size, 0),
  artifacts: profile.artifacts.length,
  ...(profile.license ? { license: profile.license } : {}),
  ...(profile.commercialUse === false ? { commercialUse: false } : {}),
});

/** Closed catalog exposed by OpenClaw config for automatic local embedding preparation. */
export const EMBEDDING_PREPARATION_TARGETS = Object.freeze([
  embeddingPreparationTarget("e5-multilingual-384", E5_EMBEDDING_PROFILE, 384),
  ...JINA_EMBEDDING_PROFILE.matryoshkaDimensions.map((dimensions) => embeddingPreparationTarget(
    `jina-v3-multilingual-${dimensions}`,
    JINA_EMBEDDING_PROFILE,
    dimensions,
  )),
  ...JINA_V5_NANO_EMBEDDING_PROFILE.matryoshkaDimensions.map((dimensions) => embeddingPreparationTarget(
    `jina-v5-nano-${dimensions}`,
    JINA_V5_NANO_EMBEDDING_PROFILE,
    dimensions,
  )),
]);

const EMBEDDING_PREPARATION_TARGETS_BY_ID = new Map(
  EMBEDDING_PREPARATION_TARGETS.map((entry) => [entry.id, entry]),
);

/** Enforce explicit acknowledgement before a non-commercial model can load or download.
 * @param {object} profile Pinned local model profile.
 * @param {boolean} accepted Whether the operator explicitly accepted the declared license.
 * @returns {void}
 */
export function assertPinnedModelLicenseAccepted(profile, accepted) {
  if (profile?.commercialUse !== false) return;
  if (accepted === true) return;
  const error = new Error(
    `${profile.model} requires explicit acknowledgement of ${profile.license || "its non-commercial license"} before download or use`,
  );
  error.code = "non_commercial_license_acknowledgement_required";
  throw error;
}

/** Return the immutable artifact profile for a known local model.
 * @param {string} model Logical model identifier.
 * @returns {object|null} Pinned profile or null for an unknown model.
 */
export function pinnedLocalModelProfile(model) {
  return PINNED_PROFILES.get(model) || null;
}

/** Resolve one immutable model/dimension preparation target by its config id.
 * @param {string} id Closed preparation-profile identifier.
 * @returns {object|null} Pinned target or null for an unknown id.
 */
export function localEmbeddingPreparationTarget(id) {
  return EMBEDDING_PREPARATION_TARGETS_BY_ID.get(id) || null;
}

/** Resolve the revision-scoped Transformers.js cache directory for a profile.
 * @param {string} cacheDir Trusted local cache root.
 * @param {object} profile Pinned local model profile.
 * @returns {string} Contained revision directory.
 */
export function modelCacheRevisionDir(cacheDir, profile) {
  if (!profile || typeof profile.model !== "string" || typeof profile.revision !== "string") {
    throw new Error("invalid pinned local model profile");
  }
  return resolveInside(cacheDir, ...profile.model.split("/"), profile.revision);
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("local model artifact operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function sha256File(path, { signal } = {}) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  const stop = () => stream.destroy(abortError(signal));
  signal?.addEventListener("abort", stop, { once: true });
  try {
    throwIfAborted(signal);
    for await (const chunk of stream) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
    throwIfAborted(signal);
    return hash.digest("hex");
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

async function inspectArtifact(path, expected, { signal } = {}) {
  try {
    throwIfAborted(signal);
    const info = await stat(path);
    throwIfAborted(signal);
    if (!info.isFile() || info.size !== expected.size) {
      return { ok: false, reason: "size", size: info.size };
    }
    const sha256 = await sha256File(path, { signal });
    return sha256 === expected.sha256
      ? { ok: true, size: info.size, sha256 }
      : { ok: false, reason: "sha256", size: info.size, sha256 };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, reason: "missing" };
    throw error;
  }
}

function artifactTarget(cacheDir, profile, expected) {
  return resolveInside(
    cacheDir,
    ...profile.model.split("/"),
    profile.revision,
    ...expected.path.split("/"),
  );
}

function artifactUrl(profile, expected) {
  const repository = profile.artifactRepository || profile.model;
  const revision = profile.artifactRevision || profile.revision;
  const path = (expected.sourcePath || expected.path).split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repository}/resolve/${revision}/${path}`;
}

async function downloadArtifact(profile, expected, target, {
  fetchImpl,
  logger,
  onChunk,
  signal,
}) {
  const response = await fetchImpl(artifactUrl(profile, expected), { redirect: "follow", signal });
  let partial = null;
  let handle;
  try {
    if (!response?.ok || !response.body) {
      throw new Error(
        `local model artifact HTTP ${response?.status ?? "error"} for ${profile.model} ${expected.path}`,
      );
    }
    const contentLength = response.headers?.get?.("content-length");
    if (typeof contentLength === "string" && /^\d+$/.test(contentLength)) {
      const declaredBytes = BigInt(contentLength);
      if (declaredBytes > BigInt(expected.size)) {
        throw new Error(
          `local model artifact Content-Length exceeds expected size for ${profile.model} ${expected.path}`,
        );
      }
    }
    throwIfAborted(signal);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    partial = resolveInside(
      dirname(target),
      `${basename(target)}.part-${process.pid}-${randomUUID()}`,
    );
    handle = await open(partial, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const rawChunk of response.body) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (size + chunk.length > expected.size) {
        throw new Error(
          `local model artifact stream exceeds expected size for ${profile.model} ${expected.path}`,
        );
      }
      await handle.write(chunk);
      hash.update(chunk);
      size += chunk.length;
      await onChunk?.(size);
    }
    throwIfAborted(signal);
    await handle.sync();
    await handle.close();
    handle = null;
    if (size !== expected.size) {
      throw new Error(
        `local model artifact size mismatch for ${profile.model} ${expected.path}: expected ${expected.size}, got ${size}`,
      );
    }
    const sha256 = hash.digest("hex");
    if (sha256 !== expected.sha256) {
      throw new Error(
        `local model artifact SHA-256 mismatch for ${profile.model} ${expected.path}`,
      );
    }
    await rename(partial, target);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        safeWarn(logger, "local-model-artifact.close", closeError, { model: profile.model, artifact: expected.path });
      }
    }
    if (partial) {
      try {
        await unlink(partial);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") {
          safeWarn(logger, "local-model-artifact.cleanup", cleanupError, { model: profile.model, artifact: expected.path });
        }
      }
    }
    if (typeof response?.body?.cancel === "function") {
      try {
        await response.body.cancel(error);
      } catch (cancelError) {
        safeWarn(logger, "local-model-artifact.cancel", cancelError, { model: profile.model, artifact: expected.path });
      }
    }
    throw error;
  }
}

function sharedDownload(profile, expected, target, { fetchImpl, logger, observedEntry = null }) {
  let entry = observedEntry || artifactDownloads.get(target);
  let created = false;
  if (!entry) {
    created = true;
    const controller = new AbortController();
    entry = {
      controller,
      subscribers: new Map(),
      lastBytes: 0,
      settled: false,
      promise: null,
    };
    entry.promise = downloadArtifact(profile, expected, target, {
      fetchImpl,
      logger,
      signal: controller.signal,
      onChunk: async (artifactBytes) => {
        entry.lastBytes = artifactBytes;
        const subscribers = [...entry.subscribers.values()];
        const notifications = await Promise.allSettled(subscribers.map((subscriber) => (
          subscriber.onChunk?.(artifactBytes)
        )));
        notifications.forEach((notification, index) => {
          if (notification.status === "rejected") {
            subscribers[index].failProgress(notification.reason);
          }
        });
      },
    });
    const settle = () => {
      entry.settled = true;
      if (artifactDownloads.get(target) === entry) artifactDownloads.delete(target);
    };
    void entry.promise.then(settle, settle);
    artifactDownloads.set(target, entry);
  }
  return { entry, created };
}

function subscribeToDownload(entry, { signal, onChunk, created }) {
  throwIfAborted(signal);
  const subscriberId = Symbol("local-model-artifact-subscriber");
  return new Promise((resolve, reject) => {
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      signal?.removeEventListener("abort", onAbort);
      entry.subscribers.delete(subscriberId);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
      if (!entry.settled && entry.subscribers.size === 0) {
        entry.controller.abort(abortError(signal));
      }
    };
    const failProgress = (error) => {
      if (!active) return;
      cleanup();
      reject(error);
      if (!entry.settled && entry.subscribers.size === 0) {
        entry.controller.abort(error);
      }
    };
    entry.subscribers.set(subscriberId, { onChunk, failProgress });
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      () => {
        if (!active) return;
        cleanup();
        resolve({ created });
      },
      (error) => {
        if (!active) return;
        cleanup();
        reject(error);
      },
    );
    if (signal?.aborted) onAbort();
  });
}

/**
 * Validate every declared file without downloading or mutating the cache.
 * @param {object} profile Pinned local model profile.
 * @param {string} cacheDir Trusted local cache root.
 * @param {{signal?: AbortSignal}} [options] Cancellation options.
 * @returns {Promise<{ok: boolean, artifacts: Array<object>}>}
 */
export async function validatePinnedModelArtifacts(profile, cacheDir, { signal } = {}) {
  const artifacts = [];
  for (const expected of profile.artifacts) {
    throwIfAborted(signal);
    const path = artifactTarget(cacheDir, profile, expected);
    artifacts.push({ path, expected, ...await inspectArtifact(path, expected, { signal }) });
  }
  return { ok: artifacts.every((entry) => entry.ok), artifacts };
}

/**
 * Atomically materialize and verify every file for one immutable model revision.
 * @param {object} profile Pinned local model profile.
 * @param {string} cacheDir Trusted local cache root.
 * @param {object} [options] Fetch, progress, logging, and cancellation options.
 * @returns {Promise<{downloaded: number, reused: number, artifacts: string[], receipts: Array<object>}>}
 */
export async function ensurePinnedModelArtifacts(profile, cacheDir, {
  acceptNonCommercialLicense = false,
  fetchImpl = globalThis.fetch,
  logger,
  onProgress,
  signal,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("local model artifact fetch capability unavailable");
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new Error("local model artifact progress callback must be a function");
  }
  assertPinnedModelLicenseAccepted(profile, acceptNonCommercialLicense);
  throwIfAborted(signal);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  let downloaded = 0;
  let reused = 0;
  const artifacts = [];
  const receipts = [];
  const bytesTotal = profile.artifacts.reduce((sum, entry) => sum + entry.size, 0);
  let bytesCompleted = 0;
  let artifactsCompleted = 0;
  const emitProgress = async (state, expected, completed = bytesCompleted) => onProgress?.({
    state,
    artifact: expected.path,
    bytesCompleted: completed,
    bytesTotal,
    artifactsCompleted,
    artifactsTotal: profile.artifacts.length,
  });
  for (const expected of profile.artifacts) {
    throwIfAborted(signal);
    const target = artifactTarget(cacheDir, profile, expected);
    const current = await inspectArtifact(target, expected, { signal });
    if (current.ok) {
      reused += 1;
      bytesCompleted += expected.size;
      artifactsCompleted += 1;
      await emitProgress("reused", expected);
      receipts.push({ path: target, expected, ...current });
    } else {
      const completedBeforeArtifact = bytesCompleted;
      let observedEntry = artifactDownloads.get(target) || null;
      await emitProgress("downloading", expected);
      throwIfAborted(signal);
      observedEntry ||= artifactDownloads.get(target) || null;
      if (!observedEntry) {
        const publishedWhileWaiting = await inspectArtifact(target, expected, { signal });
        if (publishedWhileWaiting.ok) {
          reused += 1;
          bytesCompleted += expected.size;
          artifactsCompleted += 1;
          await emitProgress("reused", expected);
          receipts.push({ path: target, expected, ...publishedWhileWaiting });
          artifacts.push(target);
          continue;
        }
        observedEntry = artifactDownloads.get(target) || null;
      }
      const { entry, created } = sharedDownload(profile, expected, target, {
        fetchImpl,
        logger,
        observedEntry,
      });
      await subscribeToDownload(entry, {
        signal,
        created,
        onChunk: (artifactBytes) => emitProgress(
          "downloading",
          expected,
          completedBeforeArtifact + artifactBytes,
        ),
      });
      const verified = await inspectArtifact(target, expected, { signal });
      if (!verified.ok) {
        throw new Error(
          `local model artifact failed post-download validation for ${profile.model} ${expected.path}`,
        );
      }
      if (created) downloaded += 1;
      else reused += 1;
      bytesCompleted += expected.size;
      artifactsCompleted += 1;
      await emitProgress("verified", expected);
      receipts.push({ path: target, expected, ...verified });
    }
    artifacts.push(target);
  }
  return { downloaded, reused, artifacts, receipts };
}
