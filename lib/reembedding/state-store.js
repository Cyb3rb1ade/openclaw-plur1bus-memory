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
import { safeDebug } from "../safe-logging.js";

const SCHEMA_VERSION = 1;
const STATE_PARTS = Object.freeze(["control", "reembedding-state.json"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLAN_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const STATES = new Set([
  "planned",
  "confirmed",
  "running",
  "validating",
  "ready_to_switch",
  "switching",
  "completed",
  "failed",
  "rollback_planned",
  "rolling_back",
  "rolled_back",
]);
const TRANSITIONS = new Map([
  ["planned", new Set(["confirmed"])],
  ["confirmed", new Set(["running"])],
  ["running", new Set(["validating", "failed"])],
  ["validating", new Set(["ready_to_switch", "failed"])],
  ["ready_to_switch", new Set(["switching"])],
  ["switching", new Set(["completed", "failed"])],
  ["completed", new Set(["rollback_planned"])],
  ["rollback_planned", new Set(["rolling_back"])],
  ["rolling_back", new Set(["rolled_back", "failed"])],
]);
const TERMINAL_STATES = new Set(["completed", "failed", "rolled_back"]);
const EXPIRABLE_COORDINATOR_STATES = new Set([
  "planned",
  "confirmed",
  "running",
  "validating",
  "ready_to_switch",
]);
const EXPIRED_SUPERSESSION_ERROR = Object.freeze({ code: "expired_migration_superseded" });
const RECORD_FIELDS = new Set([
  "id",
  "state",
  "revision",
  "createdAt",
  "updatedAt",
  "planDigest",
  "confirmation",
  "source",
  "target",
  "cursor",
  "receipts",
  "error",
  "configRevision",
  "policyRevision",
]);
const FORBIDDEN_STATE_KEYS = new Set([
  "apikey",
  "token",
  "resolvedsecret",
  "secretvalue",
  "credentialvalue",
]);

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, migrations: {} };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateJsonValue(value, path = "migration") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`invalid migration state number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`invalid migration state value at ${path}`);
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_STATE_KEYS.has(normalized)) {
      throw new Error(`secret-bearing migration state field is forbidden at ${path}.${key}`);
    }
    validateJsonValue(child, `${path}.${key}`);
  }
}

function validateConfirmation(value, planDigest) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid migration confirmation");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "expiresAt,planDigest,schemaVersion,tokenHash") throw new Error("invalid migration confirmation fields");
  if (
    value.schemaVersion !== 1
    || value.planDigest !== planDigest
    || !/^[a-f0-9]{64}$/.test(value.tokenHash)
    || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= 0
  ) throw new Error("invalid migration confirmation");
  return structuredClone(value);
}

function validateRecord(raw, expectedId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid migration record");
  if (Object.keys(raw).some((key) => !RECORD_FIELDS.has(key))) throw new Error("invalid migration record field");
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id) || raw.id !== expectedId) throw new Error("invalid migration id");
  if (!STATES.has(raw.state)) throw new Error("invalid migration state");
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error("invalid migration revision");
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) throw new Error("invalid migration createdAt");
  if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) throw new Error("invalid migration updatedAt");
  if (typeof raw.planDigest !== "string" || !PLAN_DIGEST_RE.test(raw.planDigest)) throw new Error("invalid migration plan digest");
  validateJsonValue(raw);
  const output = structuredClone(raw);
  if (raw.confirmation !== undefined) output.confirmation = validateConfirmation(raw.confirmation, raw.planDigest);
  return output;
}

function validateState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid reembedding state");
  if (Object.keys(raw).sort().join(",") !== "migrations,revision,schemaVersion") {
    throw new Error("invalid reembedding state fields");
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported reembedding state schema");
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) throw new Error("invalid reembedding state revision");
  if (!raw.migrations || typeof raw.migrations !== "object" || Array.isArray(raw.migrations)) {
    throw new Error("invalid reembedding migrations");
  }
  const migrations = {};
  for (const [id, record] of Object.entries(raw.migrations)) migrations[id] = validateRecord(record, id);
  return { schemaVersion: SCHEMA_VERSION, revision: raw.revision, migrations };
}

function readState(statePath) {
  if (!existsSync(statePath)) return emptyState();
  try {
    return validateState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch (cause) {
    const error = new Error("malformed reembedding state");
    error.code = "reembedding_state_invalid";
    error.cause = cause;
    throw error;
  }
}

function writeStateAtomic(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(state), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, statePath);
    chmodSync(statePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function revisionConflict(expectedRevision, current) {
  const error = new Error(`reembedding revision conflict: expected ${expectedRevision}, current ${current.revision}`);
  error.code = "reembedding_revision_conflict";
  error.current = deepFreeze(structuredClone(current));
  return error;
}

/** Create the single-writer durable migration state store. */
export function createMigrationStateStore({ stateRoot, now = Date.now, logger = null } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("reembedding stateRoot is required");
  if (typeof now !== "function") throw new Error("reembedding now must be a function");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const statePath = resolveInside(stateRoot, ...STATE_PARTS);
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  let writeQueue = Promise.resolve();

  const enqueue = (work) => {
    const operation = writeQueue.then(work);
    writeQueue = operation.then(
      () => undefined,
      (error) => {
        safeDebug(logger, "reembedding-state.queue", error);
        return undefined;
      },
    );
    return operation;
  };
  const get = (id) => {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("invalid migration id");
    const record = readState(statePath).migrations[id];
    return record ? deepFreeze(structuredClone(record)) : null;
  };
  const list = () => deepFreeze(Object.values(readState(statePath).migrations)
    .map((record) => structuredClone(record))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));

  const create = (input) => enqueue(async () => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid migration record");
    if (input.state !== "planned") throw new Error("new migration must start planned");
    if (typeof input.id !== "string" || !ID_RE.test(input.id)) throw new Error("invalid migration id");
    const nowValue = now();
    const timestamp = new Date(nowValue).toISOString();
    const candidate = validateRecord({
      ...structuredClone(input),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }, input.id);
    const state = readState(statePath);
    if (state.migrations[input.id]) throw new Error("migration id already exists");
    const activeMigrations = Object.values(state.migrations)
      .filter((record) => !TERMINAL_STATES.has(record.state));
    const canRetire = (record) => EXPIRABLE_COORDINATOR_STATES.has(record.state)
      && Number.isSafeInteger(record.confirmation?.expiresAt)
      && nowValue >= record.confirmation.expiresAt;
    if (activeMigrations.some((record) => !canRetire(record))) {
      const error = new Error("another reembedding migration is active");
      error.code = "reembedding_active_conflict";
      throw error;
    }
    const migrations = { ...state.migrations };
    for (const current of activeMigrations) {
      migrations[current.id] = validateRecord({
        ...current,
        state: "failed",
        revision: current.revision + 1,
        updatedAt: timestamp,
        error: EXPIRED_SUPERSESSION_ERROR,
      }, current.id);
    }
    const next = {
      schemaVersion: SCHEMA_VERSION,
      revision: state.revision + 1,
      migrations: { ...migrations, [input.id]: candidate },
    };
    writeStateAtomic(statePath, next);
    return deepFreeze(structuredClone(candidate));
  });

  const update = (id, { expectedRevision, expectedState, patch = {} } = {}) => enqueue(async () => {
    if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("invalid migration id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("invalid expected migration revision");
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("invalid migration patch");
    for (const key of Object.keys(patch)) {
      if (!RECORD_FIELDS.has(key) || ["id", "state", "revision", "createdAt", "updatedAt", "planDigest"].includes(key)) {
        throw new Error(`invalid migration patch field: ${key}`);
      }
    }
    validateJsonValue(patch);
    const state = readState(statePath);
    const current = state.migrations[id];
    if (!current) throw new Error("migration not found");
    if (current.revision !== expectedRevision) throw revisionConflict(expectedRevision, current);
    if (expectedState !== undefined && current.state !== expectedState) throw new Error("unexpected migration state");
    const candidate = validateRecord({
      ...current,
      ...structuredClone(patch),
      revision: current.revision + 1,
      updatedAt: new Date(now()).toISOString(),
    }, id);
    writeStateAtomic(statePath, {
      schemaVersion: SCHEMA_VERSION,
      revision: state.revision + 1,
      migrations: { ...state.migrations, [id]: candidate },
    });
    return deepFreeze(structuredClone(candidate));
  });

  const transition = (id, fromState, toState, { expectedRevision, patch = {} } = {}) => enqueue(async () => {
    if (!TRANSITIONS.get(fromState)?.has(toState)) {
      throw new Error(`invalid migration transition: ${fromState} -> ${toState}`);
    }
    const state = readState(statePath);
    const current = state.migrations[id];
    if (!current) throw new Error("migration not found");
    if (current.revision !== expectedRevision) throw revisionConflict(expectedRevision, current);
    if (current.state !== fromState) throw new Error(`unexpected migration state: ${current.state}`);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("invalid migration patch");
    for (const key of Object.keys(patch)) {
      if (!RECORD_FIELDS.has(key) || ["id", "state", "revision", "createdAt", "updatedAt", "planDigest"].includes(key)) {
        throw new Error(`invalid migration patch field: ${key}`);
      }
    }
    validateJsonValue(patch);
    const candidate = validateRecord({
      ...current,
      ...structuredClone(patch),
      state: toState,
      revision: current.revision + 1,
      updatedAt: new Date(now()).toISOString(),
    }, id);
    writeStateAtomic(statePath, {
      schemaVersion: SCHEMA_VERSION,
      revision: state.revision + 1,
      migrations: { ...state.migrations, [id]: candidate },
    });
    return deepFreeze(structuredClone(candidate));
  });

  return Object.freeze({ statePath, get, list, create, update, transition });
}
