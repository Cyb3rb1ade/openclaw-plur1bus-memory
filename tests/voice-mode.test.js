// tests/voice-mode.test.js
// Persona/Light für Discord-Sprachräume: Modus-Speicher und Erkennung (7.17.0).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import {
  isDiscordVoiceTurn,
  isLightVoiceTurn,
  readVoiceMode,
  voiceModeFile,
  voiceSessionKeys,
  writeVoiceMode,
} from "../lib/voice-mode.js";

function tempBase(t) {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-voice-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("defaults to persona without a file and with a broken file", (t) => {
  const base = tempBase(t);
  assert.equal(readVoiceMode(base, "main"), "persona");
  mkdirSync(dirname(voiceModeFile(base, "main")), { recursive: true });
  writeFileSync(voiceModeFile(base, "main"), "{kaputt");
  assert.equal(readVoiceMode(base, "main"), "persona");
  writeFileSync(voiceModeFile(base, "main"), JSON.stringify({ mode: "turbo" }));
  assert.equal(readVoiceMode(base, "main"), "persona");
});

test("writes and reads light and persona per agent", (t) => {
  const base = tempBase(t);
  const written = writeVoiceMode(base, "main", "light", { by: "discord:1323072788939935867" });
  assert.equal(written.mode, "light");
  assert.equal(readVoiceMode(base, "main"), "light");
  assert.equal(readVoiceMode(base, "bernhardine"), "persona", "modes are per agent");
  writeVoiceMode(base, "main", "persona");
  assert.equal(readVoiceMode(base, "main"), "persona");
  assert.throws(() => writeVoiceMode(base, "main", "turbo"), /mode/);
  assert.throws(() => writeVoiceMode(base, "../x", "light"), /agent/i);
});

test("recognises Discord voice turns only by the discord-voice provider", () => {
  assert.equal(isDiscordVoiceTurn({ messageProvider: "discord-voice" }), true);
  assert.equal(isDiscordVoiceTurn({ messageProvider: "discord" }), false);
  assert.equal(isDiscordVoiceTurn({ messageProvider: "telegram" }), false);
  assert.equal(isDiscordVoiceTurn(undefined), false);
});

test("light applies only to a voice turn while the agent's mode is light", (t) => {
  const base = tempBase(t);
  const voice = { agentId: "main", messageProvider: "discord-voice" };
  assert.equal(isLightVoiceTurn(voice, base), false);
  writeVoiceMode(base, "main", "light");
  assert.equal(isLightVoiceTurn(voice, base), true);
  assert.equal(isLightVoiceTurn({ ...voice, messageProvider: "discord" }, base), false);
  assert.equal(isLightVoiceTurn({ ...voice, agentId: "bernhardine" }, base), false);
});

test("derives the voice session keys from the allowed voice channels", () => {
  const config = { channels: { discord: { voice: { allowedChannels: [
    { guildId: "1486678369901744240", channelId: "1486678370434551811" },
    { guildId: "1486678369901744240", channelId: "1518159522076823592" },
  ] } } } };
  assert.deepEqual(voiceSessionKeys("main", config), [
    "agent:main:discord:channel:1486678370434551811",
    "agent:main:discord:channel:1518159522076823592",
  ]);
  assert.deepEqual(voiceSessionKeys("main", {}), []);
});
