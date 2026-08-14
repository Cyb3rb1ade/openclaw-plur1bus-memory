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
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConfirmation, validateConfirmation, resolveIdentity, isAuthorized, resolveChatKind } from "../lib/security.js";
import { forgetCard, correctCard, shareCard } from "../lib/telegram-commands/memory-edit.js";
import { checkAccess } from "../lib/acl-middleware.js";
import { resolveHostCommandMemoryContext } from "../lib/memory-request-context.js";
import { safeUpdate } from "../lib/safe-update.js";
import * as pluginModule from "../index.js";

const archiveDir = mkdtempSync(join(tmpdir(), "p1b-confirm-"));

function mockDb(initial = []) {
  const cards = new Map(initial.map((c) => [c.id, c]));
  return {
    cards,
    async getCard(_agent, id) { return cards.get(id) || null; },
    async tombstoneCard(_agent, id) { const c = cards.get(id); if (c) { c.status = "deleted"; c.epistemicStatus = "invalidated"; } return { ok: true, id }; },
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

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    return { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return value || "";
  },
  normalizeMessageChannel(value) {
    return value;
  },
});

async function officialMemoryContext({
  accountId = "account-a",
  chatId = "chat-a",
  senderId = "user-a",
  sessionId = "session-a",
  threadId = "thread-a",
  workspaceDir = archiveDir,
  workspaceKey = "workspace:v1:ws-a",
} = {}) {
  const peerKind = threadId ? "group" : "direct";
  const target = threadId
    ? `telegram:group:${chatId}:topic:${threadId}`
    : `telegram:direct:${chatId}`;
  const sessionRoute = threadId
    ? `telegram:group:${chatId}:topic:${threadId}`
    : `telegram:${accountId}:direct:${chatId}`;
  const workspaceAliases = {
    paths: [{ path: workspaceDir, workspaceKey }],
    aliases: [],
  };
  return resolveHostCommandMemoryContext({
    agentId: "agent-a",
    accountId,
    channel: "telegram",
    from: target,
    messageThreadId: threadId,
    senderId,
    sessionId,
    sessionKey: `agent:agent-a:${sessionRoute}`,
    threadParentId: threadId ? chatId : "",
    getCurrentConversationBinding: async () => ({
      channel: "telegram",
      accountId,
      conversationId: threadId || chatId,
      parentConversationId: chatId,
      threadId,
      peerKind,
    }),
  }, {
    requireConversation: true,
    resolveAgentWorkspaceDir: async () => workspaceDir,
    routingLoader: async () => routingCapability,
    workspaceAliases,
  });
}

function requireConfirmationHelpers() {
  for (const name of [
    "completePendingConfirmation",
    "parseConfirmationCommand",
    "rememberPendingConfirmation",
    "resolveConfirmationIdentity",
  ]) {
    assert.equal(typeof pluginModule[name], "function", `${name} must be exported`);
  }
}

