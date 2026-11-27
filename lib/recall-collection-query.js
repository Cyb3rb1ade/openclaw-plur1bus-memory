/**
 * lib/recall-collection-query.js — rule-based detector for collection
 * questions ("What activities does Melanie partake in?", "Wie oft war ich
 * beim Arzt?") and the recall width they get (recall.collectionWidth, V0).
 *
 * A collection question needs several memories at once, so it gets a wider
 * prompt (topN) and a wider candidate pool (candidateTopK) than a lookup.
 * The detector is a few English and German rules over the question text
 * (at most 1,000 characters; longer prompts are no question); it reads
 * nothing else and never fails (anything that is not a string is "no").
 * Default off: without `recall.collectionWidth.enabled` nothing here runs.
 */

/** Default prompt width of a detected collection question. */
export const COLLECTION_DEFAULT_TOP_N = 45;
/** Default candidate width (vector pool and rerank input) of a detected collection question. */
export const COLLECTION_DEFAULT_CANDIDATE_TOP_K = 200;
/** Upper bound of both widths. */
export const COLLECTION_MAX_WIDTH = 500;

// Longer prompts (pasted documents, transcripts) are no collection question,
// even when they contain "how many" or "what are" somewhere.
const MAX_QUERY_CHARS = 1_000;

// Words ending in "s" that are no plural object after "what/which".
const EN_NOT_PLURAL = new Set([
  "is", "was", "has", "does", "this", "his", "hers", "its", "yes", "us", "thus", "plus", "status",
  "focus", "bus", "campus", "less", "unless", "across", "always", "perhaps", "whereas", "towards",
  "afterwards", "besides", "ours", "yours", "theirs", "miss", "boss", "class", "process", "address",
  "business", "success", "progress", "stress", "kindness", "illness", "fitness", "happiness", "access",
  "chess", "dress", "glass", "grass", "series", "species", "news", "christmas", "means", "makes",
  "takes", "gives", "keeps", "says", "goes", "likes", "loves", "wants", "needs", "seems", "feels",
  "thinks", "knows", "plays", "works", "lives", "helps", "uses", "gets", "comes", "looks",
]);

const EN_RULES = [
  ["how-many", /\bhow\s+many\b/],
  ["how-often", /\bhow\s+often\b|\bhow\s+many\s+times\b/],
  // "what are you doing" asks about one thing; "what are your hobbies" counts.
  ["what-are", /\b(?:what|which)\s+(?:are|were)\b(?!\s+(?:you|we|they|i|he|she|it)\b)/],
  ["what-kinds", /\b(?:what|which)\s+(?:kinds|types|sorts)\s+of\b/],
  ["what-some", /\bwhat\s+(?:are|were)\s+some\b|\bname\s+(?:all|some|every)\b|\blist\s+(?:all|the|every)\b/],
  ["in-what-ways", /\bin\s+what\s+ways\b|\bwhat\s+ways\b/],
  ["all-the", /\ball\s+(?:the|of\s+the|of\s+(?:his|her|their|my|your))\b(?!\s+(?:time|way|best|same|while|more)\b)/],
];

const DE_RULES = [
  ["wie-viele", /\bwie\s+viele?\b/],
  ["wie-oft", /\bwie\s+oft\b|\bwie\s+viele\s+male?\b/],
  ["welche-alle", /\bwelche[mnrs]?\b[^?.!]*\balle[mns]?\b/],
  ["alle-meine", /\balle\s+(?:meine|deine|seine|ihre|unsere|eure|die|der)\b/],
  // "was für ein(e) …" is singular ("was für ein Wetter"), only the bare plural counts.
  ["was-fuer-plural", /\bwas\s+für\s+(?!(?:ein|eine|einen|einem|einer|eines)\b)(?:\p{L}+\s+)?\p{L}{3,}(?:en|er|e|s|n)\b/u],
  ["welche-plural", /\bwelche\s+(?:\p{L}+\s+)?\p{L}{3,}(?:en|er|s|n)\s+(?:hab|hat|hatte|war|sind|waren|kenn|mag|kauf|lese|lies|las|seh|sah|besuch|mach)/u],
  // The separable "aufzählen" ends its clause with "auf"; "ich zähle auf dich" does not.
  ["zaehl-auf", /\bzähl\w*\b[^?.!]*\bauf\b(?=\s*(?:[?.!,;:]|$))|\bliste\b|\baufzählen\b/],
];

/**
 * Whether a question asks for a collection of memories.
 *
 * @param {unknown} query question text
 * @returns {{collection: boolean, rule: string|null}} `rule` names the rule that matched
 */
export function isCollectionQuery(query) {
  if (typeof query !== "string" || !query.trim() || query.length > MAX_QUERY_CHARS) return { collection: false, rule: null };
  const text = query.toLowerCase().replace(/[’`]/g, "'");
  for (const [rule, re] of EN_RULES) if (re.test(text)) return { collection: true, rule };
  for (const [rule, re] of DE_RULES) if (re.test(text)) return { collection: true, rule };
  // "What/Which <up to two words> <plural noun>": "what activities", "which
  // national parks", "what kind of indoor activities" (a singular "kind of"
  // counts only with a plural object: "what kind of tattoo" is a lookup).
  const plural = /\b(?:what|which)\s+((?:[a-z'-]+\s+){0,2}?)([a-z]{3,}(?:ies|s))\b/g;
  const object = text.replace(/\b(what|which)\s+(?:kind|type|sort)\s+of\s+/g, "$1 ");
  for (let m = plural.exec(object); m; m = plural.exec(object)) {
    const noun = m[2];
    const lead = m[1].trim().split(/\s+/).filter(Boolean);
    if (EN_NOT_PLURAL.has(noun) || noun.endsWith("ss") || noun.endsWith("'s")) continue;
    // An auxiliary between "what" and the noun ("what did melanie's kids")
    // turns the noun into the subject, not the object asked for.
    if (lead.some((word) => /^(?:did|do|does|is|was|has|have|had|will|would|can|could|should)$/.test(word))) continue;
    return { collection: true, rule: "what-plural" };
  }
  return { collection: false, rule: null };
}

function width(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(COLLECTION_MAX_WIDTH, Math.max(1, Math.floor(n)));
}

/**
 * Normalised `recall.collectionWidth` (unknown or invalid values fall back
 * to the defaults; anything but `enabled: true` is off).
 *
 * @param {unknown} cfg
 * @returns {{enabled: boolean, topN: number, candidateTopK: number}}
 */
export function normalizeCollectionWidthConfig(cfg) {
  const source = cfg && typeof cfg === "object" ? cfg : {};
  return {
    enabled: source.enabled === true,
    topN: width(source.topN, COLLECTION_DEFAULT_TOP_N),
    candidateTopK: width(source.candidateTopK, COLLECTION_DEFAULT_CANDIDATE_TOP_K),
  };
}

/**
 * The width for one question: null when the switch is off or the question
 * is no collection question.
 *
 * @param {unknown} query
 * @param {unknown} cfg recall.collectionWidth
 * @returns {{topN: number, candidateTopK: number, rule: string}|null}
 */
export function resolveCollectionWidth(query, cfg) {
  const config = normalizeCollectionWidthConfig(cfg);
  if (!config.enabled) return null;
  const detected = isCollectionQuery(query);
  if (!detected.collection) return null;
  return { topN: config.topN, candidateTopK: config.candidateTopK, rule: detected.rule };
}
