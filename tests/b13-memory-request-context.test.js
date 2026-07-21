import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { INPUT_LIMITS } from "../lib/input-limits.js";
import {
  buildMemoryAccountTopology,
  buildMemoryWorkspaceAliases,
  createHostRoutingLoader,
  createMemoryTurnRouteRegistry,
  resolveHostCommandMemoryContext,
  resolveHostHookMemoryContext,
  resolveMemoryRequestContext,
  resolveToolMemoryRequestContext,
  stableIdentityHash,
  userPoolKey,
  workspacePoolKey,
} from "../lib/memory-request-context.js";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    const match = /^(.*):thread:([^:]+)$/.exec(value);
    return match ? { baseSessionKey: match[1], threadId: match[2] } : { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

describe("B13 canonical memory request context", () => {
  it("canonicalizes one workspace truth and freezes the complete tuple", () => {
    const ctx = resolveMemoryRequestContext({
      agentId: "agent-a",
      workspaceId: "workspace-id",
      workspaceKey: "workspace-id",
      channel: "telegram",
      accountId: "primary",
      userId: "owner-a",
      chatId: "chat-a",
    });
    assert.equal(ctx.workspaceId, "workspace:v1:workspace-id");
    assert.equal(ctx.workspaceIdentity, ctx.workspaceId);
    assert.match(ctx.userPrincipal, /^user:v1:[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(ctx), true);
    assert.equal(Object.isFrozen(ctx.workspaceAliases), true);
  });

  it("rejects conflicting workspace aliases before routing", () => {
    assert.throws(() => resolveMemoryRequestContext({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      workspaceKey: "workspace-b",
    }), /conflicting workspace identity/);
  });

  it("accepts configured path and aliases only when they resolve to one target", (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-context-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const workspaceAliases = Object.freeze({
      paths: Object.freeze([{ path: realpathSync(workspaceDir), workspaceKey: "canonical-a" }]),
      aliases: Object.freeze([{ alias: "workspace-a", workspaceKey: "canonical-a" }]),
    });
    const ctx = resolveMemoryRequestContext({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      workspaceDir,
    }, { workspaceAliases });
    assert.equal(ctx.workspaceIdentity, "workspace:v1:canonical-a");
  });

  it("hashes principals into safe AgentDbPool keys of exactly 64 chars", () => {
    const key = workspacePoolKey("dir:/tmp/a/../../secret");
    assert.match(key, /^w-[a-f0-9]{62}$/);
    assert.equal(key.length, 64);
    assert.match(userPoolKey("user:v1:8d4c2f"), /^u-[a-f0-9]{62}$/);
    assert.doesNotMatch(key, /secret|\.\./);
    assert.equal(stableIdentityHash("x").length, 64);
  });

  it("keeps equal raw user ids isolated by channel and account", () => {
    const a = resolveMemoryRequestContext({ agentId: "a", channel: "telegram", accountId: "one", userId: "42" });
    const b = resolveMemoryRequestContext({ agentId: "a", channel: "telegram", accountId: "two", userId: "42" });
    const c = resolveMemoryRequestContext({ agentId: "a", channel: "discord", accountId: "one", userId: "42" });
    assert.notEqual(a.userPrincipal, b.userPrincipal);
    assert.notEqual(a.userPrincipal, c.userPrincipal);
  });

  it("requires explicit agent and channel/account user proof", () => {
    assert.throws(() => resolveMemoryRequestContext({}), /agentId is required/);
    assert.throws(() => resolveMemoryRequestContext({ agentId: "a", userId: "42" }, { requireUser: true }), /channel\/account-bound/);
    assert.throws(() => resolveMemoryRequestContext({ agentId: "../default" }), /Invalid agent ID/);
  });

  it("rejects invalid identity types and every named over-limit field", () => {
    for (const value of [{}, true, Infinity, NaN]) {
      assert.throws(() => resolveMemoryRequestContext({ agentId: "a", userId: value }), /userId/);
    }
    const fields = [
      ["agentId", INPUT_LIMITS.AGENT_ID], ["userId", INPUT_LIMITS.USER_ID], ["chatId", INPUT_LIMITS.CHAT_ID],
      ["channel", INPUT_LIMITS.CHANNEL_ID], ["accountId", INPUT_LIMITS.ACCOUNT_ID],
      ["sessionKey", INPUT_LIMITS.SESSION_KEY], ["sessionId", INPUT_LIMITS.SESSION_ID],
      ["conversationPrincipal", INPUT_LIMITS.PRINCIPAL],
    ];
    for (const [field, limit] of fields) {
      const input = { agentId: "a", [field]: "x".repeat(limit + 1) };
      assert.throws(() => resolveMemoryRequestContext(input), /exceeds maximum length/);
    }
  });

  it("loads and validates only the four public routing functions lazily", async () => {
    let calls = 0;
    const loader = createHostRoutingLoader({ importRouting: async () => { calls++; return routingCapability; } });
    assert.equal(calls, 0);
    const loaded = await loader();
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(loaded.parseAgentSessionKey, routingCapability.parseAgentSessionKey);
    assert.equal(await loader(), loaded);
    assert.equal(calls, 1);
    const malformed = createHostRoutingLoader({ importRouting: async () => ({}) });
    await assert.rejects(() => malformed(), /routing capability/);
  });

  it("resolves official command and tool fields without synthetic identity fallbacks", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-host-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const aliases = Object.freeze({ paths: Object.freeze([{ path: realpathSync(workspaceDir), workspaceKey: "ws-a" }]), aliases: Object.freeze([]) });
    const ctx = await resolveHostCommandMemoryContext({
      senderId: "42", channel: "telegram", accountId: "primary", agentId: "agent-a",
      sessionKey: "agent:agent-a:telegram:direct:chat-a", sessionId: "session-a",
      from: "telegram:chat-a", to: "telegram:chat-a", getCurrentConversationBinding: () => null,
    }, {
      resolveAgentWorkspaceDir: async () => workspaceDir,
      workspaceAliases: aliases,
      routingLoader: async () => routingCapability,
      requireConversation: true,
    });
    assert.equal(ctx.workspaceIdentity, "workspace:v1:ws-a");
    assert.equal(ctx.chatId, "chat-a");
    assert.equal(ctx.chatKind, "private");
    assert.match(ctx.userPrincipal, /^user:v1:/);
    assert.match(ctx.conversationPrincipal, /^conversation:v1:/);

    const tool = resolveToolMemoryRequestContext({
      agentId: "agent-a", messageChannel: "telegram", agentAccountId: "primary",
      requesterSenderId: "42", deliveryContext: { to: "telegram:chat-a" }, workspaceDir,
    }, { workspaceAliases: aliases, requireUser: true });
    assert.equal(tool.userPrincipal, ctx.userPrincipal);
  });

  it("builds conservative account topology and excludes slash dispatches", () => {
    const topology = buildMemoryAccountTopology({ channels: { telegram: { accounts: { primary: {} } } } });
    assert.equal(Object.isFrozen(topology), true);
    assert.equal(topology.providers.telegram.ambiguous, true, "implicit default plus named account is ambiguous");
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    assert.equal(registry.observeReplyDispatch({ CommandBody: "/memory", sessionKey: "agent:a:telegram:direct:c" }), undefined);
    assert.equal(registry.pendingCount(), 0);
  });

  it("rejects raw duplicate workspace declarations before a Map can collapse them", () => {
    assert.throws(() => buildMemoryWorkspaceAliases({
      workspaceAliases: [
        { alias: "same", workspaceKey: "target-a" },
        { alias: "same", workspaceKey: "target-b" },
      ],
    }), /conflicting workspace alias declaration/);
    const equal = buildMemoryWorkspaceAliases({
      workspaceAliases: [
        { alias: "same", workspaceKey: "target-a" },
        { alias: "same", workspaceKey: "target-a" },
      ],
    });
    assert.deepEqual(equal.aliases, [{ alias: "same", workspaceKey: "workspace:v1:target-a" }]);
  });

  it("joins a real reply_dispatch ticket to the latest prompt session without retaining text", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-hook-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    assert.equal(registry.observeReplyDispatch({
      runId: "run-a",
      sessionKey: "agent:a:telegram:direct:chat-a",
      originatingChannel: "telegram",
      originatingTo: "chat-a",
      originatingAccountId: "default",
      ctx: {
        AgentId: "a",
        SessionKey: "agent:a:telegram:direct:chat-a",
        AccountId: "default",
        SenderId: "42",
        Provider: "telegram",
        ChatId: "chat-a",
        CommandBody: "ordinary message",
      },
    }), undefined);
    assert.equal(registry.pendingCount(), 1);
    const ctx = await resolveHostHookMemoryContext({
      runId: "run-a",
      agentId: "a",
      sessionKey: "agent:a:telegram:direct:chat-a",
      sessionId: "session-a",
      workspaceDir,
      messageProvider: "telegram",
      senderId: "42",
      chatId: "chat-a",
      channelContext: { sender: { id: "42" }, chat: { id: "chat-a" } },
    }, {
      routingCapability,
      turnRoutes: registry,
      accountTopology: buildMemoryAccountTopology({ channels: { telegram: {} } }),
      getSessionEntry: ({ agentId, sessionKey, readConsistency }) => {
        assert.deepEqual({ agentId, sessionKey, readConsistency }, {
          agentId: "a", sessionKey: "agent:a:telegram:direct:chat-a", readConsistency: "latest",
        });
        return {
          sessionId: "session-a",
          deliveryContext: { channel: "telegram", accountId: "default", to: "chat-a" },
          lastChannel: "telegram", lastAccountId: "default", lastTo: "chat-a",
        };
      },
    });
    assert.match(ctx.userPrincipal, /^user:v1:[a-f0-9]{64}$/);
    assert.equal(ctx.accountId, "default");
    assert.equal(registry.pendingCount(), 0);
  });
});
