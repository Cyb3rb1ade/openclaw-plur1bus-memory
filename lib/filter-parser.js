/**
 * lib/filter-parser.js
 *
 * Parses intuitive filter expressions from /memory command input
 * and builds LanceDB-compatible WHERE clauses.
 *
 * User-friendly aliases (DE/EN):
 *   über:/about:/cat:      → category
 *   aus:/source:/src:      → source (maps to DB origin)
 *   wichtig:/min:/important: → minImportance (maps to memoryStrength)
 *   seit:/after:/von:      → from date
 *   bis:/before:/to:       → to date
 *   gefühl:/emotion:/mood: → emotion (maps to emotionalDominant)
 *
 * Backward compatible:
 *   category:, origin:, source:, minImportance:, emotion:
 *
 * Intentionally INVALID (ambiguität):
 *   from: — shows helpful hint instead
 */

// ─── Alias-Mapping: User-Präfix → interner Key ─────────────────────────────

const KEY_ALIASES = {
  // Kategorie
  über: "category",
  about: "category",
  cat: "category",
  category: "category",
  // Quelle
  aus: "source",
  source: "source",
  src: "source",
  origin: "origin",
  // Wichtigkeit
  wichtig: "minimportance",
  min: "minimportance",
  important: "minimportance",
  minimportance: "minimportance",
  // Datum seit
  seit: "from",
  after: "from",
  von: "from",
  // Datum bis
  bis: "to",
  before: "to",
  to: "to",
  // Emotion
  gefühl: "emotion",
  emotion: "emotion",
  mood: "emotion",
};

// Intentionally ambiguous / removed
const INVALID_KEYS = new Set(["from"]);

// ─── Wert-Normalisierung ───────────────────────────────────────────────────

// NOTE: Category synonyms are intentionally NOT normalized.
// The DB stores arbitrary category values (tests use general, work,
// user_preference, strategy — none in MEMORY_CATEGORIES).
// Normalizing person→entity would break finding manually-tagged person-memories.
// Only source/origin synonyms are normalized (clearly evidenced by sourceMap
// in db-adapter.js).

// User-facing source synonyms → DB origin value
const SOURCE_SYNONYMS = {
  // dm
  dm: "dm",
  chat: "dm",
  konversation: "dm",
  conversation: "dm",
  direct: "dm",
  // group
  group: "group",
  gruppe: "group",
  channel: "group",
  // voice
  voice: "voice",
  sprachnotiz: "voice",
  audio: "voice",
  sprache: "voice",
  // note
  note: "note",
  notiz: "note",
  notes: "note",
  notizen: "note",
  // cron
  cron: "cron",
  scheduled: "cron",
  automatisch: "cron",
  // internal
  internal: "internal",
  intern: "internal",
  // github
  github: "github",
  git: "github",
};

// Reverse mapping for helpful error messages
const DB_TO_UI_SOURCE = {
  dm: ["dm", "chat", "konversation"],
  group: ["group", "gruppe"],
  voice: ["voice", "sprachnotiz", "audio"],
  note: ["note", "notiz"],
  cron: ["cron", "scheduled"],
  internal: ["internal", "intern"],
  github: ["github", "git"],
};

const DB_TO_UI_CATEGORY = {
  preference: ["preference", "vorliebe"],
  fact: ["fact", "fakt", "project", "projekt"],
  decision: ["decision", "entscheidung"],
  entity: ["entity", "person", "people", "mensch"],
  reference: ["reference", "link", "url"],
  debug: ["debug", "bug", "fehler"],
  config: ["config", "einstellung", "setting"],
  conversation: ["conversation", "gespräch", "chat"],
  knowledge: ["knowledge", "wissen"],
  curated: ["curated", "kuratiert"],
  other: ["other", "sonstiges", "anderes"],
};

/**
 * Normalizes a user-provided filter value to the DB-canonical form.
 * Categories are passed through unchanged (DB allows arbitrary values).
 * Sources are normalized based on evidence from db-adapter.js sourceMap.
 *
 * @param {string} key — internal key (e.g. "category", "source")
 * @param {string} value — raw user value
 * @returns {string} normalized value
 */
export function normalizeFilterValue(key, value) {
  const lower = String(value).toLowerCase().trim();
  if (key === "source" || key === "origin") {
    return SOURCE_SYNONYMS[lower] || lower;
  }
  return lower;
}

/**
 * Validates a filter key/value pair and returns an error message or null.
 *
 * @param {string} key — internal key
 * @param {string|number} value
 * @returns {string|null} error message or null if valid
 */
