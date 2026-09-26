import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  applyVoiceMode,
  buildVoiceModeMessage,
  isOwnerSender,
  parseVoiceButtonPayload,
  parseVoiceCommand,
} from "../lib/voice-mode-switch.js";
import { readVoiceMode } from "../lib/voice-mode.js";

const config = {
  commands: { ownerAllowFrom: ["discord:1323072788939935867"] },
  channels: { discord: { voice: { allowedChannels: [
    { guildId: "1486678369901744240", channelId: "1486678370434551811" },
    { guildId: "1486678369901744240", channelId: "1518159522076823592" },
  ] } } },
};

test("parses /voice commands and ignores other text", () => {
  assert.deepEqual(parseVoiceCommand("/voice"), { action: "menu" });
  assert.deepEqual(parseVoiceCommand("/voice light"), { action: "light" });
  assert.deepEqual(parseVoiceCommand("/voice Full"), { action: "persona" });
  assert.deepEqual(parseVoiceCommand("/voice persona"), { action: "persona" });
  assert.deepEqual(parseVoiceCommand("/voice status"), { action: "status" });
  assert.equal(parseVoiceCommand("/voice turbo"), null);
  assert.equal(parseVoiceCommand("voice light"), null);
  assert.equal(parseVoiceCommand("/vc join"), null);
});

test("parses button payloads", () => {
  assert.deepEqual(parseVoiceButtonPayload("light:main"), { mode: "light", agentId: "main" });
  assert.deepEqual(parseVoiceButtonPayload("persona:main"), { mode: "persona", agentId: "main" });
  for (const bad of ["", "turbo:main", "light", "light:../x", "light:main:extra"]) {
    assert.equal(parseVoiceButtonPayload(bad), null, bad);
  }
});

test("the mode message marks the active mode and offers both buttons", () => {
  const msg = buildVoiceModeMessage("main", "light");
  assert.match(msg.text, /Light/);
  const buttons = msg.interactive.blocks[0].buttons;
  assert.deepEqual(buttons.map((b) => b.action.value), ["plurv:persona:main", "plurv:light:main"]);
  assert.equal(msg.interactive.blocks[0].type, "buttons");
});

test("only the configured Discord owner may switch", () => {
  assert.equal(isOwnerSender("1323072788939935867", config), true);
  assert.equal(isOwnerSender("discord:1323072788939935867", config), true);
  assert.equal(isOwnerSender("999", config), false);
  assert.equal(isOwnerSender("1323072788939935867", {}), false, "no owner configured → nobody");
});

