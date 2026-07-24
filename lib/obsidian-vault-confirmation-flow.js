/** One-time identity- and vault-bound confirmation for protected vault receipts. */

import { randomUUID } from "node:crypto";

import {
  isOwnedVaultConfirmed,
  ownedVaultDigest,
  recordOwnedVaultConfirmation,
} from "./obsidian-vault-authority.js";
import { createConfirmation, validateConfirmation } from "./security.js";
import { resolveInside } from "./sql-safety.js";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

function confirmationKey(callbackData) {
  const parts = String(callbackData || "").split(":");
  if (parts.length !== 4 || parts[0] !== "vault-confirm" || parts[1] !== "confirm") return null;
  return { nonce: parts[2], targetId: parts[3], key: `${parts[2]}:${parts[3]}` };
}

/**
 * Resolve a full UUID nonce to one pending vault-confirm callback.
 *
 * @param {Map<string, object>} confirmationStore Pending confirmation store.
 * @param {string} nonce Full UUID nonce.
 * @returns {string} Callback data or an empty string.
 */
export function vaultConfirmationCallbackForNonce(confirmationStore, nonce) {
  if (!(confirmationStore instanceof Map)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(nonce || ""))) {
    return "";
  }
  for (const pending of confirmationStore.values()) {
    if (pending?.command === "vault-confirm" && pending?.nonce === nonce) {
      return pending.callbackData || "";
    }
  }
  return "";
}

/**
 * Create an in-memory pending confirmation without writing a receipt.
 *
 * @param {object} options Bound identity, vault, base DB, and confirmation store.
 * @returns {object} Pending confirmation details.
 */
export function prepareVaultConfirmation({
  baseDbPath,
  memoryCtx,
  vaultPath,
  confirmationStore,
  expiryMinutes = 10,
} = {}) {
  if (!(confirmationStore instanceof Map)) throw new TypeError("Vault confirmationStore must be a Map");
  const binding = identityBinding(memoryCtx);
  if (!binding.userId || !binding.conversationPrincipal || !binding.agentId || !binding.workspaceIdentity) {
    return { ok: false, reason: "identity_binding_required" };
  }
  const canonicalBaseDbPath = resolveInside(baseDbPath);
  const digest = ownedVaultDigest(vaultPath);
  const pending = createConfirmation({
    userId: binding.userId,
    chatId: binding.conversationPrincipal,
    command: "vault-confirm",
    targetId: randomUUID(),
    expiryMinutes,
  });
  confirmationStore.set(`${pending.nonce}:${pending.targetId}`, Object.freeze({
    ...pending,
    binding: Object.freeze(binding),
    baseDbPath: canonicalBaseDbPath,
    vaultDigest: digest,
  }));
  return {
    ok: true,
    nonce: pending.nonce,
    callbackData: pending.callbackData,
    expiresAt: pending.expiresAt,
    vaultDigest: digest,
  };
}

/**
 * Redeem an exact pending confirmation and write one protected receipt.
 *
 * @param {object} options Exact callback, identity, vault, base DB, and store.
 * @returns {object} Confirmation result.
 */
export function confirmVaultConfirmation({
  callbackData,
  confirmationStore,
  baseDbPath,
  memoryCtx,
  vaultPath,
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
  if (resolveInside(baseDbPath) !== pending.baseDbPath
    || ownedVaultDigest(vaultPath) !== pending.vaultDigest) {
    return { ok: false, reason: "vault_digest_mismatch" };
  }
  const validation = validateConfirmation(callbackData, confirmationStore, {
    userId: binding.userId,
    chatId: binding.conversationPrincipal,
  });
  if (!validation.valid) return { ok: false, reason: validation.reason };
  const receipt = recordOwnedVaultConfirmation({
    baseDbPath,
    memoryCtx,
    vaultPath,
    confirmationValidated: true,
    confirmationNonce: parsed.nonce,
  });
  return {
    ok: true,
    applied: true,
    alreadyConfirmed: isOwnedVaultConfirmed({ baseDbPath, memoryCtx, vaultPath }),
    receipt,
  };
}
