// tests/voice-light-hooks.test.js
// Light lässt Recall und Zusatzblöcke weg und nimmt pro Lauf Haiku — nur für
// Discord-Sprachzüge im Light-Modus (7.17.0).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { LIGHT_MODEL, LIGHT_VOICE_GUIDANCE, writeVoiceMode } from "../lib/voice-mode.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) { return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined; },
  normalizeMessageChannel(value) { return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined; },
});

async function register(t, overrides = {}) {
  const baseDbPath = makeTempDir("plur1bus-voice-light-");
  t.after(() => rmSync(baseDbPath, { recursive: true, force: true }));
  const handlers = new Map();
  const api = {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 384 } },
      autoCapture: false,
      autoRecall: true,
      neo: { enabled: false },
      obsidianBridge: { enabled: false },
      featureCronSetup: { auto: false },
      gc: { enabled: false },
      ...overrides,
    },
    logger: { debug() {}, error() {}, info() {}, warn() {} },
    runtime: { agent: { async resolveAgentWorkspaceDir() { return baseDbPath; } } },
    resolvePath: (v) => v,
    registerCommand() {}, registerTool() {}, registerService() {},
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
  };
  const mod = await import(`../index.js?voice-light=${Date.now()}-${Math.random()}`);
  mod.default.register(api, { importRouting: async () => routingCapability });
  return { baseDbPath, handlers };
}

const voiceCtx = { agentId: "main", messageProvider: "discord-voice", sessionKey: "agent:main:discord:channel:1518159522076823592" };

test("a light voice turn gets only the light guidance and no recall", async (t) => {
  const { baseDbPath, handlers } = await register(t);
  writeVoiceMode(baseDbPath, "main", "light");
  const recall = handlers.get("before_prompt_build").at(-1);
  const result = await recall({ prompt: "Was habe ich gestern gegessen?", messages: [] }, voiceCtx);
  assert.deepEqual(result, { prependContext: LIGHT_VOICE_GUIDANCE });
});

test("a persona voice turn and a light text turn keep the normal hook path", async (t) => {
  const { baseDbPath, handlers } = await register(t);
  const recall = handlers.get("before_prompt_build").at(-1);
  const persona = await recall({ prompt: "Hallo", messages: [] }, voiceCtx);
  assert.notDeepEqual(persona, { prependContext: LIGHT_VOICE_GUIDANCE });
  writeVoiceMode(baseDbPath, "main", "light");
  const text = await recall({ prompt: "Hallo", messages: [] }, { ...voiceCtx, messageProvider: "discord" });
  assert.notDeepEqual(text, { prependContext: LIGHT_VOICE_GUIDANCE });
});

test("before_model_resolve switches to Haiku only for light voice turns", async (t) => {
  const { baseDbPath, handlers } = await register(t);
  const resolve = handlers.get("before_model_resolve")?.at(-1);
  assert.equal(typeof resolve, "function", "the plugin registers before_model_resolve");
  assert.equal(await resolve({ prompt: "x" }, voiceCtx), undefined, "persona keeps the agent model");
  writeVoiceMode(baseDbPath, "main", "light");
  assert.deepEqual(await resolve({ prompt: "x" }, voiceCtx), LIGHT_MODEL);
  assert.equal(await resolve({ prompt: "x" }, { ...voiceCtx, messageProvider: "telegram" }), undefined);
});

test("with auto-recall off the maintenance hook also stays quiet for light voice turns", async (t) => {
  const { baseDbPath, handlers } = await register(t, { autoRecall: false, neo: { enabled: true } });
  writeVoiceMode(baseDbPath, "main", "light");
  const hook = handlers.get("before_prompt_build").at(-1);
  // Echte Sprachzüge tragen ein workspaceDir; ohne es steigt die
  // Workspace-Policy vorher aus (gewollt: eine abgeschaltete Policy gewinnt).
  const ctx = { ...voiceCtx, workspaceDir: baseDbPath };
  assert.deepEqual(await hook({ prompt: "x", messages: [] }, ctx), { prependContext: LIGHT_VOICE_GUIDANCE });
});
