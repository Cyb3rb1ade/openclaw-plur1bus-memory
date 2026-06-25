// Canonical speaker-segment schema shared between PLUR1BUS and OpenClaw.
// This module is intentionally dependency-free so it can be imported by both
// the memory plugin and any downstream normalizers.

/** @typedef {"discord_voice" | "telegram_voice" | "youtube" | "upload" | "podcast" | "meeting" | "unknown"} SpeakerSegmentSource */

/** @typedef {"discord_user_stream" | "asr_diarize" | "sortformer" | "manual" | "enrollment" | "unknown"} SpeakerSegmentAttributionSource */

/**
 * @typedef {Object} SpeakerSegmentWord
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} word
 * @property {number} [confidence]
 */

/**
 * @typedef {Object} SpeakerSegment
 * @property {SpeakerSegmentSource} source
 * @property {string | null} sourceId
 * @property {string} speakerLabel
 * @property {string | null} speakerDisplayName
 * @property {number | null} speakerConfidence
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} text
 * @property {SpeakerSegmentWord[] | null} words
 * @property {SpeakerSegmentAttributionSource} attributionSource
 * @property {string | null} diarizationModel
 * @property {string | null} asrModel
 */

const VALID_SOURCES = new Set([
  "discord_voice",
  "telegram_voice",
  "youtube",
  "upload",
  "podcast",
  "meeting",
  "unknown",
]);

const VALID_ATTRIBUTION_SOURCES = new Set([
  "discord_user_stream",
  "asr_diarize",
  "sortformer",
  "manual",
  "contextual_proposal",
  "enrollment",
  "unknown",
]);

const UNKNOWN_SOURCE = "unknown";
const UNKNOWN_ATTRIBUTION_SOURCE = "unknown";

const MEDIA_OUTPUT_ID_TOKEN_RE = /<!-- media-output-id: ([a-f0-9-]+) -->/gi;
const MEDIA_OUTPUT_ID_TOKEN_LEADING_RE = /^<!-- media-output-id: [a-f0-9-]+ -->\n?/gi;

/**
 * Coerce a value to a non-empty string or return the fallback.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function toString(value, fallback) {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return fallback;
}

/**
 * Coerce a value to a string or null.
 * @param {unknown} value
 * @returns {string | null}
 */
function toOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const s = String(value);
  return s.length > 0 ? s : null;
}

/**
 * Coerce a value to a finite number or return the fallback.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function toNumber(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n)) {
    return n;
  }
  return fallback;
}

/**
 * Coerce a value to a number in [0, 1] or null.
 * @param {unknown} value
 * @returns {number | null}
 */
function toOptionalConfidence(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    return Math.max(0, Math.min(1, n));
  }
  return null;
}

/**
 * Validate and normalize a single speaker segment. Unknown/invalid fields are
 * replaced with safe defaults so consumers never see undefined values.
 *
 * @param {unknown} input
 * @returns {SpeakerSegment}
 */
export function normalizeSpeakerSegment(input) {
  const segment = typeof input === "object" && input !== null ? input : {};

  const rawSource = toString(segment.source, UNKNOWN_SOURCE);
  const source = VALID_SOURCES.has(rawSource) ? rawSource : UNKNOWN_SOURCE;

  const rawAttribution = toString(segment.attributionSource, UNKNOWN_ATTRIBUTION_SOURCE);
  const attributionSource = VALID_ATTRIBUTION_SOURCES.has(rawAttribution)
    ? rawAttribution
    : UNKNOWN_ATTRIBUTION_SOURCE;

  const startMs = toNumber(segment.startMs, 0);
  const endMs = toNumber(segment.endMs, startMs);

  return {
    source,
    sourceId: toOptionalString(segment.sourceId),
    speakerLabel: toString(segment.speakerLabel, "unknown"),
    speakerDisplayName: toOptionalString(segment.speakerDisplayName),
    speakerConfidence: toOptionalConfidence(segment.speakerConfidence),
    startMs,
    endMs: Math.max(startMs, endMs),
    text: toString(segment.text, ""),
    words: Array.isArray(segment.words) ? segment.words.map((w) => ({
      startMs: toNumber(w?.startMs, startMs),
      endMs: toNumber(w?.endMs, startMs),
      word: toString(w?.word, ""),
      confidence: toOptionalConfidence(w?.confidence),
    })) : null,
    attributionSource,
    diarizationModel: toOptionalString(segment.diarizationModel),
    asrModel: toOptionalString(segment.asrModel),
  };
}

