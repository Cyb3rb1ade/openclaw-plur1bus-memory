/** Durable, canonical per-agent/per-workspace PLUR1BUS enablement policy. */

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

import { normalizeWorkspaceTarget, validatedIdentity } from "./memory-request-context.js";
import { INPUT_LIMITS } from "./input-limits.js";
import { safeDebug } from "./safe-logging.js";
import { resolveInside, safeAgentId, safeTimestamp } from "./sql-safety.js";

const SCHEMA_VERSION = 1;
const POLICY_FILE_PARTS = Object.freeze(["control", "workspace-policy.json"]);

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, policies: {} };
}

function normalizePolicyIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workspace policy identity must be an object");
  }
  return Object.freeze({
    agentId: safeAgentId(value.agentId),
    workspaceIdentity: normalizeWorkspaceTarget(value.workspaceIdentity, "workspace identity"),
  });
}

function validateRevision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function validateRecord(raw, expectedKey) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid workspace policy record");
  const allowed = new Set(["agentId", "workspaceIdentity", "enabled", "revision", "updatedAt", "actorId"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) throw new Error("invalid workspace policy record field");
  const identity = normalizePolicyIdentity(raw);
  if (workspacePolicyKey(identity) !== expectedKey) throw new Error("workspace policy key mismatch");
  if (typeof raw.enabled !== "boolean") throw new Error("workspace policy enabled must be boolean");
  const actorId = validatedIdentity(raw.actorId, INPUT_LIMITS.PRINCIPAL, "workspace policy actor", { required: true });
  return Object.freeze({
    ...identity,
    enabled: raw.enabled,
    revision: validateRevision(raw.revision, "workspace policy revision"),
    updatedAt: safeTimestamp(raw.updatedAt),
    actorId,
  });
}

function validateState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid workspace policy state");
  const keys = Object.keys(raw).sort();
  if (keys.join(",") !== "policies,revision,schemaVersion") throw new Error("invalid workspace policy state fields");
  if (raw.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported workspace policy state schema");
  const revision = validateRevision(raw.revision, "workspace policy state revision");
  if (!raw.policies || typeof raw.policies !== "object" || Array.isArray(raw.policies)) {
    throw new Error("invalid workspace policy records");
  }
  const policies = {};
  for (const [key, record] of Object.entries(raw.policies)) policies[key] = validateRecord(record, key);
  return { schemaVersion: SCHEMA_VERSION, revision, policies };
}

function readState(statePath) {
  if (!existsSync(statePath)) return emptyState();
  try {
    return validateState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch (error) {
    const wrapped = new Error("malformed workspace policy state");
    wrapped.code = "workspace_policy_state_invalid";
    wrapped.cause = error;
    throw wrapped;
  }
}

function writeStateAtomic(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(tmpPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(state), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmpPath, statePath);
    chmodSync(statePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function externalRecord(record) {
  return Object.freeze({ ...record, source: "override" });
}

/**
 * Return the durable key for one canonical workspace policy tuple.
 * @param {{agentId: string, workspaceIdentity: string}} value Policy identity.
 * @returns {string} Canonical compound key.
 */
export function workspacePolicyKey(value) {
  const identity = normalizePolicyIdentity(value);
  return `${identity.agentId}\u0000${identity.workspaceIdentity}`;
}

/**
 * Create the durable workspace policy store for one PLUR1BUS state root.
 * @param {{stateRoot: string, now?: () => number, logger?: object}} options Store dependencies.
 * @returns {{get: Function, list: Function, set: Function}} Policy store.
 */
export function createWorkspacePolicyStore({ stateRoot, now = Date.now, logger = null } = {}) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0) throw new Error("workspace policy stateRoot is required");
  if (typeof now !== "function") throw new Error("workspace policy now must be a function");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const statePath = resolveInside(stateRoot, ...POLICY_FILE_PARTS);
  let writeQueue = Promise.resolve();

  const get = (value) => {
    const identity = normalizePolicyIdentity(value);
    const record = readState(statePath).policies[workspacePolicyKey(identity)];
    return record
      ? externalRecord(record)
      : Object.freeze({ ...identity, enabled: true, revision: 0, source: "default" });
  };

  const list = () => Object.freeze(
    Object.values(readState(statePath).policies)
      .map(externalRecord)
      .sort((left, right) => workspacePolicyKey(left).localeCompare(workspacePolicyKey(right))),
  );

  const set = (input) => {
    const operation = writeQueue.then(async () => {
      const identity = normalizePolicyIdentity(input);
      if (typeof input.enabled !== "boolean") throw new Error("workspace policy enabled must be boolean");
      const expectedRevision = validateRevision(input.expectedRevision, "expected workspace policy revision");
      const actorId = validatedIdentity(input.actorId, INPUT_LIMITS.PRINCIPAL, "workspace policy actor", { required: true });
      const state = readState(statePath);
      const key = workspacePolicyKey(identity);
      const currentRevision = state.policies[key]?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        const error = new Error(`workspace policy revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
        error.code = "workspace_policy_revision_conflict";
        error.current = state.policies[key]
          ? externalRecord(state.policies[key])
          : Object.freeze({ ...identity, enabled: true, revision: 0, source: "default" });
        throw error;
      }
      const record = {
        ...identity,
        enabled: input.enabled,
        revision: currentRevision + 1,
        updatedAt: safeTimestamp(now()),
        actorId,
      };
      const next = {
        schemaVersion: SCHEMA_VERSION,
        revision: state.revision + 1,
        policies: { ...state.policies, [key]: record },
      };
      writeStateAtomic(statePath, next);
      logger?.debug?.(`memory-lancedb-namespaced: workspace policy revision ${record.revision} stored`);
      return externalRecord(record);
    });
    writeQueue = operation.then(
      () => undefined,
      (error) => {
        safeDebug(logger, "workspace-policy.queue", error);
        return undefined;
      },
    );
    return operation;
  };

  return Object.freeze({ get, list, set });
}
