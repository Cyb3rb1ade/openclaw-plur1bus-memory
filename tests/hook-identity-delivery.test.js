import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildMemoryAccountTopology,
  createMemoryTurnRouteRegistry,
  resolveHostHookMemoryContext,
} from "../lib/memory-request-context.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// 7.12.30: Session-Eintraege von OpenClaw 2026.9 (entry.delivery) und Hooks
// ohne messageProvider muessen den authentifizierten Kontext liefern.
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

const SESSION_KEY = "agent:main:telegram:default:direct:55736530";

function registryWithDispatch() {
  const registry = createMemoryTurnRouteRegistry({ routingCapability, now: () => 1000 });
  assert.equal(registry.observeReplyDispatch({
    runId: "run-a",
    sessionKey: SESSION_KEY,
    originatingChannel: "telegram",
    originatingTo: "55736530",
    originatingAccountId: "default",
    ctx: {
      AgentId: "main", SessionKey: SESSION_KEY, AccountId: "default", SenderId: "55736530",
      Provider: "telegram", ChatId: "55736530", OriginatingTo: "55736530", CommandBody: "ordinary message",
    },
  }), undefined);
  return registry;
}

function hookCtx(workspaceDir, extra = {}) {
  return {
    runId: "run-a", agentId: "main", sessionKey: SESSION_KEY, sessionId: "session-a", workspaceDir,
    messageProvider: "telegram", senderId: "55736530", chatId: "55736530",
    channelContext: { sender: { id: "55736530" }, chat: { id: "55736530" } },
    ...extra,
  };
}

// Exakt die Form aus agents/main/agent/openclaw-agent.sqlite (session_nodes.entry_json), 10.09.2026.
function deliveryEntry() {
  return {
    sessionId: "session-a",
    chatType: "direct",
    delivery: {
      kind: "external",
      route: { channel: "telegram", accountId: "default", target: { to: "telegram:55736530" } },
      context: { channel: "telegram", to: "telegram:55736530", accountId: "default" },
      origin: { provider: "telegram", to: "telegram:55736530", accountId: "default", chatType: "direct", surface: "telegram", from: "telegram:55736530" },
    },
  };
}

function resolve(hook, registry, entry, logger = null) {
  return resolveHostHookMemoryContext(hook, {
    routingCapability,
    turnRoutes: registry,
    accountTopology: buildMemoryAccountTopology({ channels: { telegram: {} } }),
    getSessionEntry: () => entry,
    logger,
  });
}

describe("hook identity with 2026.9 session entries", () => {
  it("authenticates a DM turn from the entry.delivery object", async (t) => {
    const workspaceDir = makeTempDir("plur1bus-hook-delivery-");
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = registryWithDispatch();
    const warnings = [];
    const ctx = await resolve(hookCtx(workspaceDir), registry, deliveryEntry(), { warn: (...args) => warnings.push(args) });
    assert.match(ctx.userPrincipal, /^user:v1:[a-f0-9]{64}$/);
    assert.equal(ctx.accountId, "default");
    assert.equal(ctx.channel, "telegram");
    assert.equal(warnings.length, 0, "no fallback warning");
    assert.equal(registry.pendingCount(), 0);
  });

  it("derives the provider from the canonical session key when the hook carries no messageProvider", async (t) => {
    const workspaceDir = makeTempDir("plur1bus-hook-noprovider-");
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = registryWithDispatch();
    const hook = hookCtx(workspaceDir);
    delete hook.messageProvider;
    const ctx = await resolve(hook, registry, deliveryEntry());
    assert.match(ctx.userPrincipal, /^user:v1:[a-f0-9]{64}$/);
    assert.equal(ctx.channel, "telegram");
  });

  it("still rejects a conflicting delivery channel and reports values in the fallback warning", async (t) => {
    const workspaceDir = makeTempDir("plur1bus-hook-conflict-");
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = registryWithDispatch();
    const entry = deliveryEntry();
    entry.delivery.route.channel = "discord";
    const warnings = [];
    const ctx = await resolve(hookCtx(workspaceDir), registry, entry, { warn: (...args) => warnings.push(args) });
    assert.equal(ctx.userPrincipal, "", "falls back to the unauthenticated base context");
    assert.equal(warnings.length, 1);
    const extra = warnings[0].find((arg) => arg && typeof arg === "object");
    assert.equal(extra.reason, "conflicting entry provider");
    assert.equal(extra.provider, "telegram");
    assert.equal(extra.step, "entry");
    assert.equal(typeof extra.sessionEntryMs, "number");
  });

  it("reports an entry without any provider alias as reason=provider with both values", async (t) => {
    const workspaceDir = makeTempDir("plur1bus-hook-noentry-");
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = registryWithDispatch();
    const warnings = [];
    const ctx = await resolve(hookCtx(workspaceDir), registry, { sessionId: "session-a", chatType: "direct" }, { warn: (...args) => warnings.push(args) });
    assert.equal(ctx.userPrincipal, "");
    const extra = warnings[0].find((arg) => arg && typeof arg === "object");
    assert.equal(extra.reason, "provider");
    assert.equal(extra.provider, "telegram");
    assert.equal(extra.entryProvider, "");
  });

  it("warns when the session entry read is slow but still authenticates", async (t) => {
    const workspaceDir = makeTempDir("plur1bus-hook-slow-");
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    const registry = registryWithDispatch();
    const warnings = [];
    const ctx = await resolveHostHookMemoryContext(hookCtx(workspaceDir), {
      routingCapability, turnRoutes: registry,
      accountTopology: buildMemoryAccountTopology({ channels: { telegram: {} } }),
      getSessionEntry: () => new Promise((resolve) => setTimeout(() => resolve(deliveryEntry()), 1050)),
      logger: { warn: (...args) => warnings.push(args) },
    });
    assert.match(ctx.userPrincipal, /^user:v1:[a-f0-9]{64}$/);
    assert.ok(warnings.some((args) => /session entry read took \d+ ms/.test(String(args[0]))));
  });
});