/**
 * Normalize an array of speaker segments. Non-array input becomes an empty
 * array; individual invalid items are replaced with safe defaults.
 *
 * @param {unknown} input
 * @returns {SpeakerSegment[]}
 */
export function normalizeSpeakerSegments(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map(normalizeSpeakerSegment);
}

/**
 * Create a canonical speaker segment. Convenience wrapper around
 * normalizeSpeakerSegment with explicit named parameters.
 *
 * @param {Partial<SpeakerSegment>} params
 * @returns {SpeakerSegment}
 */
export function createSpeakerSegment(params = {}) {
  return normalizeSpeakerSegment(params);
}

/**
 * Build a speaker segment for Discord voice using the Discord user id as the
 * canonical speaker label. Never performs biometric identification.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string | null} [params.displayName]
 * @param {string} params.text
 * @param {number} params.startMs
 * @param {number} params.endMs
 * @param {string | null} [params.asrModel]
 * @returns {SpeakerSegment}
 */
export function createDiscordSpeakerSegment({
  userId,
  displayName = null,
  text,
  startMs,
  endMs,
  asrModel = null,
}) {
  return normalizeSpeakerSegment({
    source: "discord_voice",
    sourceId: userId,
    speakerLabel: `discord:${userId}`,
    speakerDisplayName: displayName,
    speakerConfidence: null,
    startMs,
    endMs,
    text,
    words: null,
    attributionSource: "discord_user_stream",
    diarizationModel: null,
    asrModel,
  });
}

/**
 * Build a generic fallback segment for mixed audio sources where the speaker
 * is not (yet) known. This explicitly avoids assuming single-speaker input.
 *
 * @param {Object} params
 * @param {SpeakerSegmentSource} [params.source]
 * @param {string | null} [params.sourceId]
 * @param {string} params.text
 * @param {number} params.startMs
 * @param {number} params.endMs
 * @returns {SpeakerSegment}
 */
export function createUnknownSpeakerSegment({
  source = "unknown",
  sourceId = null,
  text,
  startMs,
  endMs,
}) {
  return normalizeSpeakerSegment({
    source,
    sourceId,
    speakerLabel: "speaker_0",
    speakerDisplayName: null,
    speakerConfidence: null,
    startMs,
    endMs,
    text,
    words: null,
    attributionSource: "unknown",
    diarizationModel: null,
    asrModel: null,
  });
}

/**
 * Format an array of speaker segments as human-readable text.
 * The output is intentionally free of assumed identities such as "Christian"
 * or "Eva"; only the raw speakerLabel is used.
 *
 * @param {SpeakerSegment[]} segments
 * @returns {string}
 */
export function formatSpeakerSegments(segments) {
  const normalized = normalizeSpeakerSegments(segments);
  if (normalized.length === 0) {
    return "";
  }
  return normalized
    .map((segment) => {
      const name = segment.speakerDisplayName ?? segment.speakerLabel;
      return `[${name}]: ${segment.text}`;
    })
    .join("\n");
}

/**
 * Strip the hidden media-output-id token from a transcript string.
 * @param {string} text
 * @returns {string}
 */
export function stripMediaOutputIdToken(text) {
  return String(text || "").replace(MEDIA_OUTPUT_ID_TOKEN_LEADING_RE, "");
}

/**
 * Extract all mediaOutputId values embedded in a transcript string.
 * @param {string} text
 * @returns {string[]}
 */
export function extractMediaOutputIds(text) {
  const ids = [];
  let match;
  while ((match = MEDIA_OUTPUT_ID_TOKEN_RE.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/**
 * Apply confirmed speaker mappings to segments.
 * @param {SpeakerSegment[]} segments
 * @param {Map<string, string>} mappings
 * @returns {SpeakerSegment[]}
 */
export function applySpeakerMappings(segments, mappings) {
  const map = mappings instanceof Map ? mappings : new Map(Object.entries(mappings || {}));
  return normalizeSpeakerSegments(segments).map((segment) => {
    const displayName = map.get(segment.speakerLabel);
    if (!displayName) {
      return segment;
    }
    return { ...segment, speakerDisplayName: displayName };
  });
}
