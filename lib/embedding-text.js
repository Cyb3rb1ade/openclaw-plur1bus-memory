/**
 * lib/embedding-text.js — Text für die Einbettung bereinigen (7.20.10).
 *
 * Bernds Vorschlag 1: roh speichern, bereinigt einbetten. Der gespeicherte
 * Text (Spalte `text`) bleibt wörtlich; nur der Text, aus dem der Vektor
 * entsteht, verliert Hüllen und Rauschen, die nichts über den Inhalt sagen:
 *   - führender Zeitstempel "[2026-11-24 09:43]" / "[Tue 2026-11-24 09:43 GMT+1]"
 *   - Metadatenblöcke des Hosts ("Conversation info (untrusted metadata):" + JSON)
 *   - Umschlag der Sprachnachrichten "[Audio transcript (…)]: "…"" und
 *     Medien-Kopfzeilen ("[Audio]", "User text:", "Transcript:")
 *   - Medien- und Anhang-Stummel als ganze Zeile ("[User schickte audio …]")
 *     und Kanal-Köpfe alter Eingangsumschläge ("[Telegram Christian id:1 …]",
 *     nur mit "id:" im Kopf und nicht als Linktext "[Telegram Bot API](…)")
 *   - Platzhalterzeilen "[visible thinking]", "[visible toolCall: exec]" und <think>-Blöcke
 *   - Bühnenanweisungen aus einer festen Wortliste: in eckigen Klammern
 *     ("[räuspert sich]"), in runden nur in einem Transkript ("(lacht)");
 *     nie als Linktext "[Musik](…)" oder direkt hinter einem Bezeichner ("sleep(pause)")
 *   - Füllwörter (ähm, äh, hm … — dieselbe Liste wie lib/recall-quality.js),
 *     nur zwischen Leerraum und Satzzeichen: nicht in URLs, Pfaden,
 *     Bezeichnern ("hm.com", "/opt/hm/", "ERM-Modell", "UH-60"), nicht als
 *     Einheit hinter einer Zahl ("100 hm") und nicht großgeschrieben mitten
 *     im Satz (Name: "Egbert Ehm")
 *   - Sprecherpräfix nur mit stripSpeaker: Rollenpräfix "User:"/"Assistant:"
 *     und der Sprecher direkt hinter einem Transkript-Umschlag ("Christian:")
 *
 * Runde und eckige Klammern mit anderem Inhalt bleiben stehen; im Bestand
 * sind sie fast immer Inhalt ("(keine Beschränkung)", "[gateway]").
 *
 * Der Regelsatz ist eingefroren: "clean-v1" steht als Wert in der Spalte
 * `embeddingTextMode`. Wer Regeln ändert, führt "clean-v2" ein, damit
 * gemischte Bestände erkennbar bleiben (scripts/reembed-clean.mjs).
 *
 * Rein und ohne Seiteneffekte.
 */

import { STRONG_FILLERS } from "./recall-quality.js";

/** Werte der Spalte `embeddingTextMode`. "raw" = Vektor aus dem gespeicherten Text. */
export const EMBEDDING_TEXT_MODES = Object.freeze(["raw", "clean-v1", "clean-v1-nospeaker"]);

/** Vorgabe von `embedding.cleanText`. stripSpeaker wird erst gemessen. */
export const EMBEDDING_CLEAN_TEXT_DEFAULTS = Object.freeze({ enabled: true, stripSpeaker: false });

