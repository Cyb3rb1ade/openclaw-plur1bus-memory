// lib/overlay-generator.js
import { randomUUID } from "node:crypto";
import { safeWarn, safeDebug } from "./safe-logging.js";

const ALLOWED_SHIFT_TYPES = new Set(["meaning", "confidence", "context", "unresolved-thread"]);
const MIN_RELEVANCE = 0.7;

/**
 * Defensive overlay generator. Decides whether a recalled memory deserves an
 * interpretation overlay, and if so calls an LLM to produce a provisional
 * overlay record. Factual memory is never mutated.
 */
export class OverlayGenerator {
  constructor({
    llm,
    enabled = false,
    confidenceThreshold = 0.3,
    maxPerSession = 3,
    minRelevance = MIN_RELEVANCE,
    model = "kimi-for-coding",
    overlayStore = null,
    logger = null,
  } = {}) {
    this.llm = llm;
    this.enabled = enabled;
    this.confidenceThreshold = confidenceThreshold;
    this.maxPerSession = maxPerSession;
    this.minRelevance = minRelevance;
    this.model = model;
    this.overlayStore = overlayStore;
    this.logger = logger;
  }

  /**
   * @param {Object} opts
   * @param {Object} opts.memory — recalled memory record
   * @param {string} opts.conversationContext
   * @param {number} [opts.relevanceScore=0] — recall relevance score
   * @param {string} [opts.currentRegister]
   * @param {string[]} [opts.triggerMemoryIds]
   * @param {Object} [opts.sessionState={}] — mutable per-recall state
   * @returns {Promise<object|null>}
   */
  async generate({
    memory,
    conversationContext,
    relevanceScore = 0,
    currentRegister = null,
    triggerMemoryIds = null,
    sessionState = {},
  }) {
    if (!this.enabled || !this.llm) return null;
    if (!memory?.id || !conversationContext) return null;

    // Evidence threshold guard.
    if (relevanceScore < this.minRelevance) return null;
    if (!memory.text && !memory.summary) return null;
    if (String(memory.id).startsWith("canonical:") || memory.source === "knowledge") return null;

    // Contextual signal: only generate if there is a concrete shift signal.
    const hasSignal = this._hasContextualSignal(memory, currentRegister, conversationContext);
    if (!hasSignal) return null;

    // Session rate limits (attempt-side: one overlay per target).
    if (!sessionState.overlayTargets) sessionState.overlayTargets = new Set();
    if (sessionState.overlayTargets.has(memory.id)) return null;

    const currentCount = sessionState.overlayGeneratedCount ?? 0;
    if (currentCount >= this.maxPerSession) return null;

    // Early dedupe is only applied to the unresolved-thread inferred shift type,
    // which is cheap to detect and expensive to LLM twice. All other shift types
    // are deduplicated after the LLM response has determined the actual type.
    let earlyDedupeKey = null;
    if (this.overlayStore) {
      const inferredShiftType = this._inferShiftType(memory, conversationContext);
      if (inferredShiftType === "unresolved-thread") {
        earlyDedupeKey = this.overlayStore.computeDedupeKey(
          memory.id,
          inferredShiftType,
          conversationContext,
        );
        const recent = await this.overlayStore.loadFor([memory.id], 7);
        if (recent.some((r) => r.dedupeKey === earlyDedupeKey)) return null;
      }
    }

    const memoryText = memory.summary || memory.text || "";
    const prompt = this._buildPrompt(memoryText, currentRegister, conversationContext);

    let response;
    try {
      response = await this.llm(prompt);
    } catch (error) {
      safeWarn(this.logger, "OverlayGenerator.llm", error, { memoryId: memory.id });
      return null;
    }

    if (!response || response.trim().toLowerCase() === "no shift") return null;

    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch (error) {
      safeDebug(this.logger, "OverlayGenerator.parse", error, {
        memoryId: memory.id,
        responseLength: String(response).length,
      });
      return null;
    }

    if (!ALLOWED_SHIFT_TYPES.has(parsed.shiftType)) return null;
    if (!parsed.shiftDescription || typeof parsed.shiftDescription !== "string") return null;

    const confidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? parsed.confidence
      : null;
    if (confidence === null || confidence < 0 || confidence > 1 || confidence < this.confidenceThreshold) return null;

    let confidenceDelta = 0;
    if (Number.isFinite(parsed.confidenceDelta)) {
      confidenceDelta = Math.max(-1, Math.min(1, parsed.confidenceDelta));
    }

    // Final idempotency check with the LLM-determined shift type.
    let dedupeKey = null;
    if (this.overlayStore) {
      dedupeKey = this.overlayStore.computeDedupeKey(memory.id, parsed.shiftType, conversationContext);
      if (dedupeKey !== earlyDedupeKey) {
        const recent = await this.overlayStore.loadFor([memory.id], 7);
        if (recent.some((r) => r.dedupeKey === dedupeKey)) return null;
      }
    }

    // Count only successful generations against the per-session quota.
    sessionState.overlayGeneratedCount = currentCount + 1;
    sessionState.overlayTargets.add(memory.id);

    return {
      id: randomUUID(),
      targetMemoryId: memory.id,
      createdAt: new Date().toISOString(),
      status: "provisional",
      shiftType: parsed.shiftType,
      shiftDescription: parsed.shiftDescription.slice(0, 400),
      confidence,
      confidenceDelta,
      triggerContext: String(conversationContext).slice(0, 500),
      dedupeKey,
      provenance: {
        triggerMemoryIds: triggerMemoryIds || [memory.id],
        llmModel: this.model,
      },
    };
  }

