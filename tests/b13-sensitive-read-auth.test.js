import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

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
const plur1busReads = ["start", "temperament", "persona", "skills review", "skills list", "skills show proposal-id", "reminders list", "reminders show reminder-id", "curation", "memory origin record-id", "memory explain record-id", "memory overlays", "recall why record-id", "origin trace record-id", "behavior show", "behavior candidates", "behavior explain record-id", "embeddings", "dreaming", "status", "doctor", "state"];

describe("B13 sensitive command-read authorization matrix", () => {
  it("classifies every non-Obsidian dispatched action explicitly", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    const observed = new Set([...source.matchAll(/if \(action(?:Key)? === "([a-z-]+)"/g)].map((match) => match[1]));
    const classes = {
      "public-help": new Set(),
      "sensitive-read": new Set(["behavior", "curation", "doctor", "dreaming", "embeddings", "memory", "origin", "persona", "recall", "reminder", "reminders", "skills", "start", "state", "status", "temperament", "neo"]),
      destructive: new Set(["setup", "enable", "disable", "forget", "correct"]),
      "internal-cron": new Set(["internal"]),
      "B14-obsidian": new Set(["obsidian", "conflicts", "cron", "dashboards", "evening", "evening-review", "morning", "morning-review", "review"]),
    };
    for (const action of observed) {
      const matches = Object.values(classes).filter((actions) => actions.has(action));
      assert.equal(matches.length, 1, `${action} must have exactly one dispatch class`);
    }
    assert.ok(observed.size > 15, "test must inspect the real dispatcher, not an independent literal list");
  });

  it("keeps public help and B14 delegation ahead of the general Neo store", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    const dispatcher = source.indexOf("const runPlur1busCommand");
    const generalStoreAt = source.indexOf("const commandStore = getNeoStore({", source.indexOf("const cronInternal", dispatcher));
    assert.ok(source.indexOf('actionKey === "obsidian"', dispatcher) < generalStoreAt);
    assert.ok(source.indexOf("handleObsidianBridgeCommand", dispatcher) < generalStoreAt);
    assert.ok(source.indexOf('actionKey === "skills" && !["review"', dispatcher) < generalStoreAt);
    assert.ok(source.indexOf('actionKey === "neo" && !(subKey === "workspaces"', dispatcher) < generalStoreAt);
  });

  it("authorizes direct handlers before I/O locale resolution and preserves runtime LLM identity", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    for (const marker of ["const runStatusCommand", "handler: async (commandCtx) => {\n            const deniedLen = checkArgsLength(commandCtx);", "const runMemoryCommand"]) {
      const start = source.indexOf(marker);
      const end = source.indexOf("\n        };", start);
      const handler = source.slice(start, end);
      assert.ok(handler.indexOf("resolveRegisteredMemoryContext") < handler.indexOf("resolveCommandLocale"), marker);
      assert.ok(handler.indexOf("checkAuth(memoryCtx") < handler.indexOf("resolveCommandLocale"), marker);
    }
    assert.doesNotMatch(source, /memoryCtx:\s*\{[^}]*runtimeContext\.llm/s);
    assert.doesNotMatch(source, /isAuthorized\([^,]+,\s*cfg,\s*\{[^}]*runtimeLlm/);
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

  it("keeps every recognized unknown subcommand public without invoking a data branch", async () => {
    const { baseDbPath, commands } = register();
    try {
      const command = commands.find((item) => item.name === "plur1bus");
      for (const args of ["persona bogus", "behavior bogus", "reminders bogus", "reminder bogus", "skills bogus", "neo bogus", "recall bogus", "origin bogus", "curation bogus"]) {
        const result = await command.handler({ ...intruder, args });
        assert.doesNotMatch(result.text, /allowedUserIds|Not authorized/, args);
      }
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("uses only canonical workspace fields for the general Neo store", () => {
    const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    const start = source.indexOf("const commandStore = getNeoStore({", source.indexOf("const cronInternal"));
    const store = source.slice(start, source.indexOf("});", start) + 3);
    assert.match(store, /workspaceDir: memoryCtx\?\.workspaceDir \|\| ""/);
    assert.match(store, /workspaceKey: memoryCtx\?\.workspaceIdentity \|\| ""/);
    assert.doesNotMatch(store, /commandCtx\.workspace(Key|Dir)/);
  });

  it("executes public, sensitive, destructive, cron, and B14 action fixtures through registered commands", async () => {
    const { baseDbPath, commands } = register();
    const command = commands.find((item) => item.name === "plur1bus");
    const runtimeLlm = { async complete() { throw new Error("LLM must not run"); } };
    const fixtures = [
      ["public-help", "reminders bogus", intruder, false],
      ["sensitive-read", "reminders list", intruder, true],
      ["destructive", "skills approve missing", intruder, true],
      ["internal-cron", "internal gc-run", { agentId: "agent-a", channel: "cron" }, false],
      ["B14-obsidian", "dashboards", intruder, false],
    ];
    try {
      for (const [classification, args, ctx, denied] of fixtures) {
        const result = await command.handler({ ...ctx, args, runtimeContext: { llm: runtimeLlm } });
        if (denied) assert.match(result.text, /allowedUserIds|Not authorized/, classification);
        else assert.doesNotMatch(result.text, /allowedUserIds|Not authorized/, classification);
      }
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("keeps denied and public paths away from the supplied runtime LLM capability", async () => {
    const { baseDbPath, commands } = register();
    let calls = 0;
    const runtimeLlm = { async complete() { calls++; return "unexpected"; } };
    try {
      const command = commands.find((item) => item.name === "plur1bus");
      for (const args of ["memory origin record-id", "reminders bogus", "persona bogus", "behavior bogus"]) {
        await command.handler({ ...intruder, args, runtimeContext: { llm: runtimeLlm } });
      }
      assert.equal(calls, 0);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });
});
