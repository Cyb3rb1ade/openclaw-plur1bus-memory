/**
 * lib/recall-quality.js — Qualitätsgewicht einer Erinnerung für den Auto-Recall.
 *
 * Hintergrund (7.20.10, Bernds Vorschlag 2): Alles bleibt gespeichert, nichts
 * wird gefiltert oder archiviert. Schwache Einträge (Host-Meldungen,
 * inhaltsleere Selbstvorstellungen von Hilfsagenten, Füllwort-Fragmente aus
 * Sprachnachrichten, Platzhalterzeilen) sollen im Auto-Recall aber nicht mehr
 * vor inhaltlichen Treffern stehen. Das Gewicht wird beim Recall aus einfachen
 * Regeln berechnet, es gibt keine neue Spalte. Die Pipeline multipliziert es
 * mit dem Score nach dem Rerank (lib/recall-pipeline.js, applyAutoRecallPolicy);
 * memory_recall und memory_search sehen es nie.
 *
 * Rein und ohne Abhängigkeiten (lib/query-echo.js importiert von hier den
 * Talk-Mode-Präfix). Die Regeln sind bewusst eng: Subagent- und
 * Cron-Erinnerungen werden nicht nach Herkunft abgewertet, nur nach Inhalt.
 */

/** Untergrenze des Gewichts, wenn recall.qualityWeighting.floor fehlt. */
export const RECALL_QUALITY_DEFAULT_FLOOR = 0.35;

/**
 * Faktoren je Regel. Treffen mehrere Regeln zu, wird multipliziert und auf
 * die Untergrenze angehoben.
 */
export const RECALL_QUALITY_WEIGHTS = Object.freeze({
  // Nur Platzhalterzeilen ("[visible thinking]", "[visible toolCall: exec]").
  placeholderOnly: 0.35,
  // Text beginnt mit einem Thinking-Platzhalter oder <think>.
  thinkingPrefix: 0.7,
  // Reine Host-Hülle ohne Nutzlast ("Continue the OpenClaw runtime event.",
  // "Exec failed (…, signal SIGTERM)", eingefangener Recall-Block).
  hostEnvelope: 0.4,
  // Host-Meldung mit Nutzlast ("Exec completed (…) :: <Ausgabe>", Cron-Zustellung).
  hostMessage: 0.6,
  // "Ich bin ein …-Agent. Meine Aufgabe ist …" ohne weiteren Inhalt; nur
  // wenn der Text nicht vom Nutzer stammt.
  selfIntro: 0.4,
  fillerHeavy: 0.75,
  filler: 0.9,
  veryShort: 0.8,
  short: 0.9,
  // Behauptung des Assistenten (sourceMessageRole assistant): leicht tiefer.
  assistantClaim: 0.9,
});

// Ab diesem Füllwortanteil (stark + halb schwach, je Wort) greift die Regel.
const FILLER_HEAVY_RATIO = 0.15;
const FILLER_RATIO = 0.08;
const FILLER_MIN_TOKENS = 5;
const VERY_SHORT_CHARS = 30;
const SHORT_CHARS = 60;
// Eine Selbstvorstellung gilt nur als inhaltsleer, wenn sie den Eintrag ausmacht.
const SELF_INTRO_MAX_CHARS = 500;
// Füllwörter und Anker werden nur im Anfang langer Texte gezählt.
const ANALYSIS_MAX_CHARS = 1500;
// Weniger Nutzlast als das: im Ranking wie eine reine Hülle (Gewicht 0,4
// statt 0,6). Der Capture verwirft nur Hüllen ganz ohne Nutzlast.
const HOST_PAYLOAD_MIN_CHARS = 40;

// Platzhalterzeilen, die neo-arch.js bis 7.20.9 für verborgene Blöcke schrieb.
const PLACEHOLDER_LINE_RE = /^[ \t]*\[visible (?:thinking|redacted_thinking|reasoning|toolCall|tool_use|toolUse|functionCall|function_call|server_tool_use)\b[^\]\n]*\][ \t]*$/gim;
// Nur geschlossene Blöcke: ein Text, der "<think>" bloß erwähnt, verlöre sonst
// alles ab dem Tag und würde als kurz bzw. leer abgewertet.
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;
const THINKING_PREFIX_RE = /^\s*(?:\[visible (?:thinking|redacted_thinking|reasoning)\b[^\]\n]*\]|<think>)/i;

