/**
 * lib/emotional-state.js — Emotional State Tracker für PLUR1BUS.
 *
 * Modeliert einen "Stimmungszustand" des Agenten, der sich aus der
 * Konversation ableitet und über Zeit langsam zum Baseline zurückkehrt.
 *
 * Der Zustand beeinflusst den Recall: Memories mit ähnlicher emotionaler
 * Valenz werden leicht bevorzugt (State-Dependent Memory, wie beim Menschen).
 */

import { EMOTION_DIMENSIONS, valenceCosineSimilarity } from "./emotion.js";

const BASELINE_MOOD = Object.freeze({
  joy: 0.25,
  trust: 0.45,
  anticipation: 0.25,
  sadness: 0.08,
  anger: 0.02,
  fear: 0.08,
  surprise: 0.1,
});

const DECAY_HALF_LIFE_MS = 30 * 60 * 1000; // 30 Minuten Halbwertszeit

/**
 * EmotionalState — rolling Stimmungs-Tracker pro Agent/Workspace.
 */
export class EmotionalState {
  constructor(options = {}) {
    this.baseline = { ...BASELINE_MOOD, ...(options.baseline || {}) };
    this.current = { ...this.baseline };
    this.lastUpdateAt = Date.now();
    this.moodHistory = []; // { timestamp, mood, trigger }
    this.maxHistory = options.maxHistory || 100;
  }

  /**
   * Aktualisiert die Stimmung basierend auf User-Nachrichten.
   * Gewichtet: Letzte Nachricht zählt am meisten.
   */
  updateFromMessages(messages = []) {
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Nur User-Nachrichten betrachten
    const userMessages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .slice(-5); // Letzte 5 Turns

    if (userMessages.length === 0) return;

    let totalWeight = 0;
    const delta = {};
    for (const dim of EMOTION_DIMENSIONS) delta[dim] = 0;

    for (let i = 0; i < userMessages.length; i++) {
      const msg = userMessages[i];
      const text = extractText(msg);
      if (!text) continue;

      // Gewicht: Neuere Nachrichten zählen mehr
      const weight = (i + 1) / userMessages.length;
      totalWeight += weight;

      // Simple heuristische Stimmung aus Text
      const lower = text.toLowerCase();
      for (const dim of EMOTION_DIMENSIONS) {
        const val = textValenceHint(lower, dim);
        delta[dim] += val * weight;
      }
    }

    if (totalWeight === 0) return;

    // Normalisiere Delta
    for (const dim of EMOTION_DIMENSIONS) {
      delta[dim] /= totalWeight;
    }

    // Wende Decay an, bevor wir neues Delta addieren
    this._applyDecay();

    // Blende Delta ein (nicht 100% — Stimmung ändert sich nicht schlagartig)
    const blendFactor = 0.35;
    for (const dim of EMOTION_DIMENSIONS) {
      this.current[dim] = clamp01(
        this.current[dim] * (1 - blendFactor) + (this.baseline[dim] + delta[dim]) * blendFactor
      );
    }

    this.lastUpdateAt = Date.now();
    this._recordHistory("message_turn");
  }

  /**
   * Aktualisiert die Stimmung explizit von einer Memory-Valenz.
   * Wird aufgerufen, wenn der Agent eine emotional geladene Memory recalled.
   */
  updateFromRecalledMemory(valence) {
    if (!valence || typeof valence !== "object") return;

    this._applyDecay();

    // Emotional geladene Memories beeinflussen die Stimmung leicht
    const blendFactor = 0.15;
    for (const dim of EMOTION_DIMENSIONS) {
      const v = valence[dim] ?? 0;
      if (v > 0.5) {
        this.current[dim] = clamp01(
          this.current[dim] * (1 - blendFactor) + v * blendFactor
        );
      }
    }

    this.lastUpdateAt = Date.now();
    this._recordHistory("recalled_memory");
  }

  /**
   * Natürlicher Decay: Stimmung kehrt langsam zum Baseline zurück.
   */
  decay() {
    this._applyDecay();
  }

  _applyDecay() {
    const now = Date.now();
    const elapsed = now - this.lastUpdateAt;
    if (elapsed <= 0) return;

    // Exponential Decay: nach DECAY_HALF_LIFE_MS ist die Hälfte des
    // Abstands zum Baseline zurückgegangen
    const decayFactor = Math.pow(0.5, elapsed / DECAY_HALF_LIFE_MS);

    for (const dim of EMOTION_DIMENSIONS) {
      const diff = this.current[dim] - this.baseline[dim];
      this.current[dim] = clamp01(this.baseline[dim] + diff * decayFactor);
    }

    this.lastUpdateAt = now;
  }

  /**
   * Berechnet die Kompatibilität zwischen aktueller Stimmung und einer
   * Memory-Valenz. Rückgabe in [0, 1] — 1 = perfekt passend.
   */
  computeMoodCompatibility(memoryValence) {
    this._applyDecay();

    if (!memoryValence || typeof memoryValence !== "object") return 0.5;

    // Cosine-Similarity in [-1, 1] → [0, 1]
    const similarity = valenceCosineSimilarity(this.current, memoryValence);
    return (similarity + 1) / 2;
  }

