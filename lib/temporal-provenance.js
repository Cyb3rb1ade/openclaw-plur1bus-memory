/**
 * lib/temporal-provenance.js — P5 Temporal Provenance + Operational Action Guard.
 *
 * Pure deterministic helpers that compute memory age/freshness, detect
 * operational/system-state memories, classify operational risk, and decide
 * whether live verification is required before acting on a recalled memory.
 *
 * No DB/network dependencies. `opts.now` allows fixed-time injection for tests.
 */

const DEFAULT_FRESH_MS = 15 * 60 * 1000;
const DEFAULT_RECENT_MS = 2 * 60 * 60 * 1000;

const OPERATIONAL_KEYWORDS = [
  "cron", "crontab", "cronjob",
  "systemctl", "service", "timer",
  "deploy", "deployment",
  "gateway",
  "protect script", "update script", "deploy script",
  "lockfile", "lock file", "duplicate job", "duplikat",
  "database migration", "db migration",
  "journalctl",
  "production", "live",
];

const DESTRUCTIVE_KEYWORDS = [
  "disable", "stop", "delete", "remove", "move", "drop",
  "reset hard", "reset --hard", "rm -", "chmod", "chown",
];

const HIGH_RISK_KEYWORDS = [
  "edit", "change", "alter", "modify", "rewrite", "update",
  "crontab", "cron", "cronjob", "deploy script", "protect script", "update script",
];

const MEDIUM_RISK_KEYWORDS = [
  "restart", "reload", "status", "check", "verify", "list-timers",
  "list-units", "systemctl",
];

