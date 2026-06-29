/**
 * tests/forget-correct-confirm.test.js
 *
 * Integration test for the two-step forget/correct confirmation completion.
 * The button/callback path is impossible (OpenClaw delivers no callback events),
 * so confirmations complete via a follow-up command. This exercises the actual
 * completion building blocks end-to-end:
 *   createConfirmation → validateConfirmation → forgetCard/correctCard
 * which were previously imported but never invoked (the regression).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfirmation, validateConfirmation, resolveIdentity, isAuthorized, resolveChatKind } from "../lib/security.js";
import { forgetCard, correctCard, shareCard } from "../lib/telegram-commands/memory-edit.js";

const archiveDir = mkdtempSync(join(tmpdir(), "p1b-confirm-"));

function mockDb(initial = []) {
  const cards = new Map(initial.map((c) => [c.id, c]));
  return {
    cards,
    async getCard(_agent, id) { return cards.get(id) || null; },
    async deleteCard(_agent, id) { cards.delete(id); return { ok: true }; },
    async updateCard(_agent, id, newContent) { const c = cards.get(id); if (c) c.text = newContent; return { ok: true }; },
  };
}

function mockDbPool() {
  const stored = [];
  return {
    stored,
    getDb() {
      return {
        async store(entry) {
          stored.push(entry);
        },
      };
    },
  };
}

describe("forget/correct confirmation completion", () => {
  it("forget: create → validate → forgetCard deletes (archive-first) and consumes token", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const db = mockDb([{ id, text: "secret note", title: "secret" }]);
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: id });
    store.set(`${c.nonce}:${c.targetId}`, c);

    const v = validateConfirmation(c.callbackData, store, { userId: "u1", chatId: "c1" });
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.targetId, id);

    const res = await forgetCard(db, "default", v.targetId, { archiveDir });
    assert.strictEqual(res.ok, true);
    assert.ok(res.archivePath, "should write an archive before deleting");
    assert.strictEqual(db.cards.has(id), false, "card must be deleted");
    assert.strictEqual(store.size, 0, "confirmation token must be consumed");
  });

  it("forget: wrong user is rejected, card is kept", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const db = mockDb([{ id, text: "keep me", title: "keep" }]);
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: id });
    store.set(`${c.nonce}:${c.targetId}`, c);

    const v = validateConfirmation(c.callbackData, store, { userId: "attacker", chatId: "c1" });
    assert.strictEqual(v.valid, false);
    assert.strictEqual(v.reason, "security.wrong_user");
    assert.strictEqual(db.cards.has(id), true, "card must remain when confirmation fails");
  });

  it("correct: create → validate → correctCard applies new text via updateMemory", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    const db = mockDb([{ id, text: "old text", title: "note" }]);
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "correct", targetId: id });
    c.payload = { newText: "new text", oldText: "old text" };
    store.set(`${c.nonce}:${c.targetId}`, c);

    const v = validateConfirmation(c.callbackData, store, { userId: "u1", chatId: "c1" });
    assert.strictEqual(v.valid, true);

    let applied = null;
    const res = await correctCard(db, "default", v.targetId, c.payload.newText, {
      archiveDir,
      updateMemory: async ({ id: mid, newContent }) => { applied = { id: mid, newContent }; },
    });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(applied, { id, newContent: "new text" }, "safe-reconsolidation hook must run with the new text");
  });

  it("resolveIdentity tolerates alternate field names, nesting, and missing identity", () => {
    assert.deepStrictEqual(resolveIdentity({ userId: "u", chatId: "c" }), { userId: "u", chatId: "c" });
    assert.deepStrictEqual(resolveIdentity({ from: { id: 42 }, chat: { id: 7 } }), { userId: "42", chatId: "7" });
    assert.deepStrictEqual(resolveIdentity({ sender_id: "s", conversationId: "cv" }), { userId: "s", chatId: "cv" });
    // nested under message/event (some channels)
    assert.deepStrictEqual(resolveIdentity({ message: { from: { id: 9 }, chat: { id: 3 } } }), { userId: "9", chatId: "3" });
    assert.deepStrictEqual(resolveIdentity({ event: { userId: "e1", chatId: "e2" } }), { userId: "e1", chatId: "e2" });
    assert.deepStrictEqual(resolveIdentity({}), { userId: undefined, chatId: undefined });
  });

  it("isAuthorized reports no_user_identity when the channel passes no userId", () => {
    const r = isAuthorized({ chatId: "c1" }, { security: { allowedUserIds: ["u1"] } }, { destructive: true });
    assert.strictEqual(r.authorized, false);
    assert.strictEqual(r.reason, "security.no_user_identity");
  });

  it("resolveChatKind classifies private/group/unknown", () => {
    assert.strictEqual(resolveChatKind({ chatType: "private" }), "private");
    assert.strictEqual(resolveChatKind({ chat: { type: "supergroup" } }), "group");
    assert.strictEqual(resolveChatKind({ is_group_chat: true }), "group");
    assert.strictEqual(resolveChatKind({ message: { chatType: "dm" } }), "private");
    assert.strictEqual(resolveChatKind({}), "unknown");
  });

  it("isAuthorized (no ACL): allows destructive in private DM, denies in group/unknown", () => {
    // private 1:1 → allowed (single owner, archive-first recoverable)
    const priv = isAuthorized({ chatType: "private" }, {}, { destructive: true });
    assert.strictEqual(priv.authorized, true);
    // group → denied (fail-safe)
    const grp = isAuthorized({ chatType: "group" }, {}, { destructive: true });
    assert.strictEqual(grp.authorized, false);
    assert.strictEqual(grp.reason, "security.no_auth_configured");
    // unknown chat type → denied (fail-safe)
    const unk = isAuthorized({ chatId: "c1" }, {}, { destructive: true });
    assert.strictEqual(unk.authorized, false);
  });

  it("shareCard blocks sensitive workspace promotion without explicit approval", async () => {
    const id = "44444444-4444-4444-4444-444444444444";
    const db = mockDb([{ id, text: "User API password is abc", title: "secret", category: "access/password" }]);
    const dbPool = mockDbPool();

    const denied = await shareCard(db, dbPool, "default", id);
    assert.strictEqual(denied.ok, false);
    assert.match(denied.error, /explicit approval/i);
    assert.strictEqual(dbPool.stored.length, 0);

    const allowed = await shareCard(db, dbPool, "default", id, { allowSensitiveShare: true });
    assert.strictEqual(allowed.ok, true);
    assert.strictEqual(dbPool.stored.length, 1);
  });

  it("shareCard blocks core memories even when category looks ordinary", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    const db = mockDb([{ id, text: "Core behavioral rule", title: "core", category: "note", memoryClass: "core" }]);
    const dbPool = mockDbPool();

    const denied = await shareCard(db, dbPool, "default", id);
    assert.strictEqual(denied.ok, false);
    assert.match(denied.error, /explicit approval|sensitive shared memory/i);
    assert.strictEqual(dbPool.stored.length, 0);
  });

  it("forgetCard does not expose raw DB error details to the user", async () => {
    const db = {
      async getCard() {
        throw new Error("driver leaked token=super-secret");
      },
    };
    const warnings = [];

    const result = await forgetCard(db, "default", "bad-id", {
      archiveDir,
      logger: { warn: (...args) => warnings.push(args) },
    });

    assert.strictEqual(result.ok, false);
    assert.doesNotMatch(result.error, /super-secret|token=/);
    assert.match(result.error, /internal error/i);
    assert.strictEqual(warnings.length, 1);
  });

  it("correctCard does not expose raw update error details to the user", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    const db = mockDb([{ id, text: "old", title: "note" }]);

    const result = await correctCard(db, "default", id, "new", {
      archiveDir,
      updateMemory: async () => {
        throw new Error("backend path /private/user/vault");
      },
    });

    assert.strictEqual(result.ok, false);
    assert.doesNotMatch(result.error, /private\/user\/vault/);
    assert.match(result.error, /internal error/i);
    assert.ok(result.archivePath, "archive is preserved after failed update");
  });

  it("shareCard does not expose raw store error details to the user", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    const db = mockDb([{ id, text: "ordinary note", title: "note", category: "note" }]);
    const dbPool = {
      getDb() {
        return {
          async store() {
            throw new Error("sqlite file /private/cache/shared.db");
          },
        };
      },
    };

    const result = await shareCard(db, dbPool, "default", id);

    assert.strictEqual(result.ok, false);
    assert.doesNotMatch(result.error, /private\/cache/);
    assert.match(result.error, /internal error/i);
  });

  it("forgetCard denies ACL mismatch before archive or delete", async () => {
    const id = "88888888-8888-8888-8888-888888888888";
    const db = mockDb([{ id, text: "foreign private note", scope: "agent-private", agentId: "owner-agent" }]);

    const result = await forgetCard(db, "default", id, {
      archiveDir,
      ctx: { agentId: "other-agent", workspaceDir: archiveDir },
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /access denied|acl\.agent_private\.mismatch/i);
    assert.strictEqual(db.cards.has(id), true, "ACL-denied card must not be deleted");
    assert.strictEqual(result.archivePath, undefined, "ACL denial must happen before archive");
  });

  it("forgetCard denies ACL mismatch when ownership is only storedBy/workspaceKey", async () => {
    const privateId = "99999999-9999-9999-9999-999999999999";
    const workspaceId = "aaaaaaaa-1111-1111-1111-111111111111";
    const db = mockDb([
      { id: privateId, text: "foreign private note", scope: "agent-private", storedBy: "owner-agent" },
      { id: workspaceId, text: "foreign workspace note", scope: "workspace", workspaceKey: "workspace-a" },
    ]);

    const privateResult = await forgetCard(db, "default", privateId, {
      archiveDir,
      ctx: { agentId: "other-agent", workspaceDir: archiveDir },
    });
    assert.strictEqual(privateResult.ok, false);
    assert.match(privateResult.error, /access denied|acl\.agent_private\.mismatch/i);

    const workspaceResult = await forgetCard(db, "default", workspaceId, {
      archiveDir,
      ctx: { agentId: "default", workspaceId: "workspace-b", workspaceDir: archiveDir },
    });
    assert.strictEqual(workspaceResult.ok, false);
    assert.match(workspaceResult.error, /access denied|acl\.workspace\.mismatch/i);
  });

  it("forgetCard denies user-scope access when the caller is not the owning user", async () => {
    const id = "bbbbbbbb-1111-1111-1111-111111111111";
    const db = mockDb([{ id, text: "user-scoped note", scope: "user", ownerUserId: "owner-user" }]);

    const result = await forgetCard(db, "default", id, {
      archiveDir,
      ctx: { agentId: "default", userId: "other-user", workspaceDir: archiveDir },
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /access denied|acl\.user\.mismatch/i);
    assert.strictEqual(db.cards.has(id), true, "foreign user must not delete the card");
  });

  it("forgetCard still allows the owning user to delete a user-scoped memory", async () => {
    const id = "bbbbbbbb-2222-2222-2222-222222222222";
    const db = mockDb([{ id, text: "user-scoped note", scope: "user", ownerUserId: "owner-user" }]);

    const result = await forgetCard(db, "default", id, {
      archiveDir,
      ctx: { agentId: "default", userId: "owner-user", workspaceDir: archiveDir },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(db.cards.has(id), false, "owner should still be able to delete the card");
  });
});
