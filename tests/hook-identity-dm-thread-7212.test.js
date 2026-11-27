/**
 * tests/hook-identity-dm-thread-7212.test.js — 7.21.2 ACL fix: Telegram DM
 * threads.
 *
 * OpenClaw 2026.11 keys a Telegram DM topic as
 *   agent:main:telegram:default:direct:55736530:thread:55736530:64934
 * while hook, reply dispatch and session entry name the thread "64934". Until
 * 7.21.1 the dispatch failed with "conflicting threadId" (no ticket) and the
 * prompt hook with thread_missing: 22 of 23 recalls on 24.11.2026 ran
 * unauthenticated, Christian's user-scoped memories stayed invisible.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import {
  buildMemoryAccountTopology,
  createMemoryTurnRouteRegistry,
  resolveHostHookMemoryContext,
} from "../lib/memory-request-context.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// Same thread split as the host (parseThreadSessionSuffix: lastIndexOf(":thread:")).
const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    const i = String(value).lastIndexOf(":thread:");
    return i === -1 ? { baseSessionKey: value, threadId: undefined } : { baseSessionKey: value.slice(0, i), threadId: value.slice(i + 8) };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  isIncognitoSessionKey() { return false; },
});

const PEER = "55736530";
const THREAD = "64934";
const SESSION_KEY = `agent:main:telegram:default:direct:${PEER}:thread:${PEER}:${THREAD}`;

function registryWithDispatch(sessionKey = SESSION_KEY) {
  const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
  const observed = registry.observeReplyDispatch({
    runId: "run-t",
    sessionKey,
    originatingChannel: "telegram",
    originatingTo: `telegram:${PEER}`,
    originatingAccountId: "default",
    originatingThreadId: THREAD,
    ctx: {
      AgentId: "main", SessionKey: sessionKey, AccountId: "default", SenderId: PEER,
      Provider: "telegram", ChatId: PEER, OriginatingTo: `telegram:${PEER}`, MessageThreadId: THREAD, CommandBody: "Hallo Bernd",
    },
  });
  return { registry, observed };
}

// Shape of session_nodes.entry_json for Christian's DM thread (24.11.2026).
function entry(threadId = THREAD) {
  return {
    sessionId: "session-t",
    chatType: "direct",
    delivery: {
      kind: "external",
      route: { channel: "telegram", accountId: "default", target: { to: `telegram:${PEER}` } },
      context: { channel: "telegram", to: `telegram:${PEER}`, accountId: "default", threadId },
      origin: { provider: "telegram", to: `telegram:${PEER}`, accountId: "default", chatType: "direct", threadId },
    },
  };
}

function hook(workspaceDir, extra = {}) {
  return {
    runId: "run-t", agentId: "main", sessionKey: SESSION_KEY, sessionId: "session-t", workspaceDir,
    messageProvider: "telegram", senderId: PEER, chatId: PEER,
    channelContext: { sender: { id: PEER }, chat: { id: PEER } },
    ...extra,
  };
}

const resolve = (hookCtx, registry, sessionEntry, logger = null) => resolveHostHookMemoryContext(hookCtx, {
  routingCapability,
  turnRoutes: registry,
  accountTopology: buildMemoryAccountTopology({ channels: { telegram: {} } }),
  getSessionEntry: () => sessionEntry,
  logger,
});

describe("Telegram DM threads (7.21.2)", () => {
  it("the dispatch registers a ticket instead of 'conflicting threadId'", () => {
    const { registry } = registryWithDispatch();
    assert.equal(registry.pendingCount(), 1, registry.explain(SESSION_KEY));
  });

  it("authenticates the turn when the hook carries no messageThreadId", async (t) => {
    const dir = makeTempDir("plur1bus-dm-thread-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { registry } = registryWithDispatch();
    const ctx = await resolve(hook(dir), registry, entry());
    assert.match(ctx.userPrincipal, /^user:v1:[a-f0-9]{64}$/);
  });

  it("authenticates the turn when the hook carries messageThreadId 64934", async (t) => {
    const dir = makeTempDir("plur1bus-dm-thread-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { registry } = registryWithDispatch();
    const ctx = await resolve(hook(dir, { messageThreadId: THREAD }), registry, entry());
    assert.match(ctx.userPrincipal, /^user:v1:[a-f0-9]{64}$/);
  });

  it("still refuses a session entry of another thread", async (t) => {
    const dir = makeTempDir("plur1bus-dm-thread-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { registry } = registryWithDispatch();
    const ctx = await resolve(hook(dir), registry, entry("99999"));
    assert.equal(ctx.userPrincipal, "");
  });

  it("still refuses a session entry without a thread", async (t) => {
    const dir = makeTempDir("plur1bus-dm-thread-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { registry } = registryWithDispatch();
    const bare = entry();
    delete bare.delivery.context.threadId;
    delete bare.delivery.origin.threadId;
    const ctx = await resolve(hook(dir), registry, bare);
    assert.equal(ctx.userPrincipal, "");
  });

  it("strips only the conversation partner's own prefix", () => {
    const foreign = `agent:main:telegram:default:direct:${PEER}:thread:11111111:${THREAD}`;
    const { registry } = registryWithDispatch(foreign);
    assert.equal(registry.pendingCount(), 0);
    assert.match(registry.explain(foreign), /invalid_identity:conflicting threadId/);
  });

  it("a hook messageThreadId of another thread is refused", async (t) => {
    const dir = makeTempDir("plur1bus-dm-thread-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { registry } = registryWithDispatch();
    const ctx = await resolve(hook(dir, { messageThreadId: "12345" }), registry, entry());
    assert.equal(ctx.userPrincipal, "");
  });
});
