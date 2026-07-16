/**
 * lib/reaction-directive.js — Reaktions-Neigung (Humanization F6).
 *
 * OpenClaw besitzt ein natives react-Channel-Action (Action-Group
 * "reactions"). Das Plugin versendet nichts selbst — es erzeugt nur die
 * Neigung per Direktive, und nur wenn die Fähigkeit im Gateway-Config
 * erkennbar aktiviert ist (sonst stillschweigend aus).
 */

const CAPABILITY_KEYS = new Set(["actions", "actionGroups", "allowedActions", "groups"]);
const CAPABILITY_VALUES = new Set(["reactions", "react"]);
const CAPABILITY_LIST_SUBKEYS = new Set(["allow", "allowed", "enabled"]);
const MAX_DEPTH = 8;
const DEFAULT_PALETTE = "👍 ❤️ 😂 🎉 🤔";

// OpenClaw ≥2026.7: Reaktionen sind pro Channel-Account DEFAULT-AN. Das
// Action-Gate (createActionGate) liefert true, solange `actions.reactions`
// nicht explizit false ist; Telegram hat zusätzlich `reactionLevel` mit
// Default "minimal" (= Agent-Reaktionen an). "off" und "ack" schalten sie ab.
const REACTION_DISABLED_LEVELS = new Set(["off", "ack"]);

function actionsAllowReactions(actions) {
  // Array = Allowlist: Reaktionen nur wenn explizit gelistet.
  if (Array.isArray(actions)) return actions.some((v) => CAPABILITY_VALUES.has(v));
  // Objekt = Action-Gate: default-an, nur explizites false deaktiviert.
  if (actions && typeof actions === "object") {
    return !Object.entries(actions).some(([k, v]) => CAPABILITY_VALUES.has(k) && v === false);
  }
  return true;
}

function reactionLevelAllows(level) {
  return !(typeof level === "string" && REACTION_DISABLED_LEVELS.has(level.trim()));
}

function accountAllowsReactions(account, channel) {
  if (!account || typeof account !== "object" || account.enabled === false) return false;
  if (!actionsAllowReactions(account.actions ?? channel.actions)) return false;
  return reactionLevelAllows(account.reactionLevel ?? channel.reactionLevel);
}

function detectDefaultOnChannelReactions(runtimeConfig) {
  const channels = runtimeConfig?.channels;
  if (!channels || typeof channels !== "object") return false;
  for (const channel of Object.values(channels)) {
    if (!channel || typeof channel !== "object" || channel.enabled === false) continue;
    const hasAccounts = channel.accounts && typeof channel.accounts === "object" && !Array.isArray(channel.accounts);
    // Nur erkennbar konfigurierte Channels zählen als default-an — sonst
    // würde jedes beliebige Objekt unter channels.* als Capability gelten.
    if (channel.enabled !== true && !hasAccounts) continue;
    const candidates = hasAccounts ? Object.values(channel.accounts) : [channel];
    if (candidates.some((account) => accountAllowsReactions(account, channel))) return true;
  }
  return false;
}

export function detectReactionsCapability(runtimeConfig) {
  try {
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > MAX_DEPTH || seen.has(node)) return false;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (CAPABILITY_KEYS.has(key)) {
          if (Array.isArray(value) && value.some((v) => CAPABILITY_VALUES.has(v))) return true;
          if (value && typeof value === "object" && !Array.isArray(value)) {
            if (Object.entries(value).some(([k, v]) => CAPABILITY_VALUES.has(k) && v !== false)) return true;
            // Real gateway schema: capability key -> { allow/allowed/enabled: [...] }
            // one level below the capability key itself, e.g.
            // tools.message.actions.allow: ["react"].
            if (Object.entries(value).some(([k, v]) =>
              CAPABILITY_LIST_SUBKEYS.has(k) && Array.isArray(v) && v.some((x) => CAPABILITY_VALUES.has(x))
            )) return true;
          }
        }
        if (value && typeof value === "object" && walk(value, depth + 1)) return true;
      }
      return false;
    };
    if (walk(runtimeConfig, 0)) return true;
    return detectDefaultOnChannelReactions(runtimeConfig);
  } catch (_) {
    return false;
  }
}

function resolvePalette(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return DEFAULT_PALETTE;
}

/**
 * Baut die Reaktions-Direktive mit expliziter Palette vor Persona-Palette.
 *
 * @param {Object} params - Direktiven-Optionen
 * @param {string|null} [params.palette] - Explizite Konfigurationspalette
 * @param {string|null} [params.personaPalette] - Aus Persona-Voice abgeleitete Palette
 * @returns {string} Reaktions-Direktive
 */
export function buildReactionDirective({ palette = null, personaPalette = null } = {}) {
  const emojis = resolvePalette(palette, personaPalette);
  const directive = `Auf kurze, rein bestätigende oder emotionale Nachrichten darfst du statt mit Text auch NUR mit einer Emoji-Reaktion antworten (react-Action auf die Nachricht). Passende Palette: ${emojis}. Setze Reaktionen sparsam ein — höchstens etwa einmal pro Gesprächsabschnitt.`;
  return directive.length > 400 ? directive.slice(0, 399).trimEnd() + "…" : directive;
}
