import { compareEmbeddingFingerprints, embeddingFingerprintId } from "../reembedding/fingerprint.js";
import { embeddingFingerprintFromNormalizedConfig } from "../reembedding/runtime-config.js";
import { resolveEnvVars } from "../providers/env.js";
import {
  ensurePinnedModelArtifacts,
  localEmbeddingPreparationTarget,
  pinnedLocalModelProfile,
  validatePinnedModelArtifacts,
} from "../providers/local-model-artifacts.js";
import { safeWarn } from "../safe-logging.js";
import { createModelPreparationStateStore } from "./state-store.js";

const PROGRESS_BYTES_INTERVAL = 4 * 1024 * 1024;
const PROGRESS_TIME_INTERVAL_MS = 500;

function targetFingerprint(target, profile) {
  const queryPrefix = profile.queryPrefix ?? "query: ";
  const passagePrefix = profile.passagePrefix ?? "passage: ";
  return embeddingFingerprintFromNormalizedConfig({
    provider: "local-transformers",
    model: profile.model,
    dimensions: target.dimensions,
    local: {
      model: profile.model,
      dimensions: target.dimensions,
      revision: profile.revision,
      queryPrefix,
      passagePrefix,
    },
  });
}

function baseState(target, profile, activeFingerprintId) {
  return {
    state: "downloading",
    profileId: target.id,
    model: target.model,
    modelRevision: target.revision,
    dimensions: target.dimensions,
    license: target.license || null,
    commercialUse: target.commercialUse !== false,
    bytesCompleted: 0,
    bytesTotal: target.artifactBytes,
    artifactsCompleted: 0,
    artifactsTotal: profile.artifacts.length,
    activeFingerprintId,
    targetFingerprintId: null,
    reembedding: null,
    errorCode: null,
  };
}

function errorCode(error) {
  if ([
    "artifact_validation_failed",
    "generation_inventory_failed",
    "disk_status_unavailable",
    "model_preparation_initialization_failed",
  ].includes(error?.code)) return error.code;
  if (error?.name === "AbortError" || /aborted/i.test(String(error?.message))) {
    return "model_preparation_interrupted";
  }
  if (/validation|hash|sha-256|size mismatch/i.test(String(error?.message))) {
    return "artifact_validation_failed";
  }
  return "artifact_download_failed";
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error("model preparation aborted");
    error.name = "AbortError";
    throw error;
  }
}

function phaseError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function receiptsAreValid(receipts, profile) {
  return Array.isArray(receipts)
    && receipts.length === profile.artifacts.length
    && receipts.every((receipt, index) => (
      receipt?.ok === true
      && receipt.size === profile.artifacts[index].size
      && receipt.sha256 === profile.artifacts[index].sha256
      && receipt.expected?.path === profile.artifacts[index].path
    ));
}

