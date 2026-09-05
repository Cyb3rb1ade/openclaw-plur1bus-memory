import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

import { INPUT_LIMITS } from "../lib/input-limits.js";
import { createConfirmation, validateConfirmation } from "../lib/security.js";
import {
  buildMemoryAccountTopology,
  buildMemoryWorkspaceAliases,
  createHostIncognitoSessionClassifier,
  createHostRoutingLoader,
  createMemoryTurnRouteRegistry,
  normalizeAndFreezeWorkspaceAliases,
  resolveHostCommandMemoryContext,
  resolveHostHookMemoryContext,
  resolveMemoryRequestContext,
  resolveToolMemoryRequestContext,
  stableIdentityHash,
  userPoolKey,
  workspacePoolKey,
  describeDirectSessionRoute,
  describeUserPoolLabels,
  describeWorkspacePoolLabels,
  resolveSessionOwnerMemoryContext,
} from "../lib/memory-request-context.js";
import { buildNeoWorkspaceAliases } from "../lib/neo-arch.js";

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
  isIncognitoSessionKey(value) {
    return /^agent:[^:]+:dashboard:incognito-[^:]+$/u.test(String(value || ""));
  },
});

function dispatchFixture({
  runId = "run-a",
  sessionKey = "agent:a:telegram:direct:chat-a",
  senderId = "42",
  chatId = "chat-a",
  accountId = "default",
  threadId = "",
  commandTurn,
} = {}) {
  return {
    ...(runId ? { runId } : {}),
    sessionKey,
    originatingChannel: "telegram",
    originatingTo: `telegram:${chatId}`,
    originatingAccountId: accountId,
    ...(threadId ? { originatingThreadId: threadId } : {}),
    ctx: {
      AgentId: "a",
      SessionKey: sessionKey,
      AccountId: accountId,
      SenderId: senderId,
      Provider: "telegram",
      OriginatingChannel: "telegram",
      ChatId: chatId,
      OriginatingTo: `telegram:${chatId}`,
      ...(threadId ? { MessageThreadId: threadId } : {}),
      CommandBody: commandTurn?.body ?? "ordinary message",
      ...(commandTurn ? { CommandTurn: commandTurn } : {}),
    },
  };
}

function hookFixture({
  runId = "run-a",
  sessionKey = "agent:a:telegram:direct:chat-a",
  sessionId = "session-a",
  senderId = "42",
  chatId = "chat-a",
  threadId = "",
  workspaceDir,
} = {}) {
  return {
    runId,
    agentId: "a",
    sessionKey,
    sessionId,
    workspaceDir,
    messageProvider: "telegram",
    senderId,
    chatId,
    ...(threadId ? { messageThreadId: threadId } : {}),
    channelContext: {
      sender: { id: senderId },
      chat: { id: chatId },
    },
  };
}