// Rollen-Präfix der alten Skript-Erfassung ("User: …", "Assistant: …").
const ROLE_PREFIX_RE = /^\s*(User|Assistant):\s*/i;
// Umschlag der Sprachnachrichten-Transkription.
const AUDIO_PREFIX_RE = /^\s*\[(?:audio transcript|voice transcript|transkript)[^\]]*\]:?\s*"?/i;
// Präfix, den der Host im Talk Mode einer echten Sprachnachricht voranstellt
// (OpenClawKit TalkPromptBuilder): Anweisungszeile, optional der ElevenLabs-
// Hinweis und die Unterbrechungszeile, danach Leerzeile und das Transkript.
// Was folgt, ist Nutzertext, keine Host-Nutzlast.
const TALK_MODE_PREFIX_RE = /^\s*Talk Mode active\. Reply in a concise, spoken tone\.?(?:[ \t]*\n?[ \t]*You may optionally prefix the response with JSON \(first line\) to set ElevenLabs voice[^\n]*)?(?:[ \t]*\n?[ \t]*Assistant speech interrupted at \d+(?:\.\d+)?s\.?)?\s*/i;

// Reine Hüllen am Textanfang: eingefangene Recall-Blöcke und Host-Anweisungen.
// Was darauf folgt, ist eingespeister Kontext, keine eigene Aussage.
const HOST_ENVELOPE_START_RES = [
  /^Continue the OpenClaw runtime event\b/i,
  /^\[(?:Subagent Context|Inter-session message)\]/i,
  /^You are running as a subagent\b/i,
  /^You are a memory search agent\b/i,
  /^\[assistant turn failed\b/i,
  /^<(?:plur1bus-recall|relevant-memories|memory-reactivation|memory-semantic-lens|plur1bus-neo)\b/i,
];
// Host-Meldungen am Textanfang, die eine Nutzlast tragen können.
// "System: [Zeitstempel]" steht vor System-Events, die OpenClaw an eine
// Nutzernachricht hängt; "[Subagent Task]" ist ein Auftrag des Elternagenten.
// Talk Mode gehört nicht hierher: dahinter steht eine Äußerung des Nutzers
// (TALK_MODE_PREFIX_RE, wird vorher abgeschnitten).
const HOST_MESSAGE_START_RES = [
  /^System:\s/i,
  /^Exec (?:failed|completed|finished|denied|timed out)\b/i,
  /^A background task (?:completed|failed)\b/i,
  /^A scheduled cron job delivered\b/i,
  /^\[Subagent Task\]/i,
];
// Bausteine ohne eigenen Inhalt, die beim Messen der Nutzlast wegfallen.
const HOST_BOILERPLATE_RES = [
  /^System:\s*(?:\[[^\]\n]{0,60}\]\s*)?/gim,
  /Exec (?:failed|completed|finished|denied|timed out)\s*\([^)\n]{0,80}\)\s*(?:::)?/gi,
  /The command was terminated, but external side effects may already have completed\.[^\n]*/gi,
  /A background task (?:completed|failed)\. Use this result to reply to the user in your normal assistant voice\.?/gi,
  /A scheduled cron job delivered this message to this channel:?/gi,
  /Continue the OpenClaw runtime event\.?/gi,
  /\[(?:Subagent Task|Inter-session message)\]/gi,
  /\[assistant turn failed[^\]\n]{0,80}\]/gi,
  /^[ \t]*(?:source|session_key|sessionKey|task_id|status):[^\n]*$/gim,
];
// Nutzlast: mindestens ein Buchstabe oder eine Ziffer nach den Bausteinen.
const PAYLOAD_CHAR_RE = /[\p{L}\p{N}]/u;

