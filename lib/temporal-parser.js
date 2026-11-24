/**
 * lib/temporal-parser.js — Extrahiert Zeit-Anchor aus natürlichsprachigen Queries.
 *
 * Unterstützt deutsche und englische Zeit-Ausdrücke.
 * Rückgabe:
 *   { type: "range", from: number, to: number, kind: string }
 *   { type: "anchor", referenceQuery: string }
 *   null
 *
 * 7.20.8: `classifyTemporalQuery` entscheidet, ob eine erkannte Zeitangabe
 * den Recall hart nach `createdAt` filtern darf. `createdAt` ist die
 * Gesprächszeit (wann etwas gesagt wurde), deshalb filtert nur eine Frage
 * nach der Gesprächszeit („was haben wir gestern besprochen“). Ereigniszeit,
 * beiläufige und kalendarische Angaben und Anker filtern nicht.
 */

const DAY_MS = 86400_000;
const HOUR_MS = 3600_000;

const DE_MONTHS = {
  januar: 0, februar: 1, märz: 2, maerz: 2, april: 3, mai: 4, juni: 5,
  juli: 6, august: 7, september: 8, oktober: 9, november: 10, dezember: 11,
};

const EN_MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const WEEKDAYS = {
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
  montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonntag: 0,
};

function startOfUTCDay(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function previousWeekdayUTC(ts, targetDay) {
  const d = new Date(ts);
  const currentDay = d.getUTCDay(); // 0=Sun ... 6=Sat
  let diff = currentDay - targetDay;
  if (diff <= 0) diff += 7;
  const result = new Date(ts);
  result.setUTCDate(result.getUTCDate() - diff);
  result.setUTCHours(0, 0, 0, 0);
  return result.getTime();
}

function monthIndex(name) {
  return DE_MONTHS[name] ?? EN_MONTHS[name];
}

// 7.12.41: „bis heute" / „bis jetzt" / „bis dato" / „until today" / „so far"
// sind Dauer-Angaben („bislang"), keine Tagesfenster. Bernd bekam am
// 10.09.2026 21:42 für „ich habe bis heute keine Antwort erhalten" ein
// Fenster „heute" und damit 39 → 0 Treffer. Erinnerungs-Fristen wie „bis
// heute Abend" bleiben erhalten (Tageszeit oder Uhrzeit dahinter).
// 7.20.8: dazu „seit heute/gestern/letzter Woche/letztem Monat" und „since
// today/yesterday/last week/last month" — ein Zeitraum bis jetzt, kein
// Fenster. Ohne Rücksicht auf Groß-/Kleinschreibung.
const DURATION_PHRASES = /\b(?:bis\s+(?:heute|jetzt|dato)|until\s+(?:today|now)|up\s+to\s+(?:today|now)|so\s+far|to\s+date)\b(?!\s+(?:abend|mittag|nachmittag|vormittag|früh|frueh|morgen|nacht|um\b|\d|evening|noon|afternoon|morning|night|at\b))|\b(?:seit\s+(?:heute|gestern|letzte[rnm]?\s+(?:woche|monat))|since\s+(?:today|yesterday|last\s+(?:week|month)))\b/gi;

/**
 * Entfernt Dauer-Angaben („bis heute“, „seit gestern“, „so far“), die kein
 * Zeitfenster meinen.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDurationPhrases(text) {
  return String(text || "").replace(DURATION_PHRASES, " ");
}

// ─── 7.20.8: Rauschen vor dem Parsen entfernen ─────────────────────────────
// Der Auto-Recall bekommt den rohen Prompt. Medienzeilen, Pfade, UUIDs und
// Zeilennummern speisten den Jahres-Zweig („2990“ aus einer UUID → Jahr 2990,
// „openclaw.json:2253“). Entfernt wird nur der Klammerausdruck selbst, nicht
// der Rest der Zeile: Bei Sprachnachrichten steht der Text in derselben Zeile
// wie „[Audio transcript …]“.
const NOISE_ENVELOPE = /\[(?:media attached|audio transcript|image|user sent media|voice message)[^\]\n]{0,1000}\]/gi;
const NOISE_CODE_BLOCK = /```[\s\S]*?```/g;
const NOISE_INLINE_CODE = /`[^`\n]*`/g;
const NOISE_URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const NOISE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Pfad-Muster beginnen nur am Wortanfang (Textanfang, Leerraum, öffnende
// Klammer/Anführung). Sonst probiert die Engine jede Position eines langen
// Tokens (Base64, Hashketten) und braucht quadratisch lange.
const TOKEN_START = "(?<![^\\s\"'(\\[<{=,;])";
// datei.ext:Zeile[:Spalte], optional mit Pfad davor („lib/x.js:1885“).
const NOISE_FILE_LINE = new RegExp(`${TOKEN_START}(?:[\\w.~-]*\\/)*[\\w-]+\\.[a-z][a-z0-9]{0,5}:\\d+(?::\\d+)?\\b`, "gi");
// Pfade: mit führendem „/“, „~/“, „./“, „../“, mit mindestens zwei „/“ oder
// mit Dateiendung. Ersetzt wird nur, wenn ein Segment einen Buchstaben hat —
// „24/10/2026“ bleibt, „und/oder“ und „heute/gestern“ auch.
const NOISE_PATH = new RegExp(
  `(?<![\\p{L}\\p{N}_.~-])(?:~|\\.{1,2})?\\/[\\w.-]+(?:\\/[\\w.-]*)*`
    + `|${TOKEN_START}(?:[\\w.-]+(?:\\/[\\w.-]+){2,}\\/?|(?:[\\w.-]+\\/)+[\\w-]+\\.[a-z][a-z0-9]{0,5}\\b)`,
  "giu",
);
// Hex-Folgen ab 8 Zeichen (Hashes, IDs), nur mit mindestens einer Ziffer.
const NOISE_HEX = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;

/**
 * Entfernt Text, der keine Zeitangabe sein kann: Umschlag-Kennzeichen
 * ([media attached: …], [Audio transcript …], [Image …], [user sent media …],
 * [voice message …]), Code-Blöcke, Inline-Code, URLs, UUIDs, datei.ext:Zeile,
 * Dateipfade mit Buchstaben-Segmenten und Hex-Folgen ab 8 Zeichen. Dauer-
 * Angaben entfernt erst `stripDurationPhrases`.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTemporalNoise(text) {
  return String(text || "")
    .replace(NOISE_CODE_BLOCK, " ")
    .replace(NOISE_INLINE_CODE, " ")
    .replace(NOISE_ENVELOPE, " ")
    .replace(NOISE_URL, " ")
    .replace(NOISE_UUID, " ")
    .replace(NOISE_FILE_LINE, " ")
    .replace(NOISE_PATH, (match) => (/[a-z]/i.test(match) ? " " : match))
    .replace(NOISE_HEX, " ");
}

// ─── Jahreszahlen ──────────────────────────────────────────────────────────
// 7.20.8: Eine vierstellige Zahl ist nur dann ein Jahr, wenn sie als Jahr
// erkennbar ist: mit Präposition („in 2025“, „im Jahr 2025“, „seit 2020“)
// oder alleinstehend als Satzglied („Was war 2025?“, „2025 war gut“). Nicht
// in Namen („Cyberpunk 2077“), nicht neben -./: oder Buchstaben/Ziffern
// (Datumsangaben, UUID-Teile, Zeilennummern, Dateinamen). Im Zweifel null.
const YEAR_DIGITS = "(?:19[7-9]\\d|2\\d{3})";
const NOT_WORD_BEFORE = "(?<![\\p{L}\\p{N}_])";
const YEAR_TAIL = "(?![\\p{L}\\p{N}_])(?![-./:][\\p{L}\\p{N}])";
// Eine Einheit dahinter macht die Zahl zur Menge: „in 2000 Metern“, „bis 2000 Euro“.
const YEAR_NOT_QUANTITY = "(?!\\s*(?:%|€|\\$|(?:m|cm|mm|km|meter|metern|meters?|metres?|kilometern?|kg|g|gramm|tonnen|l|ml|liter|litern|mb|gb|kb|tb|bytes?|ms|sekunden|minuten|stunden|tagen?|wochen|monaten?|jahren?|seconds|minutes|hours|days|weeks|months|years|euros?|eur|dollars?|usd|chf|franken|pfund|stück|stueck|leute|leuten|personen|menschen|einwohnern?|people|nutzern?|users|zeichen|characters|chars|wörtern?|woertern?|worten?|words|seiten|pages|zeilen|lines|tokens?|punkten?|points|teilen?|items|schritten?|steps|kalorien|calories|kcal|watt|kw|kwh|volt|ps|hp|mal|times)(?![\\p{L}])))";
const YEAR_WITH_PREPOSITION = new RegExp(
  `${NOT_WORD_BEFORE}(?:im\\s+jahre?|in\\s+the\\s+year|im|in|jahr|year|seit|since|bis|until)\\s+(${YEAR_DIGITS})${YEAR_TAIL}${YEAR_NOT_QUANTITY}`,
  "giu",
);
const YEAR_TOKEN = new RegExp(`(?<![\\p{L}\\p{N}_\\-./:])(${YEAR_DIGITS})${YEAR_TAIL}`, "gu");

function wordBefore(text) {
  const m = /([\p{L}\p{N}_]+)[^\p{L}\p{N}_\n]*$/u.exec(text);
  return m ? m[1] : null;
}

function wordAfter(text) {
  const m = /^[^\p{L}\p{N}_\n]*([\p{L}\p{N}_]+)/u.exec(text);
  return m ? m[1] : null;
}

// Wörter, die neben einem alleinstehenden Jahr stehen können. Früher reichte
// irgendein kleingeschriebenes Wort, dann waren auch „cyberpunk 2077.“,
// „zeile 2253.“ und „kostet 2000.“ Jahre.
const YEAR_WORDS_BEFORE = new Set([
  "war", "ist", "wurde", "wird", "waren", "sind", "von", "ab", "vor", "nach", "um", "circa", "ca", "etwa",
  "ungefähr", "ungefaehr", "anfang", "mitte", "ende", "anno", "jahr", "jahre",
  "was", "is", "were", "are", "from", "before", "after", "around", "about", "by", "of", "year",
]);
const YEAR_WORDS_AFTER = new Set([
  "war", "ist", "wurde", "wird", "hat", "hatte", "kam", "kommt", "begann", "beginnt", "endete", "endet", "brachte", "bringt",
  "was", "is", "will", "has", "had", "came", "comes", "began", "begins", "ended", "ends", "brought", "brings",
]);

function isStandaloneYear(text, index, length) {
  // Nur die Umgebung prüfen: bei vielen Zahlen in langen Texten sonst quadratisch.
  const beforeStart = Math.max(0, index - 80);
  const afterEnd = Math.min(text.length, index + length + 80);
  const before = text.slice(beforeStart, index);
  const after = text.slice(index + length, afterEnd);
  const atClauseStart = /[.;!?\n(]\s*$/.test(before) || (beforeStart === 0 && /^\s*$/.test(before));
  const atClauseEnd = /^\s*[.;!?,)\n]/.test(after) || (afterEnd === text.length && /^\s*$/.test(after));
  const isYearWord = (word, words) => Boolean(word) && words.has(word.toLowerCase());
  if (atClauseStart) return atClauseEnd || isYearWord(wordAfter(after), YEAR_WORDS_AFTER);
  return atClauseEnd && isYearWord(wordBefore(before), YEAR_WORDS_BEFORE);
}

function findYear(text) {
  const withPreposition = text.matchAll(YEAR_WITH_PREPOSITION).next().value;
  if (withPreposition) return parseInt(withPreposition[1], 10);
  for (const m of text.matchAll(YEAR_TOKEN)) {
    if (isStandaloneYear(text, m.index, m[0].length)) return parseInt(m[1], 10);
  }
  return null;
}

// ─── Monats-Teilstücke ─────────────────────────────────────────────────────
// 7.20.8: „last week of October 2026“ ergab bisher „letzte Woche“ (die sieben
// Tage vor der Anfrage). Erste/letzte Woche bzw. erstes/letztes Wochenende
// eines Monats ergeben den Kalendermonat.
const MONTH_NAMES = Object.keys({ ...DE_MONTHS, ...EN_MONTHS })
  .sort((a, b) => b.length - a.length)
  .join("|");
const WEEK_OF_MONTH_EN = new RegExp(
  `${NOT_WORD_BEFORE}(?:the\\s+)?(?:first|second|third|fourth|last|final)\\s+(?:(?:two|three|2|3)\\s+)?(?:week|weekend)s?\\s+of\\s+(${MONTH_NAMES})(?:,?\\s+(${YEAR_DIGITS})${YEAR_TAIL})?(?![\\p{L}])`,
  "u",
);
const WEEK_OF_MONTH_DE = new RegExp(
  `${NOT_WORD_BEFORE}(?:erste[nrs]?|zweite[nrs]?|dritte[nrs]?|vierte[nrs]?|letzte[nrs]?)\\s+(?:woche|wochenende)\\s+(?:im|des|vom|von|in)\\s+(${MONTH_NAMES})s?(?:\\s+(${YEAR_DIGITS})${YEAR_TAIL})?(?![\\p{L}])`,
  "u",
);
const MONTH_YEAR = new RegExp(`${NOT_WORD_BEFORE}(?:im|in)\\s+(\\p{L}+)\\s+(\\d{4})${YEAR_TAIL}`, "gu");
const MONTH_ONLY = new RegExp(`${NOT_WORD_BEFORE}(?:im|in)\\s+(\\p{L}+)`, "gu");
const WEEKDAY = /\b(?:am|on)\s+([a-z]+)\b/g;

// Fenster der relativen Arten; parseRange und classifyTemporalQuery teilen sie.
function rangeToday(now) {
  return { from: startOfUTCDay(now), to: now };
}

function rangeYesterday(now) {
  const todayStart = startOfUTCDay(now);
  return { from: todayStart - DAY_MS, to: todayStart };
}

// Der EINZELNE Tag (00:00 UTC bis 00:00 UTC+1).
function rangeDaysAgo(n, now) {
  if (!(n > 0 && n < 10000)) return null;
  const target = new Date(now);
  target.setUTCDate(target.getUTCDate() - n);
  target.setUTCHours(0, 0, 0, 0);
  const from = target.getTime();
  return { from, to: from + DAY_MS };
}

function rangeHoursAgo(n, now) {
  if (!(n > 0 && n < 10000)) return null;
  return { from: now - n * HOUR_MS, to: now };
}

function rangeLastWeek(now) {
  return { from: now - 7 * DAY_MS, to: now };
}

function rangeLastMonth(now) {
  return { from: now - 30 * DAY_MS, to: now };
}

function rangeWeekday(targetDay, now) {
  const from = previousWeekdayUTC(now, targetDay);
  return { from, to: from + DAY_MS };
}

function monthRange(monthIdx, year, now, kind) {
  if (year != null) {
    return { type: "range", from: Date.UTC(year, monthIdx, 1), to: Date.UTC(year, monthIdx + 1, 1), kind };
  }
  const currentYear = new Date(now).getUTCFullYear();
  const from = Date.UTC(currentYear, monthIdx, 1);
  const to = Math.min(Date.UTC(currentYear, monthIdx + 1, 1), now);
  return { type: "range", from, to, kind };
}

/**
 * Zeitfenster aus bereinigtem Text (ohne Anker-Zweig).
 *
 * @param {string} text bereits durch stripTemporalNoise/stripDurationPhrases
 * @param {number} now
 * @returns {{type:"range",from:number,to:number,kind:string}|null}
 */
function parseRange(text, now) {
  const lower = text.toLowerCase();

  // ─── Heute / Today ───────────────────────────────────────────────────────
  if (/\b(heute|today)\b/.test(lower)) {
    return { type: "range", ...rangeToday(now), kind: "today" };
  }

  // ─── Gestern / Yesterday ─────────────────────────────────────────────────
  if (/\b(gestern|yesterday)\b/.test(lower)) {
    return { type: "range", ...rangeYesterday(now), kind: "yesterday" };
  }

  // ─── Relativ: "vor N Tagen" / "N days ago" ───────────────────────────────
  const daysAgoMatch =
    lower.match(/\b(vor\s+(\d+)\s+tagen)\b/) ||
    lower.match(/\b((\d+)\s+days?\s+ago)\b/);
  if (daysAgoMatch) {
    const range = rangeDaysAgo(parseInt(daysAgoMatch[2], 10), now);
    if (range) return { type: "range", ...range, kind: "daysAgo" };
  }

  // ─── Relativ: "vor N Stunden" / "N hours ago" ────────────────────────────
  const hoursAgoMatch =
    lower.match(/\b(vor\s+(\d+)\s+stunden)\b/) ||
    lower.match(/\b((\d+)\s+hours?\s+ago)\b/);
  if (hoursAgoMatch) {
    const range = rangeHoursAgo(parseInt(hoursAgoMatch[2], 10), now);
    if (range) return { type: "range", ...range, kind: "hoursAgo" };
  }

  // ─── Teilstück eines Monats → ganzer Monat (vor „letzte Woche“!) ─────────
  const weekOfMonth = WEEK_OF_MONTH_EN.exec(lower) || WEEK_OF_MONTH_DE.exec(lower);
  if (weekOfMonth) {
    const idx = monthIndex(weekOfMonth[1]);
    if (idx !== undefined) {
      const year = weekOfMonth[2] ? parseInt(weekOfMonth[2], 10) : null;
      return monthRange(idx, year, now, year != null ? "monthYear" : "month");
    }
  }

  // ─── Relativ: "letzte Woche" / "last week" ───────────────────────────────
  if (/\b(letzte\s+woche|last\s+week)\b/.test(lower)) {
    return { type: "range", ...rangeLastWeek(now), kind: "lastWeek" };
  }

  // ─── Relativ: "letzten Monat" / "last month" ─────────────────────────────
  if (/\b(letzten?\s+monat|last\s+month)\b/.test(lower)) {
    return { type: "range", ...rangeLastMonth(now), kind: "lastMonth" };
  }

  // ─── Absolut: Monat + Jahr "im Mai 2026" / "in May 2026" ─────────────────
  // 7.20.8: alle Fundstellen prüfen, nicht nur die erste („im Jahr 2025 …
  // im Mai 2026“); Jahr nicht neben -./: („im Mai 2026-05-01“).
  for (const m of lower.matchAll(MONTH_YEAR)) {
    const idx = monthIndex(m[1]);
    const year = parseInt(m[2], 10);
    if (idx !== undefined && year >= 1970 && year < 3000) {
      return monthRange(idx, year, now, "monthYear");
    }
  }

  // ─── Absolut: Monat allein "im Mai" / "in May" (aktueller Kontext) ───────
  for (const m of lower.matchAll(MONTH_ONLY)) {
    const idx = monthIndex(m[1]);
    if (idx !== undefined) return monthRange(idx, null, now, "month");
  }

  // ─── Wochentag "am Montag" / "on Monday" ─────────────────────────────────
  for (const m of lower.matchAll(WEEKDAY)) {
    const targetDay = WEEKDAYS[m[1]];
    if (targetDay !== undefined) return { type: "range", ...rangeWeekday(targetDay, now), kind: "weekday" };
  }

  // ─── Jahr "in 2025" / "Was war 2025?" ────────────────────────────────────
  const year = findYear(text);
  if (year != null) {
    return { type: "range", from: Date.UTC(year, 0, 1), to: Date.UTC(year + 1, 0, 1), kind: "year" };
  }

  return null;
}

/**
 * Extrahiert einen temporalen Anchor aus einem Query-String.
 *
 * Range-Ergebnisse tragen seit 7.20.8 `kind` ('today'|'yesterday'|'daysAgo'|
 * 'hoursAgo'|'lastWeek'|'lastMonth'|'weekday'|'monthYear'|'month'|'year').
 *
 * @param {string} query
 * @param {number} [now=Date.now()]
 * @returns {{type:"range",from:number,to:number,kind:string}|{type:"anchor",referenceQuery:string}|null}
 */
export function parseTemporal(query, now = Date.now()) {
  if (!query || typeof query !== "string") return null;
  const cleaned = stripTemporalNoise(query);

  // ─── Anchor: "nach dem X" / "after the X" ────────────────────────────────
  // Nutze original-cased query, damit der Begriff erhalten bleibt.
  const anchorMatch =
    cleaned.match(/nach\s+dem\s+(.+)$/i) ||
    cleaned.match(/after\s+the\s+(.+)$/i);
  if (anchorMatch) {
    const ref = anchorMatch[1].trim();
    if (ref) {
      return { type: "anchor", referenceQuery: ref };
    }
  }

  return parseRange(stripDurationPhrases(cleaned), now);
}

// ─── 7.20.8: Gesprächszeit oder nicht ──────────────────────────────────────

/** Auto-Capture schreibt nach dem Zug; das harte Fenster bekommt an beiden Rändern 2 h dazu. */
export const CAPTURE_GRACE_MS = 2 * HOUR_MS;

/** Längere (bereinigte) Nachrichten filtern nie hart — meist eingefügte Dokumente. */
export const CONVERSATION_QUERY_MAX_CHARS = 1500;

/** Höchster Abstand in Zeichen zwischen Zeitangabe und Gesprächsbezug (wie GAP). */
export const CUE_TIME_MAX_DISTANCE = 60;

const RELATIVE_KINDS = new Set(["today", "yesterday", "daysAgo", "hoursAgo", "lastWeek", "lastMonth", "weekday"]);

// Jede relative Art einzeln, mit Fundstelle. parseRange liefert nur den
// ersten Treffer nach fester Reihenfolge (heute vor gestern vor …); für die
// Gesprächszeit zählt, welche Angabe beim Sprechakt steht und ob dort mehrere
// verschiedene stehen.
const RELATIVE_PATTERNS = [
  { kind: "today", re: /\b(?:heute|today)\b/giu, range: (m, now) => rangeToday(now) },
  { kind: "yesterday", re: /\b(?:gestern|yesterday)\b/giu, range: (m, now) => rangeYesterday(now) },
  {
    kind: "daysAgo",
    re: /\bvor\s+(\d+)\s+tagen\b|\b(\d+)\s+days?\s+ago\b/giu,
    range: (m, now) => rangeDaysAgo(parseInt(m[1] ?? m[2], 10), now),
  },
  {
    kind: "hoursAgo",
    re: /\bvor\s+(\d+)\s+stunden\b|\b(\d+)\s+hours?\s+ago\b/giu,
    range: (m, now) => rangeHoursAgo(parseInt(m[1] ?? m[2], 10), now),
  },
  {
    // „last week of October“ / „letzte Woche im Oktober“ ist ein Monat (parseRange).
    kind: "lastWeek",
    re: new RegExp(`\\b(?:letzte\\s+woche|last\\s+week)\\b(?!\\s+(?:of|im|des|vom|von|in)\\s+(?:${MONTH_NAMES})(?![\\p{L}]))`, "giu"),
    range: (m, now) => rangeLastWeek(now),
  },
  { kind: "lastMonth", re: /\b(?:letzten?\s+monat|last\s+month)\b/giu, range: (m, now) => rangeLastMonth(now) },
  {
    kind: "weekday",
    re: /\b(?:am|on)\s+([a-z]+)\b/giu,
    range: (m, now) => {
      const day = WEEKDAYS[m[1].toLowerCase()];
      return day === undefined ? null : rangeWeekday(day, now);
    },
  },
];

function findRelativePhrases(text, now) {
  const found = [];
  for (const { kind, re, range } of RELATIVE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const r = range(m, now);
      if (r) found.push({ kind, start: m.index, end: m.index + m[0].length, from: r.from, to: r.to });
    }
  }
  return found;
}

