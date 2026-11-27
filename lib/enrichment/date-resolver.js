/**
 * lib/enrichment/date-resolver.js — deterministic event dates from memory
 * text (English and German), resolved against the time the text was said.
 *
 * Used before the enrichment LLM as a cross-check of its `event` field
 * (lib/enrichment/enrich-llm.js) and on its own for a rule-only date pass.
 * It never touches `validFrom`/`validUntil` (real-world validity of a claim)
 * and never derives anything from `createdAt` except through the anchor the
 * caller passes in.
 *
 * Calendar rules (shared with the enrichment prompt):
 * - Days are civil days in `timeZone` (default Europe/Berlin). The LOCOMO
 *   bench stores session wall-clock time as UTC and passes `timeZone: "UTC"`.
 * - Weeks run Monday to Sunday. "last week"/"letzte Woche" is the whole
 *   previous calendar week, "two weeks ago"/"vor zwei Wochen" the calendar
 *   week that contains the day 14 days back.
 * - Coarse phrases span the whole period (month, season, year).
 * - Narrative-relative phrases ("the next day", "am nächsten Tag", "two days
 *   later"), recurring phrases ("every Monday", "montags") and durations
 *   ("for two weeks", "bis heute") produce no date.
 * - Without an anchor only explicit dates that carry a year resolve.
 *
 * Port and extension of the bench's lv-temporal-resolve.mjs (EN only, UTC).
 */

const DAY = 86_400_000;

/** Default zone for civil days. */
export const DEFAULT_EVENT_TIME_ZONE = "Europe/Berlin";

/** Values of `precision` on a hit (same set as the enrichment schema). */
export const DATE_PRECISIONS = Object.freeze(["day", "week", "month", "year", "range"]);

const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

// Unicode-aware word boundaries (\b only knows ASCII, so "übermorgen" or
// "vorgestern" would slip through it).
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";

const EN_MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
const DE_MONTHS = { januar: 0, "jänner": 0, februar: 1, "märz": 2, maerz: 2, april: 3, mai: 4, juni: 5, juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11 };
const MONTHS = { ...EN_MONTHS, ...DE_MONTHS };
const alternation = (obj) => Object.keys(obj).sort((a, b) => b.length - a.length).join("|");
const EN_MONTH_RE = alternation(EN_MONTHS);
const DE_MONTH_RE = alternation(DE_MONTHS);
const MONTH_RE = alternation(MONTHS);
// English month names that are also common words: only capitalised.
const CASE_SENSITIVE_MONTHS = new Set(["may", "march"]);

const EN_WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DE_WEEKDAYS = { sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6 };
const WEEKDAYS = { ...EN_WEEKDAYS, ...DE_WEEKDAYS };
const EN_WD_RE = alternation(EN_WEEKDAYS);
const DE_WD_RE = alternation(DE_WEEKDAYS);

const EN_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const EN_APPROX = { "a couple of": [2, 3], "a couple": [2, 3], "couple of": [2, 3], "a few": [2, 5], few: [2, 5], several: [2, 5] };
const DE_NUM = { ein: 1, eine: 1, einem: 1, einer: 1, einen: 1, eins: 1, zwei: 2, drei: 3, vier: 4, "fünf": 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, "zwölf": 12, zwoelf: 12 };
const DE_APPROX = { "ein paar": [2, 5], paar: [2, 5], einigen: [2, 5], einige: [2, 5], mehreren: [2, 5], mehrere: [2, 5] };
const EN_NUM_RE = `(\\d{1,3}|${alternation({ ...EN_APPROX, ...EN_NUM })})`;
const DE_NUM_RE = `(\\d{1,3}|${alternation({ ...DE_APPROX, ...DE_NUM })})`;

const EN_UNIT_RE = "(days?|weeks?|months?|years?)";
const DE_UNIT_RE = "(tagen|tage|tag|wochen|woche|monaten|monate|monat|jahren|jahre|jahr)";

const DE_LAST = "(?:letzte[nmrs]?|vergangene[nmrs]?|vorige[nmrs]?)";
const DE_THIS = "(?:diese[nmrs]?)";
const DE_NEXT = "(?:nächste[nmrs]?|naechste[nmrs]?|kommende[nmrs]?)";

const EN_SEASONS = { spring: "spring", summer: "summer", fall: "autumn", autumn: "autumn", winter: "winter" };
const DE_SEASONS = { "frühling": "spring", fruehling: "spring", "frühjahr": "spring", fruehjahr: "spring", sommer: "summer", herbst: "autumn", winter: "winter" };
const EN_SEASON_RE = alternation(EN_SEASONS);
const DE_SEASON_RE = alternation(DE_SEASONS);
const SEASON_START_MONTH = { spring: 2, summer: 5, autumn: 8, winter: 11 };

// Tense cues decide the direction of phrases like "in October", "on Monday"
// or "am Wochenende". Evaluated per clause.
const FUTURE_CUE = new RegExp(
  `${B}(?:will|shall|going\\s+to|gonna|plan(?:s|ning)?\\s+(?:to|on)|hop(?:e|es|ing)\\s+to|intend(?:s|ing)?\\s+to|can['’]?t\\s+wait|looking\\s+forward|about\\s+to|upcoming|want(?:s)?\\s+to|wanna|would\\s+like\\s+to|`
  + `werde|wirst|wird|werden|werdet|will|willst|wollen|wollt|möchte|möchtest|möchten|moechte|plane|planst|plant|planen|vorhaben|habe\\s+vor|hab\\s+vor|freue\\s+mich|freu\\s+mich|bald|demnächst|demnaechst|kommende[nmrs]?|anstehende[nmrs]?)${E}|['’]ll${E}`,
  "iu",
);
const DE_PAST_WORDS = "war|waren|warst|wart|hatte|hatten|hattest|ging|gingen|fuhr|fuhren|kam|kamen|sah|machte|machten|gewesen|gemacht|gegangen|gefahren|gekommen|gesehen|gekauft|gehabt|besucht|getroffen|gespielt|gegessen|geflogen|angefangen|begonnen";
// English clauses (and clauses of unknown language) use the union of both
// lists, unchanged since the bench calibration.
const PAST_CUE = new RegExp(
  `${B}(?:was|were|had|did|went|got|came|saw|made|took|spent|ate|drove|flew|met|ran|bought|found|felt|left|gave|told|said|began|won|lost|wrote|sang|thought|knew|heard|sent|brought|built|caught|taught|`
  + `${DE_PAST_WORDS})${E}`
  + `|\\p{L}{3,}ed${E}`,
  "iu",
);
// German clauses: only the German list. "was" is "what"/"which" there, and
// "-ed" ends nouns such as "Unterschied" or "Mitglied".
const DE_PAST_CUE = new RegExp(`${B}(?:${DE_PAST_WORDS})${E}`, "iu");
// Clause language by function words. Words that exist in both languages
// ("am", "an", "in", "die", "war", "will", "was", "so", "hat", "bin",
// "den") count for neither.
const DE_MARKER = new RegExp(
  `${B}(?:ich|du|er|wir|ihr|sie|mich|mir|dich|dir|sich|uns|euch|ist|sind|bist|seid|habe|hab|hast|haben|habt|nicht|und|oder|aber|mit|von|vom|zum|zur|im|der|das|dem|des|ein|eine|einen|einem|einer|eines|auf|für|fuer|nach|auch|noch|schon|wie|wo|wann|warum|wer|soll|sollte|kann|muss|mache|machst|macht|gehe|gehst|geht|ja|nein|heute|gestern|bitte|danke|sehr|mal|doch|dann|wenn|weil|dass|bei|aus|über|ueber)${E}|[äöüß]`,
  "giu",
);
const EN_MARKER = new RegExp(
  `${B}(?:the|i|you|he|she|it|we|they|me|him|us|them|my|your|his|its|our|their|is|are|were|been|have|has|had|do|does|did|and|of|to|a|with|that|this|for|on|at|but|not|what|when|where|how|who|which|going|just|really|very|would|could|should|there|then|from|about)${E}|['’](?:s|ve|re|ll|d|m|t)${E}`,
  "giu",
);
// German perfect tense: auxiliary plus participle in the same clause.
const DE_AUX = new RegExp(`${B}(?:habe|hab|hast|hat|haben|habt|hatte|hatten|bin|bist|ist|sind|seid|war|waren)${E}`, "iu");
const DE_PARTICIPLE = new RegExp(`${B}ge\\p{L}{3,}(?:t|en)${E}`, "iu");
const CLAUSE_BOUNDARY = /[.!?;\n]+|\s(?:and|but|while|und|aber|doch|während)\s/giu;
// "have been … for two years": a duration up to now, not the length of an event.
const PERFECT_CUE = new RegExp(
  `(?:${B}(?:have|has)|['’]ve|['’]s)\\s+(?:been|had|known|lived|worked|played|owned|kept|done|used|wanted|loved|studied|practi[cs]ed|run|taught|volunteered|painted|collected)${E}`,
  "iu",
);

