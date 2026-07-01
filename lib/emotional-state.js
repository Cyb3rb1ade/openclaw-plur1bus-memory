/**
 * lib/emotional-state.js — Emotional State Tracker für PLUR1BUS.
 *
 * Modeliert einen "Stimmungszustand" des Agenten, der sich aus der
 * Konversation ableitet und über Zeit langsam zum Baseline zurückkehrt.
 *
 * Der Zustand beeinflusst den Recall: Memories mit ähnlicher emotionaler
 * Valenz werden leicht bevorzugt (State-Dependent Memory, wie beim Menschen).
 *
 * v2: 8 Dimensionen (disgust ergänzt), emotion-spezifischer Decay,
 *      Nuancen- und Blend-Beschreibungen.
 */

import { EMOTION_DIMENSIONS, valenceCosineSimilarity, emotionEmoji } from "./emotion.js";

const BASELINE_MOOD = Object.freeze({
  joy: 0.25,
  trust: 0.45,
  anticipation: 0.25,
  sadness: 0.08,
  disgust: 0.02,
  anger: 0.02,
  fear: 0.08,
  surprise: 0.1,
});

/** Emotion-spezifische Halbwertszeiten in Millisekunden */
const DECAY_HALF_LIFE_MS = {
  surprise: 2 * 60 * 1000,      // 2 Minuten
  fear: 20 * 60 * 1000,         // 20 Minuten
  joy: 30 * 60 * 1000,          // 30 Minuten
  trust: 30 * 60 * 1000,        // 30 Minuten
  anticipation: 30 * 60 * 1000, // 30 Minuten
  sadness: 2 * 60 * 60 * 1000,  // 2 Stunden
  disgust: 2 * 60 * 60 * 1000,  // 2 Stunden
  anger: 2 * 60 * 60 * 1000,    // 2 Stunden
};

/** Nuancen mit langsamerem Decay */
const NUANCE_DECAY_HALF_LIFE_MS = {
  resentment: 6 * 60 * 60 * 1000,  // 6 Stunden
  shame: 12 * 60 * 60 * 1000,      // 12 Stunden
};

const DEFAULT_DECAY_MS = 30 * 60 * 1000; // 30 Minuten Fallback

/**
 * EmotionalState — rolling Stimmungs-Tracker pro Agent/Workspace.
 */
