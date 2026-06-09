/**
 * mai/obsidian-export.js — Export an Engram to Obsidian-compatible markdown.
 */

import { generateEmotionTags } from "./card-tags.js";

/**
 * Sanitize a value for YAML frontmatter by collapsing newlines.
 * @param {*} v
 * @returns {string}
 */
function sanitizeYaml(v) {
  return String(v ?? "").replace(/[\r\n]+/g, " ").trim();
}

/**
 * Export an Engram to a markdown string with YAML frontmatter and inline tags.
 *
 * @param {import("./engram-emotion.js").Engram|null} engram
 * @returns {string}
 */
export function exportEngramToObsidian(engram) {
  if (!engram) return "";

  /** @type {Record<string, any>} */
  const fm = {
    engram_id: engram.id,
    source: engram.source,
    session_id: engram.session_id,
    created_at: engram.created_at ? engram.created_at.toISOString() : "",
    decay_half_life_h: engram.decay_half_life_hours ?? 168.0,
  };

  if (engram.emotion) {
    const e = engram.emotion;
    fm.valence = e.valence ?? 0.0;
    fm.arousal = e.arousal ?? 0.0;
    fm.dominance = e.dominance ?? 0.0;
    fm.intensity = e.intensity ?? 0.0;
    fm.primary_emotion = e.primary_emotion ?? "";
    fm.emotion_language = e.language ?? "en";
    fm.emotion_source = e.source ?? "unknown";
    fm.emotion_tier = e.tier_used ?? 0;
    fm.emotion_confidence = e.confidence ?? 0.0;
    fm.emotion_timestamp = e.timestamp ?? 0;
  }

  const tags = generateEmotionTags(engram.emotion);
  const inlineTags = tags.map((t) => `#${t.replace(/\//g, "-")}`).join(" ");

  const lines = ["---"];
  for (const key of Object.keys(fm).sort()) {
    const value = fm[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${sanitizeYaml(item)}`);
    } else {
      lines.push(`${key}: ${sanitizeYaml(value)}`);
    }
  }
  lines.push("---", "");

  if (inlineTags) {
    lines.push(inlineTags, "");
  }

  lines.push(engram.content || "");

  return lines.join("\n");
}