// Ein Teilsatz endet an . ? ! : (vor Leerraum oder Textende), ; , oder einem
// Zeilenumbruch. „24.10.2026“, „z.B.“ und „14:30“ bleiben ganz.
const CLAUSE_SPLIT = /(?<=[.?!:])(?=\s|$)|[;,]|\n+/;
const GAP = "[^.?!;,\\n]{0,60}?";
const SHORT_GAP = "[^.?!;,\\n]{0,25}?";

const DE_TOLD_VERBS = "(?:gegeben|gesagt|erzählt|erzaehlt|geschickt|zugeschickt|gesendet|geschrieben|gezeigt|erklärt|erklaert|erwähnt|erwaehnt|mitgeteilt|vorgeschlagen|empfohlen|versprochen|gefragt|notiert)";
const DE_DU_VERBS = "(?:gesagt|geschrieben|geschickt|zugeschickt|vorgeschlagen|empfohlen|erzählt|erzaehlt|erwähnt|erwaehnt|versprochen|erklärt|erklaert|gezeigt|gegeben)";
const DE_TALK_VERBS = "(?:besprochen|beredet|geredet|gesprochen|diskutiert|ausgemacht|vereinbart|abgemacht|beschlossen|festgelegt|geplant)";
const DE_USER = "(?:der\\s+nutzer|die\\s+nutzerin|der\\s+user|die\\s+userin|der\\s+benutzer|die\\s+benutzerin)";
const DE_USER_VERBS = "(?:gesagt|erzählt|erzaehlt|erwähnt|erwaehnt|gefragt|geschrieben|geschickt)";
const DE_WE_DID_VERBS = "(?:gemacht|erledigt|gearbeitet|gebaut)";
const DE_YOU_DID_VERBS = "(?:gemacht|geschickt|erledigt|geprüft|geprueft|gecheckt)";