export function validateFilter(key, value) {
  if (key === "minimportance") {
    const num = typeof value === "number" ? value : parseFloat(value);
    if (Number.isNaN(num) || num < 0 || num > 1) {
      return "Wichtigkeit muss zwischen 0.0 und 1.0 liegen, z.B. wichtig:0.7";
    }
  }
  if (key === "from" || key === "to") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      return "Ungültiges Datum. Verwende YYYY-MM-DD, z.B. seit:2026-01-01";
    }
    const ts = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isNaN(ts)) {
      return "Ungültiges Datum. Verwende YYYY-MM-DD, z.B. seit:2026-01-01";
    }
  }
  return null;
}

/**
 * Returns helpful suggestions for unknown category/source values.
 *
 * @param {string} key — "category" or "source"
 * @param {string} value — unknown value
 * @returns {string} suggestion text
 */
export function suggestValidValues(key, value) {
  if (key === "category") {
    const known = Object.entries(DB_TO_UI_CATEGORY)
      .map(([db, aliases]) => `• ${db} (${aliases.join(", ")})`)
      .join("\n");
    return `Unbekannte Kategorie "${value}". Meintest du:\n${known}`;
  }
  if (key === "source" || key === "origin") {
    const known = Object.entries(DB_TO_UI_SOURCE)
      .map(([db, aliases]) => `• ${db} (${aliases.join(", ")})`)
      .join("\n");
    return `Unbekannte Quelle "${value}". Meintest du:\n${known}`;
  }
  return `"${value}" ist für ${key} nicht bekannt.`;
}

// ─── Parser ────────────────────────────────────────────────────────────────

/**
 * Escapes a string for safe use in LanceDB SQL-like WHERE clauses.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeSqlString(s) {
  return String(s).replace(/'/g, "\\'");
}

/**
 * Parses filter expressions from the end of a query string.
 *
 * @param {string} input
 * @returns {{topic: string, filters: object, errors?: Array<string>}}
 */
export function parseFilters(input) {
  const raw = String(input || "").trim();
  if (!raw) return { topic: "", filters: {} };

  const tokens = raw.split(/\s+/);
  const filters = {};
  const errors = [];
  let topicEnd = tokens.length;

  // Scan from the end to collect key:value pairs
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    const colonIdx = token.indexOf(":");
    if (colonIdx <= 0) break;

    const rawKey = token.slice(0, colonIdx).toLowerCase();
    const rawValue = token.slice(colonIdx + 1);

    // Intentionally ambiguous key
    if (INVALID_KEYS.has(rawKey)) {
      errors.push(`"${rawKey}:" ist nicht eindeutig. Meintest du aus: (Quelle) oder seit: (Datum)?`);
      break;
    }

    const internalKey = KEY_ALIASES[rawKey];
    if (!internalKey) break;

    if (internalKey === "minimportance") {
      const num = parseFloat(rawValue);
      if (!Number.isNaN(num)) {
        const err = validateFilter(internalKey, num);
        if (err) errors.push(err);
        else filters[internalKey] = num;
      } else {
        errors.push(`Ungültige Zahl für Wichtigkeit: "${rawValue}". Beispiel: wichtig:0.7`);
      }
    } else if (internalKey === "from" || internalKey === "to") {
      const err = validateFilter(internalKey, rawValue);
      if (err) errors.push(err);
      else filters[internalKey] = rawValue;
    } else {
      const normalized = normalizeFilterValue(internalKey, rawValue);
      // Source/origin synonyms are normalized; categories pass through as-is
      // because the DB stores arbitrary category values.
      filters[internalKey] = normalized;
    }
    topicEnd = i;
  }

  const topic = tokens.slice(0, topicEnd).join(" ");
  const result = { topic, filters };
  if (errors.length > 0) result.errors = errors;
  return result;
}

// ─── Where-Clause Builder ──────────────────────────────────────────────────

const KEY_TO_COLUMN = {
  category: "category",
  source: "origin",
  origin: "origin",
  minimportance: "memoryStrength",
  from: "createdAt",
  to: "createdAt",
  emotion: "emotionalDominant",
};

/**
 * Builds a LanceDB WHERE clause from parsed filters.
 *
 * @param {object} filters
 * @returns {string|null}
 */
export function buildWhereClause(filters) {
  if (!filters || Object.keys(filters).length === 0) return null;

  const clauses = [];

  for (const [key, value] of Object.entries(filters)) {
    const col = KEY_TO_COLUMN[key];
    if (!col) continue;

    if (key === "minimportance") {
      clauses.push(`${col} >= ${Number(value)}`);
    } else if (key === "from") {
      const ts = Date.parse(`${value}T00:00:00.000Z`);
      if (!Number.isNaN(ts)) clauses.push(`${col} >= ${ts}`);
    } else if (key === "to") {
      const ts = Date.parse(`${value}T23:59:59.999Z`);
      if (!Number.isNaN(ts)) clauses.push(`${col} <= ${ts}`);
    } else {
      clauses.push(`${col} = '${escapeSqlString(value)}'`);
    }
  }

  return clauses.length > 0 ? clauses.join(" AND ") : null;
}
