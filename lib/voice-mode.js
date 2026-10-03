/**
 * lib/voice-mode.js — Persona/Light für Discord-Sprachräume (7.17.0).
 *
 * Der Modus gilt je Agent und nur für Sprachzüge (messageProvider
 * "discord-voice"). Light lässt Auto-Recall und alle Zusatzblöcke weg, nimmt
 * pro Lauf ein schnelles Modell und setzt Thinking der Sprachraum-Sitzungen
 * auf off. Speichern (agent_end) läuft in beiden Modi weiter.
 */
import { join } from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./atomic-file.js";
import { safeAgentId } from "./sql-safety.js";

export const VOICE_MODES = Object.freeze(["persona", "light"]);

export const LIGHT_MODEL = Object.freeze({ providerOverride: "anthropic", modelOverride: "claude-haiku-4-5" });

export const LIGHT_VOICE_GUIDANCE = [
  "<voice-light-mode>",
  "Du sprichst gerade in einem Discord-Sprachraum im Light-Modus: antworte kurz, gesprochen und ohne Listen oder Markdown.",
  "Es ist kein Gedächtnis vorgeladen. Wenn die Frage Erinnerungen braucht, nutze memory_recall und antworte danach knapp.",
  "</voice-light-mode>",
].join("\n");

/**
 * Pfad der Modus-Datei eines Agenten.
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {string}
 */
export function voiceModeFile(baseDbPath, agentId) {
  return join(baseDbPath, ".plur1bus-voice-mode", `${safeAgentId(agentId)}.json`);
}

/**
 * Liest den Modus; fehlend, kaputt oder unbekannt gilt als "persona".
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {"persona"|"light"}
 */
export function readVoiceMode(baseDbPath, agentId) {
  try {
    const data = readJsonSafe(voiceModeFile(baseDbPath, agentId), {});
    return data?.mode === "light" ? "light" : "persona";
  } catch {
    return "persona";
  }
}

/**
 * Schreibt den Modus atomar.
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {"persona"|"light"} mode
 * @param {{by?: string}} [meta]
 * @returns {{mode: string, changedAt: string}}
 */
export function writeVoiceMode(baseDbPath, agentId, mode, meta = {}) {
  if (!VOICE_MODES.includes(mode)) throw new Error(`invalid voice mode: ${mode}`);
  const record = { mode, changedAt: new Date().toISOString(), ...(meta.by ? { by: String(meta.by) } : {}) };
  writeJsonAtomic(voiceModeFile(baseDbPath, agentId), record);
  return record;
}

/**
 * Stammt der Lauf aus einem Discord-Sprachraum?
 * @param {object} ctx - Hook-Kontext
 * @returns {boolean}
 */
export function isDiscordVoiceTurn(ctx) {
  return ctx?.messageProvider === "discord-voice";
}

/**
 * Sprachzug eines Agenten im Light-Modus?
 * @param {object} ctx - Hook-Kontext mit agentId und messageProvider
 * @param {string} baseDbPath
 * @returns {boolean}
 */
export function isLightVoiceTurn(ctx, baseDbPath) {
  if (!isDiscordVoiceTurn(ctx)) return false;
  const agentId = ctx?.agentId || "main";
  try {
    return readVoiceMode(baseDbPath, agentId) === "light";
  } catch {
    return false;
  }
}

/**
 * Sitzungsschlüssel der erlaubten Sprachräume (Host-Format
 * agent:<agent>:discord:channel:<Sprachraum-ID>).
 * @param {string} agentId
 * @param {object} config - OpenClaw-Konfiguration
 * @returns {string[]}
 */
export function voiceSessionKeys(agentId, config) {
  const channels = config?.channels?.discord?.voice?.allowedChannels;
  if (!Array.isArray(channels)) return [];
  return channels
    .map((entry) => String(entry?.channelId || "").trim())
    .filter((id) => /^\d{5,25}$/.test(id))
    .map((id) => `agent:${agentId}:discord:channel:${id}`);
}