function cue(source) {
  return new RegExp(source, "giu");
}

// Sprechakt mit dem Gesprächspartner oder das Gespräch selbst — gilt auch in
// Aussagesätzen („Die Daten hatte ich dir doch gestern gegeben“).
const CONVERSATION_CUES = [
  // hatte/hab/habe ich dir … gesagt · ich hab(e)/hatte dir … gesagt
  cue(`\\b(?:(?:hab|habe|hatte|habs|hab's)\\s+ich|ich\\s+(?:hab|habe|hatte|habs|hab's))\\b${SHORT_GAP}\\b(?:dir|euch)\\b${GAP}\\b${DE_TOLD_VERBS}\\b`),
  // hast du mir … gesagt
  cue(`\\b(?:hast|hattest)\\s+du\\b${SHORT_GAP}\\b(?:mir|uns)\\b${GAP}\\b${DE_TOLD_VERBS}\\b`),
  // du hast (mir) … gesagt/geschrieben/geschickt/vorgeschlagen
  cue(`\\bdu\\s+(?:hast|hattest)\\b${GAP}\\b${DE_DU_VERBS}\\b`),
  // wir haben … besprochen · haben wir … besprochen
  cue(`\\b(?:wir\\s+(?:haben|hatten)|(?:haben|hatten)\\s+wir)\\b${GAP}\\b${DE_TALK_VERBS}\\b`),
  // uns unterhalten
  cue(`\\b(?:wir|uns)\\b${GAP}\\bunterhalten\\b`),
  // Verb am Ende (Nebensatz, „Weißt du noch, …“): was ich dir … erzählt habe ·
  // was du mir … geschickt hast · worüber wir … gesprochen haben. „ich“ nur
  // mit dir/euch: „was ich heute mit Max gesprochen habe“ ist ein Dritter.
  cue(`\\bich\\s+(?:dir|euch)\\b${GAP}\\b${DE_TOLD_VERBS}\\s+(?:hab|habe|hatte|hätte|haette)\\b`),
  cue(`\\bdu\\b${GAP}\\b${DE_DU_VERBS}\\s+(?:hast|hattest)\\b`),
  cue(`\\bwir\\b${GAP}\\b(?:${DE_TALK_VERBS}|unterhalten)\\s+(?:haben|hatten)\\b`),
  // worüber/wovon haben wir / hast du / habe ich
  cue(`(?<![\\p{L}])(?:worüber|worueber|wovon)\\s+(?:(?:haben|hatten)\\s+wir|(?:hast|hattest)\\s+du|(?:hab|habe|hatte)\\s+ich)\\b`),
  // unser Gespräch/Chat · deine Nachricht/Antwort/Zusammenfassung/Liste.
  // Nur diese Wörter mit ihren Endungen, keine Komposita („Chatgruppe“,
  // „Gesprächspartner“, „Nachrichtenquellen“, „Antwortzeit“). `\b` reicht
  // nicht: Nach „chat“ in „Chatübersicht“ gilt das „ü“ als Wortgrenze.
  cue(`\\bunser(?:e|em|en|er|es)?\\s+(?:gespräch(?:e|en|s)?|gespraech(?:e|en|s)?|chats?|unterhaltung(?:en)?)(?![\\p{L}])`),
  cue(`\\bdein(?:e|em|en|er|es)?\\s+(?:sprachnachricht(?:en)?|nachricht(?:en)?|antwort(?:en)?|zusammenfassung(?:en)?|liste(?:n)?)(?![\\p{L}])`),
  // I told/sent/showed/gave/asked you
  cue(`\\bI(?:\\s+had|'d)?\\s+(?:told|sent|showed|gave|asked)\\b${SHORT_GAP}\\byou\\b`),
  // you told/said/sent/recommended/suggested (me)
  cue(`\\byou\\s+(?:told|said|sent|recommended|suggested)\\b`),
  // did I/we/you tell/mention/say/discuss/talk/chat/send/ask/share/agree/decide
  cue(`\\bdid\\s+(?:I|we|you)\\s+(?:tell|mention|say|discuss|talk|chat|send|ask|share|agree|decide)\\b`),
  // we discussed/talked/chatted/agreed/decided
  cue(`\\bwe(?:\\s+(?:have|had|already|just))?\\s+(?:discussed|talked|chatted|agreed|decided)\\b`),
  // our/your conversation/chat/message/summary/list (auch Plural)
  cue(`\\b(?:our|your)\\s+(?:conversations?|chats?|messages?|summary|summaries|lists?)\\b`),
  // Werkzeug-Pfad, 3. Person: the user said … · did the user say …
  // Artikel Pflicht: „a user said yesterday on reddit“ ist ein Dritter.
  cue(`\\bthe\\s+user\\s+(?:has\\s+|had\\s+)?(?:said|told|mentioned|asked|wrote|sent)\\b`),
  cue(`\\bdid\\s+the\\s+user\\s+(?:say|tell|mention|ask|write|send)\\b`),
  // der Nutzer hat … gesagt · hat der Nutzer … gesagt
  cue(`\\b(?:${DE_USER}\\s+(?:hat|hatte)|(?:hat|hatte)\\s+${DE_USER})\\b${GAP}\\b${DE_USER_VERBS}\\b`),
];

