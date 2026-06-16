/**
 * lib/memory-fact-quality.js — deterministic, testable fact-quality classifier.
 *
 * No LLM is used. The classifier exposes structured signals that callers can
 * use to clamp/downrank importance, choose categories, and record trace reasons.
 */

const TRIVIAL_FILLER = new Set([
  "ok", "okay", "yes", "yeah", "yep", "no", "nope", "go on", "continue", "proceed",
  "weiter", "mach", "danke", "bitte", "ja", "nein", "hm", "hmm", "uh", "uhh",
]);

const PREFERENCE_VERBS = new Set([
  "prefer", "prefers", "like", "likes", "love", "loves", "hate", "hates", "want", "wants",
  "bevorzuge", "bevorzugt", "mag", "möchte", "möchten", "will", "wollen",
]);

const DURABLE_MARKERS = new Set([
  "from now on", "always", "never", "remember", "remember this", "don\'t forget",
  "merke", "merke dir", "ab jetzt", "von jetzt an", "immer", "nie",
]);

const TEMPORAL_MARKERS = new Set([
  "today", "tomorrow", "yesterday", "right now", "currently", "at the moment",
  "heute", "morgen", "gestern", "gerade", "momentan", "im moment",
  "finished", "done", "passed", "failed", "build is", "deploy läuft",
]);

const STATUS_VERBS = new Set([
  "downloading", "running", "finished", "passed", "failed", "building", "testing",
  "läuft", "fertig", "abgeschlossen", "fehlgeschlagen",
]);

const PROJECT_TECH_TERMS = new Set([
  "node", "nodejs", "node.js", "react", "vue", "angular", "svelte",
  "postgres", "postgresql", "mysql", "mongodb", "sqlite", "redis", "mariadb", "dynamodb",
  "auth", "oauth", "jwt", "deploy", "deployment", "infrastructure", "pipeline",
  "docker", "kubernetes", "k8s", "terraform", "github", "gitlab", "ci", "cd",
]);

const ARCHITECTURE_WORDS = new Set([
  "architecture", "decision", "chosen", "decided", "use", "using", "migrated", "migration",
  "architektur", "entschieden", "gewählt", "verwenden", "nutzen", "umgestellt",
]);

const SECURITY_WORDS = new Set([
  "security", "vulnerability", "bypass", "auth", "authentication", "permission",
  "exploit", "cve", "fix", "fixed", "patch", "patched",
  "sicherheit", "lücke", "angriff", "auth", "berechtigung",
]);

const NEGATION_MARKERS = new Set([
  "not", "no", "never", "no longer", "not anymore", "instead", "rather",
  "nicht", "nicht mehr", "kein", "keine", "statt", "sondern", "jetzt", "nun",
]);

const CORRECTION_PATTERNS = [
  /\bnot\b.+?\banymore\b/i,
  /\bno\s+longer\b/i,
  /\binstead\s+of\b/i,
  /\brather\s+than\b/i,
  /\bstatt\b.+?\bnun\b/i,
  /\bnicht\s+mehr\b/i,
  /\bjetzt\b.+?\bstatt\b/i,
  /\b(statt|sondern)\b/i,
];

const EMOTION_ONLY_WORDS = new Set([
  "angry", "frustrated", "happy", "sad", "excited", "bored", "tired", "worried",
  "wütend", "frustriert", "glücklich", "traurig", "aufgeregt", "gelangweilt", "müde",
]);

const FILLER_PUNCTUATION = /^[^a-zA-Z0-9\u00C0-\u024F]*$/;

function normalize(text) {
  return String(text ?? "").toLowerCase().trim();
}

function tokenize(text) {
  return normalize(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function containsAny(text, set) {
  const tokens = tokenize(text);
  for (const token of tokens) {
    if (set.has(token)) return true;
  }
  return false;
}

function containsPhrase(text, phrases) {
  const lower = normalize(text);
  for (const phrase of phrases) {
    const pattern = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Allow flexible spacing/punctuation between words.
    const regex = new RegExp(pattern.replace(/\s+/g, "\\s*[^\\p{L}\\p{N}]*\\s*"), "iu");
    if (regex.test(lower)) return true;
  }
  return false;
}

function countContentTokens(text) {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "has", "have", "had", "do", "does", "did",
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einen", "einem", "eines",
    "ich", "du", "er", "sie", "es", "wir", "ihr", "sie", "mich", "dich", "ihn", "ihr", "uns", "euch",
    "und", "oder", "aber", "sondern", "in", "on", "at", "for", "with", "of", "to", "from",
  ]);
  return tokenize(text).filter((t) => t.length > 1 && !stopWords.has(t)).length;
}

