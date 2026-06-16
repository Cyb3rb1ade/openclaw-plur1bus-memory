/**
 * lib/categorize.js — Kategorie-Taxonomie + Auto-Kategorisierung.
 *
 * Eine Quelle der Wahrheit für Plugin (memory_store enum), Cron-Capture
 * (categorizeMemory), Doctor (filter), Migrations.
 */

export const MEMORY_CATEGORIES = [
  "preference",   // User-Präferenzen ("mag kurze Antworten")
  "fact",         // Fakten über User/Projekte/Umgebung
  "decision",     // Architektur-/Tech-Entscheidungen
  "entity",       // Personen, Firmen, Produkte, Orte
  "reference",    // externe Refs: URLs, Links, Dokumente
  "debug",        // Fehler, Stacks, Reproduktionsschritte
  "config",       // Settings, Schwellenwerte, Defaults
  "conversation", // generischer Gesprächs-Capture (Auto-Capture-Default)
  "knowledge",    // kuratiertes Wissen (z.B. aus MEMORY.md-Migration)
  "curated",      // Dreaming-Promotionen, manuell kuratiert
  "other",        // Fallback
];

export const MEMORY_ORIGINS = ["dm", "group", "cron", "internal"];

export const MEMORY_SCOPES = ["agent-private", "workspace", "user"];

// Patterns that signal a durable user preference.
const PREFERENCE_PATTERNS = [
  { pattern: /\b(prefer|prefers|like|likes|love|loves|hate|hates|want|wants|always|never|usually|tend to|bevorzug|bevorzuge|bevorzugt|mag|möchte|möchten)\b/i, reason: "preference verb or durable marker" },
  { pattern: /\b(from now on|ab jetzt|von jetzt an|immer|nie)\b/i, reason: "explicit durable preference marker" },
];

// Patterns that signal a project/tech decision or correction.
const DECISION_PATTERNS = [
  { pattern: /\b(decided|will use|going with|chosen|picked|entschieden|wählen wir|nehmen wir|wir wählen|wir nehmen|wir entscheiden)\b/i, reason: "architecture decision verb" },
  { pattern: /\b(migrated|migration|umgestellt|umstellen auf|switch to|switched to)\b/i, reason: "migration/change language" },
  { pattern: /\b(no longer|not anymore|instead of|rather than|statt|sondern|nicht mehr)\b/i, reason: "correction/update language" },
  { pattern: /\b(jetzt|nun)\b.*\b(statt|sondern|nicht mehr|anstelle)/i, reason: "update/correction language" },
  { pattern: /\b(deploy|deployment|infrastructure|pipeline|auth|security|vulnerability|bypass)\b.*\b(fixed|patched|use|uses|läuft|runs|on node|auf node|läuft auf)\b/i, reason: "concrete security/deploy fact" },
  { pattern: /\b(läuft auf|runs on|deployed on|deployed to|läuft mit)\b.*\b(node|python|go|java|ruby|rust|\d+)/i, reason: "runtime/version fact" },
];

const DEBUG_PATTERNS = [
  { pattern: /\b(error|exception|stack trace|traceback|fehler|failed|reproduce)\b/i, reason: "debug/error marker" },
];

const CONFIG_PATTERNS = [
  { pattern: /\b(config|setting|threshold|default|umgebungsvariable|env var)\b/i, reason: "config/setting marker" },
];

