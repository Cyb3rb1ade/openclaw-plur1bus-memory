/**
 * lib/security.js — Telegram/Chat Auth & ACL for PLUR1BUS.
 *
 * Fail-closed by default. Destructive commands always require user-bound auth.
 */

import { randomUUID } from "node:crypto";

/**
 * Resolves sender identity (userId/chatId) from a command/hook context,
 * tolerating the various field names different OpenClaw/channel versions use.
 * Returns string ids or undefined. Never throws.
 *
 * @param {object} ctx
 * @returns {{userId: string|undefined, chatId: string|undefined}}
 */
export function resolveIdentity(ctx = {}) {
  const base = ctx || {};
  // Some channels/SDK versions nest the sender under message/event/meta/raw.
  const containers = [base, base.message, base.event, base.meta, base.raw, base.ctx, base.context].filter(
    (o) => o && typeof o === "object",
  );
  let rawUser = null;
  let rawChat = null;
  for (const o of containers) {
    if (rawUser == null) {
      rawUser = o.userId ?? o.user_id ?? o.fromId ?? o.from?.id ?? o.user?.id ??
        o.senderId ?? o.sender?.id ?? o.sender_id ?? null;
    }
    if (rawChat == null) {
      rawChat = o.chatId ?? o.chat_id ?? o.chat?.id ?? o.conversationId ??
        o.conversation?.id ?? o.threadId ?? null;
    }
  }
  return {
    userId: rawUser != null && rawUser !== "" ? String(rawUser) : undefined,
    chatId: rawChat != null && rawChat !== "" ? String(rawChat) : undefined,
  };
}

/**
 * Classifies the chat as "private" (1:1 DM — single owner), "group"
 * (group/supergroup/channel — multiple participants), or "unknown".
 * Tolerates nested containers and varied field names. Never throws.
 *
 * @param {object} ctx
 * @returns {"private"|"group"|"unknown"}
 */
export function resolveChatKind(ctx = {}) {
  const base = ctx || {};
  const containers = [base, base.message, base.event, base.meta, base.raw, base.ctx, base.context].filter(
    (o) => o && typeof o === "object",
  );
  let typeRaw = null;
  let groupFlag = null;
  for (const o of containers) {
    if (typeRaw == null) {
      typeRaw = o.chatType ?? o.chat_type ?? o.chat?.type ?? o.conversationType ?? o.conversation?.type ?? null;
    }
    if (groupFlag == null) {
      if (o.isGroup === true || o.is_group === true || o.is_group_chat === true) groupFlag = true;
      else if (o.isGroup === false || o.is_group === false || o.is_group_chat === false) groupFlag = false;
    }
  }
  const t = typeRaw != null ? String(typeRaw).toLowerCase() : "";
  if (t === "group" || t === "supergroup" || t === "channel" || groupFlag === true) return "group";
  if (t === "private" || t === "dm" || t === "direct" || groupFlag === false) return "private";
  return "unknown";
}

/**
 * Checks if a command context is authorized.
 *
 * Rules:
 *   - If cfg.security.allowedUserIds is set: userId MUST be in the list.
 *   - If cfg.security.allowedChatIds is set: chatId MUST be in the list.
 *   - Destructive commands ALWAYS require userId in allowedUserIds
 *     (chatId alone is never enough for destructive ops).
 *   - If BOTH lists are empty/unset: destructive commands are allowed ONLY in a
 *     private 1:1 chat (single owner; forget/correct are archive-first), and
 *     DENIED in groups or when the chat type is unknown (fail-safe).
 *   - Non-destructive commands may use chatId-only when allowedUserIds is empty.
 *
 * @param {object} commandCtx — { userId, chatId, channel, chatType, ... }
 * @param {object} cfg — plugin config (cfg.security.allowedUserIds, allowedChatIds)
 * @param {object} opts — { destructive?: boolean, chatKind?: "private"|"group"|"unknown" }
 * @returns {{authorized: boolean, reason?: string}}
 */
