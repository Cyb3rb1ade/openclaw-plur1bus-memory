/**
 * lib/enrichment/enrich-llm.js — prompt, JSON schema and fail-closed parser
 * for the shared memory enrichment (entities, about, facets, event date).
 *
 * One call annotates a batch of records said in one session (bench: one
 * LOCOMO session; production: 10–20 rows of one session or calendar day).
 * The module is provider-agnostic: the caller passes a `complete` function
 * (bench: OpenAI client with Structured Outputs; production: the plugin's LLM
 * route). It never writes memory rows; results are sidecar entries
 * (lib/enrichment/sidecar.js).
 *
 * Event dates are cross-checked against the deterministic resolver
 * (lib/enrichment/date-resolver.js): a disagreement drops the date
 * (`dateCheck: "ambiguous"`), it is never "repaired". Event time is not
 * real-world validity: nothing here reads or writes `validFrom`/`validUntil`.
 */

import { createHash } from "node:crypto";

import {
  DATE_PRECISIONS,
  DEFAULT_EVENT_TIME_ZONE,
  civilDayInZone,
  dayRangeToMs,
  parseYmd,
  resolveEventDates,
  stripLeadingTimestamp,
} from "./date-resolver.js";

/** Version of prompt + schema + parser rules; stored on every entry. */
export const ENRICH_VERSION = 1;

/** Fixed facet taxonomy (stable slugs). */
export const ENRICH_FACETS = Object.freeze([
  "family", "relationship", "friends", "pets", "hobby", "sport", "art", "music", "media", "travel",
  "food", "work", "tech", "education", "health", "finance", "home", "events", "plans", "identity",
]);

const FACET_GLOSSES = {
  en: {
    family: "parents, children, siblings, relatives",
    relationship: "partner, dating, marriage",
    friends: "friendships, meeting friends",
    pets: "pets and animals in one's care",
    hobby: "hobbies, crafts, games, outdoor activities",
    sport: "sports, fitness, exercise",
    art: "painting, drawing, photography, other visual art",
    music: "playing or listening to music, concerts",
    media: "books, films, series, podcasts, news",
    travel: "trips, vacations, places visited",
    food: "cooking, eating out, recipes",
    work: "job, career, projects",
    tech: "software, devices, computers",
    education: "school, studies, courses, learning",
    health: "physical or mental health, medical care",
    finance: "money, purchases, shopping",
    home: "housing, moving, household",
    events: "parties, celebrations, holidays, ceremonies",
    plans: "plans, goals, wishes",
    identity: "values, beliefs, identity, community, activism",
  },
  de: {
    family: "Eltern, Kinder, Geschwister, Verwandte",
    relationship: "Partnerschaft, Dating, Ehe",
    friends: "Freundschaften, Treffen mit Freunden",
    pets: "Haustiere",
    hobby: "Hobbys, Basteln, Spiele, Unternehmungen draußen",
    sport: "Sport, Fitness, Training",
    art: "Malen, Zeichnen, Fotografie, bildende Kunst",
    music: "Musik machen oder hören, Konzerte",
    media: "Bücher, Filme, Serien, Podcasts, Nachrichten",
    travel: "Reisen, Urlaub, besuchte Orte",
    food: "Kochen, Essen gehen, Rezepte",
    work: "Arbeit, Beruf, Projekte",
    tech: "Software, Geräte, Computer",
    education: "Schule, Studium, Kurse, Lernen",
    health: "körperliche oder seelische Gesundheit, Arztbesuche",
    finance: "Geld, Käufe, Einkaufen",
    home: "Wohnen, Umzug, Haushalt",
    events: "Feiern, Feste, Feiertage, Zeremonien",
    plans: "Pläne, Ziele, Wünsche",
    identity: "Werte, Überzeugungen, Identität, Gemeinschaft, Engagement",
  },
};

/** Values of `event.precision`. */
export const EVENT_PRECISIONS = DATE_PRECISIONS;
/** Values of `event.kind`. */
export const EVENT_KINDS = Object.freeze(["past", "planned", "ongoing", "recurring"]);
/** Values of `event.source`. */
export const EVENT_SOURCES = Object.freeze(["explicit", "relative", "utterance"]);
/** Outcomes of the cross-check between LLM and resolver. */
export const DATE_CHECKS = Object.freeze(["agree", "llm-only", "parser-only", "ambiguous", "unanchored", "none"]);

