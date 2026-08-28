import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { resolveInside } from "../sql-safety.js";

const STATE_PARTS = Object.freeze(["control", "model-preparation.json"]);
const STATES = new Set(["blocked", "downloading", "validating", "ready", "failed", "interrupted"]);
const FIELDS = new Set([
  "schemaVersion",
  "revision",
  "state",
  "profileId",
  "model",
  "modelRevision",
  "dimensions",
  "license",
  "commercialUse",
  "bytesCompleted",
  "bytesTotal",
  "artifactsCompleted",
  "artifactsTotal",
  "activeFingerprintId",
  "targetFingerprintId",
  "reembedding",
  "errorCode",
  "startedAt",
  "updatedAt",
]);
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const FINGERPRINT_RE = /^embedding:v1:sha256:[a-f0-9]{64}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SUGGESTION_STATES = new Set(["not_required", "recommended", "empty_source", "blocked_insufficient_disk"]);
const NEXT_ACTIONS = new Set(["none", "plan_with_explicit_confirmation", "confirm_empty_generation_switch"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid model preparation ${label}`);
  return value;
}

function validateSuggestion(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid model preparation reembedding suggestion");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "freeBytes,nextAction,required,requiredFreeBytes,rows,status,targetBytes") {
    throw new Error("invalid model preparation reembedding suggestion fields");
  }
  if (typeof value.required !== "boolean" || !SUGGESTION_STATES.has(value.status)) {
    throw new Error("invalid model preparation reembedding suggestion state");
  }
  if (!NEXT_ACTIONS.has(value.nextAction)) throw new Error("invalid model preparation next action");
  for (const name of ["rows", "targetBytes", "requiredFreeBytes"]) safeInteger(value[name], name);
  if (value.freeBytes !== null) safeInteger(value.freeBytes, "freeBytes");
  return structuredClone(value);
}

function validateState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid model preparation state");
  if (Object.keys(raw).some((key) => !FIELDS.has(key))) throw new Error("invalid model preparation state field");
  if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1) {
    throw new Error("invalid model preparation state revision");
  }
  if (!STATES.has(raw.state) || typeof raw.profileId !== "string" || !PROFILE_RE.test(raw.profileId)) {
    throw new Error("invalid model preparation target state");
  }
  if (typeof raw.model !== "string" || !MODEL_RE.test(raw.model)) throw new Error("invalid model preparation model");
  if (typeof raw.modelRevision !== "string" || !REVISION_RE.test(raw.modelRevision)) {
    throw new Error("invalid model preparation model revision");
  }
  if (!Number.isSafeInteger(raw.dimensions) || raw.dimensions < 1) throw new Error("invalid model preparation dimensions");
  if (raw.license !== null && (typeof raw.license !== "string" || raw.license.length > 64)) {
    throw new Error("invalid model preparation license");
  }
  if (typeof raw.commercialUse !== "boolean") throw new Error("invalid model preparation commercial use flag");
  for (const name of ["bytesCompleted", "bytesTotal", "artifactsCompleted", "artifactsTotal"]) {
    safeInteger(raw[name], name);
  }
  if (raw.bytesCompleted > raw.bytesTotal || raw.artifactsCompleted > raw.artifactsTotal) {
    throw new Error("invalid model preparation progress bounds");
  }
  if (typeof raw.activeFingerprintId !== "string" || !FINGERPRINT_RE.test(raw.activeFingerprintId)) {
    throw new Error("invalid active embedding fingerprint id");
  }
  if (raw.targetFingerprintId !== null && (
    typeof raw.targetFingerprintId !== "string" || !FINGERPRINT_RE.test(raw.targetFingerprintId)
  )) throw new Error("invalid target embedding fingerprint id");
  if (raw.errorCode !== null && (typeof raw.errorCode !== "string" || !ERROR_CODE_RE.test(raw.errorCode))) {
    throw new Error("invalid model preparation error code");
  }
  if (!Number.isFinite(Date.parse(raw.startedAt)) || !Number.isFinite(Date.parse(raw.updatedAt))) {
    throw new Error("invalid model preparation timestamp");
  }
  return {
    ...structuredClone(raw),
    reembedding: validateSuggestion(raw.reembedding),
  };
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(value), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

/** Durable, secret-free state for one automatically prepared local embedding target.
 * @param {object} [options] State root and injectable clock.
 * @returns {{statePath: string, read: Function, write: Function}} Atomic state store.
 */
export function createModelPreparationStateStore({ stateRoot, now = Date.now } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("model preparation stateRoot is required");
  if (typeof now !== "function") throw new Error("model preparation clock is required");
  const statePath = resolveInside(stateRoot, ...STATE_PARTS);
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });

  const read = () => {
    if (!existsSync(statePath)) return null;
    try {
      return deepFreeze(validateState(JSON.parse(readFileSync(statePath, "utf8"))));
    } catch (cause) {
      const error = new Error("malformed model preparation state", { cause });
      error.code = "model_preparation_state_invalid";
      throw error;
    }
  };

  const write = (input) => {
    const current = read();
    const timestamp = new Date(now()).toISOString();
    const candidate = validateState({
      ...structuredClone(input),
      schemaVersion: 1,
      revision: (current?.revision || 0) + 1,
      updatedAt: timestamp,
      startedAt: input.startedAt || current?.startedAt || timestamp,
    });
    writeAtomic(statePath, candidate);
    return deepFreeze(structuredClone(candidate));
  };

  return Object.freeze({ statePath, read, write });
}