const BLOCK = Symbol("block");

// Cheap gate: a text without any of these stems has no phrase any rule matches.
const PREFILTER = new RegExp(
  `\\d|yesterday|today|tonight|tomorrow|week|month|year|ago|night|morning|afternoon|evening|day|summer|winter|spring|fall|autumn|now|${MONTH_RE}|`
  + "gestern|heute|morgen|woche|monat|jahr|tag|nacht|abend|mittwoch|sonnabend|sommer|herbst|frühling|fruehling|frühjahr|fruehjahr|neulich|letztens|unlängst|unlaengst|eben|vorhin",
  "iu",
);

// ─── Civil calendar helpers (UTC-midnight ms as a zone-free civil day) ────

const cdOf = (y, m, d) => Date.UTC(y, m, d);
const ymdOf = (cd) => new Date(cd).toISOString().slice(0, 10);
const weekdayOf = (cd) => new Date(cd).getUTCDay();
const mondayOf = (cd) => cd - ((weekdayOf(cd) + 6) % 7) * DAY;
const monthFirst = (y, m) => Date.UTC(y, m, 1);
const monthLast = (y, m) => Date.UTC(y, m + 1, 0);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const validYear = (y) => Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;
const validDay = (y, m, d) => validYear(y) && m >= 0 && m <= 11 && d >= 1 && d <= daysInMonth(y, m);
const addMonthsYM = (y, m, n) => { const t = new Date(Date.UTC(y, m + n, 1)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() }; };

/**
 * Parses "YYYY-MM-DD" into a civil day (UTC midnight ms), or null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function parseYmd(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  return validDay(y, mo, d) ? cdOf(y, mo, d) : null;
}

const formatters = new Map();
function zoneFormatter(timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

function zonedFields(ms, timeZone) {
  const out = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

function zoneOffsetMs(ms, timeZone) {
  const f = zonedFields(ms, timeZone);
  const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour === 24 ? 0 : f.hour, f.minute, f.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/**
 * Civil day of an instant in a time zone, as "YYYY-MM-DD".
 *
 * @param {number} ms epoch milliseconds
 * @param {string} [timeZone] IANA zone, default Europe/Berlin
 * @returns {string}
 */
export function civilDayInZone(ms, timeZone = DEFAULT_EVENT_TIME_ZONE) {
  const f = zonedFields(ms, timeZone);
  return ymdOf(cdOf(f.year, f.month - 1, f.day));
}

/**
 * Epoch ms of local midnight at the start of a civil day in a zone.
 *
 * @param {string} ymd "YYYY-MM-DD"
 * @param {string} [timeZone] IANA zone, default Europe/Berlin
 * @returns {number|null} null for an invalid date
 */
export function zonedDayStartMs(ymd, timeZone = DEFAULT_EVENT_TIME_ZONE) {
  const guess = parseYmd(ymd);
  if (guess == null) return null;
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

/**
 * Converts an inclusive civil-day interval to epoch ms, end exclusive
 * (left-inclusive/right-exclusive like the other time windows).
 *
 * @param {string} from "YYYY-MM-DD"
 * @param {string} until "YYYY-MM-DD", inclusive
 * @param {string} [timeZone]
 * @returns {{fromMs: number, untilMs: number}|null}
 */
export function dayRangeToMs(from, until, timeZone = DEFAULT_EVENT_TIME_ZONE) {
  const untilCd = parseYmd(until);
  const fromMs = zonedDayStartMs(from, timeZone);
  if (fromMs == null || untilCd == null) return null;
  const untilMs = zonedDayStartMs(ymdOf(untilCd + DAY), timeZone);
  if (untilMs == null || untilMs <= fromMs) return null;
  return { fromMs, untilMs };
}

// ─── Text preparation and context ─────────────────────────────────────────

// Leading "[YYYY-MM-DD HH:MM]" of bench rows and image captions are blanked
// with spaces of the same length, so match offsets stay valid for the input.
const LEADING_STAMP = /^\s*\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?[^\]\n]{0,40}\]/u;
const IMAGE_CAPTION = /\[shared an image:[^\]]*\]/giu;

function blankOut(text) {
  return text.replace(LEADING_STAMP, (m) => " ".repeat(m.length)).replace(IMAGE_CAPTION, (m) => " ".repeat(m.length));
}

/**
 * Removes a leading "[YYYY-MM-DD HH:MM]" stamp (bench row format), which is
 * the time of speaking and never an event date.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripLeadingTimestamp(text) {
  return String(text ?? "").replace(LEADING_STAMP, "").replace(/^\s+/u, "");
}

function countOf(word) {
  const w = String(word || "").toLowerCase().replace(/\s+/g, " ");
  if (/^\d+$/.test(w)) {
    const n = Number(w);
    return n > 0 && n <= 500 ? { min: n, max: n, approx: false } : null;
  }
  const exact = EN_NUM[w] ?? DE_NUM[w];
  if (exact) return { min: exact, max: exact, approx: false };
  const approx = EN_APPROX[w] ?? DE_APPROX[w];
  return approx ? { min: approx[0], max: approx[1], approx: true } : null;
}

function unitOf(word) {
  const w = String(word || "").toLowerCase();
  if (w.startsWith("day") || w.startsWith("tag")) return "day";
  if (w.startsWith("week") || w.startsWith("woche")) return "week";
  if (w.startsWith("month") || w.startsWith("monat")) return "month";
  if (w.startsWith("year") || w.startsWith("jahr")) return "year";
  return null;
}

function monthIndexOf(token) {
  const idx = MONTHS[String(token || "").toLowerCase()];
  return idx === undefined ? null : idx;
}

// "may"/"march" as a month only when capitalised.
function monthTokenOk(token) {
  const lower = String(token || "").toLowerCase();
  if (!CASE_SENSITIVE_MONTHS.has(lower)) return true;
  return token[0] === token[0].toUpperCase() && token[0] !== token[0].toLowerCase();
}

// "de" or "en" by the majority of function words, "unknown" on a tie.
function markerLanguage(text) {
  const de = (String(text).match(DE_MARKER) || []).length;
  const en = (String(text).match(EN_MARKER) || []).length;
  return de > en ? "de" : en > de ? "en" : "unknown";
}

function createContext(text, anchorCd) {
  let boundaries = null;
  // Clause around [start, end): boundaries inside the match are ignored.
  const clauseBounds = (start, end) => {
    if (!boundaries) boundaries = [...text.matchAll(CLAUSE_BOUNDARY)].map((m) => [m.index, m.index + m[0].length]);
    let from = 0;
    let to = text.length;
    for (const [bs, be] of boundaries) {
      if (be <= start) from = be;
      else if (bs >= end) { to = bs; break; }
    }
    return [from, to];
  };
  const clause = (start, end) => { const [from, to] = clauseBounds(start, end); return text.slice(from, to); };
  let textLanguage;
  const languageOf = (c) => {
    const lang = markerLanguage(c);
    if (lang !== "unknown") return lang;
    if (textLanguage === undefined) textLanguage = markerLanguage(text);
    return textLanguage;
  };
  const ctx = {
    text,
    d: anchorCd,
    y: anchorCd == null ? null : new Date(anchorCd).getUTCFullYear(),
    mo: anchorCd == null ? null : new Date(anchorCd).getUTCMonth(),
    dom: anchorCd == null ? null : new Date(anchorCd).getUTCDate(),
    wd: anchorCd == null ? null : weekdayOf(anchorCd),
    /** @returns {"future"|"past"|"unknown"} */
    tense(m) {
      const c = clause(m.index, m.index + m[0].length);
      if (FUTURE_CUE.test(c)) return "future";
      const pastCue = languageOf(c) === "de" ? DE_PAST_CUE : PAST_CUE;
      if (pastCue.test(c) || (DE_AUX.test(c) && DE_PARTICIPLE.test(c))) return "past";
      return "unknown";
    },
    clauseBefore(m) {
      const [from] = clauseBounds(m.index, m.index + m[0].length);
      return text.slice(from, m.index);
    },
  };
  return ctx;
}

// ─── Hit builders ─────────────────────────────────────────────────────────