/** Size limits of the prompt and of parsed fields. */
export const ENRICH_LIMITS = Object.freeze({
  maxRecords: 40,
  maxRecordChars: 1200,
  maxEntities: 12,
  maxAbout: 6,
  maxFacets: 3,
  maxNameChars: 60,
  maxPhraseChars: 40,
  maxRawPhraseChars: 120,
});

const DAY = 86_400_000;
const FACET_SET = new Set(ENRICH_FACETS);
const WEEKDAY_NAMES = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  de: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
};

/**
 * Canonical form of an entity or person name: NFC, trimmed, single spaces,
 * lowercase, without surrounding quotes or punctuation.
 *
 * @param {unknown} value
 * @returns {string} "" when nothing is left
 */
export function normalizeEnrichmentName(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/^["'“”„‚‘’«»()[\]{}.,;:!?-]+|["'“”„‚‘’«»()[\]{}.,;:!?-]+$/gu, "")
    .trim();
}

/**
 * Hash of a memory text; an entry whose hash differs from the current text
 * is stale.
 *
 * @param {unknown} text
 * @returns {string} 32 hex characters (sha256 prefix)
 */
export function enrichmentContentHash(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 32);
}

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * JSON schema of the model answer (Structured Outputs strict shape: every
 * property required, no additional properties, nullable `event`). `pattern`
 * and `maxItems` are advisory; the parser enforces all limits itself. Deeply
 * frozen: clone it (structuredClone) before adapting it to a provider.
 */
export const ENRICHMENT_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["records"],
  properties: {
    records: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "entities", "about", "facets", "event"],
        properties: {
          key: { type: "string" },
          entities: { type: "array", items: { type: "string" }, maxItems: ENRICH_LIMITS.maxEntities },
          about: { type: "array", items: { type: "string" }, maxItems: ENRICH_LIMITS.maxAbout },
          facets: { type: "array", items: { type: "string", enum: [...ENRICH_FACETS] }, maxItems: ENRICH_LIMITS.maxFacets },
          event: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["from", "until", "precision", "kind", "phrase", "source"],
                properties: {
                  from: { type: "string", pattern: DATE_PATTERN },
                  until: { type: "string", pattern: DATE_PATTERN },
                  precision: { type: "string", enum: [...EVENT_PRECISIONS] },
                  kind: { type: "string", enum: [...EVENT_KINDS] },
                  phrase: { type: "string" },
                  source: { type: "string", enum: [...EVENT_SOURCES] },
                },
              },
            ],
          },
        },
      },
    },
  },
});

/** Name passed with the schema (`response_format.json_schema.name`). */
export const ENRICHMENT_SCHEMA_NAME = "memory_enrichment";

function facetList(language) {
  const glosses = FACET_GLOSSES[language] || FACET_GLOSSES.en;
  return ENRICH_FACETS.map((f) => `${f} (${glosses[f]})`).join(", ");
}