// Selbstvorstellung eines Agenten am Textanfang.
const SELF_INTRO_RE = /^(?:(?:Hallo|Hi|Hey|Hello)[!,.]?\s*)?(?:Ich bin (?:ein|eine|der|die|dein|deine)\s+[\p{L}\p{N}-]*(?:Agent|Agentin|Assistent|Assistentin|Bot|Cron-Job|Job|Subagent|KI|Modell|Sprachmodell|Helfer)\b|I(?:'m| am) (?:a|an|your|the)\s+[\p{L}\p{N} -]{0,30}?(?:agent|assistant|bot|AI|model|subagent)\b)/iu;

// Füllwörter. Stark zählen immer; schwach sind gewöhnliches Deutsch und
// zählen nur halb. "um" fehlt absichtlich (deutsche Präposition).
// Exportiert für lib/embedding-text.js (bereinigte Einbettung, gleiche Liste).
export const STRONG_FILLERS = new Set(["ähm", "äh", "ähh", "äähm", "öhm", "öh", "ehm", "ähem", "hmm", "hm", "mhm", "uh", "uhm", "umm", "erm"]);
const WEAK_FILLERS = new Set(["also", "halt", "quasi", "sozusagen", "irgendwie", "eben", "naja", "gell", "eigentlich", "basically", "literally", "like"]);
const TOKEN_RE = /[\p{L}\p{N}']+/gu;

// Anker, die einen kurzen Text gehaltvoll machen: Zahl, URL, Handle, Pfad
// oder Bezeichner, CamelCase, Akronym, Zitat.
const ANCHOR_RES = [
  /\p{N}/u,
  /https?:\/\//i,
  /[@#][\p{L}\p{N}_]{2,}/u,
  /[\p{L}\p{N}][/_][\p{L}\p{N}]/u,
  /\p{L}\.\p{L}{2,}/u,
  /\p{Ll}\p{Lu}/u,
  /(?<![\p{L}])\p{Lu}{2,}(?![\p{Ll}])/u,
  /[„“"`«»]/u,
];

/**
 * Normalisiert `recall.qualityWeighting` ({ enabled, floor }). Fehlende oder
 * ungültige Werte: an, Untergrenze 0,35.
 * @param {object|boolean|null|undefined} raw
 * @returns {{enabled: boolean, floor: number}}
 */
export function resolveQualityWeightingConfig(raw) {
  if (raw === false) return { enabled: false, floor: RECALL_QUALITY_DEFAULT_FLOOR };
  const cfg = raw && typeof raw === "object" ? raw : {};
  const floor = Number(cfg.floor);
  return {
    enabled: cfg.enabled !== false,
    floor: Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : RECALL_QUALITY_DEFAULT_FLOOR,
  };
}

function stripPlaceholders(text) {
  PLACEHOLDER_LINE_RE.lastIndex = 0;
  THINK_BLOCK_RE.lastIndex = 0;
  return text.replace(PLACEHOLDER_LINE_RE, "").replace(THINK_BLOCK_RE, "");
}

/**
 * Schneidet den Talk-Mode-Präfix des Hosts vorne ab ("Talk Mode active. Reply
 * in a concise, spoken tone." samt optionalen Hinweiszeilen). Ohne Präfix
 * kommt der Text unverändert zurück. Für Gewicht und Echo-Prüfung zählt nur
 * die Äußerung dahinter; der gespeicherte Text bleibt wörtlich.
 * @param {string} text
 * @returns {string}
 */
export function stripTalkModePrefix(text) {
  const s = String(text ?? "");
  const m = TALK_MODE_PREFIX_RE.exec(s);
  return m ? s.slice(m[0].length) : s;
}

function stripEnvelopes(text) {
  return stripTalkModePrefix(text.replace(ROLE_PREFIX_RE, "")).replace(AUDIO_PREFIX_RE, "").trim();
}

function hostPayloadRest(text) {
  let rest = text;
  for (const re of HOST_BOILERPLATE_RES) {
    re.lastIndex = 0;
    rest = rest.replace(re, " ");
  }
  return rest.replace(/[\s|:.\-–—*_>]+/g, " ").trim();
}

function hostPayloadChars(text) {
  return hostPayloadRest(text).length;
}

function fillerRatio(text) {
  const tokens = text.toLowerCase().match(TOKEN_RE) || [];
  if (tokens.length < FILLER_MIN_TOKENS) return 0;
  let score = 0;
  for (const token of tokens) {
    if (STRONG_FILLERS.has(token)) score += 1;
    else if (WEAK_FILLERS.has(token)) score += 0.5;
  }
  return score / tokens.length;
}

function hasAnchor(text) {
  return ANCHOR_RES.some((re) => re.test(text));
}

/**
 * True, wenn der Text nur eine Host-Hülle ohne Nutzlast ist ("Continue the
 * OpenClaw runtime event.", "Exec failed (…, signal SIGTERM)", "System: [Zeit]"
 * ohne weiteren Text, ein Talk-Mode-Präfix ohne Äußerung). Solche Züge
 * verwirft der Capture (7.20.10). Bleibt nach den festen Bausteinen auch nur
 * ein Buchstabe oder eine Ziffer übrig ("Exec completed (…) :: ok", ein
 * kurzer Sprachbefehl hinter dem Talk-Mode-Präfix, "[Subagent Task] Prüfe den
 * Kalender"), ist es Nutzlast und wird gespeichert; wie viel sie wert ist,
 * entscheidet das Ranking (computeRecallQualityWeight). Reine Funktion, wirft nicht.
 * @param {string} text
 * @returns {boolean}
 */
export function isContentFreeHostEnvelope(text) {
  const raw = String(text ?? "");
  if (!raw.trim()) return false;
  const withoutPlaceholders = stripPlaceholders(raw);
  const body = stripEnvelopes(withoutPlaceholders);
  if (!body) {
    // Nur der Talk-Mode-Präfix, keine Äußerung dahinter.
    return TALK_MODE_PREFIX_RE.test(withoutPlaceholders.replace(ROLE_PREFIX_RE, ""));
  }
  const startsAsHost = HOST_ENVELOPE_START_RES.some((re) => re.test(body))
    || HOST_MESSAGE_START_RES.some((re) => re.test(body));
  return startsAsHost && !PAYLOAD_CHAR_RE.test(hostPayloadRest(body));
}

/**
 * Berechnet das Qualitätsgewicht einer Erinnerung aus Text und Herkunftsrolle.
 * Regeln: Platzhalter/Thinking-Präfix, Host-Hülle bzw. Host-Meldung,
 * inhaltsleere Agent-Selbstvorstellung (nicht bei Nutzertext), Füllwortanteil,
 * Länge ohne Anker (Zahl, URL, Handle, Pfad oder Bezeichner, CamelCase,
 * Akronym, Zitat; gewöhnliche Namen zählen nicht), Assistenten-Behauptung.
 * Ein Talk-Mode-Präfix zählt nicht mit. Reine Funktion, wirft nicht.
 *
 * @param {{text?: string, summary?: string, sourceMessageRole?: string, epistemicStatus?: string}} entry
 * @param {{floor?: number}} [opts]
 * @returns {{weight: number, rules: string[]}} weight in [floor, 1]; rules in Prüfreihenfolge
 */
export function computeRecallQualityWeight(entry, opts = {}) {
  const floorRaw = Number(opts.floor);
  const floor = Number.isFinite(floorRaw) && floorRaw >= 0 && floorRaw <= 1 ? floorRaw : RECALL_QUALITY_DEFAULT_FLOOR;
  const raw = String(entry?.text || entry?.summary || "");
  const rules = [];
  let weight = 1;
  const apply = (rule) => {
    rules.push(rule);
    weight *= RECALL_QUALITY_WEIGHTS[rule];
  };
  if (!raw.trim()) return { weight: 1, rules };

  const rolePrefix = ROLE_PREFIX_RE.exec(raw)?.[1]?.toLowerCase() || "";
  const role = String(entry?.sourceMessageRole || "").toLowerCase() || rolePrefix;
  const withoutPlaceholders = stripPlaceholders(raw);
  const body = stripEnvelopes(withoutPlaceholders);

  if (!body) {
    // Ein Talk-Mode-Präfix ohne Äußerung ist eine Hülle, kein Platzhalter.
    apply(TALK_MODE_PREFIX_RE.test(withoutPlaceholders.replace(ROLE_PREFIX_RE, "")) ? "hostEnvelope" : "placeholderOnly");
  } else if (THINKING_PREFIX_RE.test(stripEnvelopes(raw))) {
    apply("thinkingPrefix");
  }

  if (body && HOST_ENVELOPE_START_RES.some((re) => re.test(body))) {
    apply("hostEnvelope");
  } else if (body && HOST_MESSAGE_START_RES.some((re) => re.test(body))) {
    apply(hostPayloadChars(body) < HOST_PAYLOAD_MIN_CHARS ? "hostEnvelope" : "hostMessage");
  } else if (body && role !== "user" && body.length <= SELF_INTRO_MAX_CHARS && SELF_INTRO_RE.test(body)) {
    // Selbstvorstellungen kommen vom Agenten. Ein Nutzer, der sich beschreibt
    // ("Ich bin eine KI-Forscherin bei …"), sagt etwas über sich.
    apply("selfIntro");
  }

  if (body) {
    const ratio = fillerRatio(body.slice(0, ANALYSIS_MAX_CHARS));
    if (ratio >= FILLER_HEAVY_RATIO) apply("fillerHeavy");
    else if (ratio >= FILLER_RATIO) apply("filler");
    if (body.length < SHORT_CHARS && !hasAnchor(body)) {
      apply(body.length < VERY_SHORT_CHARS ? "veryShort" : "short");
    }
  }

  if (role === "assistant" || entry?.epistemicStatus === "assistant_asserted") apply("assistantClaim");

  return { weight: Math.min(1, Math.max(floor, weight)), rules };
}