// Nur in Frageform: gemeinsame Tätigkeit und 2. Person an den Agenten.
const QUESTION_ONLY_CUES = [
  // was haben wir … gemacht/erledigt/gearbeitet/gebaut · was wir … gemacht haben
  cue(`\\b(?:wir\\s+(?:haben|hatten)|(?:haben|hatten)\\s+wir)\\b${GAP}\\b${DE_WE_DID_VERBS}\\b`),
  cue(`\\bwir\\b${GAP}\\b${DE_WE_DID_VERBS}\\s+(?:haben|hatten)\\b`),
  // what did we do/work on/build
  cue(`\\bdid\\s+we\\s+(?:do|work|build)\\b`),
  // was hast du … gemacht/geschickt/erledigt/geprüft · hast du … die Mails gecheckt · was du … gemacht hast
  cue(`\\b(?:hast|hattest)\\s+du\\b${GAP}\\b${DE_YOU_DID_VERBS}\\b`),
  // was hast du … gesagt/geschrieben/erzählt — ohne „mir/uns“, wie „did you say“
  cue(`\\b(?:hast|hattest)\\s+du\\b${GAP}\\b${DE_DU_VERBS}\\b`),
  cue(`\\bdu\\b${GAP}\\b${DE_YOU_DID_VERBS}\\s+(?:hast|hattest)\\b`),
  // what/did you … do/send/check
  cue(`\\bdid\\s+you\\b${SHORT_GAP}\\b(?:do|send|check)\\b`),
];

