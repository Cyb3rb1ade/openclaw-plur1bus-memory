/**
 * mai/lifecycle.js — Lifecycle integration for PLUR1BUS emotion system.
 *
 * Wires the EmotionEngine, MoodTracker, ContagionGuard, ContextWeightManager,
 * ResponseModulator, NarrativeEngine, DreamingEngine, DecayEngine, RecallEngine,
 * and EmotionalMemoryBus into the existing memory lifecycle.
 */

import { EmotionEngine } from "./emotion-engine.js";
import { MoodTracker } from "./mood-tracker.js";
import { EmotionalContagionGuard } from "./contagion-guard.js";
import { ContextWeightManager } from "./context-weight.js";
import { ResponseModulator } from "./response-modulator.js";
import { NarrativeEngine } from "./narrative-engine.js";
import { DreamingEngine } from "./dreaming-engine.js";
import { DecayEngine } from "./decay-engine.js";
import { RecallEngine } from "./recall-engine.js";
import { emotionBus } from "./emotion-bus.js";
import { Engram } from "./engram-emotion.js";
import { exportEngramToObsidian } from "./obsidian-export.js";

/**
 * Orchestrates the emotion-aware memory lifecycle.
 */
export class EngramLifecycle {
  /**
   * @param {object} [options]
   * @param {object} [options.emotionEngineConfig] — passed to EmotionEngine
   * @param {object} [options.moodTrackerOptions] — passed to MoodTracker
   * @param {object} [options.contagionGuardOptions] — passed to EmotionalContagionGuard
   * @param {object} [options.contextWeightOptions] — passed to ContextWeightManager
   * @param {object} [options.decayOptions] — passed to DecayEngine
   * @param {object} [options.recallOptions] — passed to RecallEngine
   * @param {Function} [options.embed] — text → embedding vector
   * @param {Function} [options.generateId] — () → unique id string
   * @param {object} [options.db] — LanceDB connection (for recall / persist)
   * @param {string} [options.obsidianVaultPath] — path for Obsidian export
   */
  constructor(options = {}) {
    this.emotionEngine = new EmotionEngine(options.emotionEngineConfig);
    this.moodTracker = new MoodTracker(options.moodTrackerOptions);
    this.contagionGuard = new EmotionalContagionGuard(options.contagionGuardOptions);
    this.contextWeight = new ContextWeightManager(options.contextWeightOptions);
    this.responseModulator = new ResponseModulator();
    this.narrative = new NarrativeEngine({ moodTracker: this.moodTracker });
    this.dreaming = new DreamingEngine({ emotionEngine: this.emotionEngine });
    this.decay = new DecayEngine(options.decayOptions);
    this.recall = new RecallEngine({ db: options.db, emotionEngine: this.emotionEngine });

    this._embed = options.embed ?? (() => []);
    this._generateId = options.generateId ?? (() => `engram_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    this._db = options.db ?? null;
    this._obsidianVaultPath = options.obsidianVaultPath ?? null;
  }

  /**
   * User sent a message — analyse emotion, create engram, update mood, check contagion.
   *
   * @param {string} text
   * @param {string} sessionId
   * @returns {Promise<{engram: Engram, guardResult: object}>}
   */
  async onUserMessage(text, sessionId) {
    const emotion = await this.emotionEngine.analyze(text, "user");

    this.moodTracker.add(emotion);
    const guardResult = this.contagionGuard.check(emotion);

    const engram = new Engram({
      id: this._generateId(),
      content: text,
      embedding: this._embed(text),
      created_at: new Date(),
      source: "user",
      session_id: sessionId,
      emotion,
    });

    engram.computeDecayHalfLife();
    this._persist(engram);

    emotionBus.publish("engram_created", { engram, emotion });

    return { engram, guardResult };
  }

  /**
   * Assistant sent a response — also emotionally evaluated.
   *
   * @param {string} text
   * @param {string} sessionId
   * @returns {Promise<Engram>}
   */
  async onAssistantResponse(text, sessionId) {
    const emotion = await this.emotionEngine.analyze(text, "assistant");

    const engram = new Engram({
      id: this._generateId(),
      content: text,
      embedding: this._embed(text),
      created_at: new Date(),
      source: "assistant",
      session_id: sessionId,
      emotion,
    });

    engram.computeDecayHalfLife();
    this._persist(engram);

    emotionBus.publish("engram_created", { engram, emotion });

    return engram;
  }

  /**
   * Retrieve context for LLM prompt — emotion-weighted selection.
   *
   * @param {string} query
   * @param {import("./emotion-score.js").EmotionScore[]} sessionEmotions
   * @returns {Promise<{selected: Engram[], arc: object}>}
   */
  async onRetrieveContext(query, sessionEmotions = []) {
    const currentMood = this.moodTracker.currentMood;
    const currentEmotion = sessionEmotions[sessionEmotions.length - 1] ?? null;

    const candidates = await this._searchEngrams(query);

    const selected = this.contextWeight.selectContextWindow(
      candidates,
      currentEmotion,
      2000
    );

    const arc = this.narrative.detectArc(sessionEmotions);

    return { selected, arc, currentMood };
  }

  /**
   * Session ended — trigger dreaming, decay recalculation, obsidian export.
   *
   * @param {string} sessionId
   * @param {import("./emotion-score.js").EmotionScore[]} sessionEmotions
   * @returns {Promise<{arc: object, mood: object, consolidated: Engram[]}>}
   */
  async onSessionEnd(sessionId, sessionEmotions = []) {
    const arc = this.narrative.detectArc(sessionEmotions);

    const sessionEngrams = this._getSessionEngrams(sessionId);

    const consolidated = this.dreaming.consolidate(sessionEngrams);

    for (const engram of consolidated) {
      engram.computeDecayHalfLife();
    }

    if (this._obsidianVaultPath) {
      for (const engram of consolidated) {
        const md = exportEngramToObsidian(engram);
        this._writeToObsidian(engram.id, md);
      }
    }

    const mood = this.moodTracker.currentMood;

    emotionBus.publish("session_ended", {
      session_id: sessionId,
      arc,
      mood,
      consolidatedCount: consolidated.length,
    });

    return { arc, mood, consolidated };
  }

  /**
   * Modulate a system prompt based on the user's current emotional state.
   *
   * @param {import("./emotion-score.js").EmotionScore} userEmotion
   * @param {string} baseSystemPrompt
   * @returns {string}
   */
  modulateResponse(userEmotion, baseSystemPrompt) {
    return this.responseModulator.modulate(userEmotion, baseSystemPrompt);
  }

  /**
   * Suggest a temperature based on user emotion.
   *
   * @param {import("./emotion-score.js").EmotionScore} userEmotion
   * @param {number} [baseTemp=0.7]
   * @returns {number}
   */
  modulateTemperature(userEmotion, baseTemp = 0.7) {
    return this.responseModulator.modulateTemperature(userEmotion, baseTemp);
  }

  // ─── Internal persistence helpers (stubs for integration with existing lib/) ───

  /**
   * Persist an engram to all storage layers.
   * @param {Engram} engram
   */
  _persist(engram) {
    this._writeLancedb(engram);
    this._writeFlatfile(engram);
    this._updateGraph(engram);
    this._updateCards(engram);
  }

  _writeLancedb(engram) {
    // TODO: integrate with existing lib/db-adapter.js
    // const row = engram.toLancedbRow();
    // this._db.table("engrams").add([row]);
  }

  _writeFlatfile(engram) {
    // TODO: integrate with existing flat-file YAML system
  }

  _updateGraph(engram) {
    // TODO: integrate with existing lib/graph-index.js
  }

  _updateCards(engram) {
    // TODO: integrate with existing card/tag system
  }

  async _searchEngrams(query) {
    // TODO: integrate with existing vector search
    // Placeholder: return empty array until real DB is wired
    return [];
  }

  _getSessionEngrams(sessionId) {
    // TODO: integrate with existing session retrieval
    return [];
  }

  _writeToObsidian(id, markdown) {
    // TODO: integrate with existing Obsidian export in lib/
    // fs.writeFileSync(path.join(this._obsidianVaultPath, `${id}.md`), markdown, "utf8");
  }
}
