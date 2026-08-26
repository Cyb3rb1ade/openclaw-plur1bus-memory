import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { safeWarn } from "../safe-logging.js";
import { resolveInside } from "../sql-safety.js";

const artifact = (path, size, sha256) => Object.freeze({ path, size, sha256 });

export const E5_EMBEDDING_PROFILE = Object.freeze({
  model: "intfloat/multilingual-e5-small",
  revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
  artifacts: Object.freeze([
    artifact("config.json", 655, "69137736cab8b8903a07fe8afaafdda25aac55415a12a55d1bffa9f581abf959"),
    artifact("onnx/model.onnx", 470_268_510, "ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665"),
    artifact("tokenizer.json", 17_082_730, "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39"),
    artifact("tokenizer_config.json", 443, "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b"),
  ]),
});

export const JINA_RERANKER_PROFILE = Object.freeze({
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
  [JINA_RERANKER_PROFILE.model, JINA_RERANKER_PROFILE],
  [BGE_RERANKER_PROFILE.model, BGE_RERANKER_PROFILE],
]);

/** Return the immutable artifact profile for a known local model. */
export function pinnedLocalModelProfile(model) {
  return PINNED_PROFILES.get(model) || null;
}

/** Resolve the revision-scoped Transformers.js cache directory for a profile. */
export function modelCacheRevisionDir(cacheDir, profile) {
  if (!profile || typeof profile.model !== "string" || typeof profile.revision !== "string") {
    throw new Error("invalid pinned local model profile");
  }
  return resolveInside(cacheDir, ...profile.model.split("/"), profile.revision);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function inspectArtifact(path, expected) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== expected.size) {
      return { ok: false, reason: "size", size: info.size };
    }
    const sha256 = await sha256File(path);
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
  const path = expected.path.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${profile.model}/resolve/${profile.revision}/${path}`;
}

async function downloadArtifact(profile, expected, target, { fetchImpl, logger }) {
  const response = await fetchImpl(artifactUrl(profile, expected), { redirect: "follow" });
  if (!response?.ok || !response.body) {
    throw new Error(
      `local model artifact HTTP ${response?.status ?? "error"} for ${profile.model} ${expected.path}`,
    );
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const partial = resolveInside(
    dirname(target),
    `${basename(target)}.part-${process.pid}-${randomUUID()}`,
  );
  let handle;
  try {
    handle = await open(partial, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const rawChunk of response.body) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      await handle.write(chunk);
      hash.update(chunk);
      size += chunk.length;
    }
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
    try {
      await unlink(partial);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") {
        safeWarn(logger, "local-model-artifact.cleanup", cleanupError, { model: profile.model, artifact: expected.path });
      }
    }
    throw error;
  }
}

/**
 * Validate every declared file without downloading or mutating the cache.
 * @returns {Promise<{ok: boolean, artifacts: Array<object>}>}
 */
export async function validatePinnedModelArtifacts(profile, cacheDir) {
  const artifacts = [];
  for (const expected of profile.artifacts) {
    const path = artifactTarget(cacheDir, profile, expected);
    artifacts.push({ path, expected, ...await inspectArtifact(path, expected) });
  }
  return { ok: artifacts.every((entry) => entry.ok), artifacts };
}

/**
 * Atomically materialize and verify every file for one immutable model revision.
 * @returns {Promise<{downloaded: number, reused: number, artifacts: string[]}>}
 */
export async function ensurePinnedModelArtifacts(profile, cacheDir, {
  fetchImpl = globalThis.fetch,
  logger,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("local model artifact fetch capability unavailable");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  let downloaded = 0;
  let reused = 0;
  const artifacts = [];
  for (const expected of profile.artifacts) {
    const target = artifactTarget(cacheDir, profile, expected);
    const current = await inspectArtifact(target, expected);
    if (current.ok) {
      reused += 1;
    } else {
      await downloadArtifact(profile, expected, target, { fetchImpl, logger });
      const verified = await inspectArtifact(target, expected);
      if (!verified.ok) {
        throw new Error(
          `local model artifact failed post-download validation for ${profile.model} ${expected.path}`,
        );
      }
      downloaded += 1;
    }
    artifacts.push(target);
  }
  return { downloaded, reused, artifacts };
}
