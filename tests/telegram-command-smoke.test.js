/**
 * Telegram Command Smoke — P5 Runtime Validation
 *
 * Tests Telegram-Commands against Security rules using Mock-Context and Mock-Config.
 * No real Telegram API calls.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isAuthorized,
  resolveIdentity,
  resolveChatKind,
  validateConfirmation,
} from "../lib/security.js";

describe("Telegram Command Smoke: Security Rules", () => {
  // ── Helper: build Telegram-style mock context ────────────────────────────
  const tgCtx = ({ userId, chatId, chatType }) => ({
    from: { id: userId },
    chat: { id: chatId, type: chatType },
  });

  // 1. private DM + destructive command → erlaubt (wenn userId erlaubt)
  it("allows destructive command in private DM when userId is allowed", () => {
    const ctx = tgCtx({ userId: "u1", chatId: "c1", chatType: "private" });
    const identity = resolveIdentity(ctx);
    const cfg = { security: { allowedUserIds: ["u1"] } };
    const result = isAuthorized(
      { ...ctx, ...identity },
      cfg,
      { destructive: true, chatKind: resolveChatKind(ctx) }
    );
    assert.strictEqual(result.authorized, true);
  });

  // 2. group chat + destructive command → verweigert
  it("denies destructive command in group chat without matching allowedChatIds", () => {
    const ctx = tgCtx({ userId: "u1", chatId: "g1", chatType: "supergroup" });
    const identity = resolveIdentity(ctx);
    const cfg = { security: { allowedUserIds: ["u1"], allowedChatIds: ["c1"] } };
    const result = isAuthorized(
      { ...ctx, ...identity },
      cfg,
      { destructive: true, chatKind: resolveChatKind(ctx) }
    );
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.chat_not_allowed");
  });

  // 3. /forget ohne confirmation → verweigert
  it("denies /forget without valid confirmation token", () => {
    const store = new Map();
    const result = validateConfirmation(
      "forget:confirm:fake:target123",
      store,
      { userId: "u1", chatId: "c1" }
    );
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, "security.not_found_or_expired");
  });

  // 4. /correct von nicht-erlaubtem User → verweigert
  it("denies /correct from unauthorized user", () => {
    const ctx = tgCtx({ userId: "u99", chatId: "c1", chatType: "private" });
    const identity = resolveIdentity(ctx);
    const cfg = { security: { allowedUserIds: ["u1"] } };
    const result = isAuthorized(
      { ...ctx, ...identity },
      cfg,
      { destructive: true, chatKind: resolveChatKind(ctx) }
    );
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.user_not_allowed");
  });

  // 5. allowedUserIds leer + destructive → verweigert (P4C-Fix)
  it("denies destructive when allowedUserIds is empty but allowedChatIds is set (P4C-Fix)", () => {
    const ctx = tgCtx({ userId: "u1", chatId: "c1", chatType: "private" });
    const identity = resolveIdentity(ctx);
    const cfg = { security: { allowedChatIds: ["c1"] } };
    const result = isAuthorized(
      { ...ctx, ...identity },
      cfg,
      { destructive: true, chatKind: resolveChatKind(ctx) }
    );
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.user_not_allowed");
  });

  // 6. /memory recall in group → erlaubt (nicht destructive)
  it("allows /memory recall in group chat (non-destructive)", () => {
    const ctx = tgCtx({ userId: "u1", chatId: "g1", chatType: "supergroup" });
    const identity = resolveIdentity(ctx);
    const cfg = { security: { allowedChatIds: ["g1"] } };
    const result = isAuthorized(
      { ...ctx, ...identity },
      cfg,
      { destructive: false, chatKind: resolveChatKind(ctx) }
    );
    assert.strictEqual(result.authorized, true);
  });
});
