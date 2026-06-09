/**
 * mai/index.js — Barrel export for all PLUR1BUS emotion integration modules.
 *
 * Import everything from the emotion system via:
 *   import { EmotionEngine, MoodTracker, EngramLifecycle } from "./mai/index.js";
 */

// ─── Core Emotion System ───
export { EmotionScore } from "./emotion-score.js";
export { Tier1LexiconClassifier } from "./tier1-lexicon.js";
export { Tier2TransformerClassifier } from "./tier2-transformer.js";
export { Tier3LLMClassifier } from "./tier3-llm.js";
export { EmotionEngine } from "./emotion-engine.js";

// ─── Storage Integration ───
export { EMOTION_SCHEMA_FIELDS, createEngramTableWithEmotion } from "./lancedb-schema.js";
export { Engram } from "./engram-emotion.js";
export { Edge } from "./edge-emotion.js";
export { generateEmotionTags } from "./card-tags.js";
export { exportEngramToObsidian } from "./obsidian-export.js";

// ─── Process Modules ───
export { DecayEngine } from "./decay-engine.js";
export { RecallEngine } from "./recall-engine.js";
export { DreamingEngine } from "./dreaming-engine.js";

// ─── New Modules ───
export { MoodTracker } from "./mood-tracker.js";
export { NarrativeEngine } from "./narrative-engine.js";
export { ContextWeightManager } from "./context-weight.js";
export { ResponseModulator } from "./response-modulator.js";
export { EmotionalContagionGuard } from "./contagion-guard.js";
export { EmotionalMemoryBus, emotionBus } from "./emotion-bus.js";

// ─── Integration ───
export { EngramLifecycle } from "./lifecycle.js";
