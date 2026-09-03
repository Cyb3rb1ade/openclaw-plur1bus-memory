import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handleObsidianBridgeCommand } from "../lib/obsidian-control-room.js";
import {
  confirmVaultConfirmation,
  prepareVaultConfirmation,
} from "../lib/obsidian-vault-confirmation-flow.js";
import { isOwnedVaultConfirmed } from "../lib/obsidian-vault-authority.js";

const aliases = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });

function memoryCtx(overrides = {}) {
  return {
    agentId: "agent-a",
    workspaceIdentity: "workspace:v1:workspace-a",
    workspaceId: "workspace:v1:workspace-a",
    userId: "owner",
    userPrincipal: "user:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    conversationPrincipal: "conversation:v1:owner-chat",
    chatId: "owner-chat",
    chatKind: "private",
    workspaceAliases: aliases,
    ...overrides,
  };
}

describe("B14 public protected vault confirmation", () => {
  it("writes only for one exact user/chat/agent/workspace/vault confirmation", () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-vault-confirm-db-"));
    const vaultPath = mkdtempSync(join(tmpdir(), "b14-vault-confirm-vault-"));
    const otherVault = mkdtempSync(join(tmpdir(), "b14-vault-confirm-other-"));
    const confirmationStore = new Map();
    const ctx = memoryCtx();
    const prepared = prepareVaultConfirmation({
      baseDbPath,
      memoryCtx: ctx,
      vaultPath,
      confirmationStore,
    });

    assert.equal(prepared.ok, true);
    assert.match(prepared.nonce, /^[0-9a-f-]{36}$/);
    assert.deepEqual(readdirSync(baseDbPath), []);
    for (const invalid of [
      { memoryCtx: memoryCtx({ userId: "attacker" }), vaultPath },
      { memoryCtx: memoryCtx({ conversationPrincipal: "conversation:v1:other" }), vaultPath },
      { memoryCtx: memoryCtx({ agentId: "agent-b" }), vaultPath },
      { memoryCtx: memoryCtx({ workspaceIdentity: "workspace:v1:workspace-b" }), vaultPath },
      { memoryCtx: ctx, vaultPath: otherVault },
    ]) {
      const result = confirmVaultConfirmation({
        callbackData: prepared.callbackData,
        confirmationStore,
        baseDbPath,
        ...invalid,
      });
      assert.equal(result.ok, false);
      assert.deepEqual(readdirSync(baseDbPath), []);
    }

    const confirmed = confirmVaultConfirmation({
      callbackData: prepared.callbackData,
      confirmationStore,
      baseDbPath,
      memoryCtx: ctx,
      vaultPath,
    });
    assert.equal(confirmed.ok, true);
    assert.equal(isOwnedVaultConfirmed({ baseDbPath, memoryCtx: ctx, vaultPath }), true);

    const replay = confirmVaultConfirmation({
      callbackData: prepared.callbackData,
      confirmationStore,
      baseDbPath,
      memoryCtx: ctx,
      vaultPath,
    });
    assert.equal(replay.ok, false);
  });

  it("rejects expiry without writing and exposes prepare/confirm through the public handler", async () => {
    const expiredBase = mkdtempSync(join(tmpdir(), "b14-vault-expired-db-"));
    const expiredVault = mkdtempSync(join(tmpdir(), "b14-vault-expired-vault-"));
    const expiredStore = new Map();
    const ctx = memoryCtx();
    const expired = prepareVaultConfirmation({
      baseDbPath: expiredBase,
      memoryCtx: ctx,
      vaultPath: expiredVault,
      confirmationStore: expiredStore,
      expiryMinutes: -1,
    });
    const expiredResult = confirmVaultConfirmation({
      callbackData: expired.callbackData,
      confirmationStore: expiredStore,
      baseDbPath: expiredBase,
      memoryCtx: ctx,
      vaultPath: expiredVault,
    });
    assert.equal(expiredResult.ok, false);
    assert.deepEqual(readdirSync(expiredBase), []);

    const baseDbPath = mkdtempSync(join(tmpdir(), "b14-vault-public-db-"));
    const vaultPath = mkdtempSync(join(tmpdir(), "b14-vault-public-vault-"));
    const confirmationStore = new Map();
    const context = {
      config: { mode: "apply", allowWrite: true, vaultPath },
      baseDbPath,
      memoryCtx: ctx,
      commandCtx: {
        agentId: ctx.agentId,
        userId: ctx.userId,
        senderId: ctx.userId,
        chatId: ctx.chatId,
        chatType: "private",
        chatKind: "private",
      },
      pluginConfig: {
        baseDbPath,
        security: { allowedUserIds: ["owner"] },
      },
      confirmationStore,
      vaultConfirmed: false,
    };
    const prepareResult = await handleObsidianBridgeCommand(["vault-confirm", "prepare"], context);
    const preparePayload = JSON.parse(prepareResult.text);
    assert.equal(preparePayload.ok, true);
    assert.deepEqual(readdirSync(baseDbPath), []);

    const confirmResult = await handleObsidianBridgeCommand(
      ["vault-confirm", "confirm", preparePayload.nonce],
      context,
    );
    const confirmPayload = JSON.parse(confirmResult.text);
    assert.equal(confirmPayload.ok, true);
    assert.equal(isOwnedVaultConfirmed({ baseDbPath, memoryCtx: ctx, vaultPath }), true);
  });
});

describe("binding mismatch names its fields", () => {
  const base = {
    userId: "42",
    userPrincipal: "telegram:42",
    conversationPrincipal: "telegram:chat-7",
    agentId: "lab-alpha",
    workspaceIdentity: "workspace:v1:lab-alpha",
  };

  function prepared(vaultPath, baseDbPath, memoryCtx) {
    const confirmationStore = new Map();
    const p = prepareVaultConfirmation({ baseDbPath, memoryCtx, vaultPath, confirmationStore });
    assert.equal(p.ok, true);
    return { confirmationStore, callbackData: p.callbackData };
  }

  it("names only the field that moved between prepare and confirm", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-bind-"));
    const vaultPath = join(dir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    const { confirmationStore, callbackData } = prepared(vaultPath, dir, base);
    const result = confirmVaultConfirmation({
      callbackData,
      confirmationStore,
      baseDbPath: dir,
      vaultPath,
      // Same actor, same agent -- only the conversation differs.
      memoryCtx: { ...base, conversationPrincipal: "telegram:chat-8" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "binding_mismatch");
    assert.deepEqual(result.mismatchedFields, ["conversationPrincipal"]);
  });

  it("names every field that moved, and no values", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-bind-"));
    const vaultPath = join(dir, "vault");
    mkdirSync(vaultPath, { recursive: true });
    const { confirmationStore, callbackData } = prepared(vaultPath, dir, base);
    const result = confirmVaultConfirmation({
      callbackData,
      confirmationStore,
      baseDbPath: dir,
      vaultPath,
      memoryCtx: { ...base, userId: "99", userPrincipal: "telegram:99" },
    });
    assert.deepEqual(result.mismatchedFields, ["userId", "userPrincipal"]);
    assert.doesNotMatch(JSON.stringify(result), /telegram:99|telegram:42|chat-7/u, "leaks a bound value");
  });
});