const SYSTEM_PROMPTS = {
  en: [
    "You annotate short memory records from one conversation for a retrieval index. Answer only with JSON that matches the schema: one item per record, identified by its key.",
    "- entities: named people, pets, places, organisations, works (books, films, songs, games), products and named events in the record. Canonical lowercase form (\"melanie\", \"new york\", \"the hobbit\"). Never generic nouns (\"dog\", \"painting\", \"job\") and never pronouns. [] if none.",
    "- about: the persons the statement is about, as lowercase names. The speaker counts only for statements about themselves (I, my, me). [] if unclear.",
    `- facets: 1 to 3 topics from this fixed list: ${facetList("en")}. [] only if none fits.`,
    "- event: when the described event or state happened or will happen, else null.",
    "  from/until: YYYY-MM-DD, until inclusive (equal to from for a single day). precision: day | week | month | year | range. kind: past | planned | ongoing | recurring. phrase: the time words from the record, verbatim, at most 40 characters. source: explicit (a calendar date, month or year named in the text) | relative (resolved from words like yesterday, last week, two years ago) | utterance (the event happens at the time of speaking: today, tonight, right now).",
    "  Resolve relative phrases against the date the record was said (the session date unless the record shows its own date). Weeks run Monday to Sunday: \"last week\" is the whole previous calendar week, \"last month\" the whole previous calendar month, \"last weekend\" the most recent Saturday and Sunday before the session date. Coarse phrases cover the whole period.",
    "  Return null if the record gives no time for the event. Never use the session date unless the record says today, tonight, right now or similar. Relative to another event (\"the next day\", \"two days later\") or repeating without a date (\"every Monday\"): null.",
    "Records may be in English or German.",
  ].join("\n"),
  de: [
    "Du annotierst kurze Erinnerungen aus einem Gespräch für einen Suchindex. Antworte nur mit JSON nach dem Schema: ein Eintrag je Erinnerung, gekennzeichnet durch ihren key.",
    "- entities: benannte Personen, Haustiere, Orte, Organisationen, Werke (Bücher, Filme, Lieder, Spiele), Produkte und benannte Ereignisse. Kanonisch kleingeschrieben (\"eva\", \"new york\", \"der hobbit\"). Keine Gattungswörter (\"hund\", \"arzt\", \"job\"), keine Pronomen. [] wenn keine.",
    "- about: die Personen, um die es in der Aussage geht, als kleingeschriebene Namen. Der Sprecher zählt nur bei Aussagen über sich selbst (ich, mein, mir). [] wenn unklar.",
    `- facets: 1 bis 3 Themen aus dieser festen Liste: ${facetList("de")}. [] nur wenn keines passt.`,
    "- event: wann das beschriebene Ereignis oder der Zustand war oder sein wird, sonst null.",
    "  from/until: YYYY-MM-DD, until einschließlich (bei einem einzelnen Tag gleich from). precision: day | week | month | year | range. kind: past | planned | ongoing | recurring. phrase: die Zeitwörter aus der Erinnerung, wörtlich, höchstens 40 Zeichen. source: explicit (Kalenderdatum, Monat oder Jahr im Text) | relative (aufgelöst aus Wörtern wie gestern, letzte Woche, vor zwei Jahren) | utterance (das Ereignis findet zur Zeit der Äußerung statt: heute, heute Abend, gerade).",
    "  Löse relative Angaben gegen das Datum auf, an dem die Erinnerung gesagt wurde (das Gesprächsdatum, außer die Erinnerung nennt ein eigenes). Wochen gehen von Montag bis Sonntag: \"letzte Woche\" ist die ganze vorige Kalenderwoche, \"letzten Monat\" der ganze vorige Kalendermonat, \"letztes Wochenende\" das letzte Samstag-Sonntag vor dem Gesprächsdatum. Grobe Angaben umfassen den ganzen Zeitraum.",
    "  null, wenn die Erinnerung keine Zeit für das Ereignis nennt. Das Gesprächsdatum nur, wenn die Erinnerung heute, heute Abend, gerade oder Ähnliches sagt. Bezogen auf ein anderes Ereignis (\"am nächsten Tag\", \"zwei Tage später\") oder wiederkehrend ohne Datum (\"jeden Montag\"): null.",
    "Die Erinnerungen können deutsch oder englisch sein.",
  ].join("\n"),
};

