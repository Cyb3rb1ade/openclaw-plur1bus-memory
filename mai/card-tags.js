/**
 * mai/card-tags.js — Tag generation from EmotionScore objects.
 *
 * Produces hierarchical tags for filtering and graph indexing.
 */

/**
 * Generate emotion-derived tags for an engram.
 *
 * Tags follow the pattern:
 *   emotion/{primary}
 *   valence/{positive|negative|neutral}
 *   arousal/{high|low|medium}
 *   intensity/{high|low|medium}
 *   lang/{language}
 *   source/{source}
 *
 * @param {import("./emotion-score.js").EmotionScore|null} emotion
 * @returns {string[]}
 */
export function generateEmotionTags(emotion) {
  if (!emotion) return [];

  const tags = [];

  if (emotion.primary_emotion) {
    tags.push(`emotion/${String(emotion.primary_emotion).toLowerCase()}`);
  }

  const valence = emotion.valence ?? 0.0;
  if (valence > 0) tags.push("valence/positive");
  else if (valence < 0) tags.push("valence/negative");
  else tags.push("valence/neutral");

  const arousal = emotion.arousal ?? 0.0;
  if (arousal > 0.3) tags.push("arousal/high");
  else if (arousal < -0.3) tags.push("arousal/low");
  else tags.push("arousal/medium");

  const intensity = emotion.intensity ?? 0.0;
  if (intensity > 0.6) tags.push("intensity/high");
  else if (intensity < 0.3) tags.push("intensity/low");
  else tags.push("intensity/medium");

  if (emotion.language) {
    tags.push(`lang/${String(emotion.language).toLowerCase()}`);
  }

  if (emotion.source) {
    tags.push(`source/${String(emotion.source).toLowerCase()}`);
  }

  return tags;
}