export function isAuthorized(commandCtx, cfg = {}, opts = {}) {
  const { userId, chatId, channel } = commandCtx || {};
  const security = cfg.security || {};
  const allowedUserIds = security.allowedUserIds || [];
  const allowedChatIds = security.allowedChatIds || [];
  const isDestructive = opts.destructive === true;

  // No ACL configured: allow destructive ONLY in a private 1:1 chat (single
  // owner; forget/correct are archive-first and recoverable). Groups — or an
  // unknown chat type — stay fail-closed.
  if (isDestructive && allowedUserIds.length === 0 && allowedChatIds.length === 0) {
    const chatKind = opts.chatKind || resolveChatKind(commandCtx);
    if (chatKind === "private") {
      return { authorized: true, reason: "security.private_chat_owner" };
    }
    return { authorized: false, reason: "security.no_auth_configured" };
  }

  const userAllowed = allowedUserIds.length === 0 ? null : allowedUserIds.includes(userId);
  const chatAllowed = allowedChatIds.length === 0 ? null : allowedChatIds.includes(chatId);

  // Destructive commands: userId MUST be in allowedUserIds (chatId alone is
  // never sufficient).
  if (isDestructive) {
    if (allowedUserIds.length === 0) {
      return { authorized: false, reason: "security.user_not_allowed" };
    }
    // Distinguish "the channel provided no sender identity" from "user not on
    // the allowlist" — this is the diagnostic for SDK/channel identity issues.
    if (!userId) {
      return { authorized: false, reason: "security.no_user_identity" };
    }
    if (userAllowed !== true) {
      return { authorized: false, reason: "security.user_not_allowed" };
    }
    if (allowedChatIds.length > 0 && chatAllowed !== true) {
      return { authorized: false, reason: "security.chat_not_allowed" };
    }
    return { authorized: true };
  }

  // Non-destructive: either user or chat whitelist suffices
  if (allowedUserIds.length > 0 && userAllowed !== true && allowedChatIds.length > 0 && chatAllowed !== true) {
    return { authorized: false, reason: "security.neither_user_nor_chat_allowed" };
  }
  if (allowedUserIds.length > 0 && userAllowed !== true && allowedChatIds.length === 0) {
    return { authorized: false, reason: "security.user_not_allowed" };
  }
  if (allowedChatIds.length > 0 && chatAllowed !== true && allowedUserIds.length === 0) {
    return { authorized: false, reason: "security.chat_not_allowed" };
  }

  return { authorized: true };
}

/**
 * Creates a confirmation payload bound to user+chat+command+target.
 * Prevents callback replay and cross-user reuse.
 */
export function createConfirmation({ userId, chatId, command, targetId, expiryMinutes = 10 }) {
  const nonce = randomUUID();
  const expiresAt = Date.now() + expiryMinutes * 60_000;
  return {
    nonce,
    userId,
    chatId,
    command,
    targetId,
    expiresAt,
    callbackData: `${command}:confirm:${nonce}:${targetId}`,
  };
}

/**
 * Validates a confirmation callback.
 */
export function validateConfirmation(callbackData, store, { userId, chatId }) {
  if (!callbackData || !store) return { valid: false, reason: "security.missing_data" };
  const parts = callbackData.split(":");
  if (parts.length < 4 || parts[1] !== "confirm") {
    return { valid: false, reason: "security.invalid_format" };
  }
  const [, , nonce, targetId] = parts;
  const key = `${nonce}:${targetId}`;
  const pending = store.get(key);
  if (!pending) return { valid: false, reason: "security.not_found_or_expired" };
  if (pending.expiresAt < Date.now()) {
    store.delete(key);
    return { valid: false, reason: "security.expired" };
  }
  if (pending.userId !== userId) return { valid: false, reason: "security.wrong_user" };
  if (pending.chatId !== chatId) return { valid: false, reason: "security.wrong_chat" };
  store.delete(key);
  return { valid: true, targetId, command: pending.command };
}