export function detectTrivialMemory(text, _context = {}) {
  const lower = normalize(text);
  const reasons = [];
  let trivial = false;

  // Empty or no letters/numbers
  if (lower.length === 0 || FILLER_PUNCTUATION.test(text)) {
    trivial = true;
    reasons.push("empty or punctuation-only");
    return { trivial, reasons };
  }

  const tokens = tokenize(text);
  const contentCount = countContentTokens(text);

  if (tokens.length <= 2 && TRIVIAL_FILLER.has(lower.replace(/[^\p{L}\p{N}\s]/gu, "").trim())) {
    trivial = true;
    reasons.push("filler acknowledgement");
  } else if (contentCount === 0 && tokens.length <= 3) {
    trivial = true;
    reasons.push("no content tokens");
  }

  return { trivial, reasons };
}

export function detectTemporaryMemory(text, _context = {}) {
  const lower = normalize(text);
  const reasons = [];
  let temporary = false;

  if (containsPhrase(lower, Array.from(TEMPORAL_MARKERS))) {
    temporary = true;
    reasons.push("contains temporary marker");
  }

  if (containsAny(lower, STATUS_VERBS) && !/\b(läuft auf|runs on|deployed on|deployed to)\b/i.test(lower)) {
    temporary = true;
    reasons.push("transient status verb");
  }

  // One-off command outputs often contain finished/passed/failed + a command
  if (/\b(npm|yarn|pnpm|test|build|deploy)\b/.test(lower) && /\b(finished|passed|failed|done|complete|läuft|fertig)\b/.test(lower)) {
    // "läuft auf" / "runs on" is a runtime fact, not a transient status.
    if (!/\b(läuft auf|runs on|deployed on|deployed to)\b/i.test(lower)) {
      temporary = true;
      reasons.push("one-off command output");
    }
  }

  return { temporary, reasons };
}

export function detectDurablePreference(text, _context = {}) {
  const lower = normalize(text);
  const reasons = [];
  let durablePreference = false;

  if (containsAny(lower, PREFERENCE_VERBS)) {
    durablePreference = true;
    reasons.push("preference verb");
  }

  if (containsPhrase(lower, Array.from(DURABLE_MARKERS))) {
    durablePreference = true;
    reasons.push("explicit instruction");
  }

  // If it looks like a preference but has a strong temporal marker, demote
  const temp = detectTemporaryMemory(text);
  if (temp.temporary && !containsPhrase(lower, Array.from(DURABLE_MARKERS))) {
    durablePreference = false;
    reasons.length = 0;
    reasons.push("preference verb overridden by temporary marker");
  }

  return { durablePreference, reasons };
}

function extractNamedEntities(text) {
  const entities = new Set();
  if (typeof text !== "string") return entities;
  const words = text.split(/\s+/);
  for (const w of words) {
    const clean = w.replace(/[^\p{L}\p{N}\-]/gu, "");
    if (/^[A-ZÄÖÜ][a-zäöüß\-]*(?:\.[a-z]+)?$/u.test(clean) && clean.length > 1) {
      entities.add(clean.toLowerCase());
    }
  }
  return entities;
}

export function detectProjectFact(text, _context = {}) {
  const lower = normalize(text);
  const reasons = [];
  let projectFact = false;

  if (containsAny(lower, PROJECT_TECH_TERMS)) {
    projectFact = true;
    reasons.push("technical term");
  }

  if (/\b\d+(\.\d+)?\b/.test(lower) && containsAny(lower, PROJECT_TECH_TERMS)) {
    projectFact = true;
    reasons.push("version or number with technical context");
  }

  if (containsAny(lower, ARCHITECTURE_WORDS) && countContentTokens(text) >= 3) {
    projectFact = true;
    reasons.push("architecture language with substance");
  }

  if (containsAny(lower, SECURITY_WORDS) && countContentTokens(text) >= 3) {
    projectFact = true;
    reasons.push("concrete security/deploy fact");
  }

  const namedEntities = extractNamedEntities(text);
  if (namedEntities.size > 0 && countContentTokens(text) >= 3) {
    projectFact = true;
    reasons.push("named entity with descriptive content");
  }

  return { projectFact, reasons };
}

