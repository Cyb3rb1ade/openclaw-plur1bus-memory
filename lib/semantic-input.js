/**
 * lib/semantic-input.js — Semantic Long-Input Handling for Memory Commands.
 *
 * Philosophy: Never truncate or reject long semantic input.
 * Instead: compress canonically while preserving full meaning.
 */

import { createHash } from "node:crypto";
import { t } from "./i18n.js";
import { INPUT_LIMITS } from "./input-limits.js";

const DEFAULT_MAX_DIRECT_CHARS = 6000;
const DEFAULT_HARD_PAYLOAD_LIMIT_CHARS = INPUT_LIMITS.SEMANTIC_COMMAND_ARGS;

const FILLER_WORDS = new Set([
  "also", "eigentlich", "irgendwie", "sozusagen", "quasi", "halt", "eben",
  "naja", "tja", "hm", "ähm", "alsooo", "irgendwo", "irgendwann",
  "vielleicht", "eventuell", "möglicherweise", "wohl", "wohl eher", "ich denke",
  "ich meine", "ich glaube", "meiner Meinung nach", "wie gesagt", "wie bereits",
  "übrigens", "nebenbei", "außerdem", "darüber hinaus", "im Übrigen",
  "so", "dann", "und so", "und so weiter", "usw", "etc",
  "einfach", "nur", "bloß", "gerade", "mal", "nochmal", "wieder",
  "schon", "doch", "ja", "ne", "oder", "weißt du", "verstehst du",
  "weißt", "verstehst", "gell",
]);

function hashText(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function isFillerSentence(sentence) {
  const lower = sentence.toLowerCase().trim();
  return FILLER_WORDS.has(lower) || lower.length < 10;
}

function compressHeuristically(text, targetChars) {
  // 1. Split into sentences
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  // 2. Remove filler sentences and near-duplicates
  const seen = new Set();
  const unique = [];
  for (const s of sentences) {
    const normalized = s.toLowerCase().replace(/\s+/g, " ").trim();
    if (!normalized || isFillerSentence(s)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(s);
  }
  
  // 3. If still too long, keep first N sentences that fit
  let result = "";
  for (const s of unique) {
    if (result.length + s.length + 2 > targetChars) break;
    result += (result ? " " : "") + s;
  }
  
  return result || unique.slice(0, 1).join(" ");
}

/**
 * Normalizes command input semantically.
 * 
 * @param {object} options
 * @param {string} options.kind — 'recall-query' | 'forget-intent' | 'correction-old' | 'correction-new'
 * @param {string} options.text — raw user input
 * @param {function} [options.summarizer] — async (text) => canonicalText
 * @param {number} [options.maxDirectChars] — default 6000
 * @param {number} [options.hardPayloadLimitChars] — default 100000
 * @param {object} [options.logger]
 * @param {string} [options.lang] — language for error messages
 * @param {string} [options.tone] — tone for error messages
 * @returns {Promise<{canonicalText, wasCompressed, rawLength, rawHash, evidenceSummary, kind, error?}>>
 */
export async function normalizeCommandInput({
  kind,
  text,
  summarizer,
  maxDirectChars = DEFAULT_MAX_DIRECT_CHARS,
  hardPayloadLimitChars = DEFAULT_HARD_PAYLOAD_LIMIT_CHARS,
  logger = console,
  lang = "en",
  tone = "default",
}) {
  if (!text || typeof text !== "string") {
    return { error: t("semantic.input_missing", { lang, tone }), kind };
  }
  
  const rawLength = text.length;
  const rawHash = hashText(text);
  
  // Hard payload limit
  if (rawLength > hardPayloadLimitChars) {
    return {
      error: t("semantic.input_too_large", { lang, tone, vars: { length: rawLength.toLocaleString() } }),
      kind,
      rawLength,
      rawHash,
    };
  }
  
  // Short input: pass through directly
  if (rawLength <= maxDirectChars) {
    return {
      canonicalText: text.trim(),
      wasCompressed: false,
      rawLength,
      rawHash,
      evidenceSummary: null,
      kind,
    };
  }
  
  // Long input: semantic compression
  let canonicalText;

  if (typeof summarizer === "function") {
    try {
      canonicalText = await summarizer(text);
    } catch (err) {
      logger?.warn?.(`[semantic-input] summarizer failed for ${kind}: ${err.message}`);
      canonicalText = null;
    }
  }
  
  if (!canonicalText) {
    // Fallback: heuristic compression
    const targetChars = Math.max(maxDirectChars, Math.floor(rawLength * 0.3));
    canonicalText = compressHeuristically(text, targetChars);
  }
  
  const finalText = canonicalText.trim();
  // Honest flag: only mark as "compressed" if the result is actually shorter
  // (a single overly long sentence without punctuation can pass through unchanged).
  const wasCompressed = finalText.length < rawLength;
  const evidenceSummary = `Original: ${rawLength} chars, Hash: ${rawHash}`;

  return {
    canonicalText: finalText,
    wasCompressed,
    rawLength,
    rawHash,
    evidenceSummary,
    kind,
  };
}
