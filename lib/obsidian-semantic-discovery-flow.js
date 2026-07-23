/**
 * One-time, identity/scope/digest-bound Semantic Discovery confirmation flow.
 */

import { createHash, randomUUID } from "node:crypto";

import { checkAccess } from "./acl-middleware.js";
import { assertMutationAllowed } from "./obsidian-mutation-policy.js";
import { createConfirmation, validateConfirmation } from "./security.js";
import { saveLinkIndex } from "./obsidian/link-index.js";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function configBinding(rawConfig = {}) {
  return {
    vaultPath: String(rawConfig.vaultPath || ""),
    reviewRoot: String(rawConfig.reviewRoot || ""),
    graphLinks: rawConfig.graphLinks || {},
    baseDbPath: String(rawConfig.baseDbPath || rawConfig.lanceDbBasePath || ""),
  };
}

function identityBinding(memoryCtx = {}) {
  return {
    userId: String(memoryCtx.userId || ""),
    userPrincipal: String(memoryCtx.userPrincipal || ""),
    conversationPrincipal: String(memoryCtx.conversationPrincipal || memoryCtx.chatId || ""),
    agentId: String(memoryCtx.agentId || ""),
    workspaceIdentity: String(memoryCtx.workspaceIdentity || memoryCtx.workspaceId || ""),
  };
}

function authorized(memoryCtx, row) {
  try {
    return checkAccess(memoryCtx, row).allowed === true;
  } catch {
    return false;
  }
}

function normalizedSearchEntry(result) {
  return result?.entry && typeof result.entry === "object" ? result.entry : result;
}

function confirmationKey(callbackData) {
  const parts = String(callbackData || "").split(":");
  if (parts.length !== 4 || parts[0] !== "semantic-discovery" || parts[1] !== "confirm") return null;
  return { nonce: parts[2], targetId: parts[3], key: `${parts[2]}:${parts[3]}` };
}

/**
 * Resolve one full UUID nonce to its exact pending callback without consuming it.
 *
 * @param {Map<string, object>} confirmationStore
 * @param {string} nonce
 * @returns {string}
 */
export function semanticConfirmationCallbackForNonce(confirmationStore, nonce) {
  if (!(confirmationStore instanceof Map)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(nonce || ""))) {
    return "";
  }
  for (const pending of confirmationStore.values()) {
    if (pending?.command === "semantic-discovery" && pending?.nonce === nonce) {
      return pending.callbackData || "";
    }
  }
  return "";
}