export function detectCorrectionSignal(text, _context = {}) {
  const reasons = [];
  let correction = false;

  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(text)) {
      correction = true;
      reasons.push("correction pattern");
      break;
    }
  }

  // Negation + temporal marker together strongly signals a change/correction
  const lower = normalize(text);
  if (containsAny(lower, NEGATION_MARKERS) && detectTemporaryMemory(text).temporary) {
    correction = true;
    reasons.push("negation with temporal marker");
  }

  // Direct contradiction: "X, not Y" or "X, not Y"
  if (/\b\w+\b\s*,?\s+not\s+\b\w+\b/i.test(text) || /\b\w+\b\s*,?\s+nicht\s+\b\w+\b/i.test(text)) {
    correction = true;
    reasons.push("direct contradiction pattern");
  }

  return { correction, reasons };
}

export function classifyFactDurability(text, context = {}) {
  const trivial = detectTrivialMemory(text, context);
  if (trivial.trivial) return { durability: "ephemeral", reasons: trivial.reasons };

  const temporary = detectTemporaryMemory(text, context);
  if (temporary.temporary) return { durability: "temporary", reasons: temporary.reasons };

  const durablePreference = detectDurablePreference(text, context);
  const projectFact = detectProjectFact(text, context);
  const correction = detectCorrectionSignal(text, context);

  const reasons = [
    ...durablePreference.reasons,
    ...projectFact.reasons,
    ...correction.reasons,
  ];

  if (durablePreference.durablePreference || projectFact.projectFact || correction.correction) {
    return { durability: "durable", reasons: reasons.length ? reasons : ["has durable content"] };
  }

  return { durability: "unknown", reasons: ["no strong durability signal"] };
}

export function explainFactQuality(text, context = {}) {
  const trivial = detectTrivialMemory(text, context);
  const temporary = detectTemporaryMemory(text, context);
  const durablePreference = detectDurablePreference(text, context);
  const projectFact = detectProjectFact(text, context);
  const correction = detectCorrectionSignal(text, context);
  const durabilityResult = classifyFactDurability(text, context);

  const categoryHints = [];
  if (durablePreference.durablePreference) categoryHints.push("preference");
  if (projectFact.projectFact) categoryHints.push("project");
  if (correction.correction) categoryHints.push("correction");
  if (containsAny(text, SECURITY_WORDS)) categoryHints.push("security");

  const reasons = [];
  reasons.push(...trivial.reasons);
  reasons.push(...temporary.reasons);
  reasons.push(...durablePreference.reasons);
  reasons.push(...projectFact.reasons);
  reasons.push(...correction.reasons);

  let importanceBand = "low";
  let shouldPromote = false;
  let shouldDownrank = false;

  if (trivial.trivial) {
    importanceBand = "low";
    shouldDownrank = true;
  } else if (temporary.temporary && !durablePreference.durablePreference) {
    importanceBand = "low";
    shouldDownrank = true;
  } else if (correction.correction) {
    importanceBand = "high";
    shouldPromote = true;
  } else if (containsPhrase(normalize(text), Array.from(DURABLE_MARKERS))) {
    importanceBand = "high";
    shouldPromote = true;
  } else if (durablePreference.durablePreference) {
    importanceBand = "medium";
    shouldPromote = true;
  } else if (projectFact.projectFact) {
    importanceBand = countContentTokens(text) >= 5 ? "high" : "medium";
    shouldPromote = true;
  } else {
    importanceBand = "low";
  }

  // Emotion-only text should never be high importance
  const tokens = tokenize(text);
  const emotionOnly = tokens.length > 0 && tokens.every((t) => EMOTION_ONLY_WORDS.has(t) || t.length <= 2);
  if (emotionOnly) {
    importanceBand = "low";
    shouldPromote = false;
    reasons.push("emotion-only without durable preference");
  }

  // Generic tech keyword salad without a subject is not high
  const techOnly = tokens.length > 0 && tokens.every((t) => PROJECT_TECH_TERMS.has(t) || t.length <= 2);
  if (techOnly && !correction.correction && !containsPhrase(normalize(text), Array.from(DURABLE_MARKERS))) {
    importanceBand = "low";
    shouldPromote = false;
    reasons.push("generic technical keywords without subject");
  }

  return {
    durability: durabilityResult.durability,
    categoryHints,
    importanceBand,
    shouldPromote,
    shouldDownrank,
    reasons: reasons.length ? reasons : ["no strong signal"],
  };
}

