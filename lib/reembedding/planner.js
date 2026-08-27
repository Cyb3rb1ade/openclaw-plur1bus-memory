import { createHash } from "node:crypto";

import { createMigrationConfirmation } from "./confirmation.js";
import {
  compareEmbeddingFingerprints,
  embeddingFingerprintId,
} from "./fingerprint.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

function migrationId(value, label) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new Error(`invalid reembedding ${label}`);
  return value;
}

function tableId(value) {
  if (
    typeof value !== "string"
    || value.length > 512
    || value.split("/").some((segment) => !ID_RE.test(segment))
  ) throw new Error("invalid reembedding table id");
  return value;
}

function normalizeSecretRef(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid target SecretRef");
  if (Object.keys(value).sort().join(",") !== "id,provider,source") throw new Error("invalid target SecretRef fields");
  if (!["env", "store", "file", "exec"].includes(value.source)) throw new Error("invalid target SecretRef source");
  if (typeof value.provider !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.provider)) {
    throw new Error("invalid target SecretRef provider");
  }
  if (typeof value.id !== "string" || !value.id || value.id.length > 256) throw new Error("invalid target SecretRef id");
  return Object.freeze({ source: value.source, provider: value.provider, id: value.id });
}

function normalizeTable(table, sourceDimensions) {
  if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error("invalid source table inventory");
  const normalizedTableId = tableId(table.tableId);
  const version = typeof table.version === "string" && table.version ? table.version : null;
  if (!version) throw new Error("source table version is required");
  if (!Number.isSafeInteger(table.rowCount) || table.rowCount < 0) throw new Error("invalid source table row count");
  if (!Number.isSafeInteger(table.estimatedBytes) || table.estimatedBytes < 0) throw new Error("invalid source table byte estimate");
  if (table.dimensions !== undefined && table.dimensions !== sourceDimensions) {
    throw new Error(`source table dimension mismatch: ${normalizedTableId}`);
  }
  return Object.freeze({ tableId: normalizedTableId, version, rowCount: table.rowCount, estimatedBytes: table.estimatedBytes });
}

function validateProbeVector(value, dimensions) {
  const vector = ArrayBuffer.isView(value) ? Array.from(value) : value;
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new Error(`target provider probe dimension mismatch: expected ${dimensions}`);
  }
  if (vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("target provider probe returned a non-finite vector");
  }
}

function digestPlan(plan) {
  return `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Build a hash-bound plan without writing a source or target generation. */
export async function createReembeddingPlan(request = {}, dependencies = {}) {
  const id = migrationId(request.id, "migration id");
  const targetGeneration = migrationId(request.targetGeneration || `generation-${id}`, "target generation");
  if (!request.target || typeof request.target !== "object" || !request.target.fingerprint) {
    throw new Error("target embedding fingerprint is required");
  }
  for (const name of ["inventoryActiveGeneration", "statDisk", "probeTargetProvider"]) {
    if (typeof dependencies[name] !== "function") throw new Error(`reembedding planner dependency unavailable: ${name}`);
  }
  const now = typeof dependencies.now === "function" ? dependencies.now : Date.now;
  const nowValue = now();
  if (!Number.isSafeInteger(nowValue) || nowValue < 0) throw new Error("invalid reembedding planner clock");

  const generations = await dependencies.inventoryActiveGeneration();
  if (!Array.isArray(generations) || generations.length !== 1) {
    throw new Error("reembedding requires exactly one active generation");
  }
  const sourceRaw = generations[0];
  if (!sourceRaw || typeof sourceRaw !== "object" || !sourceRaw.fingerprint) {
    throw new Error("invalid active generation inventory");
  }
  const sourceGeneration = migrationId(sourceRaw.generation, "source generation");
  if (sourceGeneration === targetGeneration) throw new Error("target generation must differ from the active generation");
  const comparison = compareEmbeddingFingerprints(sourceRaw.fingerprint, request.target.fingerprint);
  if (!comparison.requiresMigration) throw new Error("reembedding plan does not change the embedding fingerprint");
  if (!Array.isArray(sourceRaw.tables)) throw new Error("invalid source table inventory");
  const tables = sourceRaw.tables.map((table) => normalizeTable(table, sourceRaw.fingerprint.dimensions));
  if (new Set(tables.map((table) => table.tableId)).size !== tables.length) throw new Error("duplicate source table inventory");

  const rows = tables.reduce((sum, table) => sum + table.rowCount, 0);
  const sourceBytes = tables.reduce((sum, table) => sum + table.estimatedBytes, 0);
  const vectorBytes = rows * request.target.fingerprint.dimensions * 4;
  const targetBytes = sourceBytes + vectorBytes;
  const requiredFreeBytes = Math.max(1, Math.ceil(targetBytes * 1.25));
  const disk = await dependencies.statDisk();
  if (!disk || !Number.isSafeInteger(disk.freeBytes) || disk.freeBytes < requiredFreeBytes) {
    throw new Error(`insufficient disk space for reembedding target generation (required ${requiredFreeBytes} bytes)`);
  }

  let probeStatus;
  if (request.target.fingerprint.provider === "local-transformers") {
    const artifactStatus = typeof dependencies.inspectTargetArtifacts === "function"
      ? await dependencies.inspectTargetArtifacts({ fingerprint: request.target.fingerprint })
      : { ready: false, verified: false };
    if (artifactStatus?.ready === true && artifactStatus?.verified === true) {
      validateProbeVector(
        await dependencies.probeTargetProvider({ target: request.target, purpose: "reembedding-plan" }),
        request.target.fingerprint.dimensions,
      );
      probeStatus = "passed";
    } else {
      probeStatus = "probe_deferred_local_artifact";
    }
  } else {
    validateProbeVector(
      await dependencies.probeTargetProvider({ target: request.target, purpose: "reembedding-plan" }),
      request.target.fingerprint.dimensions,
    );
    probeStatus = "passed";
  }

  const ttlMs = request.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60 * 1000) {
    throw new Error("invalid reembedding confirmation TTL");
  }
  const plan = deepFreeze({
    schemaVersion: 1,
    id,
    createdAt: new Date(nowValue).toISOString(),
    source: {
      generation: sourceGeneration,
      configRevision: typeof sourceRaw.configRevision === "string" ? sourceRaw.configRevision : null,
      fingerprintId: comparison.leftId,
      fingerprint: sourceRaw.fingerprint,
      tables,
    },
    target: {
      generation: targetGeneration,
      fingerprintId: comparison.rightId,
      fingerprint: request.target.fingerprint,
      ...(request.target.secretRef ? { secretRef: normalizeSecretRef(request.target.secretRef) } : {}),
      probeStatus,
    },
    estimates: {
      rows,
      providerCalls: rows,
      sourceBytes,
      targetBytes,
      requiredFreeBytes,
      freeBytes: disk.freeBytes,
    },
  });
  const planDigest = digestPlan(plan);
  const confirmation = createMigrationConfirmation({
    planDigest,
    expiresAt: nowValue + ttlMs,
    ...(dependencies.randomBytes ? { randomBytes: dependencies.randomBytes } : {}),
  });
  return deepFreeze({ plan, planDigest, confirmation });
}
