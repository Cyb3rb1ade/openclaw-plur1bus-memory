/**
 * lib/temperament-command.js — Pure Helpers für /plur1bus temperament.
 *
 * Anzeige der verfügbaren Temperament-Presets und Transformation der
 * geparsten openclaw.json. Datei-I/O und Locking passieren in index.js
 * (analog /plur1bus setup).
 */

import { TEMPERAMENT_PRESETS, DEFAULT_TEMPERAMENTS } from "./emotional-state.js";

/**
 * Beschreibt ein Preset als Listenzeile.
 */
function describePreset(name, preset) {
  const baseline = preset.baseline
    ? `, Baseline ${Object.entries(preset.baseline).map(([dim, value]) => `${dim}=${value}`).join(" ")}`
    : "";
  return `• ${name} — Sensitivity ${preset.sensitivity}, Decay ×${preset.decayMultiplier}${baseline}`;
}

/**
 * Ermittelt das Label des aktuell wirksamen Temperaments eines Agenten.
 */
function currentTemperamentLabel(agentId, temperamentsCfg) {
  const configured = temperamentsCfg?.[agentId];
  if (configured) return configured.preset || "custom";
  const fallback = DEFAULT_TEMPERAMENTS[agentId];
  if (fallback) {
    const match = Object.entries(TEMPERAMENT_PRESETS).find(([, preset]) =>
      preset.sensitivity === fallback.sensitivity && preset.decayMultiplier === fallback.decayMultiplier);
    return match ? `${match[0]} (Default)` : "default";
  }
  return "ausgewogen (Default)";
}

/**
 * Übersicht: aktuelles Temperament + Preset-Liste + Anleitung.
 *
 * @param {{ agentId: string, temperamentsCfg: object, lang: string }} params
 * @returns {string}
 */
export function renderTemperamentOverview({ agentId, temperamentsCfg = {}, lang = "de" }) {
  const de = lang === "de";
  const current = currentTemperamentLabel(agentId, temperamentsCfg);
  const lines = [
    de ? `🎭 Temperament für ${agentId}: ${current}` : `🎭 Temperament for ${agentId}: ${current}`,
    "",
    de ? "Verfügbare Presets:" : "Available presets:",
    ...Object.entries(TEMPERAMENT_PRESETS).map(([name, preset]) => describePreset(name, preset)),
    "",
    de
      ? "Setzen mit: /plur1bus temperament <preset> (Gateway-Restart nötig)"
      : "Set with: /plur1bus temperament <preset> (gateway restart required)",
  ];
  return lines.join("\n");
}

/**
 * Schreibt ein Preset in eine Kopie der geparsten openclaw.json.
 *
 * @param {object} rawCfg — geparste openclaw.json
 * @param {string} pluginKey — Key unter plugins.entries
 * @param {string} agentId
 * @param {string} presetName
 * @returns {{ ok: true, merged: object } | { error: string }}
 */
export function applyTemperamentToRawConfig(rawCfg, pluginKey, agentId, presetName) {
  const preset = TEMPERAMENT_PRESETS[presetName];
  if (!preset) {
    return { error: `Unbekanntes Preset: ${presetName}. Verfügbar: ${Object.keys(TEMPERAMENT_PRESETS).join(", ")}` };
  }
  const pluginCfg = rawCfg?.plugins?.entries?.[pluginKey]?.config;
  if (!pluginCfg || typeof pluginCfg !== "object") {
    return { error: `Plugin-Config für "${pluginKey}" nicht in openclaw.json gefunden` };
  }
  const merged = structuredClone(rawCfg);
  const mergedPluginCfg = merged.plugins.entries[pluginKey].config;
  mergedPluginCfg.emotion = mergedPluginCfg.emotion || {};
  mergedPluginCfg.emotion.temperaments = mergedPluginCfg.emotion.temperaments || {};
  mergedPluginCfg.emotion.temperaments[agentId] = { ...preset, preset: presetName };
  return { ok: true, merged };
}