function hit(fromCd, untilCd, precision, extra = {}) {
  if (fromCd == null || untilCd == null || untilCd < fromCd) return null;
  const fy = new Date(fromCd).getUTCFullYear();
  const uy = new Date(untilCd).getUTCFullYear();
  if (!validYear(fy) || !validYear(uy)) return null;
  return { fromCd, untilCd, precision, source: "relative", approximate: false, ...extra };
}
const dayHit = (cd, extra) => hit(cd, cd, "day", extra);
const weekHit = (cd, extra) => { const mon = mondayOf(cd); return hit(mon, mon + 6 * DAY, "week", extra); };
const monthHit = (y, m, extra) => { const t = addMonthsYM(y, m, 0); return hit(monthFirst(t.y, t.m), monthLast(t.y, t.m), "month", extra); };
const yearHit = (y, extra) => hit(cdOf(y, 0, 1), cdOf(y, 11, 31), "year", extra);
const rangeHit = (fromCd, untilCd, extra) => hit(fromCd, untilCd, "range", extra);

function sinceHit(fromCd, ctx, extra = {}) {
  if (ctx.d == null || fromCd == null || fromCd > ctx.d) return null;
  return rangeHit(fromCd, ctx.d, { kind: "ongoing", ...extra });
}

// Year of a month/day without a year: by tense, else the nearest occurrence.
function inferYear(monthIdx, day, ctx, m) {
  const tense = ctx.tense(m);
  const candidates = [ctx.y - 1, ctx.y, ctx.y + 1].filter((y) => day == null || validDay(y, monthIdx, day));
  const cdFor = (y) => (day == null ? monthFirst(y, monthIdx) : cdOf(y, monthIdx, day));
  const lastFor = (y) => (day == null ? monthLast(y, monthIdx) : cdOf(y, monthIdx, day));
  if (tense === "future") return candidates.find((y) => lastFor(y) >= ctx.d) ?? null;
  if (tense === "past") return [...candidates].reverse().find((y) => cdFor(y) <= ctx.d) ?? null;
  let best = null;
  let bestDist = Infinity;
  for (const y of candidates) {
    const from = cdFor(y);
    const until = lastFor(y);
    const dist = ctx.d < from ? from - ctx.d : ctx.d > until ? ctx.d - until : 0;
    if (dist < bestDist) { best = y; bestDist = dist; }
  }
  return best;
}

// Shifts a civil day by n units (n may be negative), clamping the day of month.
function shiftCd(cd, unit, n) {
  if (unit === "day") return cd + n * DAY;
  if (unit === "week") return cd + n * 7 * DAY;
  const t = new Date(cd);
  const y = t.getUTCFullYear() + (unit === "year" ? n : 0);
  const mm = t.getUTCMonth() + (unit === "month" ? n : 0);
  const target = addMonthsYM(y, mm, 0);
  return cdOf(target.y, target.m, Math.min(t.getUTCDate(), daysInMonth(target.y, target.m)));
}

// The period that lies n units from the anchor (negative = back).
function periodHit(ctx, unit, count, sign) {
  const d = ctx.d;
  if (!count.approx) {
    const n = count.min * sign;
    if (unit === "day") return dayHit(d + n * DAY);
    if (unit === "week") return weekHit(d + n * 7 * DAY);
    if (unit === "month") return monthHit(ctx.y, ctx.mo + n);
    return yearHit(ctx.y + n);
  }
  const near = count.min * sign;
  const far = count.max * sign;
  const [lo, hi] = sign < 0 ? [far, near] : [near, far];
  if (unit === "day") return rangeHit(d + lo * DAY, d + hi * DAY, { approximate: true });
  if (unit === "week") return rangeHit(d + lo * 7 * DAY, d + hi * 7 * DAY, { approximate: true });
  if (unit === "month") {
    const a = addMonthsYM(ctx.y, ctx.mo, lo);
    const b = addMonthsYM(ctx.y, ctx.mo, hi);
    return rangeHit(monthFirst(a.y, a.m), monthLast(b.y, b.m), { approximate: true });
  }
  return rangeHit(cdOf(ctx.y + lo, 0, 1), cdOf(ctx.y + hi, 11, 31), { approximate: true });
}

function seasonRange(season, startYear) {
  const start = SEASON_START_MONTH[season];
  return [monthFirst(startYear, start), monthLast(startYear, start + 2)];
}

function seasonHit(season, which, ctx) {
  const instances = [ctx.y - 2, ctx.y - 1, ctx.y, ctx.y + 1].map((sy) => seasonRange(season, sy));
  let chosen = null;
  if (which === "last") chosen = [...instances].reverse().find(([, end]) => end < ctx.d);
  else if (which === "next") chosen = instances.find(([start]) => start > ctx.d);
  else if (which === "this") {
    const sy = season === "winter" && ctx.mo <= 1 ? ctx.y - 1 : ctx.y;
    chosen = seasonRange(season, sy);
  }
  if (!chosen) return null;
  return rangeHit(chosen[0], chosen[1], { approximate: true });
}

function seasonByTense(season, ctx, m) {
  const current = [ctx.y - 1, ctx.y].map((sy) => seasonRange(season, sy)).find(([start, end]) => start <= ctx.d && ctx.d <= end);
  if (current) return rangeHit(current[0], current[1], { approximate: true });
  return seasonHit(season, ctx.tense(m) === "future" ? "next" : "last", ctx);
}

function weekendStarts(ctx) {
  const d = ctx.d;
  const wd = ctx.wd;
  const lastSat = wd >= 1 && wd <= 5 ? d - (wd + 1) * DAY : wd === 6 ? d - 7 * DAY : d - 8 * DAY;
  const upcomingSat = wd === 0 ? d - DAY : d + (6 - wd) * DAY;
  const recentSat = wd === 6 ? d : wd === 0 ? d - DAY : lastSat;
  return { lastSat, upcomingSat, recentSat };
}
const weekendHit = (sat, extra) => rangeHit(sat, sat + DAY, extra);

function nextWeekendHit(ctx) {
  const { upcomingSat } = weekendStarts(ctx);
  // Said Monday to Friday, "next weekend" means the coming one for some
  // speakers and the one after for others: cover both.
  if (ctx.wd >= 1 && ctx.wd <= 5) return rangeHit(upcomingSat, upcomingSat + 8 * DAY, { approximate: true, kind: "planned" });
  return weekendHit(upcomingSat + 7 * DAY, { kind: "planned" });
}

function weekdayBefore(ctx, target) { return ctx.d - ((((ctx.wd - target + 7) % 7) || 7) * DAY); }
function weekdayAfter(ctx, target) { return ctx.d + ((((target - ctx.wd + 7) % 7) || 7) * DAY); }
function weekdayThisWeek(ctx, target) { return mondayOf(ctx.d) + ((target + 6) % 7) * DAY; }

function lastKind(word) {
  const w = String(word || "").toLowerCase().replace(/\s+/g, " ");
  if (/^(last|this past|past|letzte[nmrs]?|vergangene[nmrs]?|vorige[nmrs]?)$/.test(w)) return "last";
  if (/^(next|coming|nächste[nmrs]?|naechste[nmrs]?|kommende[nmrs]?)$/.test(w)) return "next";
  if (/^(this|diese[nmrs]?)$/.test(w)) return "this";
  return null;
}

function relativeMonthHit(ctx, which, monthIdx) {
  let y = ctx.y;
  if (which === "last") y = monthIdx < ctx.mo ? ctx.y : ctx.y - 1;
  else if (which === "next") y = monthIdx > ctx.mo ? ctx.y : ctx.y + 1;
  return monthHit(y, monthIdx);
}

// Part of a month: "early/mid/late", "Anfang/Mitte/Ende", "beginning/end of".
function monthPartHit(y, monthIdx, part) {
  const p = String(part || "").toLowerCase();
  const last = daysInMonth(y, monthIdx);
  if (/^(early|anfang|beginning|start)$/.test(p)) return rangeHit(cdOf(y, monthIdx, 1), cdOf(y, monthIdx, 10), { approximate: true });
  if (/^(mid|mitte|middle)$/.test(p)) return rangeHit(cdOf(y, monthIdx, 11), cdOf(y, monthIdx, 20), { approximate: true });
  return rangeHit(cdOf(y, monthIdx, 21), cdOf(y, monthIdx, last), { approximate: true });
}

function yearPartHit(y, part) {
  const p = String(part || "").toLowerCase();
  if (/^(early|anfang|beginning|start)$/.test(p)) return rangeHit(cdOf(y, 0, 1), cdOf(y, 2, 31), { approximate: true });
  if (/^(mid|mitte|middle)$/.test(p)) return rangeHit(cdOf(y, 4, 1), cdOf(y, 7, 31), { approximate: true });
  return rangeHit(cdOf(y, 9, 1), cdOf(y, 11, 31), { approximate: true });
}

