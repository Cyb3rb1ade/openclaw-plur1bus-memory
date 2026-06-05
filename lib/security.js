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
  const c = ctx || {};
  const rawUser =
    c.userId ?? c.user_id ?? c.fromId ?? c.from?.id ?? c.user?.id ??
    c.senderId ?? c.sender?.id ?? c.sender_id ?? null;
  const rawChat =
    c.chatId ?? c.chat_id ?? c.chat?.id ?? c.conversationId ??
    c.conversation?.id ?? c.threadId ?? null;
  return {
    userId: rawUser != null && rawUser !== "" ? String(rawUser) : undefined,
    chatId: rawChat != null && rawChat !== "" ? String(rawChat) : undefined,
  };
}

/**
 * Checks if a command context is authorized.
 *
 * Rules:
 *   - If cfg.security.allowedUserIds is set: userId MUST be in the list.
 *   - If cfg.security.allowedChatIds is set: chatId MUST be in the list.
 *   - Destructive commands ALWAYS require userId in allowedUserIds
 *     (chatId alone is never enough for destructive ops).
 *   - If BOTH lists are empty/unset: destructive commands are DENIED.
 *   - Non-destructive commands may use chatId-only when allowedUserIds is empty.
 *
 * @param {object} commandCtx — { userId, chatId, channel }
 * @param {object} cfg — plugin config (cfg.security.allowedUserIds, allowedChatIds)
 * @param {object} opts — { destructive?: boolean }
 * @returns {{authorized: boolean, reason?: string}}
 */
export function isAuthorized(commandCtx, cfg = {}, opts = {}) {
  const { userId, chatId, channel } = commandCtx || {};
  const security = cfg.security || {};
  const allowedUserIds = security.allowedUserIds || [];
  const allowedChatIds = security.allowedChatIds || [];
  const isDestructive = opts.destructive === true;

  // Fail-closed: if no auth config at all, deny destructive
  if (isDestructive && allowedUserIds.length === 0 && allowedChatIds.length === 0) {
    return { authorized: false, reason: "security.no_auth_configured" };
  }

  const userAllowed = allowedUserIds.length === 0 ? null : allowedUserIds.includes(userId);
  const chatAllowed = allowedChatIds.length === 0 ? null : allowedChatIds.includes(chatId);

  // Destructive commands: userId MUST be in allowedUserIds
  if (isDestructive) {
    if (allowedUserIds.length > 0 && userAllowed !== true) {
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
