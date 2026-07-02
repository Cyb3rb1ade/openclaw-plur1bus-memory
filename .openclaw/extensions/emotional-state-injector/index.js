"use strict";
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const DOMINANT_EMOJI = {
  trust: "🤝",
  joy: "😊",
  anticipation: "🌟",
  surprise: "😲",
  fear: "😟",
  sadness: "😔",
  disgust: "😤",
  anger: "😠",
};

function valence(details) {
  if (!details || typeof details !== "object") return null;
  return (details.joy ?? 0) + (details.trust ?? 0) + (details.anticipation ?? 0)
       - (details.sadness ?? 0) - (details.disgust ?? 0) - (details.anger ?? 0)
       - (details.fear ?? 0);
}

function trendLabel(cur, prev, threshold = 0.05) {
  if (prev === null || prev === undefined) return "→ (unbekannt)";
  const delta = cur - prev;
  if (delta > threshold) return "↗ (steigend)";
  if (delta < -threshold) return "↘ (fallend)";
  return "→ (stabil)";
}

function buildMoodBlock(state, prevState = null) {
  const label = state.label || "";
  if (!label) return null;
  const nuances = Array.isArray(state.nuances) && state.nuances.length > 0
    ? `, ${state.nuances.join(", ")}`
    : "";
  const intensity = state.intensity || "niedrig";
  const dominant = state.dominant || null;
  const emoji = (dominant && DOMINANT_EMOJI[dominant]) ? DOMINANT_EMOJI[dominant] : "😌";

  // v6.9: PLUR1BUS schreibt ein eigenes trend-Feld — direkt nutzen.
  // Fallback für alte Dateien: valence-Vergleich mit prev-Snapshot.
  const TREND_MAP = { steigend: "↗ (steigend)", fallend: "↘ (fallend)", stabil: "→ (stabil)" };
  let trend = TREND_MAP[state.trend] || null;
  if (!trend) {
    const curV = valence(state.details);
    const prevV = prevState ? valence(prevState.details) : null;
    trend = curV !== null ? trendLabel(curV, prevV) : "→ (unbekannt)";
  }
  const trendArrow = trend.split(" ")[0];

  const displayLine = `<i>Stimmung: ${emoji} ${label}${nuances} · ${intensity} · ${trendArrow}</i>`;

  // Bewusst KEIN Event-Framing ("[Stimmungs-Update]"): Der Block beschreibt
  // ambienten Hintergrundzustand. Event-Framing hat Agenten dazu verleitet,
  // echte User-Nachrichten als "Stimmungs-Update vom Cron" zu deuten und mit
  // NO_REPLY zu beantworten (Incident 2026-07-02, Bernd).
  return [
    "[Hintergrund: emotionaler Zustand]",
    "Dies ist ambienter Hintergrundzustand — kein Event, keine Nachricht, kein eigener Anlass zu antworten.",
    "Die eigentliche eingehende Nachricht steht separat am Ende des Prompts und stammt vom dort genannten Absender.",
    `Aktuelle Stimmung: ${label}${nuances}, Intensität ${intensity}. Trend: ${trend}.`,
    `Füge am Beginn deiner Antwort (als erste Zeile, vor dem eigentlichen Inhalt) diese Stimmungszeile ein:`,
    displayLine,
    "Priorisiere weiterhin Nutzerauftrag, Fakten und Sicherheit.",
    "[/Hintergrund]",
  ].join("\n");
}

function register(api) {
  api.on("before_prompt_build", async (_event, ctx) => {
    try {
      const workspaceDir = ctx?.workspaceDir;
      if (!workspaceDir) return;
      let state;
      try {
        state = JSON.parse(readFileSync(join(workspaceDir, ".emotional-state.json"), "utf8"));
      } catch {
        return;
      }
      if (!state?.label) return;
      let prevState = null;
      try {
        prevState = JSON.parse(readFileSync(join(workspaceDir, ".emotional-state-prev.json"), "utf8"));
      } catch {
        // prev state absent or unreadable — trend will be "unbekannt"
      }
      const block = buildMoodBlock(state, prevState);
      if (!block) return;
      return { prependContext: block };
    } catch {
      return;
    }
  });
}

module.exports = register;
module.exports.default = register;
module.exports._valence = valence;
module.exports._trendLabel = trendLabel;