function sessionEntryFixture({
  sessionId = "session-a",
  accountId = "default",
  chatId = "chat-a",
  threadId = "",
} = {}) {
  const to = threadId ? `telegram:group:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  return {
    sessionId,
    deliveryContext: { channel: "telegram", accountId, to, ...(threadId ? { threadId } : {}) },
    origin: { provider: "telegram", accountId, to, ...(threadId ? { threadId } : {}) },
    lastChannel: "telegram",
    lastAccountId: accountId,
    lastTo: to,
    ...(threadId ? { lastThreadId: threadId } : {}),
  };
}

function resolveHook(hookCtx, registry, entry, accountTopology = buildMemoryAccountTopology({ channels: { telegram: {} } })) {
  return resolveHostHookMemoryContext(hookCtx, {
    routingCapability,
    turnRoutes: registry,
    accountTopology,
    getSessionEntry: () => entry,
  });
}

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

  it("accepts safe integers only for transport ids and requires strings elsewhere", () => {
    const transport = resolveMemoryRequestContext({
      agentId: "a",
      channel: "telegram",
      accountId: "default",
      userId: 42,
      chatId: -100123,
    });
    assert.equal(transport.userId, "42");
    assert.equal(transport.chatId, "-100123");
    for (const field of ["agentId", "workspaceId", "workspaceKey", "channel", "accountId", "sessionKey", "sessionId", "conversationPrincipal"]) {
      assert.throws(() => resolveMemoryRequestContext({ agentId: "a", [field]: 7 }), new RegExp(field));
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
    let workspaceCalls = 0;
    await assert.rejects(() => resolveHostCommandMemoryContext({ agentId: "a" }, {
      routingLoader: async () => { throw new Error("loader failed"); },
      resolveAgentWorkspaceDir: async () => { workspaceCalls++; return "/unused"; },
    }), /loader failed/);
    assert.equal(workspaceCalls, 0);
    const source = readFileSync(new URL("../lib/memory-request-context.js", import.meta.url), "utf8");
    assert.match(source, /import\("openclaw\/plugin-sdk\/routing"\)/);
    assert.doesNotMatch(source, /^import .*openclaw\/plugin-sdk\/routing/m);
  });

  it("loads, validates, and memoizes the public incognito classifier lazily", async () => {
    let calls = 0;
    const classify = createHostIncognitoSessionClassifier({
      importRouting: async () => {
        calls += 1;
        return routingCapability;
      },
    });
    assert.equal(calls, 0);
    assert.equal(await classify("agent:a:main"), false);
    assert.equal(await classify("agent:a:dashboard:incognito-review"), true);
    assert.equal(calls, 1);

    const malformed = createHostIncognitoSessionClassifier({ importRouting: async () => ({}) });
    await assert.rejects(() => malformed("agent:a:main"), /incognito session classifier/);
  });

  it("does not cache a failed classifier load, so a later attempt can recover", async () => {
    // A cached rejection would fail closed forever and silently disable
    // durable capture for the whole gateway lifetime.
    let calls = 0;
    const classify = createHostIncognitoSessionClassifier({
      importRouting: async () => {
        calls += 1;
        if (calls === 1) throw new Error("routing import unavailable");
        return routingCapability;
      },
    });

    await assert.rejects(() => classify("agent:a:main"), /routing import unavailable/);
    assert.equal(await classify("agent:a:main"), false, "the retry must load the classifier");
    assert.equal(await classify("agent:a:dashboard:incognito-review"), true);
    assert.equal(calls, 2, "the healed load is memoized again");
  });

  it("decodes the closed Telegram, Discord, Slack, and Mattermost command route grammar", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-providers-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const cases = [
      { provider: "telegram", sessionKey: "agent:a:main", from: "telegram:user-a", to: "telegram:user-a", chatId: "user-a", kind: "private" },
      { provider: "discord", sessionKey: "agent:a:discord:channel:chan-a", from: "discord:channel:chan-a", to: "discord:channel:chan-a", chatId: "chan-a", kind: "group" },
      { provider: "slack", sessionKey: "agent:a:direct:user-a", from: "slack:user-a", to: "slack:user-a", chatId: "user-a", kind: "private" },
      { provider: "mattermost", sessionKey: "agent:a:mattermost:group:team-a", from: "mattermost:group:team-a", to: "mattermost:group:team-a", chatId: "team-a", kind: "group" },
      { provider: "telegram", sessionKey: "agent:a:telegram:group:-100:topic:77", from: "telegram:group:-100:topic:77", to: "telegram:group:-100:topic:77", chatId: "-100", kind: "group", threadId: "77" },
    ];
    for (const fixture of cases) {
      const ctx = await resolveHostCommandMemoryContext({
        senderId: "42",
        channel: fixture.provider,
        accountId: "default",
        agentId: "a",
        sessionKey: fixture.sessionKey,
        from: fixture.from,
        to: fixture.to,
        ...(fixture.threadId ? { messageThreadId: fixture.threadId, threadParentId: fixture.chatId } : {}),
        getCurrentConversationBinding: () => null,
      }, {
        resolveAgentWorkspaceDir: async () => workspaceDir,
        routingLoader: async () => routingCapability,
        requireConversation: true,
      });
      assert.equal(ctx.channel, fixture.provider);
      assert.equal(ctx.chatId, fixture.chatId);
      assert.equal(ctx.chatKind, fixture.kind);
    }
  });

  it("accepts official provider-relative Discord user and channel delivery targets", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-discord-relative-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    for (const fixture of [
      { provider: "discord", sessionKey: "agent:a:discord:channel:chan-a", target: "channel:chan-a", chatId: "chan-a" },
      { provider: "discord", sessionKey: "agent:a:discord:direct:user-a", target: "user:user-a", chatId: "user-a" },
    ]) {
      const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
      registry.observeReplyDispatch({
        runId: "run-a",
        sessionKey: fixture.sessionKey,
        originatingChannel: fixture.provider,
        originatingTo: fixture.target,
        originatingAccountId: "default",
        ctx: {
          AgentId: "a", SessionKey: fixture.sessionKey, AccountId: "default", SenderId: "42",
          Provider: fixture.provider, ChatId: fixture.chatId, OriginatingTo: fixture.target,
          CommandBody: "ordinary message",
        },
      });
      assert.equal(registry.pendingCount(), 1, fixture.target);
      const hook = hookFixture({ workspaceDir, sessionKey: fixture.sessionKey, chatId: fixture.chatId });
      hook.messageProvider = fixture.provider;
      const entry = sessionEntryFixture({ chatId: fixture.chatId });
      entry.deliveryContext = { channel: fixture.provider, accountId: "default", to: fixture.target };
      entry.origin = { provider: fixture.provider, accountId: "default", to: fixture.target };
      entry.lastChannel = fixture.provider;
      entry.lastTo = fixture.target;
      const resolved = await resolveHostHookMemoryContext(hook, {
        routingCapability,
        turnRoutes: registry,
        accountTopology: buildMemoryAccountTopology({ channels: { [fixture.provider]: {} } }),
        getSessionEntry: () => entry,
      });
      assert.match(resolved.userPrincipal, /^user:v1:/, fixture.target);
    }
  });

  it("rejects unknown one-part agent session routes", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-closed-session-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    for (const sessionKey of [
      "agent:a:evil",
      "agent:a:direct:user-a:extra",
      "agent:a:discord:channel:chan-a:extra",
      "agent:a:discord:primary:direct:user-a:extra",
    ]) {
      await assert.rejects(() => resolveHostCommandMemoryContext({
        senderId: "42", channel: "telegram", accountId: "default", agentId: "a",
        sessionKey, from: "telegram:42", to: "telegram:42",
        getCurrentConversationBinding: () => null,
      }, {
        resolveAgentWorkspaceDir: async () => workspaceDir,
        routingLoader: async () => routingCapability,
        requireConversation: true,
      }), /session route|grammar/);
    }
  });

  it("rejects malformed, foreign, extra, and conflicting command route aliases", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-route-deny-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const base = {
      senderId: "42", channel: "discord", accountId: "default", agentId: "a",
      sessionKey: "agent:a:discord:channel:chan-a", from: "discord:channel:chan-a",
      to: "discord:channel:chan-a", getCurrentConversationBinding: () => null,
    };
    const resolve = (delta) => resolveHostCommandMemoryContext({ ...base, ...delta }, {
      resolveAgentWorkspaceDir: async () => workspaceDir,
      routingLoader: async () => routingCapability,
      requireConversation: true,
    });
    for (const delta of [
      { agentId: "b" },
      { from: "discord:unknown:chan-a" },
      { to: "telegram:chan-a" },
      { to: "discord:channel:chan-a:extra" },
      { messageThreadId: "77", threadParentId: "other-channel" },
      { accountId: "other", sessionKey: "agent:a:discord:default:direct:chan-a", from: "discord:chan-a", to: "discord:chan-a" },
      { getCurrentConversationBinding: () => ({ channel: "discord", accountId: "default", conversationId: "other" }) },
      { getCurrentConversationBinding: () => ({ accountId: "default", conversationId: "chan-a" }) },
    ]) await assert.rejects(() => resolve(delta), undefined, JSON.stringify(delta));
    const native = await resolve({ to: "slash:42" });
    assert.equal(native.chatId, "chan-a");
  });

  it("binds confirmations field-by-field to the verified host conversation principal", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-confirm-principal-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const base = {
      senderId: "42", channel: "telegram", accountId: "default", agentId: "a",
      sessionKey: "agent:a:telegram:group:chat-a:topic:thread-a", sessionId: "sid-a",
      from: "telegram:group:chat-a:topic:thread-a", to: "telegram:group:chat-a:topic:thread-a",
      messageThreadId: "thread-a", threadParentId: "chat-a",
      getCurrentConversationBinding: () => null,
    };
    const derive = (delta = {}) => resolveHostCommandMemoryContext({ ...base, ...delta }, {
      resolveAgentWorkspaceDir: async () => workspaceDir,
      routingLoader: async () => routingCapability,
      requireConversation: true,
    });
    const original = await derive();
    const corroborated = await derive({
      getCurrentConversationBinding: () => ({
        channel: "telegram", accountId: "default", conversationId: "thread-a",
        parentConversationId: "chat-a", threadId: "thread-a",
      }),
    });
    assert.equal(corroborated.conversationPrincipal, original.conversationPrincipal);
    const variants = [
      { senderId: "99" },
      { agentId: "b", sessionKey: "agent:b:telegram:group:chat-a:topic:thread-a" },
      { sessionKey: "agent:a:main" },
      { sessionId: undefined },
      { accountId: "other" },
      {
        channel: "discord", sessionKey: "agent:a:discord:channel:chat-a",
        from: "discord:channel:chat-a", to: "discord:channel:chat-a",
      },
      {
        sessionKey: "agent:a:telegram:group:chat-b:topic:thread-a",
        from: "telegram:group:chat-b:topic:thread-a", to: "telegram:group:chat-b:topic:thread-a",
        threadParentId: "chat-b",
      },
      {
        sessionKey: "agent:a:telegram:group:chat-a:topic:thread-b",
        from: "telegram:group:chat-a:topic:thread-b", to: "telegram:group:chat-a:topic:thread-b",
        messageThreadId: "thread-b",
      },
    ];
    for (const delta of variants) {
      const changed = await derive(delta);
      const store = new Map();
      const confirmation = createConfirmation({
        userId: original.userId,
        chatId: original.conversationPrincipal,
        command: "forget",
        targetId: "11111111-1111-1111-1111-111111111111",
      });
      store.set(`${confirmation.nonce}:${confirmation.targetId}`, confirmation);
      const validation = validateConfirmation(confirmation.callbackData, store, {
        userId: changed.userId,
        chatId: changed.conversationPrincipal,
      });
      assert.equal(validation.valid, false, JSON.stringify(delta));
    }
    const discord = {
      ...base,
      channel: "discord", sessionKey: "agent:a:main", sessionId: undefined,
      from: "discord:user-a", to: "slash:42", messageThreadId: undefined, threadParentId: undefined,
    };
    const d1 = await derive(discord);
    const d2 = await derive(discord);
    assert.equal(d1.conversationPrincipal, d2.conversationPrincipal);
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

  it("rejects missing agents before workspace, session-reader, or tool data work", async () => {
    let workspaceCalls = 0;
    await assert.rejects(() => resolveHostCommandMemoryContext({
      channel: "telegram", accountId: "default", sessionKey: "agent:a:main", from: "telegram:42",
    }, {
      resolveAgentWorkspaceDir: async () => { workspaceCalls++; return "/unused"; },
      routingLoader: async () => routingCapability,
    }), /agentId is required/);
    assert.equal(workspaceCalls, 0);
    assert.throws(() => resolveToolMemoryRequestContext({ workspaceDir: "/unused" }), /agentId is required/);
    let sessionReads = 0;
    await assert.rejects(() => resolveHostHookMemoryContext({ sessionKey: "agent:a:main" }, {
      routingCapability,
      turnRoutes: createMemoryTurnRouteRegistry({ routingCapability }),
      getSessionEntry: () => { sessionReads++; return null; },
    }), /agentId is required/);
    assert.equal(sessionReads, 0);
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

  it("keeps maximum-length canonical workspace targets idempotent", () => {
    const maxKey = "x".repeat(INPUT_LIMITS.AGENT_ID);
    const canonical = `workspace:v1:${maxKey}`;
    const once = normalizeAndFreezeWorkspaceAliases({
      paths: [],
      aliases: [{ alias: "maximum", workspaceKey: maxKey }],
    });
    assert.deepEqual(normalizeAndFreezeWorkspaceAliases(once), once);
    assert.equal(once.aliases[0].workspaceKey, canonical);
    assert.equal(resolveMemoryRequestContext({ agentId: "a", workspaceKey: "maximum" }, {
      workspaceAliases: once,
    }).workspaceIdentity, canonical);
    assert.equal(resolveMemoryRequestContext({ agentId: "a", workspaceId: canonical }).workspaceIdentity, canonical);

    const canonicalOnce = normalizeAndFreezeWorkspaceAliases({
      paths: [],
      aliases: [{ alias: "canonical", workspaceKey: canonical }],
    });
    assert.deepEqual(normalizeAndFreezeWorkspaceAliases(canonicalOnce), canonicalOnce);
    const canonicalDir = "workspace-dir:v1:/tmp/plur1bus-b13-canonical-dir";
    const dirOnce = normalizeAndFreezeWorkspaceAliases({
      paths: [],
      aliases: [{ alias: "directory", workspaceKey: canonicalDir }],
    });
    assert.deepEqual(normalizeAndFreezeWorkspaceAliases(dirOnce), dirOnce);

    for (const workspaceKey of [
      "x".repeat(INPUT_LIMITS.AGENT_ID + 1),
      `workspace:v1:${"x".repeat(INPUT_LIMITS.AGENT_ID + 1)}`,
      "workspace:v1:",
      "workspace:v1:workspace:v1:nested",
      "workspace:v2:unknown",
    ]) {
      assert.throws(() => normalizeAndFreezeWorkspaceAliases({
        paths: [], aliases: [{ alias: "invalid", workspaceKey }],
      }));
    }
  });

  it("rejects aliases that collide under exact Neo lookup normalization", () => {
    const conflicting = {
      workspaceAliases: [
        { alias: "FOO", workspaceKey: "target-a" },
        { alias: "foo", workspaceKey: "target-b" },
      ],
    };
    assert.throws(() => buildMemoryWorkspaceAliases(
      conflicting,
      buildNeoWorkspaceAliases(conflicting),
    ), /conflicting workspace alias declaration/);

    for (const aliases of [
      [
        { alias: "foo bar", workspaceKey: "target-a" },
        { alias: "foo_bar", workspaceKey: "target-b" },
      ],
      [
        { alias: `${"z".repeat(120)}a`, workspaceKey: "target-a" },
        { alias: `${"z".repeat(120)}b`, workspaceKey: "target-b" },
      ],
    ]) {
      const cfg = { workspaceAliases: aliases };
      assert.throws(() => buildMemoryWorkspaceAliases(cfg, buildNeoWorkspaceAliases(cfg)),
        /conflicting workspace alias declaration/);
    }

    const equal = {
      workspaceAliases: [
        { alias: "FOO", workspaceKey: "target-a" },
        { alias: "foo", workspaceKey: "target-a" },
      ],
    };
    const once = buildMemoryWorkspaceAliases(equal, buildNeoWorkspaceAliases(equal));
    assert.deepEqual(normalizeAndFreezeWorkspaceAliases(once), once);
    for (const workspaceKey of ["FOO", "FoO", "foo"]) {
      assert.equal(resolveMemoryRequestContext({ agentId: "a", workspaceKey }, {
        workspaceAliases: once,
      }).workspaceIdentity, "workspace:v1:target-a");
    }
  });

  it("rejects conflicting raw workspace path basenames before Neo can collapse them", (t) => {
    const rootA = mkdtempSync(join(tmpdir(), "plur1bus-b13-alias-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "plur1bus-b13-alias-b-"));
    const pathA = join(rootA, "shared");
    const pathB = join(rootB, "shared");
    mkdirSync(pathA);
    mkdirSync(pathB);
    t.after(() => {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    });
    const cfg = {
      neo: {
        workspaces: [
          { workspaceKey: "target-a", path: pathA },
          { workspaceKey: "target-b", path: pathB },
        ],
      },
    };
    assert.throws(() => buildMemoryWorkspaceAliases(cfg, {
      paths: [],
      aliases: [{ alias: "shared", workspaceKey: "target-b" }],
    }), /conflicting workspace alias declaration/);
  });

  it("rejects exact workspace path duplicates with different targets", (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-path-conflict-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const conflicting = {
      neo: {
        workspaces: [
          { workspaceKey: "target-a", path: workspaceDir },
          { workspaceKey: "target-b", path: workspaceDir },
        ],
      },
    };
    assert.throws(() => buildMemoryWorkspaceAliases(conflicting, buildNeoWorkspaceAliases(conflicting)),
      /conflicting workspace path declaration/);
    const equal = {
      neo: {
        workspaces: [
          { workspaceKey: "target-a", path: workspaceDir },
          { workspaceKey: "target-a", path: workspaceDir },
        ],
      },
    };
    const once = buildMemoryWorkspaceAliases(equal, buildNeoWorkspaceAliases(equal));
    assert.deepEqual(normalizeAndFreezeWorkspaceAliases(once), once);
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
        OriginatingTo: "chat-a",
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

  it("accepts only official normal CommandTurn contexts and excludes command variants", () => {
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    const normal = { kind: "normal", source: "message", authorized: false, body: "ordinary message" };
    assert.equal(registry.observeReplyDispatch(dispatchFixture({ commandTurn: normal })), undefined);
    assert.equal(registry.pendingCount(), 1);
    for (const commandTurn of [
      { kind: "text-slash", source: "text", authorized: true, body: "/memory" },
      { kind: "native", source: "native", authorized: true, body: "/memory" },
    ]) {
      registry.clear();
      registry.observeReplyDispatch(dispatchFixture({ commandTurn }));
      assert.equal(registry.pendingCount(), 0);
    }
    for (const excluded of [
      { CommandSource: "text", CommandBody: "ordinary message" },
      { CommandSource: "native", CommandBody: "ordinary message" },
      { CommandBody: "   /unknown" },
      { CommandBody: "" },
      { CommandBody: "ordinary message", isTailDispatch: true },
    ]) {
      registry.clear();
      const event = dispatchFixture({ commandTurn: undefined });
      Object.assign(event, excluded);
      Object.assign(event.ctx, excluded);
      registry.observeReplyDispatch(event);
      assert.equal(registry.pendingCount(), 0);
      registry.observeReplyDispatch(dispatchFixture({ runId: "run-normal" }));
      assert.equal(registry.pendingCount(), 1, "an excluded command must not leave a stale FIFO head");
    }
  });

  it("requires the complete raw and originating dispatch identity tuple", () => {
    const removals = [
      [["sessionKey"]], [["ctx", "SessionKey"]], [["originatingChannel"]], [["ctx", "Provider"], ["ctx", "OriginatingChannel"]],
      [["originatingAccountId"]], [["ctx", "AccountId"]], [["originatingTo"]], [["ctx", "OriginatingTo"]],
      [["ctx", "SenderId"]],
    ];
    for (const paths of removals) {
      const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
      const event = dispatchFixture();
      for (const path of paths) {
        if (path.length === 1) delete event[path[0]];
        else delete event[path[0]][path[1]];
      }
      registry.observeReplyDispatch(event);
      assert.equal(registry.pendingCount(), 0, paths.map((path) => path.join(".")).join("+"));
    }
  });

  it("derives an absent optional dispatch ChatId from exact route proofs", () => {
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    const event = dispatchFixture();
    delete event.ctx.ChatId;
    registry.observeReplyDispatch(event);
    assert.equal(registry.pendingCount(), 1);
  });

  it("re-verifies immutable claimed tickets on same-run retries", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-retry-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    registry.observeReplyDispatch(dispatchFixture());
    const original = await resolveHook(hookFixture({ workspaceDir }), registry, sessionEntryFixture());
    assert.match(original.userPrincipal, /^user:v1:/);
    const exactRetry = await resolveHook(hookFixture({ workspaceDir }), registry, sessionEntryFixture());
    assert.equal(exactRetry.userPrincipal, original.userPrincipal);
    const switched = await resolveHook(
      hookFixture({ workspaceDir, senderId: "99" }),
      registry,
      sessionEntryFixture(),
    );
    assert.equal(switched.userPrincipal, "");
    assert.equal(switched.agentId, "a");
  });

  it("treats repeated claimed dispatches as idempotent only for the same identity", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-claimed-dispatch-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    registry.observeReplyDispatch(dispatchFixture());
    const original = await resolveHook(hookFixture({ workspaceDir }), registry, sessionEntryFixture());
    registry.observeReplyDispatch(dispatchFixture());
    assert.equal(registry.pendingCount(), 0);
    assert.equal((await resolveHook(hookFixture({ workspaceDir }), registry, sessionEntryFixture())).userPrincipal, original.userPrincipal);
    registry.observeReplyDispatch(dispatchFixture({ senderId: "99" }));
    assert.equal((await resolveHook(hookFixture({ workspaceDir }), registry, sessionEntryFixture())).userPrincipal, "");
  });

  it("requires every present ticket run id to match in every proof mode", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-run-proof-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-a" }));
    const denied = await resolveHook(
      hookFixture({ workspaceDir, runId: "run-b" }),
      registry,
      sessionEntryFixture(),
    );
    assert.equal(denied.userPrincipal, "");
    assert.equal(denied.agentId, "a");
  });

  it("exercises account-session, exact-run, and single-account proof modes", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-proof-modes-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const ambiguous = buildMemoryAccountTopology({ channels: { telegram: { accounts: { named: {} } } } });
    const cases = [
      {
        label: "account-bearing session",
        sessionKey: "agent:a:telegram:acct-a:direct:chat-a",
        accountId: "acct-a",
        ticketRun: "",
        topology: ambiguous,
      },
      {
        label: "exact run",
        sessionKey: "agent:a:telegram:direct:chat-a",
        accountId: "default",
        ticketRun: "run-a",
        topology: ambiguous,
      },
      {
        label: "single account",
        sessionKey: "agent:a:telegram:direct:chat-a",
        accountId: "default",
        ticketRun: "",
        topology: buildMemoryAccountTopology({ channels: { telegram: {} } }),
      },
    ];
    for (const fixture of cases) {
      const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
      registry.observeReplyDispatch(dispatchFixture({
        runId: fixture.ticketRun,
        sessionKey: fixture.sessionKey,
        accountId: fixture.accountId,
      }));
      const ctx = await resolveHook(
        hookFixture({ workspaceDir, sessionKey: fixture.sessionKey }),
        registry,
        sessionEntryFixture({ accountId: fixture.accountId }),
        fixture.topology,
      );
      assert.match(ctx.userPrincipal, /^user:v1:/, fixture.label);
    }

    for (const topology of [
      ambiguous,
      buildMemoryAccountTopology({ channels: { telegram: { accounts: { one: {}, two: {} } } } }),
      buildMemoryAccountTopology({ channels: { telegram: {} }, bindings: [{ match: { channel: "telegram", accountId: "*" } }] }),
      Object.freeze({ providers: Object.freeze({}) }),
      Object.freeze({ providers: Object.freeze({ telegram: Object.freeze({ accounts: "default", ambiguous: false }) }) }),
    ]) {
      const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
      registry.observeReplyDispatch(dispatchFixture({ runId: "" }));
      const denied = await resolveHook(hookFixture({ workspaceDir }), registry, sessionEntryFixture(), topology);
      assert.equal(denied.userPrincipal, "");
    }
  });

  it("binds claimed retries to the originally verified session id", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-session-retry-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    registry.observeReplyDispatch(dispatchFixture());
    const original = await resolveHook(hookFixture({ workspaceDir }), registry, sessionEntryFixture());
    assert.match(original.userPrincipal, /^user:v1:/);
    const denied = await resolveHook(
      hookFixture({ workspaceDir, sessionId: "session-b" }),
      registry,
      sessionEntryFixture({ sessionId: "session-b" }),
    );
    assert.equal(denied.userPrincipal, "");
  });

  it("keeps interleaved FIFO users bound to their own sender proofs", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-users-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    registry.observeReplyDispatch(dispatchFixture({ runId: "", senderId: "42" }));
    registry.observeReplyDispatch(dispatchFixture({ runId: "", senderId: "99" }));
    const first = await resolveHook(hookFixture({ workspaceDir, runId: "run-a", senderId: "42" }), registry, sessionEntryFixture());
    const second = await resolveHook(hookFixture({ workspaceDir, runId: "run-b", senderId: "99" }), registry, sessionEntryFixture());
    assert.match(first.userPrincipal, /^user:v1:/);
    assert.match(second.userPrincipal, /^user:v1:/);
    assert.notEqual(first.userPrincipal, second.userPrincipal);

    const swapped = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    swapped.observeReplyDispatch(dispatchFixture({ runId: "", senderId: "42" }));
    swapped.observeReplyDispatch(dispatchFixture({ runId: "", senderId: "99" }));
    const denied = await resolveHook(hookFixture({ workspaceDir, runId: "run-b", senderId: "99" }), swapped, sessionEntryFixture());
    assert.equal(denied.userPrincipal, "");
    assert.equal(swapped.pendingCount(), 0);
  });

  it("bounds pending, claimed, session taint, and global overflow state", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-bounds-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    let current = 1000;
    const registry = createMemoryTurnRouteRegistry({
      routingCapability, now: () => current, ttlMs: 10, maxPending: 1, maxClaimed: 1, maxTainted: 1,
    });
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-a" }));
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-b", sessionKey: "agent:a:telegram:direct:chat-b", chatId: "chat-b" }));
    assert.deepEqual(registry.stateCounts(), { pending: 1, runIndex: 1, claimed: 0, retired: 0, tainted: 1, globalTaint: false });
    const second = await resolveHook(
      hookFixture({ workspaceDir, runId: "run-b", sessionKey: "agent:a:telegram:direct:chat-b", chatId: "chat-b" }),
      registry,
      sessionEntryFixture({ chatId: "chat-b" }),
    );
    assert.match(second.userPrincipal, /^user:v1:/);

    current = 1010;
    registry.pendingCount();
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-c" }));
    const conflicting = dispatchFixture({ runId: "run-c", senderId: "99" });
    registry.observeReplyDispatch(conflicting);
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-d", sessionKey: "agent:a:telegram:direct:chat-b", chatId: "chat-b" }));
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-d", sessionKey: "agent:a:telegram:direct:chat-b", chatId: "chat-b", senderId: "99" }));
    assert.equal(registry.stateCounts().globalTaint, true);
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-e", sessionKey: "agent:a:telegram:direct:chat-c", chatId: "chat-c" }));
    assert.equal(registry.pendingCount(), 0);
    current = 1020;
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-e", sessionKey: "agent:a:telegram:direct:chat-c", chatId: "chat-c" }));
    assert.equal(registry.pendingCount(), 1);
  });

  it("denies an out-of-order exact run and taints rather than skipping the FIFO head", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-fifo-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    const ambiguous = buildMemoryAccountTopology({ channels: { telegram: { accounts: { named: {} } } } });
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-a", senderId: "42" }));
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-b", senderId: "99" }));
    const outOfOrder = await resolveHook(
      hookFixture({ workspaceDir, runId: "run-b", senderId: "99" }),
      registry,
      sessionEntryFixture(),
      ambiguous,
    );
    assert.equal(outOfOrder.userPrincipal, "");
    assert.equal(registry.pendingCount(), 0);
  });

  it("cross-checks every present dispatch and hook thread or identity duplicate", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-duplicates-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    const dispatch = dispatchFixture();
    dispatch.ctx.OriginatingTo = "telegram:chat-b";
    registry.observeReplyDispatch(dispatch);
    assert.equal(registry.pendingCount(), 0);

    registry.clear();
    registry.observeReplyDispatch(dispatchFixture());
    const hook = hookFixture({ workspaceDir });
    hook.channelContext.sender.id = "99";
    const denied = await resolveHook(hook, registry, sessionEntryFixture());
    assert.equal(denied.userPrincipal, "");

    registry.clear();
    registry.observeReplyDispatch(dispatchFixture());
    const malformedEntry = sessionEntryFixture();
    malformedEntry.deliveryContext.accountId = { value: "default" };
    const deniedMalformedEntry = await resolveHook(hookFixture({ workspaceDir }), registry, malformedEntry);
    assert.equal(deniedMalformedEntry.userPrincipal, "");

  });

  it("rejects every present empty SessionEntry provider or account alias", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-empty-entry-alias-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const aliases = [
      ["deliveryContext", "channel"],
      ["origin", "provider"],
      [null, "lastChannel"],
      ["deliveryContext", "accountId"],
      ["origin", "accountId"],
      [null, "lastAccountId"],
    ];
    for (const [container, field] of aliases) {
      for (const empty of ["", "   "]) {
        const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
        registry.observeReplyDispatch(dispatchFixture());
        const entry = sessionEntryFixture();
        if (container) entry[container][field] = empty;
        else entry[field] = empty;
        const denied = await resolveHook(hookFixture({ workspaceDir }), registry, entry);
        assert.equal(denied.userPrincipal, "", `${container ? `${container}.` : ""}${field}=${JSON.stringify(empty)}`);
      }
    }
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    registry.observeReplyDispatch(dispatchFixture());
    const optional = sessionEntryFixture();
    delete optional.deliveryContext.channel;
    optional.origin.accountId = undefined;
    const allowed = await resolveHook(hookFixture({ workspaceDir }), registry, optional);
    assert.match(allowed.userPrincipal, /^user:v1:/, "truly absent optional aliases stay optional");
  });

  it("requires explicit hook and entry thread proof and rejects malformed present entry targets", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-thread-proof-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const sessionKey = "agent:a:telegram:group:chat-a:topic:77";
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    const dispatch = dispatchFixture({ sessionKey, threadId: "77" });
    dispatch.originatingTo = "telegram:group:chat-a:topic:77";
    dispatch.ctx.OriginatingTo = "telegram:group:chat-a:topic:77";
    registry.observeReplyDispatch(dispatch);
    const missingHookThread = hookFixture({ workspaceDir, sessionKey });
    delete missingHookThread.messageThreadId;
    delete missingHookThread.channelContext.threadId;
    const deniedMissing = await resolveHook(missingHookThread, registry, sessionEntryFixture({ threadId: "77" }));
    assert.equal(deniedMissing.userPrincipal, "");

    registry.clear();
    registry.observeReplyDispatch(dispatch);
    const malformed = sessionEntryFixture({ threadId: "77" });
    malformed.origin.to = "slash:user";
    const deniedMalformed = await resolveHook(
      hookFixture({ workspaceDir, sessionKey, threadId: "77" }),
      registry,
      malformed,
    );
    assert.equal(deniedMalformed.userPrincipal, "");
    registry.clear();
    registry.observeReplyDispatch(dispatch);
    const allowed = await resolveHook(
      hookFixture({ workspaceDir, sessionKey, threadId: "77" }),
      registry,
      sessionEntryFixture({ threadId: "77" }),
    );
    assert.match(allowed.userPrincipal, /^user:v1:/);
  });

  it("evicts claimed runs deterministically and cleanup cannot borrow another ticket", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-claimed-cap-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000, maxClaimed: 1 });
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-a" }));
    const first = await resolveHook(hookFixture({ workspaceDir, runId: "run-a" }), registry, sessionEntryFixture());
    assert.match(first.userPrincipal, /^user:v1:/);
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-b", sessionKey: "agent:a:telegram:direct:chat-b", chatId: "chat-b" }));
    const second = await resolveHook(
      hookFixture({ workspaceDir, runId: "run-b", sessionKey: "agent:a:telegram:direct:chat-b", chatId: "chat-b" }),
      registry,
      sessionEntryFixture({ chatId: "chat-b" }),
    );
    assert.match(second.userPrincipal, /^user:v1:/);
    assert.equal((await resolveHook(hookFixture({ workspaceDir, runId: "run-a" }), registry, sessionEntryFixture())).userPrincipal, "");
    registry.clearRun("run-b");
    assert.equal((await resolveHook(
      hookFixture({ workspaceDir, runId: "run-b", sessionKey: "agent:a:telegram:direct:chat-b", chatId: "chat-b" }),
      registry,
      sessionEntryFixture({ chatId: "chat-b" }),
    )).userPrincipal, "");
  });

  it("expires and evicts only the claimed retry while fresh same-session turns recover", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-claimed-recovery-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    let current = 1000;
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => current, ttlMs: 10, maxClaimed: 2 });
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-a" }));
    assert.match((await resolveHook(hookFixture({ workspaceDir, runId: "run-a" }), registry, sessionEntryFixture())).userPrincipal, /^user:v1:/);
    current = 1010;
    registry.observeReplyDispatch(dispatchFixture({ runId: "", senderId: "99" }));
    assert.equal((await resolveHook(hookFixture({ workspaceDir, runId: "run-a", senderId: "99" }), registry, sessionEntryFixture())).userPrincipal, "", "expired run cannot borrow a fresh FIFO ticket");
    const fresh = await resolveHook(hookFixture({ workspaceDir, runId: "run-b", senderId: "99" }), registry, sessionEntryFixture());
    assert.match(fresh.userPrincipal, /^user:v1:/, "fresh turn must survive claimed retry expiry");
    assert.equal(registry.stateCounts().tainted, 0);

    registry.observeReplyDispatch(dispatchFixture({ runId: "run-c" }));
    assert.match((await resolveHook(hookFixture({ workspaceDir, runId: "run-c" }), registry, sessionEntryFixture())).userPrincipal, /^user:v1:/);
    current = 1020;
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-d", senderId: "77" }));
    assert.match((await resolveHook(hookFixture({ workspaceDir, runId: "run-d", senderId: "77" }), registry, sessionEntryFixture())).userPrincipal, /^user:v1:/);
    assert.equal(registry.stateCounts().tainted, 0, "claimed cap eviction must not taint the session");
  });

  it("fails closed when A/B/C claimed-run retirement overflows its bounded tombstones", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-retired-overflow-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    let current = 1000;
    const registry = createMemoryTurnRouteRegistry({
      routingCapability,
      now: () => current,
      ttlMs: 10,
      maxClaimed: 1,
    });
    const route = async (runId, chatId) => {
      const sessionKey = `agent:a:telegram:direct:${chatId}`;
      registry.observeReplyDispatch(dispatchFixture({ runId, sessionKey, chatId }));
      return resolveHook(
        hookFixture({ workspaceDir, runId, sessionKey, chatId }),
        registry,
        sessionEntryFixture({ chatId }),
      );
    };

    assert.match((await route("run-a", "chat-a")).userPrincipal, /^user:v1:/);
    assert.match((await route("run-b", "chat-b")).userPrincipal, /^user:v1:/);
    assert.equal((await route("run-c", "chat-c")).userPrincipal, "", "the claim that overflows live tombstones is denied atomically");
    assert.deepEqual(registry.stateCounts(), {
      pending: 0,
      runIndex: 0,
      claimed: 0,
      retired: 0,
      tainted: 0,
      globalTaint: true,
    });

    const replay = await route("run-a", "chat-a");
    assert.equal(replay.userPrincipal, "", "an evicted replay must not re-enter while overflow protection is live");
    assert.equal(registry.pendingCount(), 0);

    current = 1010;
    const recovered = await route("run-d", "chat-d");
    assert.match(recovered.userPrincipal, /^user:v1:/, "fresh turns recover at the strict TTL boundary");
    const counts = registry.stateCounts();
    assert.ok(counts.claimed <= 1);
    assert.ok(counts.retired <= 1);
    assert.equal(counts.globalTaint, false);
  });

  it("does not repopulate bounded tombstones after prune-triggered retirement overflow", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-prune-overflow-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    let current = 1000;
    const registry = createMemoryTurnRouteRegistry({
      routingCapability,
      now: () => current,
      ttlMs: 10,
      maxClaimed: 1,
    });
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-a" }));
    assert.match((await resolveHook(hookFixture({ workspaceDir, runId: "run-a" }), registry, sessionEntryFixture())).userPrincipal, /^user:v1:/);
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-b", senderId: "99" }));

    current = 1005;
    assert.match((await resolveHook(
      hookFixture({ workspaceDir, runId: "run-b", senderId: "99" }),
      registry,
      sessionEntryFixture(),
    )).userPrincipal, /^user:v1:/);
    assert.equal(registry.stateCounts().retired, 1);

    current = 1010;
    assert.deepEqual(registry.stateCounts(), {
      pending: 0,
      runIndex: 0,
      claimed: 0,
      retired: 0,
      tainted: 0,
      globalTaint: true,
    });
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-c", senderId: "77" }));
    assert.equal(registry.pendingCount(), 0);

    current = 1020;
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-c", senderId: "77" }));
    assert.match((await resolveHook(
      hookFixture({ workspaceDir, runId: "run-c", senderId: "77" }),
      registry,
      sessionEntryFixture(),
    )).userPrincipal, /^user:v1:/);
  });

  it("accepts official prompt hooks without optional channelContext duplicates", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-optional-channel-context-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    for (const channelContext of [undefined, {}]) {
      const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
      registry.observeReplyDispatch(dispatchFixture());
      const hook = hookFixture({ workspaceDir });
      if (channelContext === undefined) delete hook.channelContext;
      else hook.channelContext = channelContext;
      const resolved = await resolveHook(hook, registry, sessionEntryFixture());
      assert.match(resolved.userPrincipal, /^user:v1:/);
    }
  });

  it("accepts an official headless agent hook without inventing a user or warning", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-headless-beta3-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const warnings = [];
    let sessionReads = 0;
    const resolved = await resolveHostHookMemoryContext({
      runId: "run-headless-a",
      agentId: "a",
      sessionKey: "agent:a:auto-capture-lab-a",
      sessionId: "session-headless-a",
      workspaceDir,
      // OpenClaw's public buildAgentHookContextChannelFields helper labels a
      // Gateway CLI turn with its internal non-delivery webchat sentinel even
      // though there is no authenticated transport sender or account.
      channel: "webchat",
      channelId: "webchat",
      chatId: "webchat",
    }, {
      routingCapability,
      turnRoutes: createMemoryTurnRouteRegistry({ routingCapability }),
      accountTopology: buildMemoryAccountTopology({ channels: {} }),
      getSessionEntry: () => { sessionReads++; return null; },
      logger: { warn: (...args) => warnings.push(args) },
    });

    assert.equal(resolved.agentId, "a");
    assert.equal(resolved.workspaceDir, realpathSync(workspaceDir));
    assert.equal(resolved.userPrincipal, "");
    assert.equal(resolved.conversationPrincipal, "");
    assert.equal(resolved.chatId, "");
    assert.equal(sessionReads, 0);
    assert.deepEqual(warnings, []);
  });

  it("does not treat an identity-bearing webchat hook as a headless route", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-webchat-identity-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const warnings = [];
    const resolved = await resolveHostHookMemoryContext({
      runId: "run-webchat-user-a",
      agentId: "a",
      sessionKey: "agent:a:arbitrary-webchat-session",
      sessionId: "session-webchat-user-a",
      workspaceDir,
      channel: "webchat",
      channelId: "webchat",
      chatId: "webchat",
      accountId: "default",
      senderId: "owner-a",
    }, {
      routingCapability,
      turnRoutes: createMemoryTurnRouteRegistry({ routingCapability }),
      accountTopology: buildMemoryAccountTopology({ channels: {} }),
      getSessionEntry: () => null,
      logger: { warn: (...args) => warnings.push(args) },
    });

    assert.equal(resolved.userPrincipal, "");
    assert.equal(resolved.conversationPrincipal, "");
    assert.notEqual(resolved.chatId, "");
    assert.equal(warnings.length, 1);
  });

  it("ignores non-host flat channelContext identity and thread fields", async (t) => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-official-channel-context-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
    const dispatch = dispatchFixture();
    dispatch.ctx.ChannelContext = { senderId: "99", chatId: "chat-b" };
    registry.observeReplyDispatch(dispatch);
    assert.equal(registry.pendingCount(), 1, "dispatch must ignore non-host flat ChannelContext fields");
    const hook = hookFixture({ workspaceDir });
    hook.channelContext.senderId = "99";
    hook.channelContext.chatId = "chat-b";
    hook.channelContext.threadId = "77";
    const resolved = await resolveHook(hook, registry, sessionEntryFixture());
    assert.match(resolved.userPrincipal, /^user:v1:/);
  });

  it("clears run indexes with session taints and lets global overflow expire", () => {
    let current = 1000;
    const registry = createMemoryTurnRouteRegistry({
      routingCapability,
      now: () => current,
      ttlMs: 10,
      maxPending: 1,
      maxTainted: 1,
    });
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-x" }));
    registry.clearSession("agent:a:telegram:direct:chat-a");
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-x", senderId: "99" }));
    assert.equal(registry.pendingCount(), 1, "clearSession must remove the stale run index");
    current = 1010;
    assert.equal(registry.pendingCount(), 0, "expiry is strict at the exact boundary");
    current = 1020;
    registry.observeReplyDispatch(dispatchFixture({ runId: "run-x", senderId: "99" }));
    assert.equal(registry.pendingCount(), 1, "expired taint and run index must recover deterministically");
    assert.throws(() => createMemoryTurnRouteRegistry({ routingCapability, maxPending: -1 }), /maxPending/);
  });
});

describe("operator session context for identity-bound steps", () => {
  const { mkdtempSync, mkdirSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const root = mkdtempSync(join(tmpdir(), "plur1bus-session-ctx-"));
  for (const agent of ["heisenberg", "main"]) mkdirSync(join(root, agent), { recursive: true });
  const resolveAgentWorkspaceDir = async (_config, agentId) => join(root, agentId);

  it("resolves a direct chat session to the conversation's identity-bound context", async () => {
    const ctx = await resolveSessionOwnerMemoryContext({
      sessionKey: "agent:heisenberg:telegram:heisenberg:direct:2048378590",
      routingLoader: async () => routingCapability,
      resolveAgentWorkspaceDir,
      resolveSessionEntry: async () => ({ available: true, entry: { sessionId: "706f9ef6-06ca-4dc6-9469-e2531524dd9c" } }),
    });
    assert.equal(ctx.agentId, "heisenberg");
    assert.equal(ctx.userId, "2048378590");
    assert.equal(ctx.channel, "telegram");
    assert.equal(ctx.accountId, "heisenberg");
    assert.match(ctx.conversationPrincipal, /^conversation:v1:/);
    assert.ok(ctx.userPrincipal, "a channel/account-bound user principal is present");
    assert.equal(ctx.sessionKey, "agent:heisenberg:telegram:heisenberg:direct:2048378590");
    // The same conversation always yields the same principal, as the chat command path does.
    const again = await resolveSessionOwnerMemoryContext({
      sessionKey: "agent:heisenberg:telegram:heisenberg:direct:2048378590",
      routingLoader: async () => routingCapability,
      resolveAgentWorkspaceDir,
      resolveSessionEntry: async () => ({ available: true, entry: { sessionId: "706f9ef6-06ca-4dc6-9469-e2531524dd9c" } }),
    });
    assert.equal(again.conversationPrincipal, ctx.conversationPrincipal);
  });

  it("keeps the plain agent context for sessions without a direct conversation", async () => {
    for (const sessionKey of ["agent:heisenberg:main:heartbeat", "agent:main:cron:abc:run:def", "agent:main:main"]) {
      const ctx = await resolveSessionOwnerMemoryContext({
        sessionKey,
        routingLoader: async () => routingCapability,
        resolveAgentWorkspaceDir,
      });
      assert.equal(ctx.userId, "", sessionKey);
      assert.equal(ctx.conversationPrincipal, "", sessionKey);
      assert.ok(ctx.workspaceIdentity, sessionKey);
    }
    assert.equal(describeDirectSessionRoute("agent:main:telegram:group:-100123", routingCapability), null, "a group is not a direct chat");
  });
});

describe("shared workspace pool labels", () => {
  it("names each aliased pool and its pre-alias directory identity without a path", () => {
    const { mkdtempSync, mkdirSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const root = mkdtempSync(join(tmpdir(), "plur1bus-pool-labels-"));
    const mainDir = join(root, "workspace"); mkdirSync(mainDir);
    const bDir = join(root, "workspace-bernhardine"); mkdirSync(bDir);
    const labels = describeWorkspacePoolLabels({
      paths: [{ path: mainDir, workspaceKey: "workspace:v1:main" }, { path: bDir, workspaceKey: "workspace:v1:bernhardine" }],
      aliases: [{ alias: "main", workspaceKey: "workspace:v1:main" }, { alias: "Bernhardine", workspaceKey: "workspace:v1:bernhardine" }, { alias: "bernhardine", workspaceKey: "workspace:v1:bernhardine" }],
    });
    const byLabel = Object.fromEntries(labels.map((entry) => [entry.label, entry]));
    assert.deepEqual(Object.keys(byLabel).sort(), ["Bernhardine.dir", "Bernhardine", "main", "main.dir"].sort());
    assert.equal(byLabel.main.poolKey, workspacePoolKey("workspace:v1:main"));
    assert.equal(byLabel["main.dir"].poolKey, workspacePoolKey(`workspace-dir:v1:${mainDir}`));
    assert.equal(byLabel.Bernhardine.label.length, "Bernhardine".length, "the shortest alias wins; ties fall to the lexically first");
    for (const entry of labels) {
      assert.doesNotMatch(entry.label, /\//, "labels never carry a path");
      assert.match(entry.label, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
    }
    assert.deepEqual(describeWorkspacePoolLabels(), []);
  });
});

describe("shared user pool labels", () => {
  it("names each allowed direct-message user's pool after agent, channel and account, never the id", () => {
    const hostConfig = {
      channels: {
        telegram: {
          accounts: {
            default: { allowFrom: [55736530] },
            bernhardine: { allowFrom: ["1211667028"] },
            shared: { allowFrom: [111, 222] },
            unbound: { allowFrom: [333] },
          },
        },
        discord: { accounts: { default: { allowFrom: [] } } },
      },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "default" } },
        { agentId: "bernhardine", match: { channel: "telegram", accountId: "bernhardine" } },
        { agentId: "main", match: { channel: "telegram", accountId: "shared" } },
        { agentId: "heisenberg", match: { channel: "telegram", accountId: "shared" } },
      ],
    };
    const labels = describeUserPoolLabels(hostConfig);
    const byLabel = Object.fromEntries(labels.map((entry) => [entry.label, entry.poolKey]));
    assert.deepEqual(Object.keys(byLabel).sort(), ["bernhardine.telegram.bernhardine", "main.telegram.default", "telegram.shared.1", "telegram.shared.2", "telegram.unbound"]);
    const expected = resolveMemoryRequestContext({ agentId: "main", channel: "telegram", accountId: "default", userId: "55736530", chatId: "55736530" });
    assert.equal(byLabel["main.telegram.default"], userPoolKey(expected.userPrincipal));
    for (const label of Object.keys(byLabel)) {
      assert.doesNotMatch(label, /55736530|1211667028|111|222|333/, "labels never carry a user id");
      assert.match(label, /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
    }
    assert.deepEqual(describeUserPoolLabels({}), []);
  });
});
