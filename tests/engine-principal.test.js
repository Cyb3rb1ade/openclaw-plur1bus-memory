/**
 * tests/engine-principal.test.js — PR-06 (spec 3.4, step 7 gates).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createChannelRegistry, DEFAULT_CHANNELS, memoryContextFromPrincipal, principalFromMemoryContext } from "../engine/identity/principal.js";
import { agentContextFromCommand, agentContextFromHook } from "../adapter/openclaw/turn-principal.js";
import { createPlur1busCommandRunner } from "../engine/commands/plur1bus-command.js";
import {
  buildMemoryAccountTopology,
  createMemoryTurnRouteRegistry,
  listRouteProviders,
  registerRouteProvider,
  resolveHostHookPrincipal,
  resolveMemoryRequestContext,
  stableIdentityHash,
} from "../lib/memory-request-context.js";
import { makeTempDir } from "./helpers/temp-dir.js";

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

// Minimal hook-identity-delivery fixture (pattern from
// tests/b13-memory-request-context.test.js's dispatchFixture/hookFixture/
// sessionEntryFixture): a reply_dispatch ticket, the hook context claiming
// it, and the host session entry the ticket is checked against.
function claimedTicketFixture({ workspaceDir, sessionKey = "agent:agent-a:telegram:direct:chat-a", chatId = "chat-a", senderId = "42" }) {
  const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
  registry.observeReplyDispatch({
    runId: "run-a",
    sessionKey,
    originatingChannel: "telegram",
    originatingTo: `telegram:${chatId}`,
    originatingAccountId: "default",
    ctx: {
      AgentId: "agent-a", SessionKey: sessionKey, AccountId: "default", SenderId: senderId,
      Provider: "telegram", ChatId: chatId, OriginatingTo: `telegram:${chatId}`,
      CommandBody: "ordinary message",
    },
  });
  const hookCtx = {
    runId: "run-a",
    agentId: "agent-a",
    sessionKey,
    sessionId: "session-a",
    workspaceDir,
    messageProvider: "telegram",
    senderId,
    chatId,
    channelContext: { sender: { id: senderId }, chat: { id: chatId } },
  };
  const entry = {
    sessionId: "session-a",
    deliveryContext: { channel: "telegram", accountId: "default", to: `telegram:${chatId}` },
    origin: { provider: "telegram", accountId: "default", to: `telegram:${chatId}` },
    lastChannel: "telegram",
    lastAccountId: "default",
    lastTo: `telegram:${chatId}`,
  };
  return { registry, hookCtx, entry };
}

const USER = `user:v1:${stableIdentityHash(JSON.stringify(["telegram", "default", "u1"]))}`;
const proved = { agentId: "agent-a", workspace: "workspace:v1:main", user: USER, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
const wsProved = makeTempDir("plur1bus-principal-proved-");
const wsInferred = makeTempDir("plur1bus-principal-inferred-");
const wsHook = makeTempDir("plur1bus-principal-hook-");
const wsConflict = makeTempDir("plur1bus-principal-conflict-");
// Fix round 1: the conflict check (resolveCanonicalWorkspacePrincipal) only
// lets "workspace:v1:main" and wsProved agree because this alias says so —
// resolving the alias, not bypassing the check.
const provedWorkspaceAliases = { paths: [{ path: wsProved, workspaceKey: "workspace:v1:main" }], aliases: [] };

describe("memoryContextFromPrincipal", () => {
  it("a proved principal reaches user scope with the on-disk hash unchanged", () => {
    const ctx = memoryContextFromPrincipal(proved, { workspaceDir: wsProved, workspaceAliases: provedWorkspaceAliases });
    assert.equal(ctx.userPrincipal, USER);
    assert.equal(ctx.workspaceIdentity, "workspace:v1:main");
    assert.equal(ctx.channel, "telegram");
    assert.equal(ctx.trust, "proved");
    const legacy = resolveMemoryRequestContext({ agentId: "agent-a", userId: "u1", channel: "telegram", accountId: "default" });
    assert.equal(ctx.userPrincipal, legacy.userPrincipal, "same pool directory as today");
    assert.ok(Object.isFrozen(ctx));
  });

  it("an inferred principal is agent-private (no user scope) and never throws", () => {
    for (const principal of [
      { ...proved, trust: "inferred" },
      { agentId: "agent-a", trust: "inferred", user: "user:v1:forged", workspace: "workspace:v1:other" },
      { agentId: "agent-a", trust: "inferred", chat: null },
    ]) {
      const ctx = memoryContextFromPrincipal(principal, { workspaceDir: wsInferred });
      assert.equal(ctx.userPrincipal, "");
      assert.equal(ctx.trust, "inferred");
      assert.notEqual(ctx.workspaceIdentity, "workspace:v1:other", "an inferred principal cannot name a foreign workspace");
    }
  });

  it("round-trips through principalFromMemoryContext", () => {
    const ctx = memoryContextFromPrincipal(proved, { workspaceDir: wsProved, workspaceAliases: provedWorkspaceAliases });
    const back = principalFromMemoryContext(ctx, "proved");
    assert.deepEqual([back.agentId, back.user, back.channel, back.accountId, back.trust], ["agent-a", USER, "telegram", "default", "proved"]);
  });

  // Fix round 1 (security review item 1).
  it("degrades to inferred when the user field does not match the stable-hash format", () => {
    const ctx = memoryContextFromPrincipal({ ...proved, user: "user:v1:forged" }, { workspaceDir: wsInferred });
    assert.equal(ctx.userPrincipal, "");
    assert.equal(ctx.trust, "inferred");
  });

  it("degrades to inferred when the channel is outside the registered vocabulary", () => {
    const ctx = memoryContextFromPrincipal({ ...proved, channel: "carrier-pigeon" }, { workspaceDir: wsInferred });
    assert.equal(ctx.userPrincipal, "");
    assert.equal(ctx.trust, "inferred");
  });

  it("rejects a proved principal naming a workspace that conflicts with the host's own workspaceDir", () => {
    assert.throws(
      () => memoryContextFromPrincipal({ ...proved, workspace: "workspace:v1:someone-elses" }, { workspaceDir: wsConflict }),
      /conflicting workspace identity/,
    );
  });

  it("resolves the claimed workspace through a matching alias without conflict", () => {
    const ctx = memoryContextFromPrincipal(proved, { workspaceDir: wsProved, workspaceAliases: provedWorkspaceAliases });
    assert.equal(ctx.workspaceIdentity, "workspace:v1:main");
    assert.equal(ctx.trust, "proved");
  });
});

describe("resolveHostHookPrincipal", () => {
  it("reports inferred when the ticket proof fails, with the same fallback context as before", async () => {
    const routingCapability = {
      parseAgentSessionKey: (v) => { const m = /^agent:([^:]+):(.+)$/.exec(v); return m ? { agentId: m[1], rest: m[2] } : null; },
      parseThreadSessionSuffix: (v) => ({ baseSessionKey: v, threadId: "" }),
      normalizeOptionalAccountId: (v) => v,
      normalizeMessageChannel: (v) => v,
    };
    const hookCtx = { agentId: "agent-a", sessionKey: "agent:agent-a:telegram:direct:u1", workspaceDir: wsHook };
    const result = await resolveHostHookPrincipal(hookCtx, {
      getSessionEntry: async () => null,
      turnRoutes: { claim: () => null, explain: () => "none" },
      routingCapability,
      logger: { warn() {}, info() {}, debug() {}, error() {} },
    });
    assert.equal(result.trust, "inferred");
    assert.equal(result.memoryCtx.userPrincipal, "");
  });

  // Fix round 1 (minor item 3): the two missing outcomes.
  it("reports proved when the six-step ticket proof succeeds", async () => {
    const workspaceDir = wsHook;
    const { registry, hookCtx, entry } = claimedTicketFixture({ workspaceDir });
    const result = await resolveHostHookPrincipal(hookCtx, {
      routingCapability,
      turnRoutes: registry,
      accountTopology: buildMemoryAccountTopology({ channels: { telegram: {} } }),
      getSessionEntry: () => entry,
    });
    assert.equal(result.trust, "proved");
    assert.match(result.memoryCtx.userPrincipal, /^user:v1:/);
  });

  it("reports inferred with an empty userPrincipal for the official headless/webchat route", async () => {
    const hookCtx = {
      agentId: "agent-a",
      sessionKey: "agent:agent-a:webchat",
      sessionId: "session-a",
      runId: "run-a",
      workspaceDir: wsHook,
      channelId: "webchat",
    };
    const result = await resolveHostHookPrincipal(hookCtx, {
      routingCapability,
      turnRoutes: { claimForPrompt: () => null, explain: () => "none" },
      getSessionEntry: async () => null,
    });
    assert.equal(result.trust, "inferred");
    assert.equal(result.memoryCtx.userPrincipal, "");
  });
});

describe("channel registry", () => {
  it("is seeded with today's four providers and accepts new ones", () => {
    const channels = createChannelRegistry();
    assert.deepEqual(DEFAULT_CHANNELS, ["telegram", "discord", "slack", "mattermost"]);
    for (const name of DEFAULT_CHANNELS) assert.equal(channels.has(name), true);
    assert.equal(channels.has("matrix"), false);
    channels.register("matrix");
    assert.equal(channels.has("matrix"), true);
    assert.ok(listRouteProviders().includes("matrix"), "the registry is the provider set memory-request-context validates against");
  });

  // Fix round 1 (minor item 4).
  it("rejects reserved grammar names", () => {
    for (const reserved of ["direct", "dm", "group", "channel", "main", "cron", "webchat", "CRON"]) {
      assert.throws(() => registerRouteProvider(reserved), /reserved/, reserved);
    }
  });
});

describe("agentContextFromCommand — the moved cron matcher", () => {
  it("matches exactly what index.js's isCronCommandContext matched", () => {
    const cron = (ctx) => agentContextFromCommand(ctx).origin === "cron";
    assert.equal(cron({ channel: "cron" }), true);
    assert.equal(cron({ origin: "CRON" }), true);
    assert.equal(cron({ source: "cron" }), true);
    assert.equal(cron({ kind: "cron" }), true);
    assert.equal(cron({ sessionKey: "agent:main:cron" }), true);
    assert.equal(cron({ sessionKey: "agent:main:cron:nightly" }), true);
    assert.equal(cron({ sessionKey: "agent:main:telegram:direct:1" }), false);
    assert.equal(cron({ channel: "telegram" }), false);
    assert.deepEqual(agentContextFromCommand({ channel: "cron" }), { origin: "cron", background: true });
    assert.deepEqual(agentContextFromCommand({ channel: "telegram" }), { origin: "user", background: false });
  });
});

// Fix round 1 (security review item 2): hook/prompt-derived signals must
// never mint "cron" — only agentContextFromCommand's literal channel value
// may, because "cron" skips checkAuth in engine/commands/plur1bus-command.js.
describe("agentContextFromHook — hook-derived origin never claims cron", () => {
  it("a [cron: prompt marker degrades to system, not cron", () => {
    const ctx = agentContextFromHook({ prompt: "nightly digest [cron: sweep]" }, {});
    assert.equal(ctx.origin, "system");
    assert.equal(ctx.background, true);
  });

  it("runPlur1busCommand still applies checkAuth for a hook-derived 'system' origin on an internal action", async () => {
    let checkAuthCalls = 0;
    const runner = createPlur1busCommandRunner({
      checkArgsLength: () => null,
      parsePlur1busArgs: () => [],
      obsidianActionNames: new Set(),
      knownPlur1busActions: new Set(["internal"]),
      resolveCronMemoryContext: async () => ({ agentId: "agent-a", workspaceIdentity: "ws" }),
      resolveRegisteredMemoryContext: async () => ({ agentId: "agent-a", workspaceIdentity: "ws" }),
      workspacePolicyGuard: { decision: () => ({ allowed: true }) },
      checkAuth: async () => { checkAuthCalls += 1; return { text: "Not authorized" }; },
      getNeoStore: () => ({}),
    });
    const agentContext = agentContextFromHook({ prompt: "nightly digest [cron: sweep]" }, {});
    assert.equal(agentContext.origin, "system");
    const result = await runner({ channel: "telegram", agentId: "agent-a" }, ["internal", "gc-run"], { agentContext });
    assert.equal(checkAuthCalls, 1, "checkAuth must run for a non-cron origin");
    assert.equal(result.text, "Not authorized");
  });
});
