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
const YEAR_WITH_PREPOSITION = new RegExp(
  `${NOT_WORD_BEFORE}(?:im\\s+jahre?|in\\s+the\\s+year|im|in|jahr|year|seit|since|bis|until)\\s+(${YEAR_DIGITS})${YEAR_TAIL}`,
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

function isStandaloneYear(text, index, length) {
  // Nur die Umgebung prüfen: bei vielen Zahlen in langen Texten sonst quadratisch.
  const beforeStart = Math.max(0, index - 80);
  const afterEnd = Math.min(text.length, index + length + 80);
  const before = text.slice(beforeStart, index);
  const after = text.slice(index + length, afterEnd);
  const atClauseStart = /[.;!?\n(]\s*$/.test(before) || (beforeStart === 0 && /^\s*$/.test(before));
  const atClauseEnd = /^\s*[.;!?,)\n]/.test(after) || (afterEnd === text.length && /^\s*$/.test(after));
  const isLowerWord = (word) => Boolean(word) && /^\p{Ll}/u.test(word) && !/\p{N}/u.test(word);
  if (atClauseStart) return atClauseEnd || isLowerWord(wordAfter(after));
  return atClauseEnd && isLowerWord(wordBefore(before));
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
    const from = startOfUTCDay(now);
    return { type: "range", from, to: now, kind: "today" };
  }

  // ─── Gestern / Yesterday ─────────────────────────────────────────────────
  if (/\b(gestern|yesterday)\b/.test(lower)) {
    const todayStart = startOfUTCDay(now);
    return { type: "range", from: todayStart - DAY_MS, to: todayStart, kind: "yesterday" };
  }

  // ─── Relativ: "vor N Tagen" / "N days ago" ───────────────────────────────
  // Das soll den EINZELNEN Tag abdecken (von 00:00 UTC bis 00:00 UTC+1)
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
      return { type: "range", from, to: from + DAY_MS, kind: "daysAgo" };
    }
  }

  // ─── Relativ: "vor N Stunden" / "N hours ago" ────────────────────────────
  const hoursAgoMatch =
    lower.match(/\b(vor\s+(\d+)\s+stunden)\b/) ||
    lower.match(/\b((\d+)\s+hours?\s+ago)\b/);
  if (hoursAgoMatch) {
    const n = parseInt(hoursAgoMatch[2], 10);
    if (n > 0 && n < 10000) {
      return { type: "range", from: now - n * HOUR_MS, to: now, kind: "hoursAgo" };
    }
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
    return { type: "range", from: now - 7 * DAY_MS, to: now, kind: "lastWeek" };
  }

  // ─── Relativ: "letzten Monat" / "last month" ─────────────────────────────
  if (/\b(letzten?\s+monat|last\s+month)\b/.test(lower)) {
    return { type: "range", from: now - 30 * DAY_MS, to: now, kind: "lastMonth" };
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
    if (targetDay !== undefined) {
      const from = previousWeekdayUTC(now, targetDay);
      return { type: "range", from, to: from + DAY_MS, kind: "weekday" };
    }
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

const RELATIVE_KINDS = new Set(["today", "yesterday", "daysAgo", "hoursAgo", "lastWeek", "lastMonth", "weekday"]);

// Ein Teilsatz endet an . ? ! (vor Leerraum oder Textende), ; , oder einem
// Zeilenumbruch. „24.10.2026“ und „z.B.“ bleiben ganz.
const CLAUSE_SPLIT = /(?<=[.?!])(?=\s|$)|[;,]|\n+/;
const GAP = "[^.?!;,\\n]{0,60}?";
const SHORT_GAP = "[^.?!;,\\n]{0,25}?";

const DE_TOLD_VERBS = "(?:gegeben|gesagt|erzählt|erzaehlt|geschickt|zugeschickt|gesendet|geschrieben|gezeigt|erklärt|erklaert|erwähnt|erwaehnt|mitgeteilt|vorgeschlagen|empfohlen|versprochen|gefragt|notiert)";
const DE_DU_VERBS = "(?:gesagt|geschrieben|geschickt|zugeschickt|vorgeschlagen|empfohlen|erzählt|erzaehlt|erwähnt|erwaehnt|versprochen|erklärt|erklaert|gezeigt|gegeben)";
const DE_TALK_VERBS = "(?:besprochen|beredet|geredet|gesprochen|diskutiert|ausgemacht|vereinbart|abgemacht|beschlossen|festgelegt|geplant)";
const DE_USER = "(?:der\\s+nutzer|die\\s+nutzerin|der\\s+user|die\\s+userin|der\\s+benutzer|die\\s+benutzerin)";
const DE_USER_VERBS = "(?:gesagt|erzählt|erzaehlt|erwähnt|erwaehnt|gefragt|geschrieben|geschickt)";

function cue(source) {
  return new RegExp(source, "iu");
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
  // worüber/wovon haben wir / hast du / habe ich
  cue(`(?<![\\p{L}])(?:worüber|worueber|wovon)\\s+(?:(?:haben|hatten)\\s+wir|(?:hast|hattest)\\s+du|(?:hab|habe|hatte)\\s+ich)\\b`),
  // unser Gespräch/Chat · deine Nachricht/Antwort/Zusammenfassung/Liste
  cue(`\\bunser(?:e|em|en|er|es)?\\s+(?:gespräch|gespraech|chat|unterhaltung)`),
  cue(`\\bdein(?:e|em|en|er|es)?\\s+(?:sprachnachricht|nachricht|antwort|zusammenfassung|liste)`),
  // I told/sent/showed/gave/asked you
  cue(`\\bI(?:\\s+had|'d)?\\s+(?:told|sent|showed|gave|asked)\\b${SHORT_GAP}\\byou\\b`),
  // you told/said/sent/recommended/suggested (me)
  cue(`\\byou\\s+(?:told|said|sent|recommended|suggested)\\b`),
  // did I/we/you tell/mention/say/discuss/talk/send/ask/share/agree/decide
  cue(`\\bdid\\s+(?:I|we|you)\\s+(?:tell|mention|say|discuss|talk|send|ask|share|agree|decide)\\b`),
  // we discussed/talked/chatted/agreed/decided
  cue(`\\bwe(?:\\s+(?:have|had|already|just))?\\s+(?:discussed|talked|chatted|agreed|decided)\\b`),
  // our/your conversation/chat/message/summary/list
  cue(`\\b(?:our|your)\\s+(?:conversation|chat|message|summary|list)\\b`),
  // Werkzeug-Pfad, 3. Person: the user said … · did the user say …
  cue(`\\b(?:the\\s+)?user\\s+(?:has\\s+|had\\s+)?(?:said|told|mentioned|asked|wrote|sent)\\b`),
  cue(`\\bdid\\s+the\\s+user\\s+(?:say|tell|mention|ask|write|send)\\b`),
  // der Nutzer hat … gesagt · hat der Nutzer … gesagt
  cue(`\\b(?:${DE_USER}\\s+(?:hat|hatte)|(?:hat|hatte)\\s+${DE_USER})\\b${GAP}\\b${DE_USER_VERBS}\\b`),
];

// Nur in Frageform: gemeinsame Tätigkeit und 2. Person an den Agenten.
const QUESTION_ONLY_CUES = [
  // was haben wir … gemacht/erledigt/gearbeitet/gebaut
  cue(`\\b(?:wir\\s+(?:haben|hatten)|(?:haben|hatten)\\s+wir)\\b${GAP}\\b(?:gemacht|erledigt|gearbeitet|gebaut)\\b`),
  // what did we do/work on/build
  cue(`\\bdid\\s+we\\s+(?:do|work|build)\\b`),
  // was hast du … gemacht/geschickt/erledigt/geprüft · hast du … die Mails gecheckt
  cue(`\\b(?:hast|hattest)\\s+du\\b${GAP}\\b(?:gemacht|geschickt|erledigt|geprüft|geprueft|gecheckt)\\b`),
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

function hasConversationCue(clause) {
  if (CONVERSATION_CUES.some((re) => re.test(clause))) return true;
  return isQuestionClause(clause) && QUESTION_ONLY_CUES.some((re) => re.test(clause));
}

/**
 * Entscheidet, ob eine Zeitangabe in der Anfrage den Recall hart nach
 * `createdAt` filtern darf. Hart nur, wenn die Anfrage eindeutig nach der
 * Gesprächszeit fragt: relative Zeitangabe (heute, gestern, vor N Tagen/
 * Stunden, letzte Woche, letzten Monat, Wochentag) und Gesprächsbezug im
 * selben Teilsatz, kein Zukunftssignal dort, Nachricht nicht länger als
 * `maxChars`. Das Fenster kommt aus diesem Teilsatz und ist an beiden Rändern
 * um `CAPTURE_GRACE_MS` erweitert (`to` höchstens `now`). Kalenderangaben
 * (Monat, Monat+Jahr, Jahr) und Anker filtern nie.
 *
 * @param {string} query
 * @param {number} [now=Date.now()]
 * @param {{maxChars?: number}} [opts]
 * @returns {{mode:"hard"|"none", kind:string, range:{from:number,to:number}|null, reason:string}|null}
 *   null, wenn parseTemporal nichts findet.
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
  for (const raw of text.split(CLAUSE_SPLIT)) {
    const clause = (raw || "").trim();
    if (!clause) continue;
    const range = parseRange(clause, now);
    if (!range || !RELATIVE_KINDS.has(range.kind)) continue;
    if (hasFutureCue(clause)) {
      sawFuture = true;
      continue;
    }
    if (hasConversationCue(clause)) {
      return {
        mode: "hard",
        kind: range.kind,
        range: { from: range.from - CAPTURE_GRACE_MS, to: Math.min(range.to + CAPTURE_GRACE_MS, now) },
        reason: "conversation-time",
      };
    }
  }
  return none(sawFuture ? "future" : "no-conversation-cue");
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