async function buildSuggestion({ activeFingerprint, target, inventoryActiveGeneration, statDisk, signal }) {
  throwIfAborted(signal);
  const comparison = compareEmbeddingFingerprints(activeFingerprint, target);
  if (!comparison.requiresMigration) {
    return {
      required: false,
      status: "not_required",
      rows: 0,
      targetBytes: 0,
      requiredFreeBytes: 0,
      freeBytes: null,
      nextAction: "none",
    };
  }
  if (typeof inventoryActiveGeneration !== "function" || typeof statDisk !== "function") {
    throw phaseError(
      "generation_inventory_failed",
      "model preparation dry-run capabilities unavailable",
    );
  }
  let generations;
  try {
    generations = await inventoryActiveGeneration({ signal });
    throwIfAborted(signal);
  } catch (cause) {
    throwIfAborted(signal);
    throw phaseError("generation_inventory_failed", "model preparation generation inventory failed", cause);
  }
  if (!Array.isArray(generations) || generations.length !== 1 || !Array.isArray(generations[0]?.tables)) {
    throw phaseError(
      "generation_inventory_failed",
      "model preparation dry-run requires exactly one active generation",
    );
  }
  let rows = 0;
  let sourceBytes = 0;
  for (const table of generations[0].tables) {
    if (!Number.isSafeInteger(table?.rowCount) || table.rowCount < 0) {
      throw phaseError("generation_inventory_failed", "model preparation dry-run received an invalid row count");
    }
    if (!Number.isSafeInteger(table?.estimatedBytes) || table.estimatedBytes < 0) {
      throw phaseError("generation_inventory_failed", "model preparation dry-run received an invalid byte estimate");
    }
    rows += table.rowCount;
    sourceBytes += table.estimatedBytes;
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(sourceBytes)) {
      throw phaseError("generation_inventory_failed", "model preparation dry-run estimate exceeds safe integer bounds");
    }
  }
  const vectorBytes = rows * target.dimensions * 4;
  const targetBytes = sourceBytes + vectorBytes;
  if (!Number.isSafeInteger(vectorBytes) || !Number.isSafeInteger(targetBytes)) {
    throw phaseError("generation_inventory_failed", "model preparation target estimate exceeds safe integer bounds");
  }
  const requiredFreeBytes = Math.max(1, Math.ceil(targetBytes * 1.25));
  let disk;
  try {
    throwIfAborted(signal);
    disk = await statDisk({ signal });
    throwIfAborted(signal);
  } catch (cause) {
    throwIfAborted(signal);
    throw phaseError("disk_status_unavailable", "model preparation dry-run disk status unavailable", cause);
  }
  if (!Number.isSafeInteger(disk?.freeBytes) || disk.freeBytes < 0) {
    throw phaseError("disk_status_unavailable", "model preparation dry-run disk status unavailable");
  }
  if (rows === 0) {
    return {
      required: true,
      status: "empty_source",
      rows,
      targetBytes,
      requiredFreeBytes,
      freeBytes: disk.freeBytes,
      nextAction: "confirm_empty_generation_switch",
    };
  }
  return {
    required: true,
    status: disk.freeBytes < requiredFreeBytes ? "blocked_insufficient_disk" : "recommended",
    rows,
    targetBytes,
    requiredFreeBytes,
    freeBytes: disk.freeBytes,
    nextAction: "plan_with_explicit_confirmation",
  };
}

/** Prepare a selected immutable local model without mutating any memory generation.
 * @param {object} [options] Preparation dependencies and selected profile.
 * @returns {{start: Function, shutdown: Function, snapshot: Function}} Bounded lifecycle coordinator.
 */