function ordinalOf(word) {
  const w = String(word || "").toLowerCase();
  if (/^(last|final|letzt)/u.test(w)) return "last";
  if (/^(first|erst)/u.test(w)) return 1;
  if (/^(second|zweit)/u.test(w)) return 2;
  if (/^(third|dritt)/u.test(w)) return 3;
  if (/^(fourth|viert)/u.test(w)) return 4;
  return null;
}

function weekOfMonthHit(y, monthIdx, ordinal, count, unit) {
  const last = daysInMonth(y, monthIdx);
  if (unit === "week") {
    let start;
    let end;
    if (ordinal === "last") { end = last; start = Math.max(1, last - 7 * count + 1); }
    else { start = 1 + 7 * (ordinal - 1); end = Math.min(last, start + 7 * count - 1); }
    if (start > last) return null;
    return hit(cdOf(y, monthIdx, start), cdOf(y, monthIdx, end), count === 1 ? "week" : "range");
  }
  const saturdays = [];
  for (let day = 1; day <= last; day++) if (weekdayOf(cdOf(y, monthIdx, day)) === 6) saturdays.push(cdOf(y, monthIdx, day));
  let first;
  let lastSat;
  if (ordinal === "last") { lastSat = saturdays[saturdays.length - 1]; first = saturdays[Math.max(0, saturdays.length - count)]; }
  else { first = saturdays[ordinal - 1]; lastSat = saturdays[Math.min(saturdays.length - 1, ordinal - 1 + count - 1)]; }
  if (first == null || lastSat == null) return null;
  return rangeHit(first, lastSat + DAY);
}

const isSince = (word) => /^(since|seit)$/i.test(String(word || "").trim());

// ─── Rules (most specific first; a match claims its span) ─────────────────

const rx = (source) => new RegExp(source, "giu");
const requireAnchor = (fn) => (m, ctx) => (ctx.d == null ? BLOCK : fn(m, ctx));

