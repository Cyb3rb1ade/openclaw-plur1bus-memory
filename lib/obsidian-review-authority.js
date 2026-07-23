/**
 * Protected Obsidian review authority.
 *
 * Vault artifacts are display-only. Authoritative payload, approval, and apply
 * state is stored below baseDbPath, partitioned by validated agent and the
 * collision-resistant canonical workspace key.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { workspacePoolKey } from "./memory-request-context.js";
import { assertMutationAllowed, OBSIDIAN_MUTATION_POLICY_KIND } from "./obsidian-mutation-policy.js";
import { resolveInside, safeAgentId, safeUuid } from "./sql-safety.js";

const AUTHORITY_VERSION = 1;
const BUNDLE_RE = /^rb-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function validatePolicyIdentity(policy) {
  if (!policy || policy.kind !== OBSIDIAN_MUTATION_POLICY_KIND || Object.isFrozen(policy) !== true) {
    throw new Error("Obsidian mutation policy required");
  }
  if (!policy.baseDbPath) throw new Error("Protected review authority requires baseDbPath");
  const agentId = safeAgentId(policy.agentId);
  const workspaceIdentity = String(policy.workspaceIdentity || "");
  if (!workspaceIdentity) throw new Error("Protected review authority requires workspace identity");
  return { agentId, workspaceIdentity };
}

function validateBundleId(bundleId) {
  const match = String(bundleId || "").match(BUNDLE_RE);
  if (!match) throw new Error("Invalid protected ReviewBundle ID");
  safeUuid(match[1]);
  return `rb-${match[1].toLowerCase()}`;
}

function authorityPaths(policy) {
  const { agentId, workspaceIdentity } = validatePolicyIdentity(policy);
  const baseDbPath = resolveInside(policy.baseDbPath);
  const workspaceKey = workspacePoolKey(workspaceIdentity);
  const root = resolveInside(
    baseDbPath,
    ".plur1bus-authority",
    "obsidian-review",
    agentId,
    workspaceKey,
  );
  const bundles = join(root, "bundles");
  return { baseDbPath, root, bundles, agentId, workspaceIdentity, workspaceKey };
}

function envelopeOwnedBy(envelope, paths) {
  return envelope?.authorityVersion === AUTHORITY_VERSION
    && envelope?.owner?.agentId === paths.agentId
    && envelope?.owner?.workspaceIdentity === paths.workspaceIdentity
    && envelope?.owner?.workspaceKey === paths.workspaceKey
    && envelope?.bundle?.bundleId === envelope?.bundleId;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temp, path);
}

function readEnvelope(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function recordPath(paths, bundleId) {
  return join(paths.bundles, `${validateBundleId(bundleId)}.json`);
}

/**
 * Create an authoritative review bundle owned by one exact agent/workspace.
 *
 * @param {{policy: object, bundle: object, bundleId?: string}} options
 * @returns {{bundleId: string, path: string, bundle: object}}
 */
export function createOwnedReviewBundle({ policy, bundle, bundleId = "" } = {}) {
  assertMutationAllowed(policy, "review_write");
  const paths = authorityPaths(policy);
  const id = bundleId ? validateBundleId(bundleId) : `rb-${randomUUID()}`;
  const path = recordPath(paths, id);
  if (existsSync(path)) throw new Error("Protected ReviewBundle already exists");
  const authoritativeBundle = {
    ...(bundle && typeof bundle === "object" ? bundle : {}),
    bundleId: id,
    createdByAgent: paths.agentId,
    workspaceIdentity: paths.workspaceIdentity,
  };
  const envelope = {
    authorityVersion: AUTHORITY_VERSION,
    bundleId: id,
    owner: {
      agentId: paths.agentId,
      workspaceIdentity: paths.workspaceIdentity,
      workspaceKey: paths.workspaceKey,
    },
    bundle: authoritativeBundle,
  };
  atomicWriteJson(path, envelope);
  return { bundleId: id, path, bundle: authoritativeBundle };
}

/**
 * Load only an exact owner-matching authoritative bundle.
 *
 * @param {{policy: object, bundleId: string}} options
 * @returns {object|null}
 */
export function loadOwnedReviewBundle({ policy, bundleId } = {}) {
  let paths;
  let path;
  try {
    paths = authorityPaths(policy);
    path = recordPath(paths, bundleId);
  } catch {
    return null;
  }
  const envelope = readEnvelope(path);
  if (!envelopeOwnedBy(envelope, paths)) return null;
  return envelope.bundle;
}

/**
 * Find the latest exact owner-matching authoritative bundle.
 *
 * @param {{policy: object, status?: string}} options
 * @returns {string}
 */
export function latestOwnedReviewBundleId({ policy, status = "" } = {}) {
  let paths;
  try {
    paths = authorityPaths(policy);
  } catch {
    return "";
  }
  if (!existsSync(paths.bundles)) return "";
  const candidates = [];
  for (const name of readdirSync(paths.bundles)) {
    if (!name.endsWith(".json")) continue;
    const path = join(paths.bundles, name);
    const envelope = readEnvelope(path);
    if (!envelopeOwnedBy(envelope, paths)) continue;
    if (status && envelope.bundle?.status !== status) continue;
    candidates.push({
      id: envelope.bundleId,
      createdAt: Date.parse(String(envelope.bundle?.createdAt || "")) || statSync(path).mtimeMs,
    });
  }
  candidates.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  return candidates[0]?.id || "";
}

/**
 * List authoritative bundles owned by one exact agent/workspace.
 *
 * @param {{policy: object, status?: string}} options
 * @returns {object[]}
 */
export function listOwnedReviewBundles({ policy, status = "" } = {}) {
  let paths;
  try {
    paths = authorityPaths(policy);
  } catch {
    return [];
  }
  if (!existsSync(paths.bundles)) return [];
  const bundles = [];
  for (const name of readdirSync(paths.bundles)) {
    if (!name.endsWith(".json")) continue;
    const envelope = readEnvelope(join(paths.bundles, name));
    if (!envelopeOwnedBy(envelope, paths)) continue;
    if (status && envelope.bundle?.bundle?.status !== status) continue;
    bundles.push(structuredClone(envelope.bundle));
  }
  return bundles;
}

/**
 * Atomically update an exact owner-matching authoritative bundle.
 *
 * @param {{policy: object, bundleId: string, update: Function}} options
 * @returns {object|null}
 */
export function updateOwnedReviewBundle({ policy, bundleId, update } = {}) {
  assertMutationAllowed(policy, "review_write");
  if (typeof update !== "function") throw new TypeError("Protected ReviewBundle update must be a function");
  const paths = authorityPaths(policy);
  const path = recordPath(paths, bundleId);
  const envelope = readEnvelope(path);
  if (!envelopeOwnedBy(envelope, paths)) return null;
  const next = update(structuredClone(envelope.bundle));
  if (!next || typeof next !== "object") throw new Error("Protected ReviewBundle update returned invalid state");
  const authoritativeBundle = {
    ...next,
    bundleId: envelope.bundleId,
    createdByAgent: paths.agentId,
    workspaceIdentity: paths.workspaceIdentity,
  };
  atomicWriteJson(path, { ...envelope, bundle: authoritativeBundle });
  return authoritativeBundle;
}