const LEADING_TIMESTAMP_RE = /^\s*\[(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?,?\s+)?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|\s*[A-Z]{2,5}(?:[+-]\d{1,2}(?::?\d{2})?)?|\s*[+-]\d{1,2}(?::?\d{2})?)?\]\s*/;
// "Conversation info (untrusted metadata):" + ```json … ``` (auch "Sender (untrusted metadata):").
const METADATA_BLOCK_RE = /^[^\n]{1,80}\(untrusted metadata\):[ \t]*\n```[^\n]*\n[\s\S]*?\n```[ \t]*(?:\n|$)/gm;
const AUDIO_ENVELOPE_RE = /^\s*\[(?:audio transcript|voice transcript|transkript)[^\]\n]*\]:?[ \t]*/i;
const MEDIA_HEADER_LINE_RE = /^[ \t]*\[(?:Audio|Voice|Image|Video|Document|File|Attachment)\][ \t]*$/gim;
const MEDIA_LABEL_LINE_RE = /^[ \t]*(?:User text|Transcript):[ \t]*$/gim;
// Kanal-Kopf alter Eingangsumschläge am Zeilenanfang ("[Telegram Christian id:1 …]").
// Der echte Kopf trägt "id:" (Bestand: alle 40 Treffer); ohne die Bindung
// fielen Linktexte "[Telegram Bot API](…)" und Etiketten "[Signal-Gruppe …]" weg.
const CHANNEL_HEADER_RE = /^[ \t]*\[(?=[^\]\n]{0,160}\bid:)(?:Telegram|Discord|WhatsApp|Signal|Slack|iMessage|Matrix)\b[^\]\n]{0,160}\](?!\()[ \t]*/gm;
const MEDIA_STUB_LINE_RE = /^[ \t]*\[(?:User schickte\b|media attached\b|Audio attachment could not be analyzed|attachment could not be read)[^\]\n]*\][ \t]*$/gim;
const PLACEHOLDER_LINE_RE = /^[ \t]*\[visible (?:thinking|redacted_thinking|reasoning|toolCall|tool_use|toolUse|functionCall|function_call|server_tool_use)\b[^\]\n]*\][ \t]*$/gim;
// Nur geschlossene Blöcke: ein Text, der "<think>" bloß erwähnt (Doku,
// Chat über das Format), verlöre sonst alles bis zum Ende.
const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>/gi;

const STAGE_WORDS = [
  // Deutsch
  "räuspert sich", "räuspern", "lacht", "lachen", "lachend", "lautes lachen", "kichert", "kichern",
  "seufzt", "seufzen", "hustet", "husten", "niest", "schnieft", "schmunzelt", "stöhnt", "gähnt",
  "atmet(?: tief)?(?: ein| aus| durch)?", "kurze pause", "pause", "stille", "unverständlich",
  "musik", "hintergrundgeräusche?", "geräusche?",
  // Englisch
  "laughs", "laughter", "laughing", "chuckles", "sighs", "coughs", "clears throat", "inaudible",
  "music", "silence", "background noise", "applause", "crosstalk",
];
const STAGE_BODY = `[ \\t]*(?:${STAGE_WORDS.join("|")})[ \\t]*[.!]?[ \\t]*`;
// Eckige Klammern überall, aber nicht als Linktext ("[Musik](https://…)") und
// nicht direkt hinter einem Bezeichner.
const STAGE_DIRECTION_RE = new RegExp(`(?<![\\p{L}\\p{N}_])\\[${STAGE_BODY}\\](?!\\()`, "giu");
// Runde Klammern nur in einem Transkript: sonst sind sie fast immer Inhalt
// ("Spotify (Musik)", "Fieber (Husten)", "Strg+P (Pause)", "sleep(pause)").
const STAGE_DIRECTION_ROUND_RE = new RegExp(`(?<![\\p{L}\\p{N}_])\\(${STAGE_BODY}\\)`, "giu");
const AUDIO_HEADER_LINE_RE = /^[ \t]*\[(?:Audio|Voice)\][ \t]*$/im;

// Füllwort nur als eigenes Wort zwischen Leerraum und Satzzeichen. Davor:
// Anfang, Leerraum oder Satzzeichen, keine Zahl ("100 hm" = Höhenmeter).
// Danach: Ende, Leerraum oder Satzzeichen; "." ":" "-" nur mit Leerraum oder
// Ende dahinter ("ähm." am Satzende ja, "hm.com", "erm-model", "UH-60" nein),
// kein "&" ("hm & co").
const FILLER_RE = new RegExp(
  `(?<![^\\s,;!?…()\\[\\]„“”"'«»])(?<!\\p{N}[ \\t]*)(?:${[...STRONG_FILLERS].sort((a, b) => b.length - a.length).join("|")})`
    + `(?=$|[\\s,;!?…)\\]„“”"'«»]|[.:\\-](?:\\s|$)|\\.{2,})(?![ \\t]*&)[ \\t]*[,.…!?]*`,
  "giu",
);

// Großgeschrieben mitten im Satz ("Egbert Ehm hat …"): ein Name, kein Füllwort.
function isCapitalizedMidSentence(match, offset, whole) {
  if (!/^\p{Lu}/u.test(match)) return false;
  const before = whole.slice(0, offset).trimEnd();
  return /[\p{L}\p{N}]$/u.test(before);
}