/**
 * Computes a final importance score for a memory, combining an optional
 * caller-provided explicit importance with fact-quality signals.
 *
 * @param {Object} params
 * @param {string} params.text — memory text
 * @param {string} [params.category] — assigned category
 * @param {string} [params.categoryReason] — reason for assigned category
 * @param {number} [params.explicitImportance] — caller-provided importance
 * @param {string} [params.origin="dm"] — memory origin
 * @returns {{ importance: number, importanceReason: string, factQuality: object, categoryReason: string|undefined }}
 */
export function computeMemoryImportance(params = {}) {
  const text = String(params.text ?? "");
  const category = params.category || "";
  const categoryReason = params.categoryReason;
  const origin = params.origin || "dm";
  const isExplicit = Number.isFinite(params.explicitImportance);
  const baseImportance = isExplicit ? params.explicitImportance : 0.5;

  const factQuality = explainFactQuality(text, { category, origin });

  const reasons = [];
  if (categoryReason) reasons.push(`category: ${categoryReason}`);
  reasons.push(...factQuality.reasons);

  const normalized = normalizeImportanceScore(baseImportance, reasons, {
    downrankTrivial: true,
    downrankTemporary: !isExplicit,
    minDurablePreference: 0.55,
    minProjectFact: 0.65,
    minExplicitRemember: 0.7,
    minSecurityDeploy: 0.7,
  });

  return {
    importance: normalized,
    importanceReason: reasons.join("; ") || "default importance",
    factQuality,
    categoryReason,
  };
}

/**
 * Conservative gate for KNOWLEDGE.md / long-term promotion.
 * Blocks promotion for trivial, ephemeral, or temporary facts unless an
 * explicit instruction or durable preference overrides.
 */
export function shouldPromoteMemory(category, importance, factQuality, schicht15MinImportance = 0.7) {
  if (!factQuality || factQuality.shouldDownrank) return false;
  if (!factQuality.shouldPromote && importance < schicht15MinImportance) return false;
  if (!["decision", "fact"].includes(category)) return false;
  return importance >= schicht15MinImportance;
}

export function normalizeImportanceScore(score, reasons = [], opts = {}) {
  const explicit = Number.isFinite(score) ? score : 0.5;
  const options = {
    downrankTrivial: true,
    downrankTemporary: true,
    minDurablePreference: 0.55,
    minProjectFact: 0.65,
    minExplicitRemember: 0.7,
    minSecurityDeploy: 0.7,
    ...opts,
  };

  const loweredReasons = reasons.map((r) => String(r).toLowerCase());
  const hasReason = (pattern) => loweredReasons.some((r) => pattern.test(r));
  let result = explicit;

  const isTrivial = hasReason(/filler acknowledgement|empty or punctuation-only|no content tokens|trivial/);
  const isTemporary = hasReason(/temporary marker|transient status|one-off command/);
  const isExplicitRemember = hasReason(/\bexplicit instruction\b|explicit remember instruction|remember this/);
  const isGenericTechOnly = hasReason(/\bgeneric technical keywords without subject\b/);

  // Boost durable preferences moderately.
  if (hasReason(/\bpreference verb\b/)) {
    result = Math.max(result, options.minDurablePreference);
  }

  // Preserve explicit user instructions like "remember this" / "from now on" as high signal.
  if (isExplicitRemember) {
    result = Math.max(result, options.minExplicitRemember);
  }

  // Boost project architecture facts moderately/high (but not generic keyword salad).
  if (!isGenericTechOnly && hasReason(/\b(architecture language with substance|technical term|version or number with technical context|named entity with descriptive content)\b/)) {
    result = Math.max(result, options.minProjectFact);
  }

  // Boost corrections and superseding updates.
  if (hasReason(/\b(correction pattern|direct contradiction pattern|negation with temporal marker)\b/)) {
    result = Math.max(result, options.minExplicitRemember);
  }

  // Boost security/deploy/auth/incident facts, but only when concrete.
  if (hasReason(/\bconcrete security\/deploy fact\b/)) {
    result = Math.max(result, options.minSecurityDeploy);
  }

  // Downrank temporary/status memories unless explicitly requested to remember.
  // This cap is applied AFTER floors so transient status cannot be over-promoted.
  if (options.downrankTemporary && isTemporary && !isExplicitRemember) {
    result = Math.min(result, 0.45);
  }

  // Clamp trivial / ephemeral memories to low importance.
  if (options.downrankTrivial && isTrivial) {
    result = Math.min(result, 0.2);
  }

  return clamp(result, 0, 1);
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
