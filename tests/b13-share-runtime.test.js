import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VECTOR_DIM = 384;

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return value || ""; },
  normalizeMessageChannel(value) { return value; },
});

function officialHostContext(args, { senderId = "owner", chatId = "chat-a" } = {}) {
  return {
    args,
    agentId: "agent-a",
    senderId,
    channel: "telegram",
    accountId: "default",
    sessionKey: "agent:agent-a:telegram:default:direct:chat-a",
    from: `telegram:direct:${chatId}`,
    to: `telegram:direct:${chatId}`,
    config: {},
    getCurrentConversationBinding: async () => ({
      channel: "telegram", accountId: "default", conversationId: chatId,
      parentConversationId: chatId, threadId: "", peerKind: "direct",
    }),
  };
}

describe("B13 registered share commands", () => {
  it("registers both /share and /teile aliases with one handler", async () => {
    const baseDbPath = mkdtempSync(join(tmpdir(), "p1b-share-db-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "p1b-share-ws-"));
    const commands = [];
    const api = {
      pluginConfig: { baseDbPath, embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } }, merging: { enabled: false }, emotion: { t3: { enabled: false } }, obsidianBridge: { enabled: false }, autoCapture: false, autoRecall: false, neo: { enabled: false }, gc: { enabled: false }, security: { allowedUserIds: ["owner"], allowedChatIds: ["chat-a"] } },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: { agent: { async resolveAgentWorkspaceDir() { return workspaceDir; } } },
      resolvePath: (value) => value,
      registerCommand(command) { commands.push(command); }, registerTool() {}, registerService() {}, on() {},
    };
    const { default: plugin } = await import("../index.js");
    plugin.register(api, { importRouting: async () => routingCapability });
    const share = commands.find((command) => command.name === "share");
    const teile = commands.find((command) => command.name === "teile");
    assert.ok(share, "/share must be registered");
    assert.ok(teile, "/teile must be registered");
    assert.equal(share.handler, teile.handler, "aliases must share the exact handler");
    const invalid = await share.handler(officialHostContext("not-a-uuid"));
    assert.match(invalid.text, /usage|invalid/i);
    rmSync(baseDbPath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });
});
