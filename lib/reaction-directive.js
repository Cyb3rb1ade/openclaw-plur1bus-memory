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
    return walk(runtimeConfig, 0);
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
