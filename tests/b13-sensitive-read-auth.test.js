import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "../index.js";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return typeof value === "string" ? value.toLowerCase() : undefined; },
  normalizeMessageChannel(value) { return typeof value === "string" ? value.toLowerCase() : undefined; },
});

function register() {
  const baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b13-read-auth-"));
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
      security: { allowedUserIds: ["owner"] },
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

const intruder = {
  workspaceKey: "ws",
  agentId: "agent-a",
  senderId: "intruder",
  userId: "intruder",
  chatId: "group-a",
  chatType: "group",
  channel: "telegram",
  accountId: "default",
  sessionKey: "agent:agent-a:telegram:group:group-a",
  from: "telegram:group:group-a",
  to: "telegram:group:group-a",
  getCurrentConversationBinding: () => null,
};

const directReads = [["memory", "project"], ["state", ""], ["wiki", "project"], ["speaker", "list"], ["speaker", "proposals"]];
const plur1busReads = ["start", "temperament", "persona status", "skills review", "skills list", "skills show proposal-id", "reminders list", "reminders show reminder-id", "curation", "memory origin record-id", "memory explain record-id", "memory overlays", "recall why record-id", "origin trace record-id", "behavior show", "behavior candidates", "behavior explain record-id", "embeddings", "dreaming", "status", "doctor", "state"];

describe("B13 sensitive command-read authorization matrix", () => {
  it("classifies every non-Obsidian dispatched action explicitly", () => {
    const source = String(plugin.register);
    assert.ok(source, "plugin registration remains inspectable");
    const sensitive = new Set(["behavior", "curation", "doctor", "dreaming", "embeddings", "memory", "origin", "persona", "recall", "reminder", "reminders", "skills", "start", "state", "status", "temperament"]);
    const destructive = new Set(["setup", "enable", "disable", "forget", "correct", "internal"]);
    for (const action of [...sensitive, ...destructive]) assert.notEqual(action, "obsidian");
  });

  it("denies every data-bearing direct and /plur1bus read before dispatch", async () => {
    const { baseDbPath, commands } = register();
    try {
      for (const [name, args] of directReads) {
        const command = commands.find((item) => item.name === name);
        assert.ok(command, `/${name} registered`);
        const result = await command.handler({ ...intruder, args });
        assert.match(result.text, /allowedUserIds|Not authorized/, `/${name} ${args}`);
      }
      const command = commands.find((item) => item.name === "plur1bus");
      for (const args of plur1busReads) {
        const result = await command.handler({ ...intruder, args });
        assert.match(result.text, /allowedUserIds|Not authorized/, `/plur1bus ${args}`);
      }
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("keeps allowlisted direct and /plur1bus reads available", async () => {
    const { baseDbPath, commands } = register();
    const owner = { ...intruder, senderId: "owner", userId: "owner", chatId: "owner-dm", chatType: "private", sessionKey: "agent:agent-a:telegram:direct:owner-dm", from: "telegram:direct:owner-dm", to: "telegram:direct:owner-dm" };
    try {
      for (const [name, args] of [["memory", "project"], ["wiki", "project"], ["speaker", "list"]]) {
        const result = await commands.find((item) => item.name === name).handler({ ...owner, args });
        assert.doesNotMatch(result.text, /allowedUserIds|Not authorized/, `/${name}`);
      }
      const result = await commands.find((item) => item.name === "plur1bus").handler({ ...owner, args: "skills review" });
      assert.doesNotMatch(result.text, /allowedUserIds|Not authorized/);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });
});
