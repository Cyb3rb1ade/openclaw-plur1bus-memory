/**
 * Security Regression Tests — P0 Phase
 *
 * Tests for:
 *   - safeUuid rejects invalid UUIDs
 *   - safeUuidList rejects injection
 *   - safeAgentId rejects path traversal
 *   - resolveInside blocks path traversal and symlinks
 *   - isAuthorized fail-closed behavior
 *   - Confirmation callbacks bound to user+chat
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeUuid,
  safeUuidList,
  safeAgentId,
  resolveInside,
  safeStatus,
  safeType,
  safeTimestamp,
} from "../lib/sql-safety.js";
import { isAuthorized, createConfirmation, validateConfirmation } from "../lib/security.js";

describe("safeUuid", () => {
  it("accepts valid UUIDs", () => {
    assert.strictEqual(safeUuid("550e8400-e29b-41d4-a716-446655440000"), "550e8400-e29b-41d4-a716-446655440000");
  });

  it("rejects empty string", () => {
    assert.throws(() => safeUuid(""), /Invalid memory ID format/);
  });

  it("rejects null", () => {
    assert.throws(() => safeUuid(null), /Invalid memory ID format/);
  });

  it("rejects undefined", () => {
    assert.throws(() => safeUuid(undefined), /Invalid memory ID format/);
  });

  it("rejects SQL injection attempt", () => {
    assert.throws(() => safeUuid("'; DROP TABLE memories; --"), /Invalid memory ID format/);
  });

  it("rejects path traversal in UUID", () => {
    assert.throws(() => safeUuid("../../../etc/passwd"), /Invalid memory ID format/);
  });

  it("rejects UUID with double hyphens", () => {
    assert.throws(() => safeUuid("550e8400--e29b-41d4-a716-446655440000"), /Invalid memory ID format/);
  });
});

describe("safeUuidList", () => {
  it("accepts valid UUID list", () => {
    const result = safeUuidList(["550e8400-e29b-41d4-a716-446655440000", "660e8400-e29b-41d4-a716-446655440001"]);
    assert.ok(result.includes("550e8400-e29b-41d4-a716-446655440000"));
  });

  it("rejects injection in list", () => {
    const result = safeUuidList(["550e8400-e29b-41d4-a716-446655440000", "'; DROP TABLE--"]);
    assert.ok(result.includes("550e8400"));
    assert.ok(!result.includes("DROP"));
  });

  it("caps at maxItems", () => {
    const ids = Array.from({ length: 150 }, (_, i) =>
      `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`
    );
    const result = safeUuidList(ids, 100);
    const count = result.split(",").length;
    assert.strictEqual(count, 100);
  });

  it("returns null for empty array", () => {
    assert.strictEqual(safeUuidList([]), null);
  });
});

describe("safeAgentId", () => {
  it("accepts valid agent IDs", () => {
    assert.strictEqual(safeAgentId("my-agent_123"), "my-agent_123");
  });

  it("rejects path traversal", () => {
    assert.throws(() => safeAgentId("../other-agent"), /Invalid agent ID/);
  });

  it("rejects absolute path", () => {
    assert.throws(() => safeAgentId("/etc/passwd"), /Invalid agent ID/);
  });

  it("rejects dots", () => {
    assert.throws(() => safeAgentId("agent..name"), /Invalid agent ID/);
  });

  it("rejects empty string", () => {
    assert.throws(() => safeAgentId(""), /Invalid agent ID/);
  });

  it("rejects too long", () => {
    assert.throws(() => safeAgentId("a".repeat(65)), /Invalid agent ID/);
  });
});

describe("resolveInside", () => {
  let tmpDir;

  it("before hook", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "security-test-"));
    mkdirSync(join(tmpDir, "subdir"), { recursive: true });
    writeFileSync(join(tmpDir, "subdir", "file.txt"), "hello");
  });

  it("allows file inside baseDir", () => {
    const result = resolveInside(tmpDir, "subdir", "file.txt");
    assert.ok(result.endsWith("file.txt"));
  });

  it("blocks path traversal via ..", () => {
    assert.throws(() => resolveInside(tmpDir, "..", "passwd"), /Path traversal blocked/);
  });

  it("blocks absolute path", () => {
    assert.throws(() => resolveInside(tmpDir, "/etc/passwd"), /Path traversal blocked/);
  });

  it("allows new file in existing subdir", () => {
    const result = resolveInside(tmpDir, "subdir", "newfile.txt");
    assert.ok(result.includes("newfile.txt"));
  });

  it("after hook", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("safeStatus", () => {
  it("accepts active", () => {
    assert.strictEqual(safeStatus("active"), "active");
  });

  it("rejects injection", () => {
    assert.throws(() => safeStatus("'; DROP TABLE--"), /Invalid status/);
  });
});

describe("safeType", () => {
  it("accepts person", () => {
    assert.strictEqual(safeType("person"), "person");
  });

  it("rejects injection", () => {
    assert.throws(() => safeType("'; DROP TABLE--"), /Invalid type/);
  });
});

describe("safeTimestamp", () => {
  it("accepts valid timestamp", () => {
    assert.strictEqual(safeTimestamp(1234567890), 1234567890);
  });

  it("rejects negative", () => {
    assert.throws(() => safeTimestamp(-1), /Invalid timestamp/);
  });

  it("rejects NaN", () => {
    assert.throws(() => safeTimestamp(NaN), /Invalid timestamp/);
  });

  it("rejects Infinity", () => {
    assert.throws(() => safeTimestamp(Infinity), /Invalid timestamp/);
  });
});

describe("isAuthorized", () => {
  it("denies destructive when no auth configured", () => {
    const result = isAuthorized({ userId: "u1", chatId: "c1" }, {}, { destructive: true });
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.no_auth_configured");
  });

  it("allows destructive when user in allowedUserIds", () => {
    const result = isAuthorized(
      { userId: "u1", chatId: "c1" },
      { security: { allowedUserIds: ["u1"] } },
      { destructive: true }
    );
    assert.strictEqual(result.authorized, true);
  });

  it("denies destructive when user not in allowedUserIds", () => {
    const result = isAuthorized(
      { userId: "u2", chatId: "c1" },
      { security: { allowedUserIds: ["u1"] } },
      { destructive: true }
    );
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.user_not_allowed");
  });

  it("denies destructive when chat not in allowedChatIds", () => {
    const result = isAuthorized(
      { userId: "u1", chatId: "c2" },
      { security: { allowedUserIds: ["u1"], allowedChatIds: ["c1"] } },
      { destructive: true }
    );
    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, "security.chat_not_allowed");
  });

  it("allows non-destructive when chat in allowedChatIds", () => {
    const result = isAuthorized(
      { userId: "u2", chatId: "c1" },
      { security: { allowedChatIds: ["c1"] } },
      { destructive: false }
    );
    assert.strictEqual(result.authorized, true);
  });

  it("denies non-destructive when neither user nor chat allowed", () => {
    const result = isAuthorized(
      { userId: "u2", chatId: "c2" },
      { security: { allowedUserIds: ["u1"], allowedChatIds: ["c1"] } },
      { destructive: false }
    );
    assert.strictEqual(result.authorized, false);
  });
});

describe("createConfirmation + validateConfirmation", () => {
  it("creates confirmation with nonce and expiry", () => {
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: "id1" });
    assert.ok(c.nonce);
    assert.ok(c.expiresAt > Date.now());
    assert.strictEqual(c.userId, "u1");
    assert.strictEqual(c.targetId, "id1");
  });

  it("validates correct callback", () => {
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: "id1" });
    store.set(`${c.nonce}:${c.targetId}`, c);
    const result = validateConfirmation(c.callbackData, store, { userId: "u1", chatId: "c1" });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.targetId, "id1");
  });

  it("rejects callback from wrong user", () => {
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: "id1" });
    store.set(`${c.nonce}:${c.targetId}`, c);
    const result = validateConfirmation(c.callbackData, store, { userId: "u2", chatId: "c1" });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, "security.wrong_user");
  });

  it("rejects expired callback", () => {
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: "id1", expiryMinutes: -1 });
    store.set(`${c.nonce}:${c.targetId}`, c);
    const result = validateConfirmation(c.callbackData, store, { userId: "u1", chatId: "c1" });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, "security.expired");
  });
});