const ROLE_PREFIX_RE = /^\s*(?:User|Assistant|Human|AI):[ \t]*/i;
const TRANSCRIPT_SPEAKER_RE = /^\s*[\p{Lu}][\p{L}.\-]{0,30}(?: [\p{Lu}][\p{L}.\-]{0,30})?:[ \t]+/u;

/**
 * Normalisiert `embedding.cleanText` ({ enabled, stripSpeaker }). Fehlende
 * oder ungültige Werte: an, Sprecherpräfix bleibt. `false` schaltet ab.
 * @param {object|boolean|null|undefined} raw
 * @returns {{enabled: boolean, stripSpeaker: boolean}}
 */
export function resolveEmbeddingCleanTextConfig(raw) {
  if (raw === false) return { enabled: false, stripSpeaker: false };
  const cfg = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: cfg.enabled !== false,
    stripSpeaker: cfg.stripSpeaker === true,
  };
}

/**
 * Wert für die Spalte `embeddingTextMode` bei dieser Konfiguration.
 * @param {{enabled?: boolean, stripSpeaker?: boolean}} cfg
 * @returns {"raw"|"clean-v1"|"clean-v1-nospeaker"}
 */
export function embeddingTextModeFor(cfg) {
  if (!cfg || cfg.enabled === false) return "raw";
  return cfg.stripSpeaker === true ? "clean-v1-nospeaker" : "clean-v1";
}

function removeAll(text, re, rule, onRule) {
  re.lastIndex = 0;
  let hit = false;
  const spaced = re === STAGE_DIRECTION_RE || re === STAGE_DIRECTION_ROUND_RE || re === FILLER_RE;
  const out = text.replace(re, (match, offset, whole) => {
    if (re === FILLER_RE && isCapitalizedMidSentence(match, offset, whole)) return match;
    hit = true;
    onRule?.(rule, match);
    return spaced ? " " : "";
  });
  return { text: out, hit };
}

function tidyWhitespace(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.!?;:])/g, "$1").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[,;:\s]+/, "")
    .trim();
}

/**
 * Bereinigt einen Text für die Einbettung (Regelsatz clean-v1, siehe Kopf).
 * Greift keine Regel, kommt der Text unverändert zurück (auch Leerraum).
 * Ein Ergebnis "" heißt: nur Hülle — der Aufrufer bettet dann den Rohtext ein.
 *
 * @param {string} text gespeicherter Text
 * @param {{stripSpeaker?: boolean, envelopesOnly?: boolean,
 *   onRule?: (rule: string, fragment: string) => void}} [opts]
 *   envelopesOnly: nur Zeitstempel, Metadaten, Umschläge, Stummel und
 *   Platzhalter (für Anfragen); onRule meldet jede entfernte Stelle.
 * @returns {string}
 */
export function cleanTextForEmbedding(text, opts = {}) {
  const original = typeof text === "string" ? text : String(text ?? "");
  if (!original) return original;
  const onRule = typeof opts.onRule === "function" ? opts.onRule : null;
  // Zeilenenden allein zählen nicht als Änderung (sonst würde die Migration
  // Texte neu einbetten, deren Inhalt gleich bleibt).
  let s = original.replace(/\r\n?/g, "\n");
  let changed = false;

  const ts = s.match(LEADING_TIMESTAMP_RE);
  if (ts) {
    onRule?.("timestamp", ts[0].trim());
    s = s.slice(ts[0].length);
    changed = true;
  }
  for (const [re, rule] of [
    [METADATA_BLOCK_RE, "metadata"],
    [MEDIA_STUB_LINE_RE, "mediaStub"],
    [CHANNEL_HEADER_RE, "channelHeader"],
    [PLACEHOLDER_LINE_RE, "placeholder"],
    [THINK_BLOCK_RE, "thinkBlock"],
  ]) {
    const r = removeAll(s, re, rule, onRule);
    s = r.text;
    changed ||= r.hit;
  }
  const audioHeader = AUDIO_HEADER_LINE_RE.test(s);
  const media = removeAll(s, MEDIA_HEADER_LINE_RE, "mediaHeader", onRule);
  if (media.hit) {
    s = removeAll(media.text, MEDIA_LABEL_LINE_RE, "mediaHeader", onRule).text;
    changed = true;
  }

  let afterEnvelope = false;
  const envelope = s.match(AUDIO_ENVELOPE_RE);
  if (envelope) {
    onRule?.("audioEnvelope", envelope[0].trim());
    s = s.slice(envelope[0].length);
    // Das Transkript steht in Anführungszeichen: "…".
    const trimmed = s.trim();
    if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) s = trimmed.slice(1, -1);
    changed = true;
    afterEnvelope = true;
  }

  if (!opts.envelopesOnly) {
    const transcript = afterEnvelope || audioHeader;
    const rules = [[STAGE_DIRECTION_RE, "stageDirection"], ...(transcript ? [[STAGE_DIRECTION_ROUND_RE, "stageDirection"]] : []), [FILLER_RE, "filler"]];
    for (const [re, rule] of rules) {
      const r = removeAll(s, re, rule, onRule);
      s = r.text;
      changed ||= r.hit;
    }
  }

  if (opts.stripSpeaker === true) {
    const role = s.match(ROLE_PREFIX_RE);
    if (role) {
      onRule?.("speaker", role[0].trim());
      s = s.slice(role[0].length);
      changed = true;
    } else if (afterEnvelope) {
      const speaker = s.match(TRANSCRIPT_SPEAKER_RE);
      if (speaker) {
        onRule?.("speaker", speaker[0].trim());
        s = s.slice(speaker[0].length);
        changed = true;
      }
    }
  }

  return changed ? tidyWhitespace(s) : original;
}