function cleanRecordText(text, maxChars) {
  const flat = stripLeadingTimestamp(text).replace(/\s+/gu, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

function nowOf(now) {
  return typeof now === "function" ? Number(now()) : Number(now ?? Date.now());
}

// A record's own anchor: a number; null = explicitly unknown; absent = the batch anchor.
function recordAnchor(record, batchAnchor) {
  if (Number.isFinite(record?.anchorMs)) return record.anchorMs;
  return record?.anchorMs === null ? null : batchAnchor;
}

/**
 * Prompt for one batch of records.
 *
 * @param {{records: Array<{id: string, text: string, anchorMs?: number|null}>,
 *   anchorMs?: number|null, timeZone?: string, language?: "en"|"de", maxRecordChars?: number}} args
 *   `anchorMs` is the session time (default: first record's anchor); a record
 *   whose own anchor falls on another day is shown with its date.
 * @returns {{messages: Array<{role: string, content: string}>, schema: object, schemaName: string,
 *   keys: string[], promptHash: string, sessionDate: string|null, language: string}}
 */
export function buildEnrichmentPrompt({ records, anchorMs = null, timeZone = DEFAULT_EVENT_TIME_ZONE, language = "en", maxRecordChars = ENRICH_LIMITS.maxRecordChars } = {}) {
  if (!Array.isArray(records) || records.length === 0 || records.length > ENRICH_LIMITS.maxRecords) {
    throw new TypeError(`buildEnrichmentPrompt: records must be an array of 1..${ENRICH_LIMITS.maxRecords}`);
  }
  const lang = language === "de" ? "de" : "en";
  const batchAnchor = Number.isFinite(anchorMs) ? anchorMs : (records.map((r) => r?.anchorMs).find(Number.isFinite) ?? null);
  const sessionDate = batchAnchor == null ? null : civilDayInZone(batchAnchor, timeZone);
  const keys = records.map((_, i) => String(i + 1));
  const lines = records.map((record, i) => {
    let said = "";
    if (Number.isFinite(record?.anchorMs)) {
      const day = civilDayInZone(record.anchorMs, timeZone);
      if (day !== sessionDate) said = lang === "de" ? `(gesagt ${day}) ` : `(said ${day}) `;
    } else if (sessionDate != null && record?.anchorMs === null) {
      said = lang === "de" ? "(Datum unbekannt) " : "(date unknown) ";
    }
    return `[${keys[i]}] ${said}${cleanRecordText(record?.text, maxRecordChars)}`;
  });
  let header;
  if (sessionDate == null) {
    header = lang === "de"
      ? "Gesprächsdatum: unbekannt. Löse nur ausdrückliche Kalenderdaten mit Jahr auf; bei relativen Angaben ist event null."
      : "Session date: unknown. Resolve only explicit calendar dates with a year; for relative phrases event is null.";
  } else {
    const wd = WEEKDAY_NAMES[lang][new Date(parseYmd(sessionDate)).getUTCDay()];
    header = lang === "de" ? `Gesprächsdatum: ${sessionDate} (${wd})` : `Session date: ${sessionDate} (${wd})`;
  }
  const system = SYSTEM_PROMPTS[lang];
  const user = `${header}\n${lang === "de" ? "Erinnerungen" : "Records"}:\n${lines.join("\n")}`;
  return {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    schema: ENRICHMENT_JSON_SCHEMA,
    schemaName: ENRICHMENT_SCHEMA_NAME,
    keys,
    promptHash: enrichmentPromptHash(lang),
    sessionDate,
    language: lang,
  };
}

/**
 * Hash of version, instructions and schema (not of the records).
 *
 * @param {"en"|"de"} [language]
 * @returns {string} 16 hex characters
 */
export function enrichmentPromptHash(language = "en") {
  const lang = language === "de" ? "de" : "en";
  return createHash("sha256")
    .update(`${ENRICH_VERSION}\n${SYSTEM_PROMPTS[lang]}\n${JSON.stringify(ENRICHMENT_JSON_SCHEMA)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

// ─── Parser (fail-closed) ─────────────────────────────────────────────────

function parseRaw(raw) {
  if (raw && typeof raw === "object") return { value: raw };
  const text = String(raw ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text);
  try {
    return { value: JSON.parse(fenced ? fenced[1] : text) };
  } catch (error) {
    return { error: `invalid-json: ${String(error?.message || error).slice(0, 80)}` };
  }
}

function validateNames(value, max, field) {
  if (!Array.isArray(value)) return { error: `${field}-not-array` };
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return { error: `${field}-not-string` };
    const name = normalizeEnrichmentName(item);
    if (!name) continue;
    if (name.length > ENRICH_LIMITS.maxNameChars) return { error: `${field}-too-long` };
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > max) return { error: `${field}-too-many` };
  return { value: out };
}

function validateFacets(value) {
  if (!Array.isArray(value)) return { error: "facets-not-array" };
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return { error: "facets-not-string" };
    const facet = item.trim().toLowerCase();
    if (!FACET_SET.has(facet)) return { error: "facets-unknown" };
    if (!out.includes(facet)) out.push(facet);
  }
  if (out.length > ENRICH_LIMITS.maxFacets) return { error: "facets-too-many" };
  return { value: out };
}

function precisionFits(precision, fromCd, untilCd) {
  const a = new Date(fromCd);
  const b = new Date(untilCd);
  if (precision === "day") return fromCd === untilCd;
  if (precision === "week") return untilCd - fromCd <= 6 * DAY;
  if (precision === "month") return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
  if (precision === "year") return a.getUTCFullYear() === b.getUTCFullYear();
  return precision === "range";
}

/**
 * Validates one model `event` object.
 *
 * @param {unknown} value
 * @param {string} timeZone
 * @returns {{value: object|null}|{error: string}}
 */
function validateLlmEvent(value, timeZone) {
  if (value === null) return { value: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "event-not-object" };
  const fromCd = parseYmd(value.from);
  const untilCd = parseYmd(value.until);
  if (fromCd == null || untilCd == null) return { error: "event-bad-date" };
  if (untilCd < fromCd) return { error: "event-reversed" };
  if (!EVENT_PRECISIONS.includes(value.precision)) return { error: "event-bad-precision" };
  if (!EVENT_KINDS.includes(value.kind)) return { error: "event-bad-kind" };
  if (!EVENT_SOURCES.includes(value.source)) return { error: "event-bad-source" };
  if (typeof value.phrase !== "string" || value.phrase.length > ENRICH_LIMITS.maxRawPhraseChars) return { error: "event-bad-phrase" };
  if (!precisionFits(value.precision, fromCd, untilCd)) return { error: "event-precision-mismatch" };
  const ms = dayRangeToMs(value.from, value.until, timeZone);
  if (!ms) return { error: "event-bad-date" };
  return {
    value: {
      from: value.from,
      until: value.until,
      fromMs: ms.fromMs,
      untilMs: ms.untilMs,
      precision: value.precision,
      kind: value.kind,
      phrase: value.phrase.replace(/\s+/gu, " ").trim().slice(0, ENRICH_LIMITS.maxPhraseChars),
      source: value.source,
    },
  };
}

function validateItem(item, timeZone) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "item-not-object" };
  for (const field of ["entities", "about", "facets", "event"]) {
    if (!(field in item)) return { error: `${field}-missing` };
  }
  const entities = validateNames(item.entities, ENRICH_LIMITS.maxEntities, "entities");
  if (entities.error) return entities;
  const about = validateNames(item.about, ENRICH_LIMITS.maxAbout, "about");
  if (about.error) return about;
  const facets = validateFacets(item.facets);
  if (facets.error) return facets;
  const event = validateLlmEvent(item.event, timeZone);
  if (event.error) return event;
  return { value: { entities: entities.value, about: about.value, facets: facets.value, event: event.value } };
}

/**
 * Parses a model answer. Invalid JSON or a wrong top-level shape fails the
 * whole batch; a missing, duplicated or invalid item fails only its record.
 *
 * @param {string|object} raw model output (text or already parsed object)
 * @param {{keys: string[], timeZone?: string}} opts keys from buildEnrichmentPrompt
 * @returns {{ok: boolean, error: string|null, items: Map<string, {value?: object, error?: string}>, unknownKeys: number}}
 *   `items` has one entry per expected key; `value` is
 *   {entities, about, facets, event: {from, until, fromMs, untilMs, precision, kind, phrase, source}|null}
 */
export function parseEnrichmentResponse(raw, { keys, timeZone = DEFAULT_EVENT_TIME_ZONE } = {}) {
  const items = new Map((keys || []).map((key) => [String(key), { error: "missing" }]));
  const parsed = parseRaw(raw);
  if (parsed.error) return { ok: false, error: parsed.error, items: failAll(items, parsed.error), unknownKeys: 0 };
  const list = parsed.value?.records;
  if (!Array.isArray(list)) return { ok: false, error: "records-not-array", items: failAll(items, "records-not-array"), unknownKeys: 0 };
  const seen = new Map();
  let unknownKeys = 0;
  for (const item of list) {
    const key = item && typeof item === "object" && (typeof item.key === "string" || Number.isInteger(item.key)) ? String(item.key).trim() : null;
    if (key == null || !items.has(key)) { unknownKeys++; continue; }
    seen.set(key, (seen.get(key) || 0) + 1);
    items.set(key, validateItem(item, timeZone));
  }
  for (const [key, n] of seen) if (n > 1) items.set(key, { error: "duplicate-key" });
  return { ok: true, error: null, items, unknownKeys };
}

function failAll(items, error) {
  for (const key of items.keys()) items.set(key, { error });
  return items;
}

// ─── Cross-check with the deterministic resolver ──────────────────────────

const normPhrase = (s) => String(s ?? "").toLowerCase().replace(/[’‘`]/gu, "'").replace(/\s+/gu, " ").trim();

function dayOverlap(a, b, tolDays) {
  const af = parseYmd(a.from); const au = parseYmd(a.until);
  const bf = parseYmd(b.from); const bu = parseYmd(b.until);
  if ([af, au, bf, bu].some((x) => x == null)) return false;
  const tol = tolDays * DAY;
  return af <= bu + tol && bf <= au + tol;
}

function hitAsEvent(h) {
  return {
    from: h.from, until: h.until, fromMs: h.fromMs, untilMs: h.untilMs, precision: h.precision,
    kind: h.kind ?? null, phrase: String(h.phrase).slice(0, ENRICH_LIMITS.maxPhraseChars), source: h.source,
  };
}

/**
 * Compares the model's event with the resolver hits of the same text.
 *
 * Rule: hits whose phrase matches the model's phrase (substring either way,
 * or same position in the text) decide alone; otherwise any hit decides.
 * Overlap in calendar days (approximate hits ± `toleranceDays`) = "agree".
 * No overlap = "ambiguous" (event dropped, model event kept as candidate),
 * except when no hit matches the phrase and the phrase is in the text: then
 * the resolver has no opinion on it = "llm-only". No hits: "llm-only" only
 * when the model's phrase (at least 3 characters) occurs in the text, else
 * "ambiguous"/"unverifiable" (an invented phrase, or the session date put on
 * a record without time words).
 * Model null + hits = "parser-only" (event stays null). Without an anchor a
 * non-explicit model date = "unanchored".
 *
 * @param {object|null} event validated model event
 * @param {Array<object>} hits resolveEventDates result for the record text
 * @param {{text?: string, anchorMs?: number|null, toleranceDays?: number}} [opts]
 * @returns {{dateCheck: string, event: object|null, reason?: string, candidate?: object, parserEvent?: object}}
 */
export function crossCheckEvent(event, hits, { text = "", anchorMs = null, toleranceDays = 2 } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (!event) return list.length ? { dateCheck: "parser-only", event: null, parserEvent: hitAsEvent(list[0]) } : { dateCheck: "none", event: null };
  if (!Number.isFinite(anchorMs) && event.source !== "explicit") return { dateCheck: "unanchored", event: null, candidate: event };
  const phrase = normPhrase(event.phrase);
  if (list.length === 0) {
    return phrase.length >= 3 && normPhrase(text).includes(phrase)
      ? { dateCheck: "llm-only", event }
      : { dateCheck: "ambiguous", event: null, reason: "unverifiable", candidate: event };
  }
  const lowerText = String(text ?? "").toLowerCase().replace(/[’‘`]/gu, "'");
  const at = phrase.length >= 3 ? lowerText.indexOf(phrase) : -1;
  const matched = list.filter((h) => {
    const hp = normPhrase(h.phrase);
    if (phrase.length >= 3 && hp && (hp.includes(phrase) || phrase.includes(hp))) return true;
    return at >= 0 && at < h.end && h.index < at + phrase.length;
  });
  const overlaps = (h) => dayOverlap(event, h, h.approximate ? toleranceDays : 0);
  if (matched.length) {
    return matched.some(overlaps) ? { dateCheck: "agree", event } : { dateCheck: "ambiguous", event: null, reason: "phrase-disagrees", candidate: event };
  }
  if (list.some(overlaps)) return { dateCheck: "agree", event };
  if (at >= 0) return { dateCheck: "llm-only", event, reason: "parser-other-phrases" };
  return { dateCheck: "ambiguous", event: null, reason: "unverifiable", candidate: event };
}

// ─── Entries ──────────────────────────────────────────────────────────────

/**
 * Turns a model answer into sidecar entries (parse, validate, cross-check).
 * Pure: the bench can re-run it over cached answers.
 *
 * @param {{records: Array<{id: string, text: string, anchorMs?: number|null}>, raw: string|object,
 *   keys?: string[], anchorMs?: number|null, timeZone?: string, model?: string, promptHash?: string,
 *   now?: number|(() => number), toleranceDays?: number}} args
 * @returns {{ok: boolean, error: string|null, entries: object[], failed: Array<{id: string, error: string}>, unknownKeys: number}}
 */
export function buildEnrichmentEntries({ records, raw, keys = null, anchorMs = null, timeZone = DEFAULT_EVENT_TIME_ZONE, model = "", promptHash = "", now = Date.now, toleranceDays = 2 } = {}) {
  const list = Array.isArray(records) ? records : [];
  const batchKeys = keys || list.map((_, i) => String(i + 1));
  const batchAnchor = Number.isFinite(anchorMs) ? anchorMs : (list.map((r) => r?.anchorMs).find(Number.isFinite) ?? null);
  const parsed = parseEnrichmentResponse(raw, { keys: batchKeys, timeZone });
  const enrichedAt = nowOf(now);
  const entries = [];
  const failed = [];
  list.forEach((record, i) => {
    const id = String(record?.id ?? "");
    const item = parsed.items.get(batchKeys[i]);
    if (!id || !item || item.error) { failed.push({ id, error: item?.error || "missing" }); return; }
    const anchor = recordAnchor(record, batchAnchor);
    const hits = resolveEventDates(record.text, anchor, { timeZone });
    const check = crossCheckEvent(item.value.event, hits, { text: record.text, anchorMs: anchor, toleranceDays });
    const entry = {
      id,
      contentHash: enrichmentContentHash(record.text),
      enrichedAt,
      enrichVersion: ENRICH_VERSION,
      model: String(model || ""),
      promptHash: String(promptHash || ""),
      timeZone,
      anchorTs: Number.isFinite(anchor) ? anchor : 0,
      entities: item.value.entities,
      about: item.value.about,
      facets: item.value.facets,
      event: check.event,
      dateCheck: check.dateCheck,
    };
    if (check.reason) entry.dateReason = check.reason;
    if (check.candidate) entry.eventCandidate = check.candidate;
    if (check.parserEvent) entry.parserEvent = check.parserEvent;
    entries.push(entry);
  });
  return { ok: parsed.ok, error: parsed.error, entries, failed, unknownKeys: parsed.unknownKeys };
}

/**
 * Enriches one batch through a caller-supplied completion function.
 *
 * `complete({messages, schema, schemaName, maxTokens})` returns the model
 * text, or `{text, usage}`; `usage` is passed through untouched so the caller
 * can track cost. A thrown error fails the batch (returned, not thrown).
 *
 * @param {{records: Array<{id: string, text: string, anchorMs?: number|null}>,
 *   complete: (req: {messages: object[], schema: object, schemaName: string, maxTokens: number}) => Promise<string|{text: string, usage?: object}>,
 *   anchorMs?: number|null, timeZone?: string, language?: "en"|"de", model?: string, maxTokens?: number,
 *   now?: number|(() => number), toleranceDays?: number}} args
 * @returns {Promise<{ok: boolean, error: string|null, entries: object[], failed: Array<{id: string, error: string}>,
 *   usage: object|null, promptHash: string, raw: string|object|null, unknownKeys: number}>}
 */
export async function enrichBatch({ records, complete, anchorMs = null, timeZone = DEFAULT_EVENT_TIME_ZONE, language = "en", model = "", maxTokens = 4000, now = Date.now, toleranceDays = 2 } = {}) {
  if (typeof complete !== "function") throw new TypeError("enrichBatch: complete must be a function");
  const prompt = buildEnrichmentPrompt({ records, anchorMs, timeZone, language });
  let response;
  try {
    response = await complete({ messages: prompt.messages, schema: prompt.schema, schemaName: prompt.schemaName, maxTokens });
  } catch (error) {
    const message = `complete-failed: ${String(error?.message || error).slice(0, 200)}`;
    return { ok: false, error: message, entries: [], failed: records.map((r) => ({ id: String(r?.id ?? ""), error: message })), usage: null, promptHash: prompt.promptHash, raw: null, unknownKeys: 0 };
  }
  const isObj = response && typeof response === "object";
  const raw = isObj ? (response.text ?? response.content ?? null) : response;
  const usage = isObj ? (response.usage ?? null) : null;
  const built = buildEnrichmentEntries({
    records, raw, keys: prompt.keys, anchorMs, timeZone, model, promptHash: prompt.promptHash, now, toleranceDays,
  });
  return { ...built, usage, promptHash: prompt.promptHash, raw };
}