const QUESTION_START = /^(?:(?:und|also|ok|okay|na|and|so|hey)\s+)?(?:was|wann|wo|wie|welche[mnrs]?|woran|worüber|worueber|wovon|wer|warum|wieso|hast|hattest|habt|haben|hatten|hat|what|which|when|where|how|who|why|did|do|does|have|has|had)(?![\p{L}])/iu;

// Zukunftssignal im Teilsatz. „heute/gestern Morgen“ und „Guten Morgen“ sind
// keine Zukunft (ebenso „am Morgen“).
const FUTURE_CUE = /(?<![\p{L}])(?:morgen|übermorgen|uebermorgen|nächste[nmrs]?|naechste[nmrs]?|kommende[nmrs]?|wird|werden|werde|tomorrow|next|upcoming|going\s+to|will|shall)(?![\p{L}])/iu;
const NOT_FUTURE_MORNING = /(?<![\p{L}])(?:heute|gestern|vorgestern|guten|am)\s+morgen(?![\p{L}])/giu;

function isQuestionClause(clause) {
  if (/\?\s*$/.test(clause)) return true;
  return QUESTION_START.test(clause.replace(/^[^\p{L}]+/u, ""));
}

function hasFutureCue(clause) {
  return FUTURE_CUE.test(clause.replace(NOT_FUTURE_MORNING, " "));
}

