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

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { resolveInside } from "./sql-safety.js";
import { validateInput } from "./input-limits.js";
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

const TIMED_PASSIVE_HALF_LIVES_MS = Object.freeze({
  surprise: 120000,
  fear: 900000,
  anger: 900000,
  joy: 1800000,
  anticipation: 1800000,
  sadness: 2700000,
  disgust: 2700000,
  trust: 3600000,
});
const TIMED_APPROACH_HALF_LIFE_MS = 300000;
const TIMED_EVIDENCE_HOLD_MS = 120000;
const MAX_TIMED_EVENT_IDS = 512;

const DEFAULT_DECAY_MS = 30 * 60 * 1000; // 30 Minuten Fallback

/**
 * EmotionalState — rolling Stimmungs-Tracker pro Agent/Workspace.
 * @param {object} [options] Baseline, temperament and recall settings.
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
    this._timedMood = null;
    this._timedTarget = null;
    this._timedExpiresAt = 0;
    this._timedExpiresAtByDimension = Object.fromEntries(EMOTION_DIMENSIONS.map(dim => [dim, 0]));
    this._timedLastObservedAt = null;
    this._timedEventIds = new Map();
  }

  /**
   * Enable elapsed-time mood integration without changing the current mood.
   * @param {{enabled?:boolean,approachHalfLifeMs?:number,evidenceHoldMs?:number,passiveHalfLivesMs?:object}} [options] Timing settings.
   * @returns {void}
   */
  configureTimedMood({ enabled = true, approachHalfLifeMs = TIMED_APPROACH_HALF_LIFE_MS,
    evidenceHoldMs = TIMED_EVIDENCE_HOLD_MS, passiveHalfLivesMs = {} } = {}) {
    this._applyDecay();
    const passive = {};
    for (const dim of EMOTION_DIMENSIONS) {
      passive[dim] = positiveFinite(passiveHalfLivesMs?.[dim], TIMED_PASSIVE_HALF_LIVES_MS[dim]);
    }
    this._timedMood = {
      enabled: enabled === true,
      approachHalfLifeMs: positiveFinite(approachHalfLifeMs, TIMED_APPROACH_HALF_LIFE_MS),
      evidenceHoldMs: Math.min(positiveFinite(evidenceHoldMs, TIMED_EVIDENCE_HOLD_MS), TIMED_EVIDENCE_HOLD_MS),
      passiveHalfLivesMs: passive,
    };
    if (!this._timedMood.enabled) {
      this._timedTarget = null;
      this._timedExpiresAt = 0;
      this._timedExpiresAtByDimension = Object.fromEntries(EMOTION_DIMENSIONS.map(dim => [dim, 0]));
    }
  }

  /**
   * Replace only known reaction targets; unnamed dimensions retain their original expiry.
   * @param {object} reaction Complete normalized eight-dimensional reaction vector.
   * @param {{eventId:string,observedAt:number,now?:number,dimensions?:string[]}} [observation] Stable identity, time and unique known dimensions (default all eight).
   * @returns {boolean} Whether fresh evidence was accepted.
   */
  applyTimedEvidence(reaction, { eventId, observedAt, now = Date.now(), dimensions = EMOTION_DIMENSIONS } = {}) {
    if (!Array.isArray(dimensions) || !dimensions.length || new Set(dimensions).size !== dimensions.length
      || ![...dimensions].every(dim => EMOTION_DIMENSIONS.includes(dim))
      || !this._timedMood?.enabled || !validVector(reaction) || !validEventId(eventId)
      || !validTimestamp(now) || !validTimestamp(observedAt) || observedAt > now
      || now < this.lastUpdateAt || observedAt + this._timedMood.evidenceHoldMs <= now
      || (this._timedLastObservedAt !== null && observedAt < this._timedLastObservedAt)
      || this._timedEventIds.has(eventId)) return false;

    // Integrate only the OLD target through now before installing new evidence.
    this._advanceTimedMood(now);
    this._timedTarget ??= { ...this.baseline };
    for (const dim of dimensions) {
      this._timedTarget[dim] = clamp01(this.baseline[dim] + reaction[dim] * this.sensitivity);
      this._timedExpiresAtByDimension[dim] = observedAt + this._timedMood.evidenceHoldMs;
    }
    this._timedExpiresAt = Math.max(...Object.values(this._timedExpiresAtByDimension));
    this._timedLastObservedAt = observedAt;
    this._timedEventIds.set(eventId, observedAt);
    if (this._timedEventIds.size > MAX_TIMED_EVENT_IDS) {
      this._timedEventIds.delete(this._timedEventIds.keys().next().value);
    }
    this._recordHistory("timed_evidence");
    return true;
  }

  _advanceTimedMood(now) {
    if (!validTimestamp(now) || now <= this.lastUpdateAt) return;
    const timing = this._timedMood;
    const elapsed = now - this.lastUpdateAt;
    for (const dim of EMOTION_DIMENSIONS) {
      const activeElapsed = this._timedTarget
        ? Math.max(0, Math.min(now, this._timedExpiresAtByDimension[dim]) - this.lastUpdateAt) : 0;
      const passiveElapsed = elapsed - activeElapsed;
      const approachFactor = Math.pow(0.5, activeElapsed / timing.approachHalfLifeMs);
      let value = this.current[dim];
      if (activeElapsed > 0) {
        const target = this._timedTarget[dim];
        value = target + (value - target) * approachFactor;
      }
      const halfLife = timing.passiveHalfLivesMs[dim] * this.decayMultiplier;
      this.current[dim] = clamp01(this.baseline[dim] + (value - this.baseline[dim]) * Math.pow(0.5, passiveElapsed / halfLife));
    }
    for (const dim of EMOTION_DIMENSIONS) {
      if (this._timedExpiresAtByDimension[dim] <= now) this._timedExpiresAtByDimension[dim] = 0;
    }
    this._timedExpiresAt = Math.max(...Object.values(this._timedExpiresAtByDimension));
    this._decayNuances(elapsed);
    this.lastUpdateAt = now;
    if (this._timedExpiresAt <= now) {
      this._timedTarget = null;
      this._timedExpiresAt = 0;
      this._timedExpiresAtByDimension = Object.fromEntries(EMOTION_DIMENSIONS.map(dim => [dim, 0]));
    }
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
      const text = extractMessageText(msg);
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
    if (this._timedMood?.enabled) {
      this._advanceTimedMood(now);
      return;
    }
    const elapsed = now - this.lastUpdateAt;
    if (elapsed <= 0) return;

    // Per-emotion decay
    for (const dim of EMOTION_DIMENSIONS) {
      const halfLife = (DECAY_HALF_LIFE_MS[dim] || DEFAULT_DECAY_MS) * this.decayMultiplier;
      const decayFactor = Math.pow(0.5, elapsed / halfLife);
      const diff = this.current[dim] - this.baseline[dim];
      this.current[dim] = clamp01(this.baseline[dim] + diff * decayFactor);
    }

    this._decayNuances(elapsed);
    this.lastUpdateAt = now;
  }

  _decayNuances(elapsed) {
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

  /**
   * Vollständiger, wiederherstellbarer Zustand für die Restart-Persistenz.
   * @returns {object} Version 3 snapshot with bounded timed evidence metadata.
   */
  serializeState() {
    this._applyDecay();
    return {
      version: 3,
      timedMood: {
        target: this._timedTarget ? { ...this._timedTarget } : null,
        expiresAt: this._timedExpiresAt,
        expiresAtByDimension: { ...this._timedExpiresAtByDimension },
        lastObservedAt: this._timedLastObservedAt,
        eventIds: Array.from(this._timedEventIds, ([eventId, observedAt]) => ({ eventId, observedAt })),
      },
      current: { ...this.current },
      nuanceState: { ...this.nuanceState },
      lastUpdateAt: this.lastUpdateAt,
      baseline: { ...this.baseline },
    };
  }

  /**
   * Lädt den Zustand einmalig aus einer .emotional-state.json (Feld `state`).
   * Der Decay rechnet ab dem persistierten lastUpdateAt weiter — ein Restart
   * lässt die Stimmung natürlich abklingen statt sie zu löschen.
   * Configure timed mode before hydration; snapshots never enable it implicitly.
   *
   * @param {string} filePath
   * @returns {boolean} true wenn Zustand übernommen wurde
   */
  hydrateOnce(filePath) {
    if (this._hydrated) return false;
    this._hydrated = true;
    try {
      const absolutePath = resolve(filePath);
      const safePath = resolveInside(dirname(absolutePath), basename(absolutePath));
      const data = JSON.parse(readFileSync(safePath, "utf8"));
      const st = data?.state;
      if (!st || typeof st !== "object" || !st.current || typeof st.current !== "object"
        || (st.version !== undefined && st.version !== 2 && st.version !== 3)) return false;
      for (const dim of EMOTION_DIMENSIONS) {
        if (Number.isFinite(st.current[dim])) this.current[dim] = clamp01(st.current[dim]);
      }
      if (st.nuanceState && typeof st.nuanceState === "object") {
        for (const [label, intensity] of Object.entries(st.nuanceState)) {
          if (Number.isFinite(intensity) && intensity > 0) this.nuanceState[label] = clamp01(intensity);
        }
      }
      if (Number.isFinite(st.lastUpdateAt) && st.lastUpdateAt > 0 && st.lastUpdateAt <= Date.now()) {
        this.lastUpdateAt = st.lastUpdateAt;
      }
      if (this._timedMood?.enabled && st.version === 3 && validTimestamp(st.lastUpdateAt) && st.lastUpdateAt <= Date.now()) {
        this._hydrateTimedMood(st.timedMood, st.lastUpdateAt);
      }
      this._applyDecay();
      return true;
    } catch (_e) {
      return false;
    }
  }

  _hydrateTimedMood(timed, lastUpdateAt) {
    if (!timed || typeof timed !== "object" || !Array.isArray(timed.eventIds)
      || timed.eventIds.length > MAX_TIMED_EVENT_IDS
      || (timed.lastObservedAt !== null && (!validTimestamp(timed.lastObservedAt) || timed.lastObservedAt > lastUpdateAt))) return;
    const targetIsAbsent = timed.target === null && timed.expiresAt === 0;
    const targetIsValid = validVector(timed.target) && validTimestamp(timed.expiresAt)
      && timed.lastObservedAt !== null && timed.expiresAt > timed.lastObservedAt
      && timed.expiresAt <= timed.lastObservedAt + TIMED_EVIDENCE_HOLD_MS;
    if (!targetIsAbsent && !targetIsValid) return;
    // Validate the entire addition before installing target, expiry or dedupe state.
    const expiries = timed.expiresAtByDimension === undefined
      ? Object.fromEntries(EMOTION_DIMENSIONS.map(dim => [dim, timed.expiresAt]))
      : timed.expiresAtByDimension;
    if (!expiries || typeof expiries !== "object" || Array.isArray(expiries)
      || Object.keys(expiries).length !== EMOTION_DIMENSIONS.length
      || !EMOTION_DIMENSIONS.every(dim => Object.hasOwn(expiries, dim) && validTimestamp(expiries[dim])
        && (expiries[dim] === 0 || (targetIsValid && expiries[dim] > lastUpdateAt
          && expiries[dim] <= timed.lastObservedAt + TIMED_EVIDENCE_HOLD_MS)))
      || Math.max(...Object.values(expiries)) !== timed.expiresAt) return;
    const ids = new Map();
    for (const event of timed.eventIds) {
      if (!validEventId(event?.eventId) || !validTimestamp(event?.observedAt)
        || timed.lastObservedAt === null || event.observedAt > timed.lastObservedAt || ids.has(event.eventId)) return;
      ids.set(event.eventId, event.observedAt);
    }
    this._timedTarget = targetIsValid ? { ...timed.target } : null;
    this._timedExpiresAt = targetIsValid ? timed.expiresAt : 0;
    this._timedExpiresAtByDimension = { ...expiries };
    this._timedLastObservedAt = timed.lastObservedAt;
    this._timedEventIds = ids;
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

function positiveFinite(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validVector(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && EMOTION_DIMENSIONS.every((dim) => Object.hasOwn(value, dim)
      && Number.isFinite(value[dim]) && value[dim] >= 0 && value[dim] <= 1);
}

function validEventId(value) {
  return typeof value === "string" && value.trim().length > 0
    && validateInput(value, { maxLength: 512, name: "emotion event ID", required: true }).ok;
}

export function extractMessageText(msg) {
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
 * Benannte Temperament-Presets — wählbar via `/plur1bus temperament <name>`.
 */
export const TEMPERAMENT_PRESETS = Object.freeze({
  ausgewogen: { sensitivity: 1.0, decayMultiplier: 1.0 },
  warm: { baseline: { joy: 0.35, trust: 0.5 }, sensitivity: 1.5, decayMultiplier: 1.3 },
  "kühl": { baseline: { anticipation: 0.3, joy: 0.15 }, sensitivity: 0.8, decayMultiplier: 0.7 },
  feurig: { baseline: { joy: 0.3, anticipation: 0.3 }, sensitivity: 1.8, decayMultiplier: 1.5 },
  stoisch: { sensitivity: 0.5, decayMultiplier: 0.6 },
});

/**
 * Ausgelieferte Default-Temperamente pro Agent (überschreibbar via
 * `emotion.temperaments.<agentId>` in der Plugin-Config).
 *
 * Bewusst nur generische Einträge: `main` ist die OpenClaw-Standard-Agent-ID,
 * `default` greift für alle übrigen. Individuelle Agenten-Temperamente gehören
 * in die Nutzer-Config (`/plur1bus temperament <preset>`).
 */
export const DEFAULT_TEMPERAMENTS = Object.freeze({
  main: { sensitivity: 1.2, decayMultiplier: 1.0 },
  default: { ...TEMPERAMENT_PRESETS.ausgewogen },
});

/**
 * Einzeiler für den injizierten Prompt-Kontext.
 * @param {ReturnType<EmotionalState["describeMood"]>} mood
 */
export function formatMoodLine(mood) {
  if (!mood || !mood.label) return "";
  const trend = mood.trend && mood.trend !== "stabil" ? `, ${mood.trend}` : "";
  return `${mood.emoji || "🧠"} Aktuelle Stimmung: ${mood.label} (${mood.intensity}${trend})`;
}

/**
 * Menschenlesbarer Inhalt für .current-mood.txt.
 * @param {ReturnType<EmotionalState["describeMood"]>} mood
 * @param {string} agentId
 * @param {Date|number} [now]
 */
export function formatMoodFile(mood, agentId = "default", now = new Date()) {
  if (!mood) return "";
  const trend = mood.trend && mood.trend !== "stabil" ? `, ${mood.trend}` : "";
  const nuances = mood.nuances?.length ? mood.nuances.join(", ") : "—";
  const top = Object.entries(mood.details || {})
    .filter(([key]) => EMOTION_DIMENSIONS.includes(key))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, value]) => `${key} ${Number(value).toFixed(2)}`)
    .join(" · ");
  return [
    `${mood.emoji || "🧠"} ${mood.label} (${mood.intensity}${trend})`,
    `Dominant: ${mood.dominant} · Nuancen: ${nuances}`,
    `Top: ${top}`,
    `Stand: ${new Date(now).toISOString()} (agent: ${agentId})`,
  ].join("\n") + "\n";
}

/**
 * Factory für pro-Agent EmotionalState-Instanzen mit Temperament-Profilen.
 *
 * @param {object} [options]
 * @param {object} [options.temperaments] — per-Agent-Overrides, gemerged über DEFAULT_TEMPERAMENTS
 * @param {number} [options.moodInfluence] — Stärke des stimmungskongruenten Recall-Boosts
 */
export function createEmotionalStatePool(options = {}) {
  const states = new Map();
  const temperaments = { ...DEFAULT_TEMPERAMENTS, ...(options.temperaments || {}) };

  const resolveProfile = (id) => {
    const profile = temperaments[id] || temperaments.default || {};
    return {
      ...profile,
      moodInfluence: Number.isFinite(profile.moodInfluence) ? profile.moodInfluence : options.moodInfluence,
    };
  };

  return {
    get(agentId) {
      const id = agentId || "default";
      if (!states.has(id)) {
        states.set(id, new EmotionalState(resolveProfile(id)));
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