test("applying light stores the mode and sets thinking off in every voice session, never the model", async (t) => {
  const base = makeTempDir("plur1bus-voice-switch-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const patches = [];
  const patchSessionEntry = async ({ agentId, sessionKey, update }) => {
    const next = update({ thinkingLevel: "high", model: "keep" });
    patches.push({ agentId, sessionKey, next });
    return next;
  };
  const out = await applyVoiceMode({ baseDbPath: base, agentId: "main", mode: "light", config, patchSessionEntry, by: "discord:1323072788939935867" });
  assert.deepEqual(out, { mode: "light", patched: 2, failed: 0 });
  assert.equal(readVoiceMode(base, "main"), "light");
  assert.deepEqual(patches.map((p) => p.sessionKey), [
    "agent:main:discord:channel:1486678370434551811",
    "agent:main:discord:channel:1518159522076823592",
  ]);
  for (const p of patches) {
    assert.equal(p.next.thinkingLevel, "off");
    assert.equal(p.next.reasoningLevel, "off");
    assert.equal(p.next.model, "keep", "the model is never touched");
  }

  patches.length = 0;
  await applyVoiceMode({ baseDbPath: base, agentId: "main", mode: "persona", config, patchSessionEntry });
  assert.equal(readVoiceMode(base, "main"), "persona");
  for (const p of patches) {
    assert.equal("thinkingLevel" in p.next, false, "persona removes the thinking override");
    assert.equal(p.next.reasoningLevel, "off", "reasoning stays off in voice rooms");
  }
});

test("a failing session patch is counted, the mode is still stored", async (t) => {
  const base = makeTempDir("plur1bus-voice-switch-");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const out = await applyVoiceMode({
    baseDbPath: base, agentId: "main", mode: "light", config,
    patchSessionEntry: async () => { throw new Error("locked"); },
  });
  assert.deepEqual(out, { mode: "light", patched: 0, failed: 2 });
  assert.equal(readVoiceMode(base, "main"), "light");
});

test("the /voice hook and the plurv button switch the mode for the owner only", async (t) => {
  const { rmSync: rm } = await import("node:fs");
  const { makeTempDir } = await import("./helpers/temp-dir.js");
  const baseDbPath = makeTempDir("plur1bus-voice-hook-");
  t.after(() => rm(baseDbPath, { recursive: true, force: true }));
  const hooks = [];
  const interactive = [];
  const patched = [];
  const sent = [];
  const api = {
    pluginConfig: { baseDbPath, embedding: { provider: "local-transformers", local: { dimensions: 384 } }, autoCapture: false, autoRecall: false, neo: { enabled: false }, obsidianBridge: { enabled: false }, featureCronSetup: { auto: false }, gc: { enabled: false } },
    config,
    logger: { debug() {}, error() {}, info() {}, warn() {} },
    runtime: {
      agent: { async resolveAgentWorkspaceDir() { return baseDbPath; }, session: { async patchSessionEntry(p) { patched.push(p.sessionKey); return p.update({}); } } },
      channel: { outbound: { async loadAdapter(channel) { assert.equal(channel, "discord"); return { async sendPayload(ctx) { sent.push(ctx); return { messageId: String(sent.length) }; } }; } } },
    },
    resolvePath: (v) => v,
    registerCommand() {}, registerTool() {}, registerService() {},
    on(name, fn) { hooks.push({ name, fn }); },
    registerInteractiveHandler(r) { interactive.push(r); },
  };
  const mod = await import(`../index.js?voice-switch=${Date.now()}`);
  mod.default.register(api, { importRouting: async () => ({
    parseAgentSessionKey(v) { const m = /^agent:([^:]+):(.+)$/.exec(v); return m ? { agentId: m[1], rest: m[2] } : null; },
    parseThreadSessionSuffix(v) { return { baseSessionKey: v, threadId: "" }; },
    normalizeOptionalAccountId(v) { return v || undefined; },
    normalizeMessageChannel(v) { return v || undefined; },
  }) });
  const dispatchHooks = hooks.filter((h) => h.name === "before_dispatch").map((h) => h.fn);
  const run = async (event, context) => {
    for (const fn of dispatchHooks) {
      const out = await fn(event, context);
      if (out?.handled) return out;
    }
    return undefined;
  };
  const context = { channelId: "discord", accountId: "default", senderId: "1323072788939935867", conversationId: "channel:1518159522076823592", sessionKey: "agent:main:discord:channel:1518159522076823592" };

  const light = await run({ body: "/voice light", isGroup: true }, context);
  assert.equal(light?.handled, true);
  assert.equal(readVoiceMode(baseDbPath, "main"), "light");
  assert.equal(patched.length, 2);
  assert.equal(sent.length, 1, "the mode message with buttons is sent to the channel");
  assert.equal(sent[0].to, "channel:1518159522076823592");
  assert.equal(sent[0].accountId, "default");
  assert.match(sent[0].payload.text, /Light/);
  assert.equal(sent[0].payload.interactive.blocks[0].type, "buttons");

  const stranger = await run({ body: "/voice full" }, { ...context, senderId: "42" });
  assert.match(stranger.text, /Nur der Besitzer/);
  assert.equal(readVoiceMode(baseDbPath, "main"), "light");

  const telegram = await run({ body: "/voice full" }, { ...context, channelId: "telegram" });
  assert.match(telegram.text, /nur für Discord/);

  assert.equal(await run({ body: "Hallo Bernd" }, context), undefined);

  const button = interactive.find((r) => r.channel === "discord" && r.namespace === "plurv");
  assert.ok(button, "a discord handler for plurv is registered");
  const cleared = [];
  const tap = (senderId, authorized = true) => button.handler({
    channel: "discord",
    accountId: "default",
    conversationId: "channel:1518159522076823592",
    senderId,
    auth: { isAuthorizedSender: authorized },
    interaction: { kind: "button", payload: "persona:main" },
    respond: { clearComponents: async (p) => cleared.push(p), editMessage: async () => {}, acknowledge: async () => {} },
  });
  await tap("42");
  assert.equal(readVoiceMode(baseDbPath, "main"), "light", "stranger tap changes nothing");
  assert.equal(cleared.length, 0);
  await tap("1323072788939935867");
  assert.equal(readVoiceMode(baseDbPath, "main"), "persona");
  assert.match(cleared.at(-1).text, /Persona/);
  assert.equal(sent.length, 2, "fresh buttons follow the click");
  assert.match(sent[1].payload.text, /Persona/);
});
