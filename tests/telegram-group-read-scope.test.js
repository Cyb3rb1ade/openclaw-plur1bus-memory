import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import plugin from "../index.js";
import { isAuthorized } from "../lib/security.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// Audit engine-telegram F1: without allowedUserIds/allowedChatIds, read
// commands that return memory content must not run in groups (README
// `security.allowedUserIds`: non-destructive commands run in private 1:1
// contexts). DMs of the owner keep working; an allowlist is unchanged.

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return typeof value === "string" ? value.toLowerCase() : undefined; },
  normalizeMessageChannel(value) { return typeof value === "string" ? value.toLowerCase() : undefined; },
});

function register({ security = {} } = {}) {
  const baseDbPath = makeTempDir("plur1bus-group-read-scope-");
  const commands = [];
  const noop = () => {};
  plugin.register({
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: true },
      obsidianBridge: { enabled: false },
      security,
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    runtime: { agent: { async resolveAgentWorkspaceDir() { return baseDbPath; } } },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool: noop,
    registerService: noop,
    on: noop,
  }, { importRouting: async () => routingCapability });
  return { baseDbPath, commands };
}

const group = {
  workspaceKey: "ws",
  agentId: "agent-a",
  senderId: "member",
  userId: "member",
  chatId: "group-a",
  chatType: "group",
  channel: "telegram",
  accountId: "default",
  sessionKey: "agent:agent-a:telegram:group:group-a",
  from: "telegram:group:group-a",
  to: "telegram:group:group-a",
  getCurrentConversationBinding: () => null,
};
const dm = {
  ...group,
  senderId: "owner",
  userId: "owner",
  chatId: "owner-dm",
  chatType: "private",
  sessionKey: "agent:agent-a:telegram:direct:owner-dm",
  from: "telegram:direct:owner-dm",
  to: "telegram:direct:owner-dm",
};

const DENIED = /private 1:1|privaten 1:1|Not authorized|Nicht autorisiert|Keine Berechtigung/;
const directReads = [["memory", "gesundheit"], ["wiki", "projekt"], ["state", ""], ["speaker", "list"]];
const plur1busReads = ["critical list", "critical", "memory explain record-id", "status", "skills list", "persona"];

describe("isAuthorized sensitiveRead (no allowlist configured)", () => {
  it("denies group and unknown chats, allows private 1:1", () => {
    for (const ctx of [{ chatType: "group" }, { chat: { type: "supergroup" } }, { chatId: "c1" }]) {
      const result = isAuthorized(ctx, {}, { sensitiveRead: true });
      assert.equal(result.authorized, false, JSON.stringify(ctx));
      assert.equal(result.reason, "security.private_chat_required");
    }
    assert.equal(isAuthorized({ chatType: "private" }, {}, { sensitiveRead: true }).authorized, true);
    assert.equal(isAuthorized({ chatType: "group" }, {}, { sensitiveRead: true, chatKind: "private" }).authorized, true);
  });

  it("leaves configured allowlists and plain non-destructive checks unchanged", () => {
    const users = { security: { allowedUserIds: ["owner"] } };
    assert.equal(isAuthorized({ userId: "owner", chatType: "group" }, users, { sensitiveRead: true }).authorized, true);
    assert.equal(isAuthorized({ userId: "x", chatType: "group" }, users, { sensitiveRead: true }).authorized, false);
    const chats = { security: { allowedChatIds: ["g1"] } };
    assert.equal(isAuthorized({ chatId: "g1", chatType: "group" }, chats, { sensitiveRead: true }).authorized, true);
    assert.equal(isAuthorized({ chatType: "group" }, {}, {}).authorized, true);
    assert.equal(isAuthorized({ chatType: "group" }, {}, { destructive: true }).reason, "security.no_auth_configured");
  });
});

describe("read commands without allowlist", () => {
  it("refuses memory-bearing reads in groups before any data access", async () => {
    const { baseDbPath, commands } = register();
    try {
      for (const [name, args] of directReads) {
        const command = commands.find((item) => item.name === name);
        assert.ok(command, `/${name} registered`);
        const result = await command.handler({ ...group, args });
        assert.match(result.text, DENIED, `/${name} ${args} in group`);
      }
      const command = commands.find((item) => item.name === "plur1bus");
      for (const args of plur1busReads) {
        const result = await command.handler({ ...group, args });
        assert.match(result.text, DENIED, `/plur1bus ${args} in group`);
      }
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("keeps the owner's private chat working without allowlist", async () => {
    const { baseDbPath, commands } = register();
    try {
      for (const [name, args] of directReads) {
        const result = await commands.find((item) => item.name === name).handler({ ...dm, args });
        assert.doesNotMatch(result.text, DENIED, `/${name} ${args} in DM`);
      }
      const command = commands.find((item) => item.name === "plur1bus");
      for (const args of plur1busReads) {
        const result = await command.handler({ ...dm, args });
        assert.doesNotMatch(result.text, DENIED, `/plur1bus ${args} in DM`);
      }
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("allows group reads when the group is allowlisted", async () => {
    const { baseDbPath, commands } = register({ security: { allowedChatIds: ["group-a"] } });
    try {
      for (const [name, args] of [["memory", "gesundheit"], ["wiki", "projekt"]]) {
        const result = await commands.find((item) => item.name === name).handler({ ...group, args });
        assert.doesNotMatch(result.text, DENIED, `/${name} ${args} in allowlisted group`);
      }
      const result = await commands.find((item) => item.name === "plur1bus").handler({ ...group, args: "critical list" });
      assert.doesNotMatch(result.text, DENIED);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });
});
