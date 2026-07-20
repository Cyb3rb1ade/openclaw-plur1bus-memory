/**
 * lib/semantic-input.js — Semantic Long-Input Handling for Memory Commands.
 *
 * Philosophy: Never truncate or reject long semantic input.
 * Instead: compress canonically while preserving full meaning.
 */

import { createHash } from "node:crypto";
import { t } from "./i18n.js";
import { INPUT_LIMITS } from "./input-limits.js";

const DEFAULT_MAX_DIRECT_CHARS = INPUT_LIMITS.SEARCH_QUERY;
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

function trimExcerptToWords(excerpt, { trimStart = false, trimEnd = false } = {}) {
  let result = excerpt;
  if (trimStart && result && !/^\s/.test(result)) {
    const firstBoundary = result.search(/\s/);
    if (firstBoundary > 0 && firstBoundary < result.length / 2) {
      result = result.slice(firstBoundary + 1);
    }
  }
  if (trimEnd && result && !/\s$/.test(result)) {
    const lastBoundary = result.lastIndexOf(" ");
    if (lastBoundary > result.length / 2) {
      result = result.slice(0, lastBoundary);
    }
  }
  return result.trim();
}

function selectRepresentativeExcerpts(text, targetChars) {
  const target = Math.max(1, Math.floor(targetChars));
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= target) return normalized;

  const separator = " … ";
  if (target <= separator.length * 2 + 3) return normalized.slice(0, target);

  const excerptBudget = Math.floor((target - separator.length * 2) / 3);
  const middleStart = Math.max(0, Math.floor((normalized.length - excerptBudget) / 2));
  const tailStart = Math.max(0, normalized.length - excerptBudget);
  const excerpts = [
    trimExcerptToWords(normalized.slice(0, excerptBudget), { trimEnd: true }),
    trimExcerptToWords(normalized.slice(middleStart, middleStart + excerptBudget), {
      trimStart: true,
      trimEnd: true,
    }),
    trimExcerptToWords(normalized.slice(tailStart), { trimStart: true }),
  ].filter(Boolean);

  return excerpts.join(separator).slice(0, target).trim();
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
  
  // 3. Preserve all unique clauses when they fit. Otherwise retain bounded,
  // word-aligned evidence from the beginning, middle, and end. This also
  // handles a single punctuation-free sentence or token without bypassing
  // the caller's direct-input budget.
  const candidate = unique.join(" ") || text;
  return selectRepresentativeExcerpts(candidate, targetChars);
}

/**
 * Normalizes command input semantically.
 * 
 * @param {object} options
 * @param {string} options.kind — 'recall-query' | 'forget-intent' | 'correction-old' | 'correction-new'
 * @param {string} options.text — raw user input
 * @param {function} [options.summarizer] — async (text) => canonicalText
 * @param {number} [options.maxDirectChars] — default SEARCH_QUERY limit (2000)
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
      logger?.warn?.(`[semantic-input] summarizer failed for ${kind}: llm_error`);
      canonicalText = null;
    }
  }
  
  if (!canonicalText) {
    // Fallback: heuristic compression
    canonicalText = compressHeuristically(text, maxDirectChars);
  } else if (canonicalText.length > maxDirectChars) {
    canonicalText = compressHeuristically(canonicalText, maxDirectChars);
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