describe("forget/correct confirmation completion", () => {
  it("forget: create → validate → forgetCard tombstoned (archive-first) and consumes token", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const db = mockDb([{ id, text: "secret note", title: "secret", scope: "agent-private" }]);
    const store = new Map();
    const c = createConfirmation({ userId: "u1", chatId: "c1", command: "forget", targetId: id });
    store.set(`${c.nonce}:${c.targetId}`, c);

    const v = validateConfirmation(c.callbackData, store, { userId: "u1", chatId: "c1" });
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.targetId, id);

    const res = await forgetCard(db, "default", v.targetId, { archiveDir, workspaceDir: archiveDir });
    assert.strictEqual(res.ok, true);
    assert.ok(res.archivePath, "should write an archive before tombstoning");
    assert.strictEqual(db.cards.has(id), true, "tombstone keeps the row (soft-delete)");
    assert.strictEqual(db.cards.get(id).status, "deleted", "row must be soft-deleted");
    assert.strictEqual(db.cards.get(id).epistemicStatus, "invalidated", "trust must be invalidated");
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

  it("uses complete UUID nonces and exact nonce+target lookup for forget, correct, and later share", async () => {
    requireConfirmationHelpers();
    const memoryCtx = await officialMemoryContext();
    const identity = pluginModule.resolveConfirmationIdentity(memoryCtx);
    const targetA = "aaaaaaaa-1111-1111-1111-111111111111";
    const targetB = "bbbbbbbb-2222-2222-2222-222222222222";

    for (const command of ["forget", "correct", "share"]) {
      const confirmationStore = new Map();
      const confirmationIndex = new Map();
      const nonceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
      const nonceB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
      const pendingA = {
        nonce: nonceA,
        ...identity,
        command,
        targetId: targetA,
        expiresAt: Date.now() + 60_000,
        callbackData: `${command}:confirm:${nonceA}:${targetA}`,
      };
      const pendingB = {
        nonce: nonceB,
        ...identity,
        command,
        targetId: targetB,
        expiresAt: Date.now() + 60_000,
        callbackData: `${command}:confirm:${nonceB}:${targetB}`,
      };
      pluginModule.rememberPendingConfirmation(confirmationStore, confirmationIndex, pendingA);
      pluginModule.rememberPendingConfirmation(confirmationStore, confirmationIndex, pendingB);

      const short = pluginModule.parseConfirmationCommand(`confirm ${nonceA.slice(0, 8)}`);
      assert.equal(short.requested, true);
      assert.equal(short.nonce, "");
      assert.equal(confirmationStore.size, 2, `${command}: shortened prefix must not consume`);

      const altered = `${nonceA.slice(0, -1)}3`;
      const alteredResult = pluginModule.completePendingConfirmation({
        confirmationIndex,
        confirmationStore,
        expectedCommand: command,
        memoryCtx,
        nonce: altered,
      });
      assert.equal(alteredResult.error, "not_found_or_expired");
      assert.equal(confirmationStore.size, 2, `${command}: altered suffix must not consume`);

      confirmationIndex.set(nonceA, `${nonceA}:${targetB}`);
      const wrongTarget = pluginModule.completePendingConfirmation({
        confirmationIndex,
        confirmationStore,
        expectedCommand: command,
        memoryCtx,
        nonce: nonceA,
      });
      assert.equal(wrongTarget.error, "not_found_or_expired");
      assert.equal(confirmationStore.has(`${nonceA}:${targetA}`), true, `${command}: another target must not consume`);
      confirmationIndex.set(nonceA, `${nonceA}:${targetA}`);

      const exact = pluginModule.completePendingConfirmation({
        confirmationIndex,
        confirmationStore,
        expectedCommand: command,
        memoryCtx,
        nonce: nonceA,
      });
      assert.equal(exact.pending, pendingA);
      assert.equal(confirmationStore.has(`${nonceA}:${targetA}`), false, `${command}: exact redemption is one-time`);
      const replay = pluginModule.completePendingConfirmation({
        confirmationIndex,
        confirmationStore,
        expectedCommand: command,
        memoryCtx,
        nonce: nonceA,
      });
      assert.equal(replay.error, "not_found_or_expired");
      assert.equal(confirmationStore.has(`${nonceB}:${targetB}`), true, `${command}: ambiguous shared prefix must retain the other nonce`);

      pendingB.expiresAt = Date.now() - 1;
      const expired = pluginModule.completePendingConfirmation({
        confirmationIndex,
        confirmationStore,
        expectedCommand: command,
        memoryCtx,
        nonce: nonceB,
      });
      assert.equal(expired.error, "security.expired");
      assert.equal(confirmationStore.has(`${nonceB}:${targetB}`), false, `${command}: expiry must consume only the expired nonce`);
      assert.equal(confirmationIndex.has(nonceB), false, `${command}: expiry lookup must clear the nonce index too`);
      assert.equal(confirmationStore.size, confirmationIndex.size, `${command}: expiry lookup must retain atomic map sizes`);
    }
  });

  it("prunes expired pending confirmations from both indexes before insertion and lookup", async () => {
    requireConfirmationHelpers();
    const memoryCtx = await officialMemoryContext();
    const identity = pluginModule.resolveConfirmationIdentity(memoryCtx);
    const confirmationStore = new Map();
    const confirmationIndex = new Map();
    const expired = {
      nonce: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      ...identity,
      command: "forget",
      targetId: "eeeeeeee-1111-1111-1111-111111111111",
      expiresAt: Date.now() - 1,
      callbackData: "forget:confirm:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:eeeeeeee-1111-1111-1111-111111111111",
    };
    pluginModule.rememberPendingConfirmation(confirmationStore, confirmationIndex, expired);

    const live = {
      nonce: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      ...identity,
      command: "forget",
      targetId: "ffffffff-1111-1111-1111-111111111111",
      expiresAt: Date.now() + 60_000,
      callbackData: "forget:confirm:ffffffff-ffff-4fff-8fff-ffffffffffff:ffffffff-1111-1111-1111-111111111111",
    };
    pluginModule.rememberPendingConfirmation(confirmationStore, confirmationIndex, live);

    assert.equal(confirmationStore.has(`${expired.nonce}:${expired.targetId}`), false);
    assert.equal(confirmationIndex.has(expired.nonce), false);
    assert.equal(confirmationStore.size, confirmationIndex.size);

    const exact = pluginModule.completePendingConfirmation({
      confirmationStore,
      confirmationIndex,
      expectedCommand: "forget",
      memoryCtx,
      nonce: live.nonce,
    });
    assert.equal(exact.pending, live, "later exact redemption must remain intact");
    assert.equal(confirmationStore.size, confirmationIndex.size);
  });

  it("caps pending confirmations at 1024 and evicts the oldest record atomically", async () => {
    requireConfirmationHelpers();
    const memoryCtx = await officialMemoryContext();
    const identity = pluginModule.resolveConfirmationIdentity(memoryCtx);
    const confirmationStore = new Map();
    const confirmationIndex = new Map();
    const pending = Array.from({ length: 1025 }, (_, index) => {
      const suffix = index.toString(16).padStart(12, "0");
      const nonce = `00000000-0000-4000-8000-${suffix}`;
      const targetId = `00000000-0000-4000-8001-${suffix}`;
      return {
        nonce,
        ...identity,
        command: "forget",
        targetId,
        expiresAt: Date.now() + 60_000,
        callbackData: `forget:confirm:${nonce}:${targetId}`,
      };
    });

    for (const entry of pending) {
      pluginModule.rememberPendingConfirmation(confirmationStore, confirmationIndex, entry);
    }

    assert.equal(confirmationStore.size, 1024);
    assert.equal(confirmationIndex.size, 1024);
    assert.equal(confirmationStore.has(`${pending[0].nonce}:${pending[0].targetId}`), false);
    assert.equal(confirmationIndex.has(pending[0].nonce), false);

    const exact = pluginModule.completePendingConfirmation({
      confirmationStore,
      confirmationIndex,
      expectedCommand: "forget",
      memoryCtx,
      nonce: pending[1].nonce,
    });
    assert.equal(exact.pending, pending[1], "eviction must not corrupt later exact redemption");
    assert.equal(confirmationStore.size, confirmationIndex.size);
  });

  it("binds create and completion to canonical host user and conversation context", async () => {
    requireConfirmationHelpers();
    const ownerCtx = await officialMemoryContext();
    const identity = pluginModule.resolveConfirmationIdentity(ownerCtx);
    assert.deepStrictEqual(identity, {
      userId: ownerCtx.userId,
      chatId: ownerCtx.conversationPrincipal,
    });

    const confirmationStore = new Map();
    const confirmationIndex = new Map();
    const pending = createConfirmation({
      ...identity,
      command: "forget",
      targetId: "cccccccc-3333-3333-3333-333333333333",
    });
    pluginModule.rememberPendingConfirmation(confirmationStore, confirmationIndex, pending);

    const mismatches = [
      await officialMemoryContext({ threadId: "thread-b" }),
      await officialMemoryContext({ accountId: "account-b" }),
      await officialMemoryContext({ sessionId: "session-b" }),
      await officialMemoryContext({ senderId: "user-b" }),
      await officialMemoryContext({ chatId: "chat-b" }),
    ];
    for (const mismatchCtx of mismatches) {
      const result = pluginModule.completePendingConfirmation({
        confirmationIndex,
        confirmationStore,
        expectedCommand: "forget",
        memoryCtx: mismatchCtx,
        nonce: pending.nonce,
      });
      assert.ok(result.error, "cross-context redemption must fail");
      assert.equal(confirmationStore.has(`${pending.nonce}:${pending.targetId}`), true, "failed redemption must not consume");
    }

    const matching = pluginModule.completePendingConfirmation({
      confirmationIndex,
      confirmationStore,
      expectedCommand: "forget",
      memoryCtx: ownerCtx,
      nonce: pending.nonce,
    });
    assert.equal(matching.pending, pending);
  });

  it("/correct preserves canonical workspace ownership and replacement visibility", async () => {
    const ownerCtx = await officialMemoryContext();
    const otherWorkspace = mkdtempSync(join(tmpdir(), "p1b-correct-other-"));
    const otherWorkspaceCtx = await officialMemoryContext({
      workspaceDir: otherWorkspace,
      workspaceKey: "workspace:v1:ws-b",
    });
    const id = "dddddddd-4444-4444-4444-444444444444";
    const oldRow = {
      id,
      text: "old workspace fact",
      summary: "old workspace fact",
      vector: [1, 0],
      status: "active",
      versionNumber: 1,
      scope: "workspace",
      agentId: "agent-a",
      storedBy: "agent-a",
      workspaceId: "workspace:v1:ws-a",
      workspaceKey: "workspace:v1:ws-a",
      ownerUserId: "",
    };
    const adapterDb = mockDb([oldRow]);
    const rawRows = new Map([[id, oldRow]]);
    const order = [];
    let replacement;
    const rawDb = {
      async getById(memoryId) {
        return rawRows.get(memoryId) || null;
      },
      async store(entry) {
        order.push("store");
        replacement = entry;
        rawRows.set(entry.id, entry);
      },
      async update(memoryId, patch) {
        order.push("supersede");
        rawRows.set(memoryId, { ...rawRows.get(memoryId), ...patch });
      },
    };

    const result = await correctCard(adapterDb, "agent-a", id, "new workspace fact", {
      archiveDir,
      ctx: ownerCtx,
      updateMemory: async ({ id: memoryId, newContent, archivePath }) => {
        assert.equal(existsSync(archivePath), true, "archive must exist before correction update");
        await safeUpdate(rawDb, memoryId, {
          text: newContent,
          summary: newContent,
          vector: [1, 0],
        }, {
          updateSource: "telegram:/correct",
          updateEvidence: "confirmed correction",
          confidence: 1,
        }, {
          workspaceAliases: ownerCtx.workspaceAliases,
          skipDriftGate: true,
        });
      },
    });

    assert.equal(result.ok, true);
    assert.deepStrictEqual(order, ["store", "supersede"]);
    assert.equal(replacement.workspaceId, "workspace:v1:ws-a");
    assert.equal(replacement.workspaceKey, "workspace:v1:ws-a");
    assert.equal(checkAccess(ownerCtx, replacement).allowed, true);
    assert.equal(checkAccess(otherWorkspaceCtx, replacement).allowed, false);
  });

  it("registered handlers use canonical confirmation helpers without identity fallback or prefix scans", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    const forgetStart = source.indexOf("const runForgetCommand");
    const correctEnd = source.indexOf("const runMemoryFeedbackCommand", forgetStart);
    const handlers = source.slice(forgetStart, correctEnd);
    assert.match(
      handlers,
      /const memoryCtx = (?:suppliedMemoryCtx \|\| )?await resolveRegisteredMemoryContext\(commandCtx\);[\s\S]*?checkMemoryAuth\(memoryCtx, commandCtx/,
      "canonical context must resolve before authorization",
    );
    assert.match(handlers, /resolveConfirmationIdentity\(memoryCtx\)/);
    assert.match(handlers, /completePendingConfirmation\(/);
    assert.doesNotMatch(handlers, /resolveIdentity\(/);
    assert.doesNotMatch(handlers, /nonce\.startsWith\(token\)/);
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
    const privatePool = { async withWriteDb(_agent, fn) { return fn({ init: async () => {}, getById: async () => ({ id, text: "User API password is abc", category: "access/password", agentId: "default", status: "active" }) }); } };
    const sharedPool = {};

    const denied = await shareCard(privatePool, sharedPool, { embed: async () => [1] }, "default", id, { ctx: { agentId: "default", workspaceIdentity: "ws" } });
    assert.strictEqual(denied.ok, false);
    assert.match(denied.error, /explicit approval/i);
  });

  it("shareCard blocks core memories even when category looks ordinary", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    const privatePool = { async withWriteDb(_agent, fn) { return fn({ init: async () => {}, getById: async () => ({ id, text: "Core behavioral rule", category: "note", memoryClass: "core", agentId: "default", status: "active" }) }); } };

    const denied = await shareCard(privatePool, {}, { embed: async () => [1] }, "default", id, { ctx: { agentId: "default", workspaceIdentity: "ws" } });
    assert.strictEqual(denied.ok, false);
    assert.match(denied.error, /explicit approval|sensitive shared memory/i);
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
    const privatePool = { async withWriteDb(_agent, fn) { return fn({ init: async () => {}, getById: async () => ({ id, text: "ordinary note", category: "note", agentId: "default", status: "active" }) }); } };
    const sharedPool = { async withWorkspaceDb(_ctx, _fn) { throw new Error("sqlite file /private/cache/shared.db"); } };

    const result = await shareCard(privatePool, sharedPool, { embed: async () => [1] }, "default", id, { ctx: { agentId: "default", workspaceIdentity: "ws" } });

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
    const owner = `user:v1:${"a".repeat(64)}`;
    const db = mockDb([{ id, text: "user-scoped note", scope: "user", ownerUserId: owner }]);

    const result = await forgetCard(db, "default", id, {
      archiveDir,
      ctx: { agentId: "default", userPrincipal: `user:v1:${"b".repeat(64)}`, workspaceDir: archiveDir },
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /access denied|acl\.user\.mismatch/i);
    assert.strictEqual(db.cards.has(id), true, "foreign user must not delete the card");
  });

  it("forgetCard still allows the owning user to tombstone a user-scoped memory", async () => {
    const id = "bbbbbbbb-2222-2222-2222-222222222222";
    const owner = `user:v1:${"a".repeat(64)}`;
    const db = mockDb([{ id, text: "user-scoped note", scope: "user", ownerUserId: owner }]);

    const result = await forgetCard(db, "default", id, {
      archiveDir,
      workspaceDir: archiveDir,
      ctx: { agentId: "default", userPrincipal: owner, workspaceDir: archiveDir },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(db.cards.has(id), true, "tombstone keeps the row");
    assert.strictEqual(db.cards.get(id).status, "deleted");
  });
});