const LOW_RISK_KEYWORDS = [
  "journalctl", "log", "logged", "warning", "error",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesKeyword(source, keyword) {
  const normalized = String(keyword || "").toLowerCase();
  if (!normalized) return false;
  if (/^[\p{L}\p{N}_-]+$/u.test(normalized)) {
    const boundary = "[^\\p{L}\\p{N}_-]";
    return new RegExp(`(^|${boundary})${escapeRegExp(normalized)}(?=$|${boundary})`, "u").test(source);
  }
  return source.includes(normalized);
}

/**
 * Parses a timestamp value into epoch milliseconds.
 * Accepts ISO strings, numbers, or Date objects.
 * Returns undefined for missing/invalid values.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {number|undefined}
 */
export function parseMemoryTimestamp(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (value instanceof Date) return boundedTimestamp(value.getTime());
  if (typeof value === "number") return boundedTimestamp(value);
  return boundedTimestamp(Date.parse(String(value)));
}

// Größter Wert, den `new Date(ms).toISOString()` noch darstellen kann. Ohne
// diese Schranke wirft buildTemporalProvenance bei absurden Werten (z.B. einem
// als Nanosekunden fehlinterpretierten Stempel) einen RangeError und reißt das
// gesamte Recall-Rendering mit — ein unbrauchbarer Wert muss stattdessen wie
// ein fehlender behandelt werden.
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

function boundedTimestamp(ms) {
  if (!Number.isFinite(ms) || ms === 0) return undefined;
  if (Math.abs(ms) > MAX_TIMESTAMP_MS) return undefined;
  return ms;
}

/**
 * Formats an age in milliseconds as a compact human-readable label.
 *
 * @param {number|undefined} ageMs
 * @returns {string}
 */
export function formatAgeForPrompt(ageMs) {
  if (ageMs === undefined || ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  const minutes = Math.round(ageMs / (60 * 1000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(ageMs / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(ageMs / (24 * 60 * 60 * 1000));
  return `${days}d ago`;
}

/**
 * Classifies memory freshness based on age.
 *
 * @param {number|undefined} ageMs
 * @param {{freshMs?: number, recentMs?: number}} [opts={}]
 * @returns {"fresh"|"recent"|"stale"|"unknown"}
 */
export function classifyMemoryFreshness(ageMs, opts = {}) {
  if (ageMs === undefined || ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  const freshMs = opts.freshMs ?? DEFAULT_FRESH_MS;
  const recentMs = opts.recentMs ?? DEFAULT_RECENT_MS;
  if (ageMs <= freshMs) return "fresh";
  if (ageMs <= recentMs) return "recent";
  return "stale";
}

/**
 * Computes the effective age of a memory using the most recent available
 * timestamp (lastRetrievedAt > updatedAt > createdAt).
 *
 * @param {Object} memory
 * @param {{now?: number}} [opts={}]
 * @returns {{ageMs?: number, ageLabel: string, timestamp?: number, timestampField?: string}}
 */
export function computeMemoryAge(memory, opts = {}) {
  const now = opts.now ?? Date.now();
  // Use updatedAt or createdAt as the observation timestamp. lastRetrievedAt is
  // recall time, not the time the memory content was observed, so it must not
  // be used to decide freshness of the underlying operational state.
  const candidates = [
    { field: "updatedAt", value: parseMemoryTimestamp(memory?.updatedAt) },
    { field: "createdAt", value: parseMemoryTimestamp(memory?.createdAt) },
  ];
  const best = candidates.find(c => c.value !== undefined);
  if (!best) {
    return { ageMs: undefined, ageLabel: "unknown" };
  }
  const ageMs = Math.max(0, now - best.value);
  return {
    ageMs,
    ageLabel: formatAgeForPrompt(ageMs),
    timestamp: best.value,
    timestampField: best.field,
  };
}

/**
 * Detects whether a memory describes operational/system state.
 *
 * @param {string} text
 * @param {{summary?: string, category?: string}} [metadata={}]
 * @returns {{isOperational: boolean, reasons: string[]}}
 */
export function detectOperationalMemory(text, metadata = {}) {
  const source = String(text || metadata.summary || "").toLowerCase();
  const reasons = [];
  for (const keyword of OPERATIONAL_KEYWORDS) {
    if (matchesKeyword(source, keyword)) {
      reasons.push(`operational keyword: ${keyword}`);
    }
  }
  return {
    isOperational: reasons.length > 0,
    reasons,
  };
}

/**
 * Classifies the operational risk level of a memory.
 *
 * @param {string} text
 * @param {{summary?: string, category?: string}} [metadata={}]
 * @returns {{isOperational: boolean, operationalRisk: "none"|"low"|"medium"|"high"|"destructive", reasons: string[]}}
 */
export function classifyOperationalRisk(text, metadata = {}) {
  const operational = detectOperationalMemory(text, metadata);
  if (!operational.isOperational) {
    return { isOperational: false, operationalRisk: "none", reasons: [] };
  }

  const source = String(text || metadata.summary || "").toLowerCase();
  const reasons = [...operational.reasons];

  for (const keyword of DESTRUCTIVE_KEYWORDS) {
    if (matchesKeyword(source, keyword)) {
      reasons.push(`destructive keyword: ${keyword}`);
      return { isOperational: true, operationalRisk: "destructive", reasons };
    }
  }

  for (const keyword of HIGH_RISK_KEYWORDS) {
    if (matchesKeyword(source, keyword)) {
      reasons.push(`high-risk keyword: ${keyword}`);
      return { isOperational: true, operationalRisk: "high", reasons };
    }
  }

  for (const keyword of MEDIUM_RISK_KEYWORDS) {
    if (matchesKeyword(source, keyword)) {
      reasons.push(`medium-risk keyword: ${keyword}`);
      return { isOperational: true, operationalRisk: "medium", reasons };
    }
  }

  for (const keyword of LOW_RISK_KEYWORDS) {
    if (matchesKeyword(source, keyword)) {
      reasons.push(`low-risk keyword: ${keyword}`);
      return { isOperational: true, operationalRisk: "low", reasons };
    }
  }

  return { isOperational: true, operationalRisk: "medium", reasons };
}

/**
 * Decides whether a memory requires live verification before action.
 *
 * @param {Object} provenance
 * @returns {boolean}
 */
export function shouldRequireLiveVerification(provenance) {
  if (!provenance || !provenance.isOperational) return false;
  // Autoritative Quellen (kanonische KNOWLEDGE.md-Sections) sind die Referenz,
  // gegen die verifiziert wird — sie selbst zur Live-Prüfung zu zwingen wäre
  // zirkulär. Das Alter wird trotzdem ehrlich ausgewiesen.
  if (provenance.authoritative === true) return false;
  return provenance.freshness === "stale" || provenance.freshness === "unknown";
}

/**
 * Enriches a RecallDecisionTrace with temporal provenance metadata and adds
 * guard records for stale/unknown-age operational memories.
 *
 * @param {Object} trace
 * @param {Array} memories
 * @param {{now?: number}} [opts={}]
 */
export function enrichTraceWithTemporalProvenance(trace, memories, opts = {}) {
  if (!trace || typeof trace !== "object") return;
  if (!Array.isArray(trace.guards)) trace.guards = [];
  if (!trace.summary || typeof trace.summary !== "object" || Array.isArray(trace.summary)) trace.summary = {};

  const memoryById = new Map();
  for (const m of (memories || [])) {
    if (m?.id) memoryById.set(String(m.id), m);
  }

  const candidates = Array.isArray(trace.candidates) ? trace.candidates : [];
  for (const candidate of candidates) {
    const memory = memoryById.get(String(candidate.id));
    if (!memory) continue;
    const provenance = buildTemporalProvenance(memory, opts);
    candidate.temporal = provenance;
  }

  const decisions = Array.isArray(trace.decisions) ? trace.decisions : [];
  for (const decision of decisions) {
    const memory = memoryById.get(String(decision.memoryId));
    if (!memory) continue;
    const provenance = buildTemporalProvenance(memory, opts);
    decision.temporal = provenance;
    if (provenance.requiresLiveVerification) {
      trace.guards.push({
        name: "operational-live-verification-required",
        passed: false,
        stage: decision.stage || "context-render",
        memoryId: decision.memoryId,
        reason: `stale operational memory (${provenance.operationalRisk}); live verification required before action`,
        recordedAt: new Date().toISOString(),
      });
      trace.summary.guardFail = (trace.summary.guardFail || 0) + 1;
    }
  }
}

/**
 * Builds the complete temporal provenance object for a memory.
 *
 * @param {Object} memory
 * @param {{now?: number, freshMs?: number, recentMs?: number}} [opts={}]
 * @returns {Object}
 */
export function buildTemporalProvenance(memory, opts = {}) {
  const now = opts.now ?? Date.now();
  const createdMs = parseMemoryTimestamp(memory?.createdAt);
  const updatedMs = parseMemoryTimestamp(memory?.updatedAt);
  const retrievedMs = parseMemoryTimestamp(memory?.lastRetrievedAt);
  const age = computeMemoryAge(memory, { now });
  const freshness = classifyMemoryFreshness(age.ageMs, opts);
  const risk = classifyOperationalRisk(memory?.text || memory?.display, { summary: memory?.summary, category: memory?.category });

  const reasons = [...risk.reasons];
  if (freshness === "stale") {
    reasons.push(`stale operational memory older than ${formatThreshold(opts.recentMs ?? DEFAULT_RECENT_MS)}`);
  } else if (freshness === "unknown") {
    reasons.push("operational memory with unknown age");
  }

  const provenance = {
    createdAt: createdMs !== undefined ? new Date(createdMs).toISOString() : null,
    updatedAt: updatedMs !== undefined ? new Date(updatedMs).toISOString() : null,
    lastRetrievedAt: retrievedMs !== undefined ? new Date(retrievedMs).toISOString() : null,
    ageMs: age.ageMs,
    ageLabel: age.ageLabel,
    freshness,
    isOperational: risk.isOperational,
    operationalRisk: risk.operationalRisk,
    authoritative: memory?.authoritative === true,
    requiresLiveVerification: false,
    reasons,
  };

  provenance.requiresLiveVerification = shouldRequireLiveVerification(provenance);
  return provenance;
}

function formatThreshold(ms) {
  if (ms < 60 * 60 * 1000) return `${Math.round(ms / (60 * 1000))}m`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}

// ---------------------------------------------------------------------------
// 7.20.10 (Mangel 3): Zustandsangaben beim Rendern datieren.
//
// Ein gespeicherter Satz wie "aktuell 7.12.2" stand im Prompt wörtlich; das
// Datum hing nur als age-Attribut am Record, und das Modell musste "71d ago"
// selbst auf das Wort "aktuell" beziehen. annotateVolatileStateForPrompt setzt
// "[Stand TT.MM.JJJJ]" direkt hinter den Zustandsmarker. Der gespeicherte Text
// bleibt unverändert, annotiert wird nur die Prompt-Ausgabe.
//
// Das Datum ist Systemzeit (createdAt, bei Versionen versionCreatedAt), also
// der Zeitpunkt, an dem PLUR1BUS den Satz notiert hat — nie updatedAt, das
// Metadaten-Patches und Statuswechsel neu setzen. Es geht weder in
// validFrom/validUntil noch in die validAt-Filterung ein (Bi-Temporal-Invariante).
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Zeile für den Recall-Block, wenn mindestens ein Record annotiert wurde. */
export const VOLATILE_STATE_INSTRUCTION = "STATE AS OF: Words like aktuell/derzeit/läuft/live/latest/currently inside a record describe the state on its [Stand …] date (when the record was noted), not today. Do not present such a state as current without a live check.";

const VOLATILE_STATE_DEFAULTS = Object.freeze({ enabled: true, minAgeDays: 2, maxPerRecord: 2 });

// Zustandsmarker (deutsch/englisch), an Wortgrenzen. "zur Zeit" (getrennt)
// fehlt absichtlich: "zur Zeit des Unfalls/der Messung" verweist auf ein
// Ereignis, nicht auf "jetzt"; das Label landete dort mitten im Formular-
// oder Sachverhalt. Im Bestand hatte "zur Zeit" keinen echten Treffer, "zurzeit" bleibt.
const VOLATILE_MARKER_RE = /(?<![\p{L}\p{N}_])(aktuell(?:e[mnrs]?)?|derzeit(?:ig(?:e[mnrs]?)?)?|momentan(?:e[mnrs]?)?|zurzeit|jetzt|gerade|läuft|laeuft|live|currently|now running|latest)(?![\p{L}\p{N}_])/giu;
// Ein Wert muss höchstens so viele Zeichen nach dem Marker beginnen.
const VOLATILE_VALUE_MAX_GAP = 30;
// Versionsnummer (7.12.2, 2026.11.3, v4.6) oder Modellname.
const VOLATILE_VALUE_RES = [
  /(?<![\p{L}\p{N}_.])v?\d+(?:\.\d+){1,3}(?![\p{N}])/u,
  /(?<![\p{L}\p{N}_])(?:claude|opus|sonnet|haiku|gpt|gemini|kimi|qwen|llama|mistral|deepseek|grok|glm|nemotron)(?![\p{L}])/iu,
];
// Datum schon in der Nähe: TT.MM.JJJJ, TT.MM. (zweistelliger Monat, keine
// Ziffer danach — "7.12.2." am Satzende und "7.12.61" sind Versionen), ISO,
// "Stand", "as of", Monatsnamen.
const VOLATILE_DATE_RES = [
  /(?<![\d.])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}(?!\d)/,
  /(?<![\d.])(?:0?[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])\.(?![\d])/,
  /(?<!\d)(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)/,
  /(?<![\p{L}])Stand(?![\p{L}])/u,
  /\bas of\b/i,
  /(?<!\d)\d{1,2}\.\s*(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/iu,
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i,
];
const VOLATILE_DATE_WINDOW = 60;
// Höchstens ein Label je so viele Zeichen.
const VOLATILE_LABEL_SPACING = 40;
// Zitate und Inline-Code: dort steht kein eigener Zustand.
const VOLATILE_QUOTE_RE = /„[^“”"\n]{0,400}[“”"]|"[^"\n]{0,400}"|«[^»\n]{0,400}»|»[^«\n]{0,400}«|“[^”\n]{0,400}”|`[^`\n]{0,400}`/g;

/**
 * Normalisiert `recall.volatileStateAnnotation` (enabled, minAgeDays,
 * maxPerRecord). Fehlende oder ungültige Werte fallen auf die Defaults
 * (an, 2 Tage, 2 je Record).
 * @param {object|boolean|null|undefined} raw
 * @returns {{enabled: boolean, minAgeDays: number, maxPerRecord: number}}
 */
export function resolveVolatileStateAnnotationConfig(raw) {
  if (raw === false) return { ...VOLATILE_STATE_DEFAULTS, enabled: false };
  const cfg = raw && typeof raw === "object" ? raw : {};
  const minAgeDays = Number(cfg.minAgeDays);
  const maxPerRecord = Number(cfg.maxPerRecord);
  return {
    enabled: cfg.enabled !== false,
    minAgeDays: Number.isFinite(minAgeDays) && minAgeDays >= 0 ? minAgeDays : VOLATILE_STATE_DEFAULTS.minAgeDays,
    maxPerRecord: Number.isFinite(maxPerRecord) && maxPerRecord >= 1 ? Math.min(10, Math.floor(maxPerRecord)) : VOLATILE_STATE_DEFAULTS.maxPerRecord,
  };
}

/**
 * Wandelt einen Zeitstempel (Number, BigInt aus LanceDB, ISO-String, Date) in
 * Epoch-ms. 0/0n, ungültige oder nicht sicher darstellbare Werte ergeben
 * undefined.
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function toObservedAtMs(value) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return undefined;
    return parseMemoryTimestamp(Number(value));
  }
  return parseMemoryTimestamp(value);
}

function stateDateParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

// Datum in der Gateway-Zeitzone (wie lib/temporal-context.js). Eine ungültige
// Zone fällt auf UTC zurück: das Ergebnis trägt dann timeZoneFallback, und der
// Fehler geht zusätzlich an opts.onError, wenn gesetzt.
function formatStateDate(ms, timeZone, onError) {
  let parts;
  let timeZoneFallback = false;
  try {
    parts = stateDateParts(ms, timeZone || undefined);
  } catch (error) {
    timeZoneFallback = true;
    if (typeof onError === "function") onError(error);
    parts = stateDateParts(ms, "UTC");
  }
  return {
    label: `${parts.day}.${parts.month}.${parts.year}`,
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    timeZoneFallback,
  };
}

function quotedSpans(text) {
  const spans = [];
  VOLATILE_QUOTE_RE.lastIndex = 0;
  for (let m = VOLATILE_QUOTE_RE.exec(text); m; m = VOLATILE_QUOTE_RE.exec(text)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function hasValueAfter(text, from) {
  const tail = text.slice(from, from + VOLATILE_VALUE_MAX_GAP + 40);
  return VOLATILE_VALUE_RES.some((re) => {
    const m = re.exec(tail);
    return Boolean(m) && m.index <= VOLATILE_VALUE_MAX_GAP;
  });
}

function hasDateNear(text, start, end) {
  const window = text.slice(Math.max(0, start - VOLATILE_DATE_WINDOW), end + VOLATILE_DATE_WINDOW);
  return VOLATILE_DATE_RES.some((re) => re.test(window));
}

/**
 * Setzt "[Stand TT.MM.JJJJ]" hinter Zustandsmarker (aktuell, derzeit, läuft,
 * live, latest, currently …), denen innerhalb von 30 Zeichen ein Wert folgt
 * (Versionsnummer, Modellname). Ausgenommen: Zitate und Inline-Code, Stellen
 * mit einem Datum im Umkreis von 60 Zeichen, Docker-/npm-Tags wie ":latest".
 * Höchstens maxPerRecord Labels je Text und eines je 40 Zeichen; Records
 * jünger als minAgeDays bleiben unverändert. Reine Funktion, wirft nicht.
 *
 * @param {string} text bereits für den Prompt bereinigter Text
 * @param {number|bigint|string|Date} observedAt createdAt bzw. versionCreatedAt, nie updatedAt
 * @param {{now?: number, minAgeDays?: number, maxPerRecord?: number, timeZone?: string, onError?: Function}} [opts]
 * @returns {{text: string, annotated: number, stateAsOf: string|null, timeZoneFallback?: true}}
 *   stateAsOf als YYYY-MM-DD, wenn annotiert; timeZoneFallback, wenn die Zone
 *   ungültig war und in UTC datiert wurde
 */
export function annotateVolatileStateForPrompt(text, observedAt, opts = {}) {
  const input = typeof text === "string" ? text : String(text ?? "");
  const unchanged = { text: input, annotated: 0, stateAsOf: null };
  if (!input) return unchanged;
  const observedMs = toObservedAtMs(observedAt);
  if (observedMs === undefined) return unchanged;
  const cfg = resolveVolatileStateAnnotationConfig(opts);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (now - observedMs < cfg.minAgeDays * MS_PER_DAY) return unchanged;

  const spans = quotedSpans(input);
  const inserts = [];
  let lastInsert = Number.NEGATIVE_INFINITY;
  VOLATILE_MARKER_RE.lastIndex = 0;
  for (let m = VOLATILE_MARKER_RE.exec(input); m; m = VOLATILE_MARKER_RE.exec(input)) {
    if (inserts.length >= cfg.maxPerRecord) break;
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].toLowerCase() === "latest" && /[:@/\-_.]/.test(input[start - 1] || "")) continue;
    if (spans.some(([from, to]) => start >= from && start < to)) continue;
    if (end - lastInsert < VOLATILE_LABEL_SPACING) continue;
    if (!hasValueAfter(input, end)) continue;
    if (hasDateNear(input, start, end)) continue;
    inserts.push(end);
    lastInsert = end;
  }
  if (inserts.length === 0) return unchanged;

  const date = formatStateDate(observedMs, opts.timeZone, opts.onError);
  let out = "";
  let cursor = 0;
  for (const at of inserts) {
    out += `${input.slice(cursor, at)} [Stand ${date.label}]`;
    cursor = at;
  }
  out += input.slice(cursor);
  const result = { text: out, annotated: inserts.length, stateAsOf: date.iso };
  if (date.timeZoneFallback) result.timeZoneFallback = true;
  return result;
}