const REFERENCE_PATTERNS = [
  { pattern: /https?:\/\//i, reason: "URL present" },
  { pattern: /\b(url|link|reference)\b/i, reason: "reference language" },
];

const ENTITY_PATTERNS = [
  { pattern: /\bname:|\bperson:|\bcompany:|\bproduct:|\bplace:/i, reason: "explicit entity tag" },
];

// Words that make a bare fact trigger substantial enough to become "fact".
const FACT_SUBSTANCE_PATTERNS = [
  { pattern: /\b(project|team|company|product|place|city|festival|event|app|service|api)\b/i, reason: "substantive noun" },
  { pattern: /\b[A-ZÄÖÜ][a-zäöüß\-]+(?:\s+[A-ZÄÖÜ][a-zäöüß\-]+)?\s+\b(is|are|was|were|has|have|ist|sind|war|waren)\b/i, reason: "named entity with copula" },
];

const BARE_FACT_TRIGGER = /\b(is |are |was |were |has |have |ist |sind |war |waren |\d{4})\b/i;

const TEMPORAL_STATUS_PATTERNS = [
  { pattern: /\b(today|tomorrow|yesterday|right now|currently|at the moment|heute|morgen|gestern|gerade|momentan)\b/i, reason: "temporal marker" },
  { pattern: /\b(finished|passed|failed|done|complete|läuft|fertig|abgeschlossen)\b/i, reason: "status verb" },
];

const FILLER_PATTERN = /^\s*(ok|okay|yes|yeah|yep|no|nope|go on|continue|proceed|weiter|mach|danke|bitte|ja|nein|hm|hmm|uh|uhh)\s*[^\p{L}\p{N}]*\s*$/iu;

function containsNamedEntity(text) {
  const words = String(text).split(/\s+/);
  for (const w of words) {
    const clean = w.replace(/[^\p{L}\p{N}\-]/gu, "");
    if (/^[A-ZÄÖÜ][a-zäöüß\-]*(?:\.[a-z]+)?$/u.test(clean) && clean.length > 1) {
      return true;
    }
  }
  return false;
}

function hasSubstance(text) {
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return tokens.length >= 3;
}

function isFiller(text) {
  return FILLER_PATTERN.test(text);
}

function isTemporalStatus(text) {
  return TEMPORAL_STATUS_PATTERNS.some((p) => p.pattern.test(text));
}

/**
 * Returns { category, reason } for a text using deterministic heuristics.
 * Specific patterns are checked first; generic fallbacks come last.
 */
export function categorizeMemoryWithReason(text) {
  const str = String(text ?? "").trim();

  if (str.length === 0) {
    return { category: "other", reason: "empty text" };
  }

  // Filler / acknowledgements → conversation
  if (isFiller(str)) {
    return { category: "conversation", reason: "filler/acknowledgement" };
  }

  // Preference
  for (const { pattern, reason } of PREFERENCE_PATTERNS) {
    if (pattern.test(str)) {
      return { category: "preference", reason };
    }
  }

  // Decision / correction / update / concrete security-deploy
  // Checked before transient-status so "Deployment läuft auf Node 22" is a decision,
  // while "npm test läuft" remains transient/conversational.
  for (const { pattern, reason } of DECISION_PATTERNS) {
    if (pattern.test(str)) {
      return { category: "decision", reason };
    }
  }

  // Transient status → conversation (not a durable fact)
  if (isTemporalStatus(str)) {
    return { category: "conversation", reason: "transient status/temporal marker" };
  }

  // Debug
  for (const { pattern, reason } of DEBUG_PATTERNS) {
    if (pattern.test(str)) {
      return { category: "debug", reason };
    }
  }

  // Config
  for (const { pattern, reason } of CONFIG_PATTERNS) {
    if (pattern.test(str)) {
      return { category: "config", reason };
    }
  }

  // Reference
  for (const { pattern, reason } of REFERENCE_PATTERNS) {
    if (pattern.test(str)) {
      return { category: "reference", reason };
    }
  }

  // Explicit entity tag
  for (const { pattern, reason } of ENTITY_PATTERNS) {
    if (pattern.test(str)) {
      return { category: "entity", reason };
    }
  }

  // Fact — only when there is enough substance (named entity or substantive noun)
  // to avoid classifying every English sentence as a fact.
  if (BARE_FACT_TRIGGER.test(str)) {
    for (const { pattern, reason } of FACT_SUBSTANCE_PATTERNS) {
      if (pattern.test(str)) {
        return { category: "fact", reason };
      }
    }
    if (containsNamedEntity(str) && hasSubstance(str)) {
      return { category: "fact", reason: "named entity with copula and substance" };
    }
  }

  // Generic tech keyword salad without a subject → conversation, not decision/fact
  const techKeywordCount = (str.match(/\b(node\.?js?|react|vue|angular|svelte|postgres|postgresql|mysql|mongodb|sqlite|redis|auth|oauth|jwt|deploy)\b/gi) || []).length;
  const wordCount = str.split(/\s+/).length;
  if (techKeywordCount >= 2 && techKeywordCount / wordCount > 0.5 && wordCount <= 5) {
    return { category: "conversation", reason: "generic keyword list without subject" };
  }

  return { category: "conversation", reason: "generic conversational content" };
}

/**
 * Backwards-compatible wrapper returning only the category string.
 */
export function categorizeMemory(text) {
  return categorizeMemoryWithReason(text).category;
}