/**
 * Compute an ACL-filtered in-memory discovery plan and create one pending
 * confirmation. This function performs no filesystem or external mutation.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function prepareSemanticDiscovery({
  rawConfig = {},
  memoryCtx,
  records = [],
  confirmationStore,
  searchSimilar,
  expiryMinutes = 10,
} = {}) {
  if (!(confirmationStore instanceof Map)) throw new TypeError("Semantic Discovery confirmationStore must be a Map");
  if (typeof searchSimilar !== "function") throw new TypeError("Semantic Discovery searchSimilar must be a function");
  const binding = identityBinding(memoryCtx);
  if (!binding.userId || !binding.conversationPrincipal || !binding.agentId || !binding.workspaceIdentity) {
    return { ok: false, reason: "identity_binding_required" };
  }
  const sourceRows = (Array.isArray(records) ? records : [])
    .filter((row) => row && row.id && Array.isArray(row.vector) && authorized(memoryCtx, row))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const authorizedById = new Map(sourceRows.map((row) => [String(row.id), row]));
  const maxLinks = Math.max(1, Number(rawConfig.graphLinks?.semanticDiscovery?.maxLinksPerRecord || 5));
  const entries = {};
  for (const source of sourceRows) {
    const results = await searchSimilar(source);
    const similar = [];
    for (const result of Array.isArray(results) ? results : []) {
      const neighbor = normalizedSearchEntry(result);
      if (!neighbor?.id || String(neighbor.id) === String(source.id)) continue;
      if (!authorized(memoryCtx, neighbor)) continue;
      if (!authorizedById.has(String(neighbor.id))) continue;
      if (!similar.includes(String(neighbor.id))) similar.push(String(neighbor.id));
      if (similar.length >= maxLinks) break;
    }
    entries[String(source.id)] = {
      similar,
      contentHash: digest({
        id: source.id,
        text: source.text || "",
        summary: source.summary || "",
      }),
    };
  }
  const plan = Object.freeze({
    version: 1,
    vaultPath: String(rawConfig.vaultPath || ""),
    sourceIds: Object.freeze(sourceRows.map((row) => String(row.id))),
    entries: Object.freeze(Object.fromEntries(
      Object.entries(entries).map(([id, entry]) => [id, Object.freeze({
        ...entry,
        similar: Object.freeze([...entry.similar]),
      })]),
    )),
    sourceRows: Object.freeze(sourceRows.map((row) => Object.freeze({ ...row, vector: Object.freeze([...row.vector]) }))),
  });
  const planId = randomUUID();
  const pending = createConfirmation({
    userId: binding.userId,
    chatId: binding.conversationPrincipal,
    command: "semantic-discovery",
    targetId: planId,
    expiryMinutes,
  });
  const configDigest = digest(configBinding(rawConfig));
  const exactPlanDigest = digest(plan);
  const stored = Object.freeze({
    ...pending,
    binding: Object.freeze(binding),
    configDigest,
    exactPlanDigest,
    plan,
  });
  confirmationStore.set(`${pending.nonce}:${pending.targetId}`, stored);
  return {
    ok: true,
    nonce: pending.nonce,
    callbackData: pending.callbackData,
    expiresAt: pending.expiresAt,
    configDigest,
    exactPlanDigest,
    plan,
  };
}

/**
 * Redeem one exact confirmation and write the already ACL-filtered plan once.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function confirmSemanticDiscovery({
  callbackData,
  confirmationStore,
  memoryCtx,
  rawConfig = {},
  policy,
  writeIndex,
  writeMirrors,
} = {}) {
  if (!(confirmationStore instanceof Map)) return { ok: false, reason: "missing_confirmation_store" };
  const parsed = confirmationKey(callbackData);
  if (!parsed) return { ok: false, reason: "invalid_format" };
  const pending = confirmationStore.get(parsed.key);
  if (!pending) return { ok: false, reason: "not_found_or_expired" };
  const binding = identityBinding(memoryCtx);
  if (canonicalJson(binding) !== canonicalJson(pending.binding)) {
    return { ok: false, reason: "binding_mismatch" };
  }
  if (digest(configBinding(rawConfig)) !== pending.configDigest) {
    return { ok: false, reason: "digest_mismatch" };
  }
  if (digest(pending.plan) !== pending.exactPlanDigest) {
    return { ok: false, reason: "plan_digest_mismatch" };
  }
  if (policy?.agentId !== binding.agentId || policy?.workspaceIdentity !== binding.workspaceIdentity) {
    return { ok: false, reason: "policy_scope_mismatch" };
  }
  try {
    assertMutationAllowed(policy, "semantic_index_write");
    assertMutationAllowed(policy, "vault_write");
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
  const validation = validateConfirmation(callbackData, confirmationStore, {
    userId: binding.userId,
    chatId: binding.conversationPrincipal,
  });
  if (!validation.valid) return { ok: false, reason: validation.reason };

  if (typeof writeMirrors === "function") {
    await writeMirrors(pending.plan.sourceRows, { policy });
  }
  const writer = typeof writeIndex === "function"
    ? writeIndex
    : async (plan) => {
        saveLinkIndex(plan.vaultPath, { version: "1", entries: plan.entries }, { mutationPolicy: policy });
        return { path: `${plan.vaultPath}/.plur1bus/link-index.json` };
      };
  const write = await writer(pending.plan, { policy });
  return {
    ok: true,
    applied: true,
    sourceIds: pending.plan.sourceIds,
    entries: pending.plan.entries,
    write,
  };
}
