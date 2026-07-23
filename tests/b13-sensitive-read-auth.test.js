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

function register({ commandRuntimeHooks, handleObsidianBridgeCommand, config = {} } = {}) {
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
      ...config,
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    runtime: { agent: { async resolveAgentWorkspaceDir() { return baseDbPath; } } },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool: noop,
    registerService: noop,
    on: noop,
  }, { importRouting: async () => routingCapability, commandRuntimeHooks, handleObsidianBridgeCommand });
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
const plur1busReads = ["start", "temperament", "persona", "skills review", "skills list", "skills show proposal-id", "reminders list", "reminders show reminder-id", "curation", "memory origin record-id", "memory explain record-id", "memory overlays", "memory overlay", "memory contradictions", "memory doctor", "recall why record-id", "origin trace record-id", "behavior show", "behavior candidates", "behavior explain record-id", "embeddings", "dreaming", "status", "doctor", "state"];

const ACTION_FIXTURES = [
  ["public-help", ""], ["public-help", "help"], ["public-help", "unknown"],
  ["public-help", "skills bogus"], ["public-help", "neo bogus"], ["public-help", "recall bogus"], ["public-help", "origin bogus"], ["public-help", "persona bogus"], ["public-help", "behavior bogus"], ["public-help", "reminders bogus"], ["public-help", "curation bogus"],
  ["sensitive-read", "start"], ["sensitive-read", "temperament"], ["sensitive-read", "persona"],
  ["sensitive-read", "skills review"], ["sensitive-read", "skills list"], ["sensitive-read", "skills show proposal-id"],
  ["sensitive-read", "reminder list"], ["sensitive-read", "reminder show reminder-id"], ["sensitive-read", "reminder help"],
  ["sensitive-read", "reminders list"], ["sensitive-read", "reminders show reminder-id"], ["sensitive-read", "reminders help"],
  ["sensitive-read", "status"], ["sensitive-read", "doctor"], ["sensitive-read", "state"],
  ["sensitive-read", "curation"], ["sensitive-read", "curation conflicts"], ["sensitive-read", "curation stale"], ["sensitive-read", "curation promoted"],
  ["sensitive-read", "memory origin record-id"], ["sensitive-read", "memory explain record-id"], ["sensitive-read", "memory overlays"], ["sensitive-read", "memory overlay"], ["sensitive-read", "memory contradictions"], ["sensitive-read", "memory doctor"],
  ["sensitive-read", "recall why record-id"], ["sensitive-read", "origin trace record-id"],
  ["sensitive-read", "behavior show"], ["sensitive-read", "behavior candidates"], ["sensitive-read", "behavior explain record-id"],
  ["sensitive-read", "embeddings"], ["sensitive-read", "dreaming"], ["sensitive-read", "neo workspaces migrate --dry-run"],
  ["destructive", "setup safe"], ["destructive", "enable"], ["destructive", "disable"], ["destructive", "forget record-id"], ["destructive", "correct record-id text"],
  ["destructive", "temperament calm"], ["destructive", "persona regenerate"], ["destructive", "persona accept"],
  ["destructive", "skills approve proposal-id"], ["destructive", "skills reject proposal-id"],
  ["destructive", "reminder cancel reminder-id"], ["destructive", "reminders delete reminder-id"],
  ["destructive", "memory promote record-id"], ["destructive", "memory demote record-id"], ["destructive", "memory prune record-id"], ["destructive", "memory tombstone record-id"], ["destructive", "memory disable-overlay record-id"], ["destructive", "memory supersede-overlay record-id"],
  ["destructive", "behavior promote record-id"], ["destructive", "behavior demote record-id"], ["destructive", "behavior prune record-id"], ["destructive", "neo workspaces migrate"],
  ["internal-cron", "internal gc-run"],
  ["B14-obsidian", "obsidian help"], ["B14-obsidian", "conflicts"], ["B14-obsidian", "cron"], ["B14-obsidian", "dashboards"], ["B14-obsidian", "evening"], ["B14-obsidian", "evening-review"], ["B14-obsidian", "morning"], ["B14-obsidian", "morning-review"], ["B14-obsidian", "review"],
];

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
    const effects = { neo: 0, pool: 0, dbInit: 0, embed: 0, locale: 0, llm: 0 };
    const { baseDbPath, commands } = register({ commandRuntimeHooks: {
      onNeoStore: () => { effects.neo++; },
      onPoolAcquire: () => { effects.pool++; },
      onDbInit: () => { effects.dbInit++; },
      onEmbed: () => { effects.embed++; },
      onLocale: () => { effects.locale++; },
      onLlmCallContext: () => { effects.llm++; },
    } });
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
      assert.deepEqual(effects, { neo: 0, pool: 0, dbInit: 0, embed: 0, locale: 0, llm: 0 });
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

  it("executes every dispatcher action/subcommand fixture in exactly one class", async () => {
    const effects = { neo: [], pool: 0, dbInit: 0, embed: 0, locale: 0, llm: [] };
    const { baseDbPath, commands } = register({
      commandRuntimeHooks: {
        onNeoStore: (effect) => effects.neo.push(effect),
        onPoolAcquire: () => { effects.pool++; },
        onDbInit: () => { effects.dbInit++; },
        onEmbed: () => { effects.embed++; },
        onLocale: () => { effects.locale++; },
        onLlmCallContext: (context) => effects.llm.push(context),
      },
    });
    const command = commands.find((item) => item.name === "plur1bus");
    const runtimeLlm = { async complete() { throw new Error("LLM must not run"); } };
    try {
      for (const [classification, args] of ACTION_FIXTURES) {
        const ctx = classification === "internal-cron" ? { agentId: "agent-a", channel: "cron" } : intruder;
        const before = { neo: effects.neo.length, pool: effects.pool, dbInit: effects.dbInit, embed: effects.embed, locale: effects.locale, llm: effects.llm.length };
        const result = await command.handler({ ...ctx, args, runtimeContext: { llm: runtimeLlm } });
        if (classification === "sensitive-read" || classification === "destructive") {
          assert.match(result.text, /allowedUserIds|Not authorized/, args);
        } else {
          assert.doesNotMatch(result.text, /allowedUserIds|Not authorized/, args);
        }
        const delta = {
          neo: effects.neo.slice(before.neo), pool: effects.pool - before.pool, dbInit: effects.dbInit - before.dbInit,
          embed: effects.embed - before.embed, locale: effects.locale - before.locale, llm: effects.llm.length - before.llm,
        };
        if (classification === "public-help" || classification === "sensitive-read" || classification === "destructive") {
          assert.deepEqual(delta, { neo: [], pool: 0, dbInit: 0, embed: 0, locale: 0, llm: 0 }, `${args} must do no data-bearing work`);
        }
        if (classification === "B14-obsidian") {
          assert.ok(delta.neo.every((effect) => effect.purpose === "obsidian"), `${args} must not construct the general store`);
        }
      }
      assert.ok(ACTION_FIXTURES.some(([classification, args]) => classification === "public-help" && args), "public help must include non-empty input");
      assert.equal(effects.pool, 0, "denied/public dispatch must not acquire a DB pool");
      assert.equal(effects.dbInit, 0, "denied/public dispatch must not initialize a DB");
      assert.equal(effects.embed, 0, "denied/public dispatch must not embed");
      assert.equal(effects.llm.length, 0, "denied/public dispatch must not call an LLM");
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("delegates B14 aliases to the Obsidian handler without constructing the general store", async () => {
    const effects = [];
    const { baseDbPath, commands } = register({
      commandRuntimeHooks: { onNeoStore: (effect) => effects.push(effect) },
      handleObsidianBridgeCommand: async () => ({ text: "B14 registered handler reached" }),
    });
    try {
      const result = await commands.find((item) => item.name === "plur1bus").handler({ ...intruder, args: "obsidian help" });
      assert.equal(result.text, "B14 registered handler reached");
      assert.deepEqual(effects.map((effect) => effect.purpose), ["obsidian"]);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
    }
  });

  it("passes the exact registered runtime LLM only to its downstream call context", async () => {
    const contexts = [];
    const { baseDbPath, commands } = register({
      config: { merging: { enabled: true } },
      commandRuntimeHooks: { onLlmCallContext: (context) => contexts.push(context) },
    });
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b13-runtime-llm-"));
    const runtimeLlm = { async complete() { return "- concise\n- helpful\n- warm"; } };
    const owner = { ...intruder, senderId: "owner", userId: "owner", chatId: "owner-dm", chatType: "private" };
    try {
      const result = await commands.find((item) => item.name === "plur1bus").handler({ ...owner, args: "persona regenerate", workspaceDir, runtimeContext: { llm: runtimeLlm } });
      assert.match(result.text, /Persona profile generated|Persona-Profil erzeugt/);
      assert.equal(contexts.length, 1);
      assert.equal(contexts[0].runtimeLlm, runtimeLlm);
    } finally {
      rmSync(baseDbPath, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
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
