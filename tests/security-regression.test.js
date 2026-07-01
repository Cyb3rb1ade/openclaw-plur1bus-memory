/**
 * Security Regression Sweep — P4 Release Candidate
 *
 * Validates:
 *   - Auth: private DM allows destructive, group denies
 *   - Destructive commands require confirmation
 *   - Path traversal is blocked / sanitized
 *   - Filter parser sanitizes malicious input
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isAuthorized, resolveChatKind, createConfirmation, validateConfirmation } from "../lib/security.js";
import { parseFilters, buildWhereClause } from "../lib/filter-parser.js";
import { safeAgentId, resolveInside } from "../lib/sql-safety.js";
import { archiveCard } from "../lib/telegram-commands/memory-edit.js";

describe("Auth: private DM vs group chat (no ACL)", () => {
  it("allows destructive in private DM", () => {
    const result = isAuthorized({ chatType: "private" }, {}, { destructive: true });
    assert.strictEqual(result.authorized, true);
    assert.strictEqual(result.reason, "security.private_chat_owner");
  });

  it("denies destructive in group chat", () => {
    const result = isAuthorized({ chatType: "group" }, {}, { destructive: true });
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.no_auth_configured");
  });

  it("denies destructive in supergroup", () => {
    const result = isAuthorized({ chat: { type: "supergroup" } }, {}, { destructive: true });
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.no_auth_configured");
  });

  it("denies destructive when chat kind is unknown", () => {
    const result = isAuthorized({ chatId: "c1" }, {}, { destructive: true });
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.no_auth_configured");
  });
});

describe("Auth: destructive never allowed by chatId alone", () => {
  it("denies destructive when allowedUserIds empty but allowedChatIds set", () => {
    const result = isAuthorized(
      { userId: "u1", chatId: "c1" },
      { security: { allowedChatIds: ["c1"] } },
      { destructive: true }
    );
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.user_not_allowed");
  });

  it("allows destructive when userId in allowedUserIds and chatId in allowedChatIds", () => {
    const result = isAuthorized(
      { userId: "u1", chatId: "c1" },
      { security: { allowedUserIds: ["u1"], allowedChatIds: ["c1"] } },
      { destructive: true }
    );
    assert.strictEqual(result.authorized, true);
  });

  it("denies destructive when userId in allowedUserIds but chatId not in allowedChatIds", () => {
    const result = isAuthorized(
      { userId: "u1", chatId: "c2" },
      { security: { allowedUserIds: ["u1"], allowedChatIds: ["c1"] } },
      { destructive: true }
    );
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.chat_not_allowed");
  });

  it("denies destructive when allowedUserIds set and no user identity provided", () => {
    const result = isAuthorized(
      { chatId: "c1" },
      { security: { allowedUserIds: ["u1"] } },
      { destructive: true }
    );
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.no_user_identity");
  });
});

describe("resolveChatKind classification", () => {
  it("classifies private correctly", () => {
    assert.strictEqual(resolveChatKind({ chatType: "private" }), "private");
    assert.strictEqual(resolveChatKind({ chat_type: "dm" }), "private");
    assert.strictEqual(resolveChatKind({ isGroup: false }), "private");
  });

  it("classifies group correctly", () => {
    assert.strictEqual(resolveChatKind({ chatType: "group" }), "group");
    assert.strictEqual(resolveChatKind({ chatType: "supergroup" }), "group");
    assert.strictEqual(resolveChatKind({ chatType: "channel" }), "group");
    assert.strictEqual(resolveChatKind({ is_group_chat: true }), "group");
  });

  it("classifies unknown when no hints", () => {
    assert.strictEqual(resolveChatKind({}), "unknown");
  });
});

describe("forget/correct confirmation", () => {
  it("rejects forget without valid confirmation token", () => {
    const store = new Map();
    const result = validateConfirmation("forget:confirm:fake:target", store, { userId: "u1", chatId: "c1" });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, "security.not_found_or_expired");
  });

  it("rejects forget with expired confirmation", () => {
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: "t1", expiryMinutes: -1 });
    store.set(`${c.nonce}:${c.targetId}`, c);
    const result = validateConfirmation(c.callbackData, store, { userId: "u1", chatId: "c1" });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, "security.expired");
  });

  it("rejects forget confirmation from wrong user", () => {
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: "t1" });
    store.set(`${c.nonce}:${c.targetId}`, c);
    const result = validateConfirmation(c.callbackData, store, { userId: "u2", chatId: "c1" });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, "security.wrong_user");
  });

  it("rejects forget confirmation from wrong chat", () => {
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: "t1" });
    store.set(`${c.nonce}:${c.targetId}`, c);
    const result = validateConfirmation(c.callbackData, store, { userId: "u1", chatId: "c2" });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, "security.wrong_chat");
  });
});

describe("Path handling", () => {
  let tmpDir;

  it("setup temp dir", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sec-reg-"));
  });

  it("rejects path traversal in agentId", () => {
    assert.throws(() => safeAgentId("../etc/passwd"), /Invalid agent ID/);
    assert.throws(() => safeAgentId(".."), /Invalid agent ID/);
    assert.throws(() => safeAgentId("a/../b"), /Invalid agent ID/);
  });

  it("rejects path traversal via resolveInside", () => {
    assert.throws(() => resolveInside(tmpDir, "..", "passwd"), /Path traversal blocked/);
    assert.throws(() => resolveInside(tmpDir, "foo", "..", "..", "passwd"), /Path traversal blocked/);
  });

  it("rejects absolute path in resolveInside", () => {
    assert.throws(() => resolveInside(tmpDir, "/etc/passwd"), /Path traversal blocked/);
  });

  it("sanitizes card id in archive path", () => {
    const card = { id: "../../../etc/passwd", text: "test" };
    const path = archiveCard(card, "testagent", tmpDir);
    assert.ok(path.includes("etcpasswd"));
    assert.ok(!path.includes(".."));
    assert.ok(!path.includes("/etc/passwd"));
    rmSync(path);
  });

  it("archives cards with BigInt fields returned from LanceDB", () => {
    const card = { id: "bigint-card", text: "test", createdAt: BigInt(123) };
    const path = archiveCard(card, "testagent", tmpDir);
    const archived = JSON.parse(readFileSync(path, "utf8"));
    assert.strictEqual(archived.createdAt, "123");
    rmSync(path);
  });

  it("cleanup temp dir", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("Filter parser sanitization", () => {
  it("sanitizes SQL injection via single quote in category", () => {
    const clause = buildWhereClause({ category: "person' OR '1'='1" });
    assert.ok(!clause.includes("= 'person' OR '"));
    // Must use SQL-standard escaping (doubled quotes), not backslash
    assert.ok(clause.includes("''"));
  });

  it("sanitizes SQL injection in emotion filter", () => {
    const clause = buildWhereClause({ emotion: "'; DROP TABLE--" });
    // Must be a single quoted literal; no unterminated/breakout patterns
    assert.ok(clause.startsWith("emotionalDominant = '"));
    assert.ok(clause.endsWith("'"));
    assert.ok(clause.includes("''"));
  });

  it("sanitizes SQL injection in source filter", () => {
    const clause = buildWhereClause({ source: "dm' OR '1'='1" });
    assert.ok(!clause.includes("= 'dm' OR '"));
    assert.ok(clause.includes("''"));
  });

  it("leaves malicious input in topic when no valid filter key", () => {
    const result = parseFilters("foo bar'; DROP TABLE--");
    assert.strictEqual(result.topic, "foo bar'; DROP TABLE--");
    assert.deepStrictEqual(result.filters, {});
  });

  it("buildWhereClause returns null for empty filters", () => {
    assert.strictEqual(buildWhereClause({}), null);
    assert.strictEqual(buildWhereClause(null), null);
  });
});