/**
 * Text und Modus für die Einbettung einer Erinnerung. Ist die Bereinigung
 * aus oder bleibt nur Hülle übrig (""), wird der Rohtext eingebettet ("raw").
 * @param {string} text gespeicherter Text
 * @param {{enabled?: boolean, stripSpeaker?: boolean}} cfg aus resolveEmbeddingCleanTextConfig
 * @returns {{text: string, mode: "raw"|"clean-v1"|"clean-v1-nospeaker"}}
 */
export function prepareEmbeddingText(text, cfg) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  const mode = embeddingTextModeFor(cfg);
  if (mode === "raw") return { text: raw, mode };
  const cleaned = cleanTextForEmbedding(raw, { stripSpeaker: cfg.stripSpeaker === true });
  if (!cleaned.trim()) return { text: raw, mode: "raw" };
  return { text: cleaned, mode };
}

/**
 * Text für die Neu-Einbettung einer bestehenden Zeile nach ihrem
 * gespeicherten Modus: clean-v1 bereinigt, clean-v1-nospeaker bereinigt ohne
 * Sprecher, raw (oder unbekannt/leer) wörtlich. Für Schreiber, die den Vektor
 * neu berechnen und die Spalte embeddingTextMode der Quellzeile übernehmen
 * (Re-Embedding-Generation, /share, Legacy-Share-Migration): Modus und Vektor
 * passen so zusammen. Bleibt bei clean-* nur Hülle übrig, gilt raw.
 * @param {string} text gespeicherter Text
 * @param {unknown} mode embeddingTextMode der Zeile
 * @returns {{text: string, mode: "raw"|"clean-v1"|"clean-v1-nospeaker"}}
 */
export function embeddingTextForStoredMode(text, mode) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  if (mode === "clean-v1" || mode === "clean-v1-nospeaker") {
    const cleaned = cleanTextForEmbedding(raw, { stripSpeaker: mode === "clean-v1-nospeaker" });
    if (cleaned.trim()) return { text: cleaned, mode };
  }
  return { text: raw, mode: "raw" };
}

/**
 * Anfrage-Text für die Einbettung im Auto-Recall: nur Hüllen (Zeitstempel,
 * Metadaten, Transkript-Umschlag, Stummel), keine Füllwörter oder
 * Bühnenanweisungen. Den Sprecher nur, wenn auch die Erinnerungen ohne ihn
 * eingebettet werden. Ist die Bereinigung aus oder bleibt nichts übrig,
 * kommt der Rohtext zurück.
 * @param {string} query
 * @param {{enabled?: boolean, stripSpeaker?: boolean}} cfg
 * @returns {string}
 */
export function cleanQueryForEmbedding(query, cfg) {
  const raw = typeof query === "string" ? query : String(query ?? "");
  if (!cfg || cfg.enabled === false) return raw;
  const cleaned = cleanTextForEmbedding(raw, { envelopesOnly: true, stripSpeaker: cfg.stripSpeaker === true });
  return cleaned.trim() ? cleaned : raw;
}
