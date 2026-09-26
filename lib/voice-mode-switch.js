// lib/voice-mode-switch.js
/**
 * lib/voice-mode-switch.js — Umschalten Persona/Light per /modus und Knöpfen (7.17.0).
 * Reine Funktionen plus applyVoiceMode mit injiziertem Sitzungs-Patch.
 */
import { voiceSessionKeys, writeVoiceMode } from "./voice-mode.js";

export const VOICE_BUTTON_NAMESPACE = "plurv";
const AGENT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const COMMAND_RE = /^\/modus(?:\s+(\S+))?\s*$/i;
const ACTIONS = Object.freeze({ light: "light", full: "persona", persona: "persona", status: "status" });

/**
 * @param {string} body - Nachrichtentext
 * @returns {{action: "menu"|"light"|"persona"|"status"}|null}
 */
export function parseVoiceCommand(body) {
  const match = COMMAND_RE.exec(String(body || "").trim());
  if (!match) return null;
  if (!match[1]) return { action: "menu" };
  const action = ACTIONS[match[1].toLowerCase()];
  return action ? { action } : null;
}

/**
 * @param {string} payload - Teil nach "plurv:"
 * @returns {{mode: "light"|"persona", agentId: string}|null}
 */
export function parseVoiceButtonPayload(payload) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 2 || !["light", "persona"].includes(parts[0]) || !AGENT_RE.test(parts[1])) return null;
  return { mode: parts[0], agentId: parts[1] };
}

/**
 * Nachricht mit aktivem Modus und beiden Knöpfen.
 * @param {string} agentId
 * @param {"light"|"persona"} mode
 * @returns {{text: string, interactive: object}}
 */
export function buildVoiceModeMessage(agentId, mode) {
  const text = mode === "light"
    ? "🎙️ Sprachräume: **Light** — schnell, ohne vorgeladenes Gedächtnis, Thinking aus."
    : "🎙️ Sprachräume: **Persona** — volles Gedächtnis und Thinking.";
  return {
    text,
    interactive: {
      blocks: [{
        type: "buttons",
        buttons: [
          { label: mode === "persona" ? "✅ Persona" : "Persona", style: "primary", action: { type: "callback", value: `${VOICE_BUTTON_NAMESPACE}:persona:${agentId}` } },
          { label: mode === "light" ? "✅ Light" : "Light", style: "success", action: { type: "callback", value: `${VOICE_BUTTON_NAMESPACE}:light:${agentId}` } },
        ],
      }],
    },
  };
}

/**
 * Ist der Absender der konfigurierte Discord-Besitzer (commands.ownerAllowFrom)?
 * @param {string} senderId
 * @param {object} config
 * @returns {boolean}
 */
export function isOwnerSender(senderId, config) {
  const id = String(senderId || "").replace(/^discord:/, "").trim();
  if (!id) return false;
  const owners = Array.isArray(config?.commands?.ownerAllowFrom) ? config.commands.ownerAllowFrom : [];
  return owners.some((entry) => {
    const raw = String(entry).trim();
    if (raw.startsWith("discord:user:")) return false;
    return raw.replace(/^discord:/, "") === id;
  });
}

/**
 * Speichert den Modus und setzt Thinking/Reasoning der Sprachraum-Sitzungen.
 * Nie das Modell.
 * @param {{baseDbPath: string, agentId: string, mode: "light"|"persona", config: object, patchSessionEntry: Function, by?: string}} params
 * @returns {Promise<{mode: string, patched: number, failed: number}>}
 */
export async function applyVoiceMode({ baseDbPath, agentId, mode, config, patchSessionEntry, by }) {
  writeVoiceMode(baseDbPath, agentId, mode, { by });
  let patched = 0;
  let failed = 0;
  for (const sessionKey of voiceSessionKeys(agentId, config)) {
    try {
      await patchSessionEntry({
        agentId,
        sessionKey,
        update: (current) => {
          const next = { ...(current || {}), reasoningLevel: "off" };
          if (mode === "light") next.thinkingLevel = "off";
          else delete next.thinkingLevel;
          return next;
        },
      });
      patched += 1;
    } catch {
      failed += 1;
    }
  }
  return { mode, patched, failed };
}