export class EmotionalState {
  constructor(options = {}) {
    this.baseline = { ...BASELINE_MOOD, ...(options.baseline || {}) };
    this.current = { ...this.baseline };
    // Temperament-Parameter (v3): steuern Stärke und Dauer des Ausschlags —
    // die Stimmung selbst entsteht weiterhin nur aus Gesprächsinhalten.
    this.sensitivity = Number.isFinite(options.sensitivity) && options.sensitivity > 0 ? options.sensitivity : 1.0;
    this.decayMultiplier = Number.isFinite(options.decayMultiplier) && options.decayMultiplier > 0 ? options.decayMultiplier : 1.0;
    this.blendFactor = Number.isFinite(options.blendFactor) ? clamp01(options.blendFactor) : 0.5;
    this.moodInfluence = Number.isFinite(options.moodInfluence) && options.moodInfluence >= 0 ? options.moodInfluence : 0.3;
    this.nuanceState = {}; // { label: intensity }
    this.lastUpdateAt = Date.now();
    this.moodHistory = []; // { timestamp, mood, trigger }
    this.maxHistory = options.maxHistory || 100;
    this._hydrated = false;
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
   * Blendet ein Emotions-Ergebnis der EmotionEngine (Legacy-Valenz-Format von
   * inferEmotionalValenceAsync) in die Stimmung ein. Ersetzt die alte
   * Regex-Heuristik als primärer Update-Pfad.
   *
   * @param {{joy?:number, trust?:number, anticipation?:number, sadness?:number,
   *          disgust?:number, anger?:number, fear?:number, surprise?:number,
   *          emotionalIntensity?:number, nuances?:Array<{label:string,intensity:number}>}} valence
   */
  applyEmotionScore(valence) {
    if (!valence || typeof valence !== "object") return;

    this._applyDecay();

    const intensity = clamp01(valence.emotionalIntensity ?? 0);
    // Intensive Emotionen bewegen die Stimmung stärker; sensitivity ist das
    // Temperament des Agenten.
    const blend = clamp01(this.blendFactor * this.sensitivity * (0.5 + intensity * 0.5));

    for (const dim of EMOTION_DIMENSIONS) {
      const v = clamp01(valence[dim] ?? 0);
      const target = clamp01(this.baseline[dim] + v * this.sensitivity);
      this.current[dim] = clamp01(this.current[dim] * (1 - blend) + target * blend);
    }

    for (const nuance of Array.isArray(valence.nuances) ? valence.nuances : []) {
      const nIntensity = clamp01(nuance?.intensity ?? 0);
      if (nuance?.label && nIntensity > 0.2) {
        this.nuanceState[nuance.label] = Math.max(this.nuanceState[nuance.label] || 0, nIntensity);
      }
    }

    this.lastUpdateAt = Date.now();
    this._recordHistory("emotion_engine");
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

    // Nuancen aus der Memory übernehmen
    if (valence.nuances && Array.isArray(valence.nuances)) {
      for (const nuance of valence.nuances) {
        if (nuance.intensity > 0.3) {
          this.nuanceState[nuance.label] = Math.max(
            this.nuanceState[nuance.label] || 0,
            nuance.intensity
          );
        }
      }
    }

    this.lastUpdateAt = Date.now();
    this._recordHistory("recalled_memory");
  }

  /**
   * Natürlicher Decay: Stimmung kehrt langsam zum Baseline zurück.
   * Emotion-spezifisch: surprise schnell, resentment/shame langsam.
   */
  decay() {
    this._applyDecay();
  }

  _applyDecay() {
    const now = Date.now();
    const elapsed = now - this.lastUpdateAt;
    if (elapsed <= 0) return;

    // Per-emotion decay
    for (const dim of EMOTION_DIMENSIONS) {
      const halfLife = (DECAY_HALF_LIFE_MS[dim] || DEFAULT_DECAY_MS) * this.decayMultiplier;
      const decayFactor = Math.pow(0.5, elapsed / halfLife);
      const diff = this.current[dim] - this.baseline[dim];
      this.current[dim] = clamp01(this.baseline[dim] + diff * decayFactor);
    }

    // Nuancen decay
    for (const [label, intensity] of Object.entries(this.nuanceState)) {
      const halfLife = (NUANCE_DECAY_HALF_LIFE_MS[label] || DEFAULT_DECAY_MS) * this.decayMultiplier;
      const decayFactor = Math.pow(0.5, elapsed / halfLife);
      const newIntensity = intensity * decayFactor;
      if (newIntensity < 0.05) {
        delete this.nuanceState[label];
      } else {
        this.nuanceState[label] = newIntensity;
      }
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
    const moodBoost = (compatibility - 0.5) * (this.moodInfluence * 2); // ±moodInfluence Max (Default ±0.3)
    const intensityBoost = intensity * 0.05; // Max +0.05 für sehr emotionale Memories

    return 1.0 + moodBoost + intensityBoost;
  }

  /**
   * Gibt eine menschenlesbare Stimmungsbeschreibung zurück.
   * Berücksichtigt Nuancen und Blends.
   */
  describeMood() {
    this._applyDecay();

    const entries = EMOTION_DIMENSIONS.map((dim) => ({
      dim,
      value: this.current[dim],
      diff: this.current[dim] - this.baseline[dim],
    }));

    // v3: Dominanz nach Abweichung von der Baseline, nicht nach Absolutwert —
    // sonst gewinnt der Trust-Sockel (0.45) gegen jede echte Regung.
    entries.sort((a, b) => b.diff - a.diff);

    const dominant = entries[0];
    const dominantDe = {
      joy: "fröhlich",
      trust: "vertrauensvoll",
      anticipation: "gespannt",
      sadness: "nachdenklich",
      disgust: "abgeneigt",
      anger: "angespannt",
      fear: "vorsichtig",
      surprise: "neugierig",
    }[dominant.dim] || "neutral";

    // Nuancen berücksichtigen
    const activeNuances = Object.entries(this.nuanceState)
      .filter(([, v]) => v > 0.2)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);

    // Wenn die dominante Emotion nur minimal über der Baseline liegt
    if (dominant.diff < 0.05 && activeNuances.length === 0) {
      return { label: "ausgeglichen", dominant: dominant.dim, intensity: "niedrig", trend: this._computeTrend(), details: this.current, nuances: [], emoji: "🧘" };
    }

    const intensity =
      dominant.diff > 0.35 ? "hoch" :
      dominant.diff > 0.15 ? "mittel" : "niedrig";

    let label = dominantDe;
    // Wenn Nuancen aktiv sind, beschreibe sie
    if (activeNuances.length > 0) {
      const nuanceDe = {
        relief: "erleichtert",
        pride: "stolz",
        gratitude: "dankbar",
        nostalgia: "nostalgisch",
        loneliness: "einsam",
        resentment: "verbittert",
        awe: "ehrfürchtig",
        contempt: "verächtlich",
        guilt: "schuldig",
        shame: "beschämt",
        hope: "hoffnungsvoll",
        envy: "neidisch",
        compassion: "mitfühlend",
        curiosity: "neugierig",
        boredom: "gelangweilt",
        excitement: "aufgeregt",
        love: "liebevoll",
        disappointment: "enttäuscht",
        embarrassment: "verlegen",
        serenity: "gelassen",
      }[activeNuances[0]] || activeNuances[0];
      label = `${nuanceDe} und ${dominantDe}`;
    }

    return {
      label,
      dominant: dominant.dim,
      intensity,
      trend: this._computeTrend(),
      details: this.current,
      nuances: activeNuances,
      emoji: emotionEmoji(activeNuances[0] || dominant.dim),
    };
  }

  /** Summe der absoluten Abweichungen von der Baseline über alle Dimensionen. */
  _totalDeviation(mood) {
    let sum = 0;
    for (const dim of EMOTION_DIMENSIONS) {
      sum += Math.abs((mood?.[dim] ?? 0) - this.baseline[dim]);
    }
    return sum;
  }

  /**
   * Trend gegenüber dem letzten Stimmungs-Snapshot: baut sich die Emotion
   * gerade auf ("steigend"), klingt sie ab ("fallend") oder ist sie "stabil"?
   */
  _computeTrend() {
    const history = this.moodHistory;
    if (history.length === 0) return "stabil";
    const nowDev = this._totalDeviation(this.current);
    let ref = history[history.length - 1];
    // Direkt nach einem Update entspricht der letzte Eintrag dem aktuellen
    // Zustand — dann gegen den vorherigen vergleichen.
    if (history.length >= 2 && Math.abs(this._totalDeviation(ref.mood) - nowDev) < 1e-9) {
      ref = history[history.length - 2];
    }
    const prevDev = this._totalDeviation(ref.mood);
    if (nowDev > prevDev + 0.03) return "steigend";
    if (nowDev < prevDev - 0.03) return "fallend";
    return "stabil";
  }

  /**
   * Snapshot der aktuellen Stimmung als Plain-Object.
   */
  snapshot() {
    this._applyDecay();
    return { ...this.current, nuances: { ...this.nuanceState }, timestamp: new Date().toISOString() };
  }

  _recordHistory(trigger) {
    this.moodHistory.push({
      timestamp: new Date().toISOString(),
      mood: { ...this.current },
      nuances: { ...this.nuanceState },
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
    disgust: /\b(ekel|widerlich|abscheu|übel|schmutzig|dreckig)\b/,
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
