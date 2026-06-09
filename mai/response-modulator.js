/**
 * ResponseModulator — adjusts LLM system prompts and temperature based on
 * the detected user emotion.
 */

import { EmotionScore } from "./emotion-score.js";

export class ResponseModulator {
  /**
   * Emotion → tone / prompt-prefix mappings.
   */
  static MODES = {
    joy: {
      tone: "warm and enthusiastic",
      prompt_prefix:
        "The user is feeling joyful. Match their positive energy, celebrate their wins, and keep the tone upbeat and encouraging.",
    },
    sadness: {
      tone: "gentle and supportive",
      prompt_prefix:
        "The user is feeling sad. Be gentle, validate their feelings, offer quiet support, and avoid being overly chipper.",
    },
    anger: {
      tone: "calm and de-escalating",
      prompt_prefix:
        "The user is feeling angry. Stay calm, acknowledge their frustration, and help de-escalate while remaining respectful.",
    },
    fear: {
      tone: "reassuring and grounding",
      prompt_prefix:
        "The user is feeling fearful. Be reassuring, provide grounding context, and avoid alarmist language.",
    },
    surprise: {
      tone: "curious and open",
      prompt_prefix:
        "The user is surprised. Lean into curiosity, explore the unexpected with them, and keep an open mind.",
    },
    neutral: {
      tone: "balanced and clear",
      prompt_prefix:
        "The user's emotional state is neutral. Maintain a balanced, clear, and helpful tone.",
    },
  };

  /**
   * Prepend an emotion-appropriate prefix to the system prompt.
   *
   * @param {EmotionScore} userEmotion
   * @param {string} baseSystemPrompt
   * @returns {string}
   */
  modulate(userEmotion, baseSystemPrompt) {
    if (!(userEmotion instanceof EmotionScore)) {
      return baseSystemPrompt;
    }
    const mode = this._resolveMode(userEmotion);
    const prefix = mode.prompt_prefix;
    return `${prefix}\n\n${baseSystemPrompt}`;
  }

  /**
   * Adjust sampling temperature based on user emotion.
   *
   * @param {EmotionScore} userEmotion
   * @param {number} [baseTemp=0.7]
   * @returns {number}
   */
  modulateTemperature(userEmotion, baseTemp = 0.7) {
    if (!(userEmotion instanceof EmotionScore)) {
      return baseTemp;
    }
    const primary = userEmotion.primary_emotion.toLowerCase();

    if (primary === "anger" || primary === "fear") {
      return Math.max(0.1, baseTemp - 0.2);
    }
    if (primary === "surprise" || primary === "joy") {
      return Math.min(1.0, baseTemp + 0.1);
    }
    return baseTemp;
  }

  /**
   * Resolve the closest mode for an EmotionScore.
   * @param {EmotionScore} emotion
   * @returns {{tone:string, prompt_prefix:string}}
   */
  _resolveMode(emotion) {
    const key = emotion.primary_emotion.toLowerCase();
    if (ResponseModulator.MODES[key]) {
      return ResponseModulator.MODES[key];
    }
    // Fallback by valence/arousal heuristics
    if (emotion.valence > 0.3 && emotion.arousal > 0.3) return ResponseModulator.MODES.joy;
    if (emotion.valence < -0.3 && emotion.arousal > 0.3) return ResponseModulator.MODES.anger;
    if (emotion.valence < -0.3 && emotion.arousal < 0) return ResponseModulator.MODES.sadness;
    if (emotion.valence < -0.1 && emotion.arousal > 0.1) return ResponseModulator.MODES.fear;
    if (emotion.arousal > 0.5) return ResponseModulator.MODES.surprise;
    return ResponseModulator.MODES.neutral;
  }
}