  /**
   * Berechnet einen Recall-Boost-Faktor für eine Memory.
   *
   * - Memories mit ähnlicher Stimmung werden leicht bevorzugt
   * - Emotional sehr intensive Memories (unabhängig von Stimmung) bekommen
   *   einen kleinen universellen Boost (wichtige Erinnerungen)
   * - "Wichtige Lektionen" (hoher Angst/Ärger + hoher Trust in der Memory)
   *   werden NIEMALS unterdrückt
   */
  computeRecallBoost(memoryValence, memoryImportance = 0.5) {
    const compatibility = this.computeMoodCompatibility(memoryValence);
    const intensity = memoryValence?.emotionalIntensity ?? 0;

    // Ist das eine "wichtige Lektion"? (hohe negative Emotion + gelernt)
    const isValuableLesson =
      (memoryValence?.anger > 0.5 || memoryValence?.fear > 0.5) &&
      (memoryValence?.trust > 0.3 || memoryImportance > 0.7);

    if (isValuableLesson) {
      // Wichtige Lektionen immer leicht boosten, unabhängig von Stimmung
      return 1.0 + intensity * 0.1;
    }

    // Standard: Stimmungskompatibilität beeinflusst Score leicht
    // Bei sehr positiver Stimmung: positive Memories stärker boosten
    // Bei negativer Stimmung: negative Memories nicht komplett ausblenden,
    // aber schwächer recallen (außer wichtige Lektionen)
    const moodBoost = (compatibility - 0.5) * 0.3; // ±0.15 Max
    const intensityBoost = intensity * 0.05; // Max +0.05 für sehr emotionale Memories

    return 1.0 + moodBoost + intensityBoost;
  }

  /**
   * Gibt eine menschenlesbare Stimmungsbeschreibung zurück.
   */
  describeMood() {
    this._applyDecay();

    const entries = EMOTION_DIMENSIONS.map((dim) => ({
      dim,
      value: this.current[dim],
      diff: this.current[dim] - this.baseline[dim],
    }));

    entries.sort((a, b) => b.value - a.value);

    const dominant = entries[0];
    const dominantDe = {
      joy: "fröhlich",
      trust: "vertrauensvoll",
      anticipation: "gespannt",
      sadness: "nachdenklich",
      anger: "angespannt",
      fear: "vorsichtig",
      surprise: "neugierig",
    }[dominant.dim] || "neutral";

    // Wenn die dominante Emotion nur leicht über dem Baseline liegt
    if (Math.abs(dominant.diff) < 0.1) {
      return { label: "ausgeglichen", dominant: dominant.dim, intensity: "niedrig", details: this.current };
    }

    const intensity =
      dominant.value > 0.7 ? "hoch" :
      dominant.value > 0.4 ? "mittel" : "niedrig";

    return { label: dominantDe, dominant: dominant.dim, intensity, details: this.current };
  }

  /**
   * Snapshot der aktuellen Stimmung als Plain-Object.
   */
  snapshot() {
    this._applyDecay();
    return { ...this.current, timestamp: new Date().toISOString() };
  }

  _recordHistory(trigger) {
    this.moodHistory.push({
      timestamp: new Date().toISOString(),
      mood: { ...this.current },
      trigger,
    });
    if (this.moodHistory.length > this.maxHistory) {
      this.moodHistory = this.moodHistory.slice(-this.maxHistory);
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ");
  }
  return String(msg.content || "");
}

function textValenceHint(lower, dim) {
  const patterns = {
    joy: /\b(gut|toll|super|freu|glück|happy|😊|🎉|👍)\b/,
    trust: /\b(vertrau|sicher|ok|klar|verstanden|passt|genau)\b/,
    anticipation: /\b(bald|demnächst|hoffe|plan|start|bereit|ready)\b/,
    sadness: /\b(schade|leider|traurig|enttäuscht|bedauer|nicht gut)\b/,
    anger: /\b(ärger|frust|nervt|falsch|kaputt|mist|verdammt)\b/,
    fear: /\b(angst|sorgen|besorgt|problem|risiko|warn|gefahr)\b/,
    surprise: /\b(überrasch|wow|omg|unglaublich|tatsächlich|echt)\b/,
  };
  const re = patterns[dim];
  if (!re) return 0;
  const matches = (lower.match(re) || []).length;
  return Math.min(matches * 0.25, 0.8);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Factory für pro-Agent EmotionalState-Instanzen.
 */
export function createEmotionalStatePool() {
  const states = new Map();

  return {
    get(agentId) {
      const id = agentId || "default";
      if (!states.has(id)) {
        states.set(id, new EmotionalState());
      }
      return states.get(id);
    },

    snapshot(agentId) {
      return this.get(agentId).snapshot();
    },

    describe(agentId) {
      return this.get(agentId).describeMood();
    },

    // Wartung: Decay für alle States anwenden (z.B. im Cron)
    decayAll() {
      for (const state of states.values()) {
        state.decay();
      }
    },

    // Status für /zustand Command
    status() {
      const out = {};
      for (const [id, state] of states.entries()) {
        out[id] = state.describeMood();
      }
      return out;
    },
  };
}