const RULES = [
  // Narrative-relative: relative to another event, not to the anchor.
  { re: rx(`${B}the\\s+(?:next|following|previous|prior|preceding)\\s+(?:day|morning|afternoon|evening|night|week|weekend|month|year|summer|winter|spring|fall|autumn|${EN_WD_RE})s?${E}`), fn: () => BLOCK },
  { re: rx(`${B}the\\s+(?:day|night|week|weekend|month|year)\\s+(?:before|after)${E}(?!\\s+(?:yesterday|tomorrow|last|next|this)${E})`), fn: () => BLOCK },
  { re: rx(`${B}${EN_NUM_RE}\\s+(?:days?|weeks?|months?|years?|hours?)\\s+(?:later|after(?:wards)?|before|earlier|prior|beforehand)${E}`), fn: () => BLOCK },
  { re: rx(`${B}(?:am|im|in\\s+der)\\s+(?:nächsten|naechsten|folgenden|darauffolgenden|vorherigen|vorigen)\\s+(?:tag|morgen|abend|nacht)${E}`), fn: () => BLOCK },
  { re: rx(`${B}(?:folgende[nmrs]?|darauffolgende[nmrs]?)\\s+(?:tag|morgen|abend|nacht|woche|wochenende|monat|jahr)${E}`), fn: () => BLOCK },
  { re: rx(`${B}tags?\\s+(?:darauf|danach|zuvor|davor)${E}`), fn: () => BLOCK },
  { re: rx(`${B}${DE_NUM_RE}\\s+${DE_UNIT_RE}\\s+(?:später|spaeter|danach|darauf|davor|zuvor|vorher|früher|frueher)${E}`), fn: () => BLOCK },
  // Durations up to now ("bis heute" is "so far", not a day).
  { re: rx(`${B}(?:bis\\s+heute|bis\\s+jetzt|bis\\s+dato|until\\s+today|to\\s+this\\s+day|so\\s+far|up\\s+to\\s+now|until\\s+now)${E}`), fn: () => BLOCK },
  // Recurring.
  { re: rx(`${B}(?:every|each)\\s+(?:other\\s+|single\\s+)?(?:day|morning|afternoon|evening|night|week|weekend|month|year|summer|winter|spring|fall|autumn|${EN_WD_RE})${E}`), fn: () => BLOCK },
  { re: rx(`${B}(?:on\\s+)?(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekends)${E}`), fn: () => BLOCK },
  { re: rx(`${B}(?:once|twice|three\\s+times|\\d+\\s+times)\\s+(?:a|per|every)\\s+(?:day|week|month|year)${E}`), fn: () => BLOCK },
  { re: rx(`${B}(?:jede[nmrs]?|alle)\\s+(?:zwei\\s+|drei\\s+|paar\\s+)?(?:tag|tage|morgen|abend|woche|wochen|wochenende|monat|monate|jahr|jahre|sommer|winter|frühling|herbst|${DE_WD_RE})${E}`), fn: () => BLOCK },
  { re: rx(`${B}(?:montags|dienstags|mittwochs|donnerstags|freitags|samstags|sonntags|wochenends|werktags)${E}`), fn: () => BLOCK },
  { re: rx(`${B}(?:einmal|zweimal|dreimal|\\d+\\s*mal)\\s+(?:am\\s+tag|pro\\s+(?:tag|woche|monat|jahr)|im\\s+(?:monat|jahr)|in\\s+der\\s+woche|die\\s+woche)${E}`), fn: () => BLOCK },
  { re: rx(`${B}immer\\s+(?:am|im)\\s+\\p{L}+${E}`), fn: () => BLOCK },

  // ISO date.
  {
    re: rx(`${B}(?:(since|seit|from|ab)\\s+)?(\\d{4})-(\\d{2})-(\\d{2})(?!\\d)`),
    fn: (m, ctx) => {
      const y = Number(m[2]); const mo = Number(m[3]) - 1; const d = Number(m[4]);
      if (!validDay(y, mo, d)) return BLOCK;
      return (isSince(m[1]) && sinceHit(cdOf(y, mo, d), ctx, { source: "explicit" })) || dayHit(cdOf(y, mo, d), { source: "explicit" });
    },
  },
  // German numeric date with a four-digit year: 3.10.2026. (Two-digit years
  // only after a preposition, below: "1.10.12" is more often a version.)
  {
    re: rx(`${B}(?:(seit|ab|bis|am|vom|zum|den|dem)\\s+)?(?<![\\d.])(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})(?![\\d.]?\\d)`),
    fn: (m, ctx) => {
      const d = Number(m[2]); const mo = Number(m[3]) - 1;
      const y = Number(m[4]);
      if (!validDay(y, mo, d)) return BLOCK;
      return (isSince(m[1]) && sinceHit(cdOf(y, mo, d), ctx, { source: "explicit" })) || dayHit(cdOf(y, mo, d), { source: "explicit" });
    },
  },
  // Day ranges within one month: "April 3rd to 9th", "November 5-6",
  // "3rd to 9th of April", "vom 3. bis 5. Oktober".
  {
    re: rx(`${B}(?:(?:from|between)\\s+)?(${EN_MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|until|and|through)\\s*(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => dayRangeRule(m, ctx, m[1], Number(m[2]), Number(m[3]), m[4]),
  },
  {
    re: rx(`${B}(?:(?:from|between)\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|until|and|through)\\s*(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${EN_MONTH_RE})(?:,?\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => dayRangeRule(m, ctx, m[3], Number(m[1]), Number(m[2]), m[4]),
  },
  {
    re: rx(`${B}(?:vom\\s+)?(\\d{1,2})\\.\\s*(?:-|–|bis(?:\\s+zum)?)\\s*(\\d{1,2})\\.\\s?(${DE_MONTH_RE})(?:\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => dayRangeRule(m, ctx, m[3], Number(m[1]), Number(m[2]), m[4]),
  },
  // "the week of April 3rd": the calendar week of that day.
  {
    re: rx(`${B}(?:the\\s+)?week\\s+of\\s+(?:the\\s+)?(${EN_MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => {
      const out = dayMonthRule(m, ctx, null, Number(m[2]), m[1], m[3]);
      return out && out !== BLOCK ? { ...weekHit(out.fromCd), source: "explicit", yearInferred: out.yearInferred } : out;
    },
  },
  // Week or weekend of a month: "first week of May", "letztes Wochenende im Oktober".
  {
    re: rx(`${B}(?:the\\s+)?(first|second|third|fourth|last|final)\\s+(?:(two|three|2|3)\\s+)?(weeks?|weekends?)\\s+(?:of|in)\\s+(${EN_MONTH_RE})(?:,?\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => weekOfMonthRule(m, ctx, m[1], m[2], m[3], m[4], m[5]),
  },
  {
    re: rx(`${B}(?:(?:in\\s+der|am|im)\\s+)?(erste[nmrs]?|zweite[nmrs]?|dritte[nmrs]?|vierte[nmrs]?|letzte[nmrs]?)\\s+(?:(zwei|drei)\\s+)?(wochenende|wochen|woche)\\s+(?:im|des|vom|von|in)\\s+(${DE_MONTH_RE})s?(?:\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => weekOfMonthRule(m, ctx, m[1], m[2], m[3], m[4], m[5]),
  },
  // Day + month (+ year), German: "am 3. Oktober (2026)".
  {
    re: rx(`${B}(?:(am|vom|zum|bis|seit|ab|den|dem)\\s+)?(\\d{1,2})\\.\\s?(${DE_MONTH_RE})(?:\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => dayMonthRule(m, ctx, m[1], Number(m[2]), m[3], m[4]),
  },
  // Day + month (+ year), English day first: "3rd of October", "3 October 2026".
  {
    re: rx(`${B}(?:(on|since|from|until|by)\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${EN_MONTH_RE})(?:,?\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => dayMonthRule(m, ctx, m[1], Number(m[2]), m[3], m[4]),
  },
  // English month first: "October 3rd", "October 3, 2026".
  {
    re: rx(`${B}(?:(on|since|from|until|by)\\s+)?(${EN_MONTH_RE})\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => dayMonthRule(m, ctx, m[1], Number(m[3]), m[2], m[4]),
  },
  // German numeric date after a preposition, year optional: "am 3.10.", "am 3.10.26".
  {
    re: rx(`${B}(am|vom|zum|bis|seit|ab|den|dem)\\s+(\\d{1,2})\\.(\\d{1,2})\\.(?:(\\d{2})(?![\\d.]?\\d))?(?![\\d])`),
    fn: (m, ctx) => {
      const d = Number(m[2]); const mo = Number(m[3]) - 1;
      if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
      if (m[4]) {
        const y2 = 2000 + Number(m[4]);
        if (!validDay(y2, mo, d)) return BLOCK;
        return (isSince(m[1]) && sinceHit(cdOf(y2, mo, d), ctx, { source: "explicit" })) || dayHit(cdOf(y2, mo, d), { source: "explicit" });
      }
      if (ctx.d == null) return BLOCK;
      const y = inferYear(mo, d, ctx, m);
      if (y == null || !validDay(y, mo, d)) return BLOCK;
      return (isSince(m[1]) && sinceHit(cdOf(y, mo, d), ctx, { source: "explicit", yearInferred: true })) || dayHit(cdOf(y, mo, d), { source: "explicit", yearInferred: true });
    },
  },
  // Part of a month.
  {
    re: rx(`${B}(anfang|mitte|ende)\\s+(${DE_MONTH_RE})(?:\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => monthPartRule(m, ctx, m[1], m[2], m[3]),
  },
  {
    re: rx(`${B}(early|mid|late)[-\\s]+(${EN_MONTH_RE})(?:,?\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => monthPartRule(m, ctx, m[1], m[2], m[3]),
  },
  {
    re: rx(`${B}(?:the\\s+)?(beginning|start|middle|end)\\s+of\\s+(${EN_MONTH_RE})(?:,?\\s+(\\d{4}))?${E}`),
    fn: (m, ctx) => monthPartRule(m, ctx, m[1], m[2], m[3]),
  },
  // Month + year: "in October 2025", "Oktober 2025".
  {
    re: rx(`${B}(?:(in|im|during|since|seit|from|ab|of|back\\s+in)\\s+)?(${MONTH_RE})\\s*,?\\s+(\\d{4})${E}`),
    fn: (m, ctx) => {
      const idx = monthIndexOf(m[2]);
      const y = Number(m[3]);
      if (idx == null || !validYear(y)) return null;
      return (isSince(m[1]) && sinceHit(monthFirst(y, idx), ctx, { source: "explicit" })) || monthHit(y, idx, { source: "explicit" });
    },
  },
  // Relative month name: "last October", "nächsten Mai".
  {
    re: rx(`${B}(last|this\\s+past|this|next|coming)\\s+(${EN_MONTH_RE})${E}`),
    fn: requireAnchor((m, ctx) => (monthTokenOk(m[2]) ? relativeMonthHit(ctx, lastKind(m[1]), monthIndexOf(m[2])) : null)),
  },
  {
    re: rx(`${B}(${DE_LAST}|${DE_THIS}|${DE_NEXT})\\s+(${DE_MONTH_RE})${E}`),
    fn: requireAnchor((m, ctx) => relativeMonthHit(ctx, lastKind(m[1]), monthIndexOf(m[2]))),
  },
  // Preposition + month: "in October", "im Oktober", "seit Mai".
  {
    re: rx(`${B}(in|im|during|since|seit|over)\\s+(${MONTH_RE})${E}`),
    fn: (m, ctx) => {
      if (!monthTokenOk(m[2])) return null;
      if (ctx.d == null) return BLOCK;
      const idx = monthIndexOf(m[2]);
      if (isSince(m[1])) {
        const y = idx <= ctx.mo ? ctx.y : ctx.y - 1;
        return sinceHit(monthFirst(y, idx), ctx, { source: "explicit", yearInferred: true });
      }
      const y = inferYear(idx, null, ctx, m);
      return y == null ? BLOCK : monthHit(y, idx, { source: "explicit", yearInferred: true });
    },
  },
  // Seasons.
  {
    re: rx(`${B}(${EN_SEASON_RE})\\s+(?:of\\s+)?(\\d{4})${E}`),
    fn: (m) => seasonYearRule(EN_SEASONS[m[1].toLowerCase()], Number(m[2])),
  },
  {
    re: rx(`${B}(?:in|during|over)\\s+the\\s+(${EN_SEASON_RE})\\s+of\\s+(\\d{4})${E}`),
    fn: (m) => seasonYearRule(EN_SEASONS[m[1].toLowerCase()], Number(m[2])),
  },
  {
    re: rx(`${B}(?:im\\s+)?(${DE_SEASON_RE})\\s+(\\d{4})${E}`),
    fn: (m) => seasonYearRule(DE_SEASONS[m[1].toLowerCase()], Number(m[2])),
  },
  {
    re: rx(`${B}(last|this\\s+past|past|this|next|coming)\\s+(${EN_SEASON_RE})${E}`),
    fn: requireAnchor((m, ctx) => seasonHit(EN_SEASONS[m[2].toLowerCase()], lastKind(m[1]), ctx)),
  },
  {
    re: rx(`${B}(?:im\\s+)?(${DE_LAST}|${DE_THIS}|${DE_NEXT})\\s+(${DE_SEASON_RE})${E}`),
    fn: requireAnchor((m, ctx) => seasonHit(DE_SEASONS[m[2].toLowerCase()], lastKind(m[1]), ctx)),
  },
  {
    re: rx(`${B}(?:in|during|over)\\s+the\\s+(${EN_SEASON_RE})${E}`),
    fn: requireAnchor((m, ctx) => seasonByTense(EN_SEASONS[m[1].toLowerCase()], ctx, m)),
  },
  {
    re: rx(`${B}(?:im|über\\s+den|ueber\\s+den)\\s+(${DE_SEASON_RE})${E}`),
    fn: requireAnchor((m, ctx) => seasonByTense(DE_SEASONS[m[1].toLowerCase()], ctx, m)),
  },
  // Year with a preposition: "in 2025", "seit 2020", "im Jahr 2024".
  {
    re: rx(`${B}(in|im|during|since|seit|back\\s+in|im\\s+jahre?|in\\s+the\\s+year|anno|from|ab)\\s+(\\d{4})${E}(?![.,:/-]\\d)`),
    fn: (m, ctx) => {
      const y = Number(m[2]);
      if (!validYear(y)) return null;
      return (isSince(m[1]) && sinceHit(cdOf(y, 0, 1), ctx, { source: "explicit" })) || yearHit(y, { source: "explicit" });
    },
  },
  // "heute vor einer Woche", "a week ago today": the exact day.
  {
    re: rx(`${B}heute\\s+vor\\s+${DE_NUM_RE}\\s+${DE_UNIT_RE}${E}`),
    fn: requireAnchor((m, ctx) => exactAgoRule(m[1], m[2], ctx)),
  },
  {
    re: rx(`${B}${EN_NUM_RE}\\s+${EN_UNIT_RE}\\s+ago\\s+today${E}`),
    fn: requireAnchor((m, ctx) => exactAgoRule(m[1], m[2], ctx)),
  },
  // Day words.
  { re: rx(`${B}(?:the\\s+)?day\\s+before\\s+yesterday${E}`), fn: requireAnchor((m, ctx) => dayHit(ctx.d - 2 * DAY, { kind: "past" })) },
  { re: rx(`${B}vorgestern(?:\\s+(?:früh|frueh|morgen|vormittag|mittag|nachmittag|abend|nacht))?${E}`), fn: requireAnchor((m, ctx) => dayHit(ctx.d - 2 * DAY, { kind: "past" })) },
  { re: rx(`${B}(?:the\\s+)?day\\s+after\\s+tomorrow${E}`), fn: requireAnchor((m, ctx) => dayHit(ctx.d + 2 * DAY, { kind: "planned" })) },
  { re: rx(`${B}(?:übermorgen|uebermorgen)${E}`), fn: requireAnchor((m, ctx) => dayHit(ctx.d + 2 * DAY, { kind: "planned" })) },
  { re: rx(`${B}(?:last\\s+night|letzte\\s+nacht)${E}`), fn: requireAnchor((m, ctx) => rangeHit(ctx.d - DAY, ctx.d, { kind: "past" })) },
  { re: rx(`${B}yesterday(?:\\s+(?:morning|afternoon|evening|night))?${E}`), fn: requireAnchor((m, ctx) => dayHit(ctx.d - DAY, { kind: "past" })) },
  { re: rx(`${B}gestern(?:\\s+(?:früh|frueh|morgen|vormittag|mittag|nachmittag|abend|nacht))?${E}`), fn: requireAnchor((m, ctx) => dayHit(ctx.d - DAY, { kind: "past" })) },
  {
    re: rx(`${B}(?:today|tonight|this\\s+(?:morning|afternoon|evening)|earlier\\s+today|just\\s+now|right\\s+now)${E}`),
    fn: requireAnchor((m, ctx) => dayHit(ctx.d, { source: "utterance" })),
  },
  {
    re: rx(`${B}(?:heute(?:\\s+(?:früh|frueh|morgen|vormittag|mittag|nachmittag|abend|nacht))?|gerade\\s+eben|eben\\s+gerade|vorhin|soeben)${E}`),
    fn: requireAnchor((m, ctx) => dayHit(ctx.d, { source: "utterance" })),
  },
  { re: rx(`${B}tomorrow(?:\\s+(?:morning|afternoon|evening|night))?${E}`), fn: requireAnchor((m, ctx) => dayHit(ctx.d + DAY, { kind: "planned" })) },
  {
    re: rx(`${B}morgen(?:\\s+(?:früh|frueh|vormittag|mittag|nachmittag|abend|nacht))?${E}`),
    fn: (m, ctx) => {
      if (isMorgenNoun(m, ctx.text)) return null;
      return ctx.d == null ? BLOCK : dayHit(ctx.d + DAY, { kind: "planned" });
    },
  },
  // "two weeks ago", "vor zwei Wochen".
  { re: rx(`${B}${EN_NUM_RE}\\s+${EN_UNIT_RE}\\s+ago${E}`), fn: requireAnchor((m, ctx) => agoRule(m[1], m[2], ctx, -1)) },
  { re: rx(`${B}vor\\s+${DE_NUM_RE}\\s+${DE_UNIT_RE}${E}`), fn: requireAnchor((m, ctx) => agoRule(m[1], m[2], ctx, -1)) },
  // "the other day", "neulich".
  {
    re: rx(`${B}(?:the\\s+other\\s+day|neulich|letztens|unlängst|unlaengst)${E}`),
    fn: requireAnchor((m, ctx) => rangeHit(ctx.d - 6 * DAY, ctx.d - DAY, { approximate: true, kind: "past" })),
  },
  // Durations up to now ("for the past two years", "seit drei Jahren").
  {
    re: rx(`${B}(?:over|in|during)\\s+the\\s+(?:past|last)\\s+${EN_NUM_RE}\\s+${EN_UNIT_RE}${E}`),
    fn: requireAnchor((m, ctx) => sinceCountRule(m[1], m[2], ctx)),
  },
  {
    re: rx(`${B}(?:over|in|during)\\s+the\\s+(?:past|last)\\s+(day|week|month|year)${E}`),
    fn: requireAnchor((m, ctx) => sinceCountRule("1", m[1], ctx)),
  },
  {
    re: rx(`${B}for\\s+(the\\s+(?:past|last)\\s+)?${EN_NUM_RE}\\s+${EN_UNIT_RE}(\\s+now)?${E}`),
    fn: (m, ctx) => {
      // "for two weeks" alone is the length of an event, not a date.
      const sinceLike = Boolean(m[1] || m[4]) || PERFECT_CUE.test(ctx.clauseBefore(m));
      if (!sinceLike || ctx.d == null) return BLOCK;
      return sinceCountRule(m[2], m[3], ctx);
    },
  },
  { re: rx(`${B}seit\\s+${DE_NUM_RE}\\s+${DE_UNIT_RE}${E}`), fn: requireAnchor((m, ctx) => sinceCountRule(m[1], m[2], ctx)) },
  {
    re: rx(`${B}(?:in\\s+den|während\\s+der|waehrend\\s+der)\\s+(?:letzten|vergangenen)\\s+${DE_NUM_RE}\\s+${DE_UNIT_RE}${E}`),
    fn: requireAnchor((m, ctx) => sinceCountRule(m[1], m[2], ctx)),
  },
  { re: rx(`${B}(?:für|fuer|within|innerhalb(?:\\s+von)?)\\s+${DE_NUM_RE}\\s+${DE_UNIT_RE}${E}`), fn: () => BLOCK },
  { re: rx(`${B}within\\s+${EN_NUM_RE}\\s+${EN_UNIT_RE}${E}`), fn: () => BLOCK },
  { re: rx(`${B}seit\\s+(?:jahren|monaten|wochen|tagen)${E}`), fn: () => BLOCK },
  // "in two weeks": a date only when it points ahead.
  {
    re: rx(`${B}in\\s+${EN_NUM_RE}\\s+${EN_UNIT_RE}${E}`),
    fn: (m, ctx) => (ctx.d == null || ctx.tense(m) !== "future" ? BLOCK : agoRule(m[1], m[2], ctx, 1, "planned")),
  },
  {
    re: rx(`${B}in\\s+${DE_NUM_RE}\\s+${DE_UNIT_RE}${E}`),
    fn: (m, ctx) => (ctx.d == null || ctx.tense(m) === "past" ? BLOCK : agoRule(m[1], m[2], ctx, 1, "planned")),
  },
  // Weeks.
  { re: rx(`${B}(?:this\\s+past|past)\\s+week${E}`), fn: requireAnchor((m, ctx) => rangeHit(ctx.d - 7 * DAY, ctx.d, { approximate: true, kind: "past" })) },
  { re: rx(`${B}(last|this|next|coming)\\s+week${E}`), fn: requireAnchor((m, ctx) => weekRule(lastKind(m[1]), ctx)) },
  { re: rx(`${B}(${DE_LAST}|${DE_THIS}|${DE_NEXT})\\s+woche${E}`), fn: requireAnchor((m, ctx) => weekRule(lastKind(m[1]), ctx)) },
  // Weekends.
  { re: rx(`${B}(?:last|this\\s+past|past)\\s+weekend${E}`), fn: requireAnchor((m, ctx) => weekendHit(/past/i.test(m[0]) ? weekendStarts(ctx).recentSat : weekendStarts(ctx).lastSat, { kind: "past" })) },
  { re: rx(`${B}(?:next)\\s+weekend${E}`), fn: requireAnchor((m, ctx) => nextWeekendHit(ctx)) },
  { re: rx(`${B}(?:coming)\\s+weekend${E}`), fn: requireAnchor((m, ctx) => weekendHit(weekendStarts(ctx).upcomingSat, { kind: "planned" })) },
  { re: rx(`${B}(?:had|spent)\\s+(?:a|the|my|this|our)\\s+(?:\\p{L}+\\s+){0,2}weekend${E}`), fn: requireAnchor((m, ctx) => weekendHit(weekendStarts(ctx).recentSat, { kind: "past" })) },
  { re: rx(`${B}(?:over|on|during)\\s+the\\s+weekend${E}`), fn: requireAnchor((m, ctx) => weekendByTense(ctx, m, null)) },
  { re: rx(`${B}this\\s+weekend${E}`), fn: requireAnchor((m, ctx) => weekendByTense(ctx, m, "upcoming")) },
  { re: rx(`${B}the\\s+weekend${E}`), fn: requireAnchor((m, ctx) => weekendByTense(ctx, m, null)) },
  { re: rx(`${B}(?:am\\s+)?${DE_LAST}\\s+wochenende${E}`), fn: requireAnchor((m, ctx) => weekendHit(weekendStarts(ctx).lastSat, { kind: "past" })) },
  { re: rx(`${B}(?:an\\s+|am\\s+)?${DE_THIS}\\s+wochenende${E}`), fn: requireAnchor((m, ctx) => weekendByTense(ctx, m, "upcoming")) },
  {
    re: rx(`${B}(?:am\\s+)?(${DE_NEXT})\\s+wochenende${E}`),
    fn: requireAnchor((m, ctx) => (/^kommend/i.test(m[1]) ? weekendHit(weekendStarts(ctx).upcomingSat, { kind: "planned" }) : nextWeekendHit(ctx))),
  },
  { re: rx(`${B}(?:am|übers|uebers|über\\s+das|ueber\\s+das)\\s+wochenende${E}`), fn: requireAnchor((m, ctx) => weekendByTense(ctx, m, null)) },
  // Weekdays.
  {
    re: rx(`${B}(last|this\\s+past|past|next|this|coming|on)\\s+(${EN_WD_RE})(?:\\s+(?:morning|afternoon|evening|night))?${E}`),
    fn: requireAnchor((m, ctx) => weekdayRule(m, ctx, m[1].toLowerCase() === "on" ? "tense" : lastKind(m[1]), EN_WEEKDAYS[m[2].toLowerCase()])),
  },
  {
    re: rx(`${B}(?:am\\s+)?(${DE_LAST}|${DE_THIS}|${DE_NEXT})\\s+(${DE_WD_RE})(?:abend|früh|frueh|morgen|nachmittag|vormittag|mittag|nacht)?${E}`),
    fn: requireAnchor((m, ctx) => weekdayRule(m, ctx, lastKind(m[1]), DE_WEEKDAYS[m[2].toLowerCase()])),
  },
  {
    re: rx(`${B}am\\s+(${DE_WD_RE})(?:abend|früh|frueh|morgen|nachmittag|vormittag|mittag|nacht)?${E}`),
    fn: requireAnchor((m, ctx) => weekdayRule(m, ctx, "tense", DE_WEEKDAYS[m[1].toLowerCase()])),
  },
  // Months relative to the anchor.
  {
    re: rx(`${B}(?:at\\s+)?the\\s+(beginning|start|middle|end)\\s+of\\s+(last|this|next)\\s+month${E}`),
    fn: requireAnchor((m, ctx) => monthOffsetPartRule(ctx, m[2], m[1])),
  },
  {
    re: rx(`${B}(anfang|mitte|ende)\\s+(?:des\\s+)?(?:(${DE_LAST}|${DE_THIS}|${DE_NEXT})\\s+)?monats${E}`),
    fn: requireAnchor((m, ctx) => monthOffsetPartRule(ctx, m[2] || "this", m[1])),
  },
  { re: rx(`${B}earlier\\s+this\\s+month${E}`), fn: requireAnchor((m, ctx) => rangeHit(monthFirst(ctx.y, ctx.mo), ctx.d, { kind: "past" })) },
  { re: rx(`${B}(?:the\\s+)?past\\s+month${E}`), fn: requireAnchor((m, ctx) => rangeHit(ctx.d - 30 * DAY, ctx.d, { approximate: true, kind: "past" })) },
  { re: rx(`${B}(last|this|next|coming)\\s+month${E}`), fn: requireAnchor((m, ctx) => monthOffsetRule(ctx, m[1])) },
  { re: rx(`${B}(?:im\\s+)?(${DE_LAST}|${DE_THIS}|${DE_NEXT})\\s+monats?${E}`), fn: requireAnchor((m, ctx) => monthOffsetRule(ctx, m[1])) },
  // Years relative to the anchor.
  {
    re: rx(`${B}(?:at\\s+)?the\\s+(beginning|start|middle|end)\\s+of\\s+(last|this|next)\\s+year${E}`),
    fn: requireAnchor((m, ctx) => yearPartHit(ctx.y + yearOffset(m[2]), m[1])),
  },
  {
    re: rx(`${B}(anfang|mitte|ende)\\s+(?:des\\s+)?(?:(${DE_LAST}|${DE_THIS}|${DE_NEXT})\\s+)?jahres${E}`),
    fn: requireAnchor((m, ctx) => yearPartHit(ctx.y + yearOffset(m[2] || "this"), m[1])),
  },
  { re: rx(`${B}earlier\\s+this\\s+year${E}`), fn: requireAnchor((m, ctx) => rangeHit(cdOf(ctx.y, 0, 1), ctx.d, { kind: "past" })) },
  { re: rx(`${B}(?:the\\s+)?past\\s+year${E}`), fn: requireAnchor((m, ctx) => rangeHit(shiftCd(ctx.d, "year", -1), ctx.d, { approximate: true, kind: "past" })) },
  { re: rx(`${B}(last|this|next|coming)\\s+year${E}`), fn: requireAnchor((m, ctx) => yearHit(ctx.y + yearOffset(m[1]))) },
  { re: rx(`${B}(?:im\\s+|in\\s+)?(${DE_LAST}|${DE_THIS}|${DE_NEXT})\\s+jahr(?:es|s)?${E}`), fn: requireAnchor((m, ctx) => yearHit(ctx.y + yearOffset(m[1]))) },
  { re: rx(`${B}im\\s+vorjahr${E}`), fn: requireAnchor((m, ctx) => yearHit(ctx.y - 1)) },
  // Day of the current/previous month: "on the 11th", "am 11.".
  { re: rx(`${B}on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)${E}`), fn: requireAnchor((m, ctx) => dayOfMonthRule(m, ctx, Number(m[1]))) },
  {
    re: rx(`${B}am\\s+(\\d{1,2})\\.(?!\\d)(?!\\s*\\d)`),
    fn: (m, ctx) => {
      // "am 3. Tag": a capitalised word after it is a noun, not a date.
      const next = /^\s+(\S)/u.exec(ctx.text.slice(m.index + m[0].length))?.[1];
      if (next && next !== next.toLowerCase()) return null;
      return ctx.d == null ? BLOCK : dayOfMonthRule(m, ctx, Number(m[1]));
    },
  },
];

function weekOfMonthRule(m, ctx, ordWord, countWord, unitWord, monthWord, yearWord) {
  if (!monthTokenOk(monthWord) && !yearWord) return null;
  const idx = monthIndexOf(monthWord);
  const ordinal = ordinalOf(ordWord);
  if (idx == null || ordinal == null) return null;
  const count = countWord ? (Number(countWord) || { two: 2, three: 3, zwei: 2, drei: 3 }[countWord.toLowerCase()] || 1) : 1;
  const unit = /end/i.test(unitWord) ? "weekend" : "week";
  let y = yearWord ? Number(yearWord) : null;
  if (y == null) {
    if (ctx.d == null) return BLOCK;
    y = inferYear(idx, null, ctx, m);
  }
  if (!validYear(y)) return BLOCK;
  const out = weekOfMonthHit(y, idx, ordinal, count, unit);
  return out ? { ...out, source: "explicit", yearInferred: !yearWord } : BLOCK;
}

function dayMonthRule(m, ctx, prep, day, monthWord, yearWord) {
  const idx = monthIndexOf(monthWord);
  if (idx == null || day < 1 || day > 31) return null;
  if (!yearWord && !monthTokenOk(monthWord) && !prep) return null;
  let y = yearWord ? Number(yearWord) : null;
  const yearInferred = y == null;
  if (y == null) {
    if (ctx.d == null) return BLOCK;
    y = inferYear(idx, day, ctx, m);
  }
  if (y == null || !validDay(y, idx, day)) return BLOCK;
  const cd = cdOf(y, idx, day);
  return (isSince(prep) && sinceHit(cd, ctx, { source: "explicit", yearInferred })) || dayHit(cd, { source: "explicit", yearInferred });
}

function dayRangeRule(m, ctx, monthWord, firstDay, lastDay, yearWord) {
  const idx = monthIndexOf(monthWord);
  if (idx == null || firstDay < 1 || lastDay > 31 || lastDay <= firstDay) return null;
  if (!yearWord && !monthTokenOk(monthWord)) return null;
  let y = yearWord ? Number(yearWord) : null;
  if (y == null) {
    if (ctx.d == null) return BLOCK;
    y = inferYear(idx, firstDay, ctx, m);
  }
  if (y == null || !validDay(y, idx, firstDay) || !validDay(y, idx, lastDay)) return BLOCK;
  return rangeHit(cdOf(y, idx, firstDay), cdOf(y, idx, lastDay), { source: "explicit", yearInferred: !yearWord });
}

function monthPartRule(m, ctx, part, monthWord, yearWord) {
  if (!yearWord && !monthTokenOk(monthWord)) return null;
  const idx = monthIndexOf(monthWord);
  if (idx == null) return null;
  let y = yearWord ? Number(yearWord) : null;
  if (y == null) {
    if (ctx.d == null) return BLOCK;
    y = inferYear(idx, null, ctx, m);
  }
  if (!validYear(y)) return BLOCK;
  const out = monthPartHit(y, idx, part);
  return out ? { ...out, source: "explicit", yearInferred: !yearWord } : BLOCK;
}

function seasonYearRule(season, year) {
  if (!season || !validYear(year)) return null;
  // "winter 2026" = December 2025 to February 2026.
  const startYear = season === "winter" ? year - 1 : year;
  const [from, until] = seasonRange(season, startYear);
  return rangeHit(from, until, { source: "explicit", approximate: true });
}

function exactAgoRule(countWord, unitWord, ctx) {
  const count = countOf(countWord);
  const unit = unitOf(unitWord);
  if (!count || count.approx || !unit) return BLOCK;
  return dayHit(shiftCd(ctx.d, unit, -count.min), { kind: "past" });
}

function agoRule(countWord, unitWord, ctx, sign, kind = sign < 0 ? "past" : "planned") {
  const count = countOf(countWord);
  const unit = unitOf(unitWord);
  if (!count || !unit) return BLOCK;
  const out = periodHit(ctx, unit, count, sign);
  return out ? { ...out, kind } : BLOCK;
}

function sinceCountRule(countWord, unitWord, ctx) {
  const count = countOf(countWord);
  const unit = unitOf(unitWord);
  if (!count || !unit) return BLOCK;
  return sinceHit(shiftCd(ctx.d, unit, -count.max), ctx, { approximate: true }) || BLOCK;
}

function weekRule(which, ctx) {
  const mon = mondayOf(ctx.d);
  if (which === "last") return weekHit(mon - 7 * DAY, { kind: "past" });
  if (which === "next") return weekHit(mon + 7 * DAY, { kind: "planned" });
  if (which === "this") return weekHit(mon);
  return BLOCK;
}

function weekendByTense(ctx, m, fallback) {
  const starts = weekendStarts(ctx);
  const tense = ctx.tense(m);
  if (tense === "past") return weekendHit(starts.recentSat, { kind: "past" });
  if (tense === "future" || fallback === "upcoming") return weekendHit(starts.upcomingSat);
  return BLOCK;
}

function weekdayRule(m, ctx, which, target) {
  if (target === undefined) return BLOCK;
  let mode = which;
  if (mode === "tense") {
    const tense = ctx.tense(m);
    if (tense === "unknown") return BLOCK;
    mode = tense === "past" ? "last" : "next";
  }
  if (mode === "last") return dayHit(weekdayBefore(ctx, target), { kind: "past" });
  if (mode === "next") return dayHit(weekdayAfter(ctx, target), { kind: "planned" });
  if (mode === "this") return dayHit(weekdayThisWeek(ctx, target));
  return BLOCK;
}

function monthOffset(word) {
  const which = lastKind(word);
  return which === "last" ? -1 : which === "next" ? 1 : 0;
}

function monthOffsetRule(ctx, word) {
  const off = monthOffset(word);
  const out = monthHit(ctx.y, ctx.mo + off);
  return out ? { ...out, kind: off < 0 ? "past" : off > 0 ? "planned" : undefined } : BLOCK;
}

function monthOffsetPartRule(ctx, word, part) {
  const t = addMonthsYM(ctx.y, ctx.mo, monthOffset(word));
  return monthPartHit(t.y, t.m, part) || BLOCK;
}

function yearOffset(word) {
  const which = lastKind(word);
  return which === "last" ? -1 : which === "next" ? 1 : 0;
}

function dayOfMonthRule(m, ctx, day) {
  if (day < 1 || day > 31) return BLOCK;
  const tense = ctx.tense(m);
  let t;
  if (tense === "future") t = day >= ctx.dom ? addMonthsYM(ctx.y, ctx.mo, 0) : addMonthsYM(ctx.y, ctx.mo, 1);
  else t = day <= ctx.dom ? addMonthsYM(ctx.y, ctx.mo, 0) : addMonthsYM(ctx.y, ctx.mo, -1);
  if (!validDay(t.y, t.m, day)) return BLOCK;
  return dayHit(cdOf(t.y, t.m, day), { approximate: true });
}

const MORGEN_NOUN_BEFORE = new Set(["heute", "guten", "gute", "am", "jeden", "jede", "den", "einen", "schönen", "schoenen", "frühen", "fruehen", "diesen", "diesem", "eines", "dem", "der", "des", "vom", "neuen", "nächsten", "naechsten", "folgenden"]);

// "Morgen" is also a noun ("guten Morgen", "am Morgen"); only the adverb is a day.
function isMorgenNoun(m, text) {
  const before = text.slice(0, m.index);
  const prevWord = (/([\p{L}]+)\s*$/u.exec(before)?.[1] || "").toLowerCase();
  if (MORGEN_NOUN_BEFORE.has(prevWord)) return true;
  const capitalised = m[0][0] === "M";
  if (!capitalised) return false;
  // Capitalised mid-sentence: the noun. At the start of a sentence: the adverb.
  const prevChar = /(\S)\s*$/u.exec(before)?.[1];
  return Boolean(prevChar) && !/[.!?:"„“«»\n]/u.test(prevChar);
}

/**
 * All event-date phrases in a text, resolved against the anchor.
 *
 * @param {string} text memory text (a leading "[YYYY-MM-DD HH:MM]" stamp and
 *   "[shared an image: …]" captions are ignored)
 * @param {number|null|undefined} anchorMs when the text was said (epoch ms);
 *   null resolves only explicit dates that carry a year
 * @param {{timeZone?: string}} [opts] zone of the civil days (default Europe/Berlin)
 * @returns {Array<{phrase: string, index: number, end: number, from: string, until: string,
 *   fromMs: number, untilMs: number, precision: "day"|"week"|"month"|"year"|"range",
 *   kind: "past"|"planned"|"ongoing"|null, source: "explicit"|"relative"|"utterance",
 *   approximate: boolean, yearInferred: boolean}>} sorted by position; `until` is
 *   inclusive, `untilMs` exclusive
 */
export function resolveEventDates(text, anchorMs, { timeZone = DEFAULT_EVENT_TIME_ZONE } = {}) {
  const raw = String(text ?? "");
  if (!raw.trim() || !PREFILTER.test(raw)) return [];
  const anchorCd = Number.isFinite(anchorMs) ? parseYmd(civilDayInZone(anchorMs, timeZone)) : null;
  const body = blankOut(raw);
  const ctx = createContext(body, anchorCd);
  const claimed = [];
  const overlaps = (s, e) => claimed.some(([cs, ce]) => s < ce && cs < e);
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of body.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const out = rule.fn(m, ctx);
      if (out == null) continue;
      claimed.push([start, end]);
      if (out === BLOCK) continue;
      hits.push({ ...out, index: start, end, phrase: raw.slice(start, end).trim() });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  const result = [];
  for (const h of hits) {
    const from = ymdOf(h.fromCd);
    const until = ymdOf(h.untilCd);
    const ms = dayRangeToMs(from, until, timeZone);
    if (!ms) continue;
    let kind = h.kind ?? null;
    if (kind == null && anchorCd != null && h.source !== "utterance") {
      if (h.untilCd < anchorCd) kind = "past";
      else if (h.fromCd > anchorCd) kind = "planned";
    }
    result.push({
      phrase: h.phrase,
      index: h.index,
      end: h.end,
      from,
      until,
      fromMs: ms.fromMs,
      untilMs: ms.untilMs,
      precision: h.precision,
      kind,
      source: h.source,
      approximate: Boolean(h.approximate),
      yearInferred: Boolean(h.yearInferred),
    });
  }
  return result;
}

/**
 * The first event-date phrase of a text, or null when it has none.
 *
 * @param {string} text
 * @param {number|null|undefined} anchorMs
 * @param {{timeZone?: string}} [opts]
 * @returns {ReturnType<typeof resolveEventDates>[number]|null}
 */
export function resolveEventDate(text, anchorMs, opts = {}) {
  return resolveEventDates(text, anchorMs, opts)[0] ?? null;
}
