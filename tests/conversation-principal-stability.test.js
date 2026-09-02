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

/**
 * A two-step confirmation -- vault-confirm, semantic-discovery -- is
 * necessarily two chat messages. If the conversation principal changed between
 * them, confirm could never match what prepare bound, and the whole flow was
 * unreachable over any chat channel.
 */
describe("conversation principal across consecutive messages", () => {
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

  function resolver(t) {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-convprincipal-"));
    t.after(() => rmSync(workspaceDir, { recursive: true, force: true }));
    return (ctx) => resolveHostCommandMemoryContext(ctx, {
      resolveAgentWorkspaceDir: async () => workspaceDir,
      routingLoader: async () => routingCapability,
      requireConversation: true,
    });
  }

  it("stays identical when only the per-call sessionId differs", async (t) => {
    const resolve = resolver(t);
    const prepare = await resolve({ ...base, sessionId: "run-1" });
    const confirm = await resolve({ ...base, sessionId: "run-2" });
    assert.match(prepare.conversationPrincipal, /^conversation:v1:/u);
    assert.equal(
      prepare.conversationPrincipal,
      confirm.conversationPrincipal,
      "a second message in the same chat must bind identically",
    );
  });

  it("stays identical whether or not a sessionId is present at all", async (t) => {
    const resolve = resolver(t);
    const withId = await resolve({ ...base, sessionId: "run-1" });
    const withoutId = await resolve({ ...base });
    assert.equal(withId.conversationPrincipal, withoutId.conversationPrincipal);
  });

  it("still separates a different chat, thread and agent", async (t) => {
    const resolve = resolver(t);
    const own = await resolve({ ...base, sessionId: "run-1" });
    const otherChat = await resolve({
      ...base,
      sessionKey: "agent:agent-a:telegram:direct:other-chat",
      from: "telegram:other-chat",
      to: "telegram:other-chat",
    });
    const otherAgent = await resolve({
      ...base,
      agentId: "agent-b",
      sessionKey: "agent:agent-b:telegram:direct:owner-chat",
    });
    assert.notEqual(own.conversationPrincipal, otherChat.conversationPrincipal);
    assert.notEqual(own.conversationPrincipal, otherAgent.conversationPrincipal);
  });
});