// ─── Teilsätze ohne Satzzeichen ────────────────────────────────────────────
// Die Zeitangabe muss zum Sprechakt gehören, nicht zu dem, was gesagt wurde.
// Ohne Komma („Ich hab dir gesagt dass er am Donnerstag kommt“), im Englischen
// (vor „that“ steht nie ein Komma) und in Sprachnachrichten fehlt die Grenze.

// Diktat für Dritte: „Schreib Eva: …“, „Tell him: …“. Der Rest der Nachricht
// ist fremder Text. „Sag mal:“, „Sag mir:“, „Tell me:“ richten sich an den Agenten.
const DICTATION = /(?:^|[.!?;,\n])\s*(?:(?:bitte|dann|und|jetzt|ok|okay|also|please|then|and|now)\s+)*(?:schreib|schreibe|antworte|schick|schicke|sende|sag|sage|richte|frag|write|reply|tell|send|ask)(?![\p{L}])(?!\s+(?:mal|mir|mich|uns|me|us)(?![\p{L}]))[^:\n.?!;]{0,40}:(?=\s|$)/iu;

// Deutsch: dass/ob leiten immer einen eigenen Teilsatz ein.
const DE_CONJUNCTION = /(?<![\p{L}])(?:dass|daß|ob)(?![\p{L}])/giu;
// Deutsch: Nach dem Partizip des Sprechakts („Ich hab dir gesagt | das Paket
// kommt am Freitag“), bei Verb am Ende nach dem Hilfsverb („was ich dir
// erzählt habe | …“), beginnt ein neuer Teilsatz — außer es folgt nur noch die
// Zeitangabe („Was hab ich dir erzählt gestern?“).
const DE_PARTICIPLE = new RegExp(
  `(?<![\\p{L}])(?:${[DE_TOLD_VERBS, DE_DU_VERBS, DE_TALK_VERBS, DE_USER_VERBS, DE_WE_DID_VERBS, DE_YOU_DID_VERBS].join("|")}|unterhalten)(?![\\p{L}])`,
  "giu",
);
const DE_AUXILIARY = /^\s*(?:hab|habe|habs|hab's|hast|hat|haben|habt|hatte|hattest|hatten|hätte|hättest|hätten|haette|ist|bin|bist|sind|seid|war|warst|waren|wurde|wurden|worden|wird|werden|wäre|wären)(?![\p{L}])/iu;
const TIME_FILLER = /(?<![\p{L}])(?:noch|nochmal|nochmals|eigentlich|so|doch|genau|denn|abend|abends|morgen|morgens|früh|frueh|mittag|mittags|nachmittag|vormittag|nacht|nachts|evening|morning|night|afternoon)(?![\p{L}])/giu;
// Deutsch: Fragewort mitten im Teilsatz leitet einen Nebensatz ein, wenn der
// Rest mit dem finiten Verb endet („hast du gesehen | was Eva heute gemacht
// hat“). Sonst ist „was“ meist „etwas“ („Hast du mir gestern was geschickt?“).
const DE_WH = /(?<![\p{L}])(?:was|wer|wen|wem|wessen|wo|wann|wie|warum|wieso|weshalb|weswegen|welche[mnrs]?|worüber|worueber|wovon|womit|woran|worum|wohin|woher)(?![\p{L}])/giu;
const DE_FINITE_END = /(?<![\p{L}])(?:hat|habe|hab|hast|haben|habt|hatte|hattest|hatten|hätte|hättest|hätten|ist|bin|bist|sind|seid|war|warst|waren|wäre|wären|wird|wirst|werden|würde|würden|kann|kannst|können|könnt|konnte|konnten|soll|sollst|sollen|sollte|sollten|will|willst|wollen|wollte|wollten|muss|musst|müssen|musste|mussten|darf|darfst|dürfen|durfte|gibt|gab|geht|ging|kommt|kam|passiert|läuft|lief|macht|machte|sagt|sagte|meint|meinte|heißt|hieß|weiß|wusste|steht|stand|denkt|dachte|findet|fand|braucht|brauchte|tut|tat|klingt|klang)[^\p{L}\p{N}]*$/iu;
// Englisch: Fragewort/Konjunktion mitten im Teilsatz („I told you | what
// happened yesterday“, „did I ask you | if Eva called yesterday“).
const EN_WH = /(?<![\p{L}'])(?:what|who|whom|whose|when|where|why|how|which|whether|if)(?![\p{L}])/giu;
// Englisch: Objektsatz nach einem Verb des Sagens („I told you | he's coming
// on Thursday“, „You said | the package arrives on Friday“). „that“ vor einer
// Zeitangabe ist ein Pronomen („You said that yesterday“).
const EN_SPEECH_VERB = /(?<![\p{L}])(?:(?:told|tell|asked|ask|promised|promise|showed|show|wrote|write)(?:\s+(?:you|me|us|him|her|them)(?![\p{L}]))?|said|say|says|mentioned|mention|explained|explain|agreed|agree|decided|decide|discussed|discuss)(?![\p{L}])/giu;
const EN_TIME_AHEAD = "(?:yesterday|today|tonight|last\\s+(?:week|month|night)|this\\s+(?:morning|afternoon|evening|week|month)|on\\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\\d+\\s+(?:days?|hours?)\\s+ago)(?![\\p{L}])";
const EN_DET = "(?:the|a|an|my|his|her|their|our|your|this|these|those)";
const EN_NP_WORD = `(?!(?:${EN_DET}|yesterday|today|tonight|last|on|about|to|for|with|in|at|from|that)(?![\\p{L}]))[\\p{L}'-]+`;
const EN_FINITE = "(?:is|are|was|were|has|had|have|will|would|can|could|should|did|does|comes|came|goes|went|arrives|arrived|starts|started|leaves|left|called|happened|happens|gets|got)";
const EN_CLAUSE_OPENER = new RegExp(
  `^\\s+(?:that\\s+(?!${EN_TIME_AHEAD})[\\p{L}]`
    + `|(?:i|he|she|we|they)(?:'[a-z]+)?(?![\\p{L}])`
    + `|(?:it|you|there)(?:'s|'re|'ll|'d|\\s+(?:is|are|was|were|will|would|has|had|can|could))(?![\\p{L}])`
    + `|(?:${EN_DET}\\s+)?${EN_NP_WORD}(?:\\s+${EN_NP_WORD}){0,2}\\s+${EN_FINITE}(?![\\p{L}]))`,
  "iu",
);

function cutAfterDictation(text) {
  const m = DICTATION.exec(text);
  return m ? text.slice(0, m.index + m[0].length) : text;
}

function isOnlyTimePhrase(rest, now) {
  const phrases = findRelativePhrases(rest, now);
  if (phrases.length === 0) return false;
  let remainder = rest;
  for (const p of phrases.sort((a, b) => b.start - a.start)) {
    remainder = `${remainder.slice(0, p.start)} ${remainder.slice(p.end)}`;
  }
  return !/[\p{L}\p{N}]/u.test(remainder.replace(TIME_FILLER, " "));
}

function cutAt(text, positions) {
  const sorted = [...new Set(positions)].filter((p) => p > 0 && p < text.length).sort((a, b) => a - b);
  const parts = [];
  let last = 0;
  for (const p of sorted) {
    parts.push(text.slice(last, p));
    last = p;
  }
  parts.push(text.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function splitSubordinate(clause, now) {
  const cuts = [];
  for (const m of clause.matchAll(DE_CONJUNCTION)) cuts.push(m.index);
  for (const m of clause.matchAll(EN_WH)) cuts.push(m.index);
  for (const m of clause.matchAll(DE_PARTICIPLE)) {
    let end = m.index + m[0].length;
    // Verb am Ende: Der Nebensatz endet nach dem Hilfsverb („ob ich dir das
    // schon erzählt hatte | aber heute morgen …“).
    const aux = DE_AUXILIARY.exec(clause.slice(end));
    if (aux) end += aux[0].length;
    const rest = clause.slice(end);
    if (!/^\s+[\p{L}\p{N}]/u.test(rest) || isOnlyTimePhrase(rest, now)) continue;
    cuts.push(end);
  }
  for (const m of clause.matchAll(EN_SPEECH_VERB)) {
    const end = m.index + m[0].length;
    if (EN_CLAUSE_OPENER.test(clause.slice(end))) cuts.push(end);
  }
  const parts = [];
  for (const part of cutAt(clause, cuts)) {
    const whCuts = [];
    for (const m of part.matchAll(DE_WH)) {
      if (m.index > 0 && DE_FINITE_END.test(part.slice(m.index + m[0].length))) whCuts.push(m.index);
    }
    parts.push(...cutAt(part, whCuts));
  }
  return parts;
}

/**
 * Teilsätze für die Gesprächszeit-Prüfung: Satzzeichen, dann Nebensätze ohne
 * Satzzeichen. Frageform und Zukunftssignal gelten für den ganzen
 * Satzzeichen-Teilsatz („Tomorrow I'll tell you | what we discussed today“
 * bleibt Zukunft).
 *
 * @param {string} text bereinigt
 * @param {number} now
 * @returns {{text: string, question: boolean, future: boolean}[]}
 */
function conversationClauses(text, now) {
  const compact = text.replace(/[^\S\n]+/g, " ").replace(/ ?\n[\n ]*/g, "\n");
  const clauses = [];
  for (const raw of cutAfterDictation(compact).split(CLAUSE_SPLIT)) {
    const clause = (raw || "").trim();
    if (!clause) continue;
    const question = isQuestionClause(clause);
    const future = hasFutureCue(clause);
    for (const part of splitSubordinate(clause, now)) clauses.push({ text: part, question, future });
  }
  return clauses;
}

function cueSpans(clause, question) {
  const spans = [];
  const lists = question ? [CONVERSATION_CUES, QUESTION_ONLY_CUES] : [CONVERSATION_CUES];
  for (const list of lists) {
    for (const re of list) {
      for (const m of clause.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return spans;
}

function isNearCue(phrase, spans) {
  return spans.some((s) => phrase.end >= s.start - CUE_TIME_MAX_DISTANCE && phrase.start <= s.end + CUE_TIME_MAX_DISTANCE);
}

/**
 * Entscheidet, ob eine Zeitangabe in der Anfrage den Recall hart nach
 * `createdAt` filtern darf. Hart nur, wenn die Anfrage eindeutig nach der
 * Gesprächszeit fragt: relative Zeitangabe (heute, gestern, vor N Tagen/
 * Stunden, letzte Woche, letzten Monat, Wochentag) und Gesprächsbezug im
 * selben Teilsatz, höchstens `CUE_TIME_MAX_DISTANCE` Zeichen auseinander,
 * genau eine solche Angabe dort, kein Zukunftssignal, Nachricht nicht länger
 * als `maxChars`. Teilsätze enden an Satzzeichen (auch „: “), vor dass/ob,
 * vor Nebensätzen mit Fragewort und nach dem Sprechakt („Ich hab dir gesagt |
 * dass …“, „I told you | he's coming …“); nach einem Diktat („Schreib Eva: …“)
 * zählt der Rest nicht. Das Fenster ist an beiden Rändern um
 * `CAPTURE_GRACE_MS` erweitert (`to` höchstens `now`). Kalenderangaben
 * (Monat, Monat+Jahr, Jahr) und Anker filtern nie.
 *
 * @param {string} query
 * @param {number} [now=Date.now()]
 * @param {{maxChars?: number}} [opts]
 * @returns {{mode:"hard"|"none", kind:string, range:{from:number,to:number}|null, reason:string}|null}
 *   null, wenn parseTemporal nichts findet. reason bei "none": anchor, absolute-time, long-message,
 *   ambiguous-time (mehrere Zeitangaben am Sprechakt), future oder no-conversation-cue.
 */
export function classifyTemporalQuery(query, now = Date.now(), { maxChars = CONVERSATION_QUERY_MAX_CHARS } = {}) {
  const parsed = parseTemporal(query, now);
  if (!parsed) return null;
  if (parsed.type === "anchor") {
    return { mode: "none", kind: "anchor", range: null, reason: "anchor" };
  }
  const none = (reason) => ({ mode: "none", kind: parsed.kind, range: { from: parsed.from, to: parsed.to }, reason });
  if (!RELATIVE_KINDS.has(parsed.kind)) return none("absolute-time");

  const text = stripDurationPhrases(stripTemporalNoise(query));
  if (text.replace(/\s+/g, " ").trim().length > maxChars) return none("long-message");

  let sawFuture = false;
  let sawAmbiguous = false;
  for (const { text: clause, question, future } of conversationClauses(text, now)) {
    const phrases = findRelativePhrases(clause, now);
    if (phrases.length === 0) continue;
    if (future) {
      sawFuture = true;
      continue;
    }
    const spans = cueSpans(clause, question);
    const attached = phrases.filter((p) => isNearCue(p, spans));
    if (attached.length === 0) continue;
    // Zwei verschiedene Angaben am Sprechakt („Was hast du mir gestern über
    // den Termin heute gesagt?“) oder eine Kalenderangabe davor im Rang
    // („am Montag im Mai“): nicht eindeutig, also nicht hart.
    const distinct = new Set(attached.map((p) => `${p.from}:${p.to}`));
    const clauseRange = parseRange(clause, now);
    if (distinct.size > 1 || !clauseRange || !RELATIVE_KINDS.has(clauseRange.kind)) {
      sawAmbiguous = true;
      continue;
    }
    const [{ kind, from, to }] = attached;
    return {
      mode: "hard",
      kind,
      range: { from: from - CAPTURE_GRACE_MS, to: Math.min(to + CAPTURE_GRACE_MS, now) },
      reason: "conversation-time",
    };
  }
  return none(sawAmbiguous ? "ambiguous-time" : sawFuture ? "future" : "no-conversation-cue");
}

// ─── 7.20.7-Parser, unverändert ────────────────────────────────────────────
// Nur für temporalFilterMode "legacy" in runRecallPipeline (A/B im Messstand).
// Eigene Kopie der alten Dauer-Phrasen, weil stripDurationPhrases seit 7.20.8
// mehr entfernt.
const LEGACY_DURATION_PHRASES = /\b(?:bis\s+(?:heute|jetzt|dato)|until\s+(?:today|now)|up\s+to\s+(?:today|now)|so\s+far|to\s+date)\b(?!\s+(?:abend|mittag|nachmittag|vormittag|früh|frueh|morgen|nacht|um\b|\d|evening|noon|afternoon|morning|night|at\b))/g;

/**
 * Der Zeitparser aus 7.20.7, unverändert (ohne Rauschfilter, ohne `kind`).
 * Nur für den Vergleich im Messstand (`temporalFilterMode: "legacy"`).
 *
 * @param {string} query
 * @param {number} [now=Date.now()]
 * @returns {{type:"range",from:number,to:number}|{type:"anchor",referenceQuery:string}|null}
 */
export function parseTemporalLegacy(query, now = Date.now()) {
  if (!query || typeof query !== "string") return null;
  const lower = query.toLowerCase().replace(LEGACY_DURATION_PHRASES, " ");

  const anchorMatch =
    query.match(/nach\s+dem\s+(.+)$/i) ||
    query.match(/after\s+the\s+(.+)$/i);
  if (anchorMatch) {
    const ref = anchorMatch[1].trim();
    if (ref) {
      return { type: "anchor", referenceQuery: ref };
    }
  }

  if (/\b(heute|today)\b/.test(lower)) {
    const from = startOfUTCDay(now);
    return { type: "range", from, to: now };
  }

  if (/\b(gestern|yesterday)\b/.test(lower)) {
    const todayStart = startOfUTCDay(now);
    return { type: "range", from: todayStart - DAY_MS, to: todayStart };
  }

  const daysAgoMatch =
    lower.match(/\b(vor\s+(\d+)\s+tagen)\b/) ||
    lower.match(/\b((\d+)\s+days?\s+ago)\b/);
  if (daysAgoMatch) {
    const n = parseInt(daysAgoMatch[2], 10);
    if (n > 0 && n < 10000) {
      const target = new Date(now);
      target.setUTCDate(target.getUTCDate() - n);
      target.setUTCHours(0, 0, 0, 0);
      const from = target.getTime();
      return { type: "range", from, to: from + DAY_MS };
    }
  }

  const hoursAgoMatch =
    lower.match(/\b(vor\s+(\d+)\s+stunden)\b/) ||
    lower.match(/\b((\d+)\s+hours?\s+ago)\b/);
  if (hoursAgoMatch) {
    const n = parseInt(hoursAgoMatch[2], 10);
    if (n > 0 && n < 10000) {
      return { type: "range", from: now - n * HOUR_MS, to: now };
    }
  }

  if (/\b(letzte\s+woche|last\s+week)\b/.test(lower)) {
    return { type: "range", from: now - 7 * DAY_MS, to: now };
  }

  if (/\b(letzten?\s+monat|last\s+month)\b/.test(lower)) {
    return { type: "range", from: now - 30 * DAY_MS, to: now };
  }

  const monthYearMatch =
    lower.match(/\b(im\s+([a-zäöüß]+)\s+(\d{4}))\b/) ||
    lower.match(/\b(in\s+([a-z]+)\s+(\d{4}))\b/);
  if (monthYearMatch) {
    const monthName = monthYearMatch[2];
    const year = parseInt(monthYearMatch[3], 10);
    const idx = DE_MONTHS[monthName] ?? EN_MONTHS[monthName];
    if (idx !== undefined && year >= 1970 && year < 3000) {
      const from = Date.UTC(year, idx, 1);
      const to = Date.UTC(year, idx + 1, 1);
      return { type: "range", from, to };
    }
  }

  const monthOnlyMatch =
    lower.match(/\b(im\s+([a-zäöüß]+))\b/) ||
    lower.match(/\b(in\s+([a-z]+))\b/);
  if (monthOnlyMatch) {
    const monthName = monthOnlyMatch[2];
    const idx = DE_MONTHS[monthName] ?? EN_MONTHS[monthName];
    if (idx !== undefined) {
      const d = new Date(now);
      const year = d.getUTCFullYear();
      const from = Date.UTC(year, idx, 1);
      const to = Math.min(Date.UTC(year, idx + 1, 1), now);
      return { type: "range", from, to };
    }
  }

  const weekdayMatch =
    lower.match(/\b(am\s+([a-z]+))\b/) ||
    lower.match(/\b(on\s+([a-z]+))\b/);
  if (weekdayMatch) {
    const dayName = weekdayMatch[2];
    const targetDay = WEEKDAYS[dayName];
    if (targetDay !== undefined) {
      const from = previousWeekdayUTC(now, targetDay);
      return { type: "range", from, to: from + DAY_MS };
    }
  }

  const yearMatch = lower.match(/\b(\d{4})\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10);
    if (year >= 1970 && year < 3000) {
      const from = Date.UTC(year, 0, 1);
      const to = Date.UTC(year + 1, 0, 1);
      return { type: "range", from, to };
    }
  }

  return null;
}