  _hasContextualSignal(memory, currentRegister, conversationContext) {
    const context = String(conversationContext);

    // Unresolved-thread signal: explicit phrase in current context.
    const unresolvedHint = /\b(unresolved|offen|noch nicht|pending|follow.?up)\b/i.test(context);
    if (unresolvedHint) return true;

    // Explicit contextual shift signal.
    const contextualShiftPhrases = [
      "since then", "since we last", "since that", "now", "no longer",
      "used to", "mittlerweile", "inzwischen", "nunmehr", "nicht mehr",
    ];
    const lowerContext = context.toLowerCase();
    if (contextualShiftPhrases.some((phrase) => lowerContext.includes(phrase))) return true;

    // Emotional mismatch signal — requires both current register and stored valence.
    if (!currentRegister || !memory.emotionalValence || typeof memory.emotionalValence !== "object" || Array.isArray(memory.emotionalValence)) return false;
    const negativeWords = ["grief", "conflict", "loss", "anger", "anguish", "sadness", "fear"];
    const positiveWords = ["celebration", "joy", "triumph", "delight", "elation"];
    const dominant = Object.entries(memory.emotionalValence)
      .filter(([k]) => !["nuances", "emotionalIntensity"].includes(k))
      .sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const registerLower = String(currentRegister).toLowerCase();
    const memoryLower = String(dominant).toLowerCase();
    const registerNegative = negativeWords.some((w) => registerLower.includes(w));
    const registerPositive = positiveWords.some((w) => registerLower.includes(w));
    const memoryNegative = negativeWords.some((w) => memoryLower.includes(w));
    const memoryPositive = positiveWords.some((w) => memoryLower.includes(w));
    return (memoryNegative && registerPositive) || (memoryPositive && registerNegative);
  }

  _inferShiftType(memory, conversationContext) {
    if (/\b(unresolved|offen|noch nicht|pending|follow.?up)\b/i.test(conversationContext)) {
      return "unresolved-thread";
    }
    return "meaning";
  }

  _buildPrompt(memoryText, currentRegister, conversationContext) {
    const safeContext = String(conversationContext);
    return [
      {
        role: "system",
        content: `You are a memory-reconsolidation assistant. A factual memory is being recalled in a new context. Decide whether the meaning, confidence, context, or resolution status of the memory has shifted.

Allowed shift types: meaning, confidence, context, unresolved-thread.

Reply with a JSON object:
{
  "shiftType": "meaning",
  "shiftDescription": "One sentence describing the shift.",
  "confidence": 0.85,
  "confidenceDelta": 0.0
}

Confidence must be 0.0–1.0. If no shift is needed, reply exactly with: no shift`,
      },
      {
        role: "user",
        content: `Memory: "${memoryText.slice(0, 1000)}"
Current emotional register: ${currentRegister || "neutral"}
Current conversation context: ${safeContext.slice(0, 500)}`,
      },
    ];
  }
}
