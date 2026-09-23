/**
 * tests/engine-principal.test.js — PR-06 (spec 3.4, step 7 gates).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createChannelRegistry, DEFAULT_CHANNELS, memoryContextFromPrincipal, principalFromMemoryContext } from "../engine/identity/principal.js";
import { agentContextFromCommand } from "../adapter/openclaw/turn-principal.js";
import { listRouteProviders, resolveHostHookPrincipal, resolveMemoryRequestContext, stableIdentityHash } from "../lib/memory-request-context.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const USER = `user:v1:${stableIdentityHash(JSON.stringify(["telegram", "default", "u1"]))}`;
const proved = { agentId: "agent-a", workspace: "workspace:v1:main", user: USER, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" };
const wsProved = makeTempDir("plur1bus-principal-proved-");
const wsInferred = makeTempDir("plur1bus-principal-inferred-");
const wsHook = makeTempDir("plur1bus-principal-hook-");

describe("memoryContextFromPrincipal", () => {
  it("a proved principal reaches user scope with the on-disk hash unchanged", () => {
    const ctx = memoryContextFromPrincipal(proved, { workspaceDir: wsProved });
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
    const ctx = memoryContextFromPrincipal(proved, { workspaceDir: wsProved });
    const back = principalFromMemoryContext(ctx, "proved");
    assert.deepEqual([back.agentId, back.user, back.channel, back.accountId, back.trust], ["agent-a", USER, "telegram", "default", "proved"]);
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