export function createModelPreparationCoordinator({
  stateRoot,
  cacheDir,
  config = {},
  activeFingerprint,
  ensureArtifacts = ensurePinnedModelArtifacts,
  validateArtifacts = validatePinnedModelArtifacts,
  inventoryActiveGeneration,
  statDisk,
  fetchImpl = globalThis.fetch,
  logger,
  onState,
  now = Date.now,
} = {}) {
  const store = createModelPreparationStateStore({ stateRoot, now });
  if (!activeFingerprint || typeof activeFingerprint !== "object") {
    throw new Error("active embedding fingerprint is required for model preparation");
  }
  const activeFingerprintId = embeddingFingerprintId(activeFingerprint);
  const resolvedCacheDir = resolveEnvVars(cacheDir, {
    groups: ["localPath"],
    label: "model preparation cacheDir",
  });
  const target = localEmbeddingPreparationTarget(config.profile);
  if (!target) throw new Error("unknown local embedding preparation profile");
  const profile = pinnedLocalModelProfile(target.model);
  if (!profile || profile.role !== "embedding" || profile.revision !== target.revision) {
    throw new Error("local embedding preparation target is not pinned");
  }
  const initialState = baseState(target, profile, activeFingerprintId);
  let activeTask = null;
  let abortController = null;
  let shuttingDown = false;
  let volatileSnapshot = null;
  let snapshotReadWarningLogged = false;

  const write = (value) => {
    let snapshot;
    try {
      snapshot = store.write(value);
    } catch (error) {
      volatileSnapshot = Object.freeze({
        ...value,
        state: "failed",
        errorCode: "model_preparation_state_unavailable",
      });
      throw error;
    }
    volatileSnapshot = snapshot;
    onState?.(snapshot);
    return snapshot;
  };

  const snapshot = () => {
    try {
      return store.read() || volatileSnapshot;
    } catch (error) {
      if (!snapshotReadWarningLogged) {
        snapshotReadWarningLogged = true;
        safeWarn(logger, "model-preparation.state", error);
      }
      return volatileSnapshot || Object.freeze({
        ...initialState,
        state: "failed",
        errorCode: "model_preparation_state_unavailable",
      });
    }
  };

  const run = async () => {
    let state = initialState;
    if (target.commercialUse === false && config.acceptNonCommercialLicense !== true) {
      return write({
        ...state,
        state: "blocked",
        errorCode: "non_commercial_license_acknowledgement_required",
      });
    }
    state = write(state);
    abortController = new AbortController();
    let lastProgressBytes = 0;
    let lastProgressAt = now();
    try {
      const ensured = await ensureArtifacts(profile, resolvedCacheDir, {
        acceptNonCommercialLicense: config.acceptNonCommercialLicense === true,
        fetchImpl,
        logger,
        signal: abortController.signal,
        onProgress: async (progress) => {
          const currentTime = now();
          const terminalArtifactProgress = progress.state === "verified" || progress.state === "reused";
          if (
            !terminalArtifactProgress
            && progress.bytesCompleted - lastProgressBytes < PROGRESS_BYTES_INTERVAL
            && currentTime - lastProgressAt < PROGRESS_TIME_INTERVAL_MS
          ) return;
          lastProgressBytes = progress.bytesCompleted;
          lastProgressAt = currentTime;
          state = write({
            ...state,
            state: "downloading",
            bytesCompleted: progress.bytesCompleted,
            bytesTotal: progress.bytesTotal,
            artifactsCompleted: progress.artifactsCompleted,
            artifactsTotal: progress.artifactsTotal,
          });
        },
      });
      throwIfAborted(abortController.signal);
      state = write({
        ...state,
        state: "validating",
        bytesCompleted: target.artifactBytes,
        artifactsCompleted: profile.artifacts.length,
      });
      const validation = receiptsAreValid(ensured?.receipts, profile)
        ? { ok: true, artifacts: ensured.receipts }
        : await validateArtifacts(profile, resolvedCacheDir, { signal: abortController.signal });
      throwIfAborted(abortController.signal);
      if (validation?.ok !== true || validation.artifacts?.length !== profile.artifacts.length) {
        const validationError = new Error("local model artifact validation failed");
        validationError.code = "artifact_validation_failed";
        throw validationError;
      }
      const fingerprint = targetFingerprint(target, profile);
      const suggestion = await buildSuggestion({
        activeFingerprint,
        target: fingerprint,
        inventoryActiveGeneration,
        statDisk,
        signal: abortController.signal,
      });
      throwIfAborted(abortController.signal);
      return write({
        ...state,
        state: "ready",
        targetFingerprintId: embeddingFingerprintId(fingerprint),
        reembedding: suggestion,
        errorCode: null,
      });
    } catch (error) {
      const interrupted = shuttingDown || abortController.signal.aborted;
      safeWarn(logger, "model-preparation", error, { model: target.model, profile: target.id });
      return write({
        ...state,
        state: interrupted ? "interrupted" : "failed",
        errorCode: interrupted ? "model_preparation_interrupted" : errorCode(error),
      });
    } finally {
      abortController = null;
    }
  };

  const start = () => {
    if (shuttingDown) throw new Error("model preparation coordinator is shutting down");
    if (!activeTask) {
      const task = run().finally(() => {
        if (activeTask === task) activeTask = null;
      });
      activeTask = task;
    }
    return activeTask;
  };

  const shutdown = async () => {
    shuttingDown = true;
    abortController?.abort();
    if (activeTask) await activeTask;
  };

  return Object.freeze({ start, shutdown, snapshot });
}

/** Create a secret-free in-memory failure view when optional preparation cannot initialize.
 * @param {object} [options] Selected profile, active fingerprint, and stable failure code.
 * @returns {{start: Function, shutdown: Function, snapshot: Function}} In-memory failed coordinator.
 */
export function createFailedModelPreparationCoordinator({
  config = {},
  activeFingerprint,
  failureCode = "model_preparation_initialization_failed",
} = {}) {
  const target = localEmbeddingPreparationTarget(config.profile);
  const profile = target ? pinnedLocalModelProfile(target.model) : null;
  if (!target || !profile || !activeFingerprint) {
    throw new Error("failed model preparation view requires a valid target and active fingerprint");
  }
  const snapshot = Object.freeze({
    ...baseState(target, profile, embeddingFingerprintId(activeFingerprint)),
    state: "failed",
    errorCode: failureCode,
  });
  return Object.freeze({
    async start() { return snapshot; },
    async shutdown() {},
    snapshot: () => snapshot,
  });
}
