import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveHostCommandMemoryContext } from "../lib/memory-request-context.js";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/u.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) {
    return { baseSessionKey: value, threadId: "" };
  },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

const base = {
  args: "",
  agentId: "agent-a",
  senderId: "owner-user",
  channel: "telegram",
  accountId: "default",
  sessionKey: "agent:agent-a:telegram:direct:owner-chat",
  from: "telegram:owner-chat",
  to: "telegram:owner-chat",
  getCurrentConversationBinding: () => null,
};

/**
 * OpenClaw's Telegram command path hands the plugin
 * `entry?.sessionId || randomUUID()`: a fresh random id on every command as
 * long as the chat has no persisted session. A two-step confirmation is two
 * commands, so in a fresh chat the bound conversation principal never matched
 * and confirm answered binding_mismatch. Only a sessionId the host has
 * persisted is conversation identity.
 */
describe("conversation principal and the persisted session entry", () => {
  function resolver(t, resolveSessionEntry) {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-persisted-session-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    return (ctx) => resolveHostCommandMemoryContext(ctx, {
      resolveAgentWorkspaceDir: async () => workspaceDir,
      routingLoader: async () => routingCapability,
      requireConversation: true,
      ...(resolveSessionEntry ? { resolveSessionEntry } : {}),
    });
  }

  it("ignores a host-minted random sessionId when the chat has no persisted session", async (t) => {
    const resolve = resolver(t, async () => ({ available: true, entry: null }));
    const prepare = await resolve({ ...base, sessionId: "random-1" });
    const confirm = await resolve({ ...base, sessionId: "random-2" });
    assert.equal(prepare.conversationPrincipal, confirm.conversationPrincipal);
  });

  it("binds the persisted sessionId, not whatever the call carried", async (t) => {
    const resolve = resolver(t, async () => ({ available: true, entry: { sessionId: "persisted-1" } }));
    const a = await resolve({ ...base, sessionId: "call-1" });
    const b = await resolve({ ...base, sessionId: "call-2" });
    assert.equal(a.conversationPrincipal, b.conversationPrincipal);
    assert.equal(a.sessionId, "persisted-1");
  });

  it("still separates two genuinely different persisted sessions", async (t) => {
    let current = "persisted-1";
    const resolve = resolver(t, async () => ({ available: true, entry: { sessionId: current } }));
    const first = await resolve({ ...base, sessionId: "call-1" });
    current = "persisted-2";
    const second = await resolve({ ...base, sessionId: "call-1" });
    assert.notEqual(first.conversationPrincipal, second.conversationPrincipal);
  });

  it("keeps trusting the call's sessionId when the host has no session store", async (t) => {
    const resolve = resolver(t, async () => ({ available: false }));
    const a = await resolve({ ...base, sessionId: "session-a" });
    const b = await resolve({ ...base, sessionId: "session-b" });
    assert.notEqual(a.conversationPrincipal, b.conversationPrincipal);
  });

  it("keeps trusting the call's sessionId when no session lookup is wired", async (t) => {
    // Hosts and tests without a session store keep today's behaviour, and the
    // "wrong session" attack in the share/forget/correct suites stays refused.
    const resolve = resolver(t, null);
    const a = await resolve({ ...base, sessionId: "session-a" });
    const b = await resolve({ ...base, sessionId: "session-b" });
    assert.notEqual(a.conversationPrincipal, b.conversationPrincipal);
  });

  it("resolves the persisted entry by the command's agent and session key", async (t) => {
    const seen = [];
    const resolve = resolver(t, async (scope) => { seen.push(scope); return { available: true, entry: null }; });
    await resolve({ ...base, sessionId: "random-1" });
    assert.deepEqual(seen, [{ agentId: "agent-a", sessionKey: "agent:agent-a:telegram:direct:owner-chat" }]);
  });
});
