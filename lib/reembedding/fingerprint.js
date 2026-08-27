import { createHash } from "node:crypto";

const SCHEMA_VERSION = 1;
const CONFIG_FIELDS = new Set([
  "provider",
  "model",
  "revision",
  "dimensions",
  "endpoint",
  "baseUrl",
  "queryPrefix",
  "passagePrefix",
  "pooling",
  "normalize",
  "dtype",
]);
const CREDENTIAL_FIELDS = new Set(["apiKey", "apiKeyEnv", "credentialGeneration"]);
const RECORD_FIELDS = new Set(["schemaVersion", ...CONFIG_FIELDS, "artifacts"]);
const MOVING_REVISIONS = new Set(["main", "master", "latest", "dev", "beta", "nightly"]);
const SHA256_RE = /^[a-f0-9]{64}$/;

function nonEmptyString(value, label, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`invalid embedding fingerprint ${label}`);
  return value.trim();
}

function normalizeEndpoint(value) {
  if (value === undefined || value === null || value === "") return undefined;
  let endpoint;
  try {
    endpoint = new URL(String(value));
  } catch {
    throw new Error("invalid embedding fingerprint endpoint");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("invalid embedding fingerprint endpoint protocol");
  }
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.href;
}

function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error("embedding fingerprint artifacts must be an array");
  const normalized = artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error("invalid embedding fingerprint artifact");
    }
    const keys = Object.keys(artifact).sort();
    if (keys.length !== 2 || keys[0] !== "path" || keys[1] !== "sha256") {
      throw new Error("invalid embedding fingerprint artifact fields");
    }
    const path = nonEmptyString(artifact.path, "artifact path");
    if (path.startsWith("/") || path.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("invalid embedding fingerprint artifact path");
    }
    const sha256 = nonEmptyString(artifact.sha256, "artifact sha256").toLowerCase();
    if (!SHA256_RE.test(sha256)) throw new Error("invalid embedding fingerprint artifact sha256");
    return Object.freeze({ path, sha256 });
  });
  normalized.sort((left, right) => left.path.localeCompare(right.path) || left.sha256.localeCompare(right.sha256));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new Error("duplicate embedding fingerprint artifact path");
    }
  }
  return Object.freeze(normalized);
}

function canonicalRecord(config, artifacts) {
  const provider = nonEmptyString(config.provider, "provider");
  const model = nonEmptyString(config.model, "model");
  const revision = nonEmptyString(config.revision, "revision", { optional: true });
  if (revision && MOVING_REVISIONS.has(revision.toLowerCase())) {
    throw new Error("embedding fingerprint requires an immutable revision");
  }
  if (!Number.isSafeInteger(config.dimensions) || config.dimensions <= 0) {
    throw new Error("invalid embedding fingerprint dimensions");
  }
  const endpoint = normalizeEndpoint(config.endpoint ?? config.baseUrl);
  const output = {
    schemaVersion: SCHEMA_VERSION,
    provider,
    model,
    ...(revision ? { revision } : {}),
    dimensions: config.dimensions,
    ...(endpoint ? { endpoint } : {}),
    ...(config.queryPrefix !== undefined ? { queryPrefix: nonEmptyString(config.queryPrefix, "queryPrefix") } : {}),
    ...(config.passagePrefix !== undefined ? { passagePrefix: nonEmptyString(config.passagePrefix, "passagePrefix") } : {}),
    ...(config.pooling !== undefined ? { pooling: nonEmptyString(config.pooling, "pooling") } : {}),
    ...(config.normalize !== undefined ? { normalize: config.normalize === true } : {}),
    ...(config.dtype !== undefined ? { dtype: nonEmptyString(config.dtype, "dtype") } : {}),
    artifacts: normalizeArtifacts(artifacts),
  };
  return Object.freeze(output);
}

/** Normalize every vector-space input into a closed immutable fingerprint. */
export function normalizeEmbeddingFingerprint(config = {}, artifactIdentities = []) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("embedding fingerprint config must be an object");
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_FIELDS.has(key) && !CREDENTIAL_FIELDS.has(key)) {
      throw new Error(`unknown embedding fingerprint field: ${key}`);
    }
  }
  return canonicalRecord(config, artifactIdentities);
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("embedding fingerprint must be an object");
  }
  for (const key of Object.keys(record)) {
    if (!RECORD_FIELDS.has(key) && !CREDENTIAL_FIELDS.has(key)) {
      throw new Error(`unknown embedding fingerprint field: ${key}`);
    }
  }
  if (record.schemaVersion !== undefined && record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error("unsupported embedding fingerprint schema version");
  }
  return canonicalRecord(record, record.artifacts || []);
}

/** Return the schema-prefixed SHA-256 identity of a canonical fingerprint. */
export function embeddingFingerprintId(fingerprint) {
  const canonical = normalizeRecord(fingerprint);
  return `embedding:v${SCHEMA_VERSION}:sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** Compare two fingerprints without considering credential rotation metadata. */
export function compareEmbeddingFingerprints(left, right) {
  const leftFingerprint = normalizeRecord(left);
  const rightFingerprint = normalizeRecord(right);
  const leftId = embeddingFingerprintId(leftFingerprint);
  const rightId = embeddingFingerprintId(rightFingerprint);
  return Object.freeze({
    equal: leftId === rightId,
    requiresMigration: leftId !== rightId,
    leftId,
    rightId,
  });
}
