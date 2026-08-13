/**
 * lib/critical-review.js — UX-Vertrag, Datenschutz und Kurzreferenzen für
 * Critical-Memory-Reviews.
 *
 * Reine, DB-freie Helfer. Sie bilden den gemeinsamen Vertrag zwischen der
 * OpenClaw- und der Hermes-Runtime:
 *
 *   - verständliche Typ- und Grundbezeichnungen (keine internen Rohwerte),
 *   - sichere, begrenzte Vorschauen mit vollständiger Secret-Unterdrückung,
 *   - Source-Role-/Provenienz-Behandlung (keine Assistant-False-Positives),
 *   - Kurzreferenzen (kürzestes eindeutiges UUID-Suffix, min. 5 Hex-Zeichen),
 *   - die Aktionssemantik Accept / Reject (nicht-destruktiv) / Edit.
 */

import { t } from "./i18n.js";
import { safeUuid } from "./sql-safety.js";

// ─── Typ- und Grundbezeichnungen ────────────────────────────────────────────

export const CRITICAL_TYPE_LABELS = Object.freeze({
  person: { de: "Information über eine Person", en: "Information about a person" },
  beziehung: { de: "Persönliche Beziehung", en: "Personal relationship" },
  geburtstag: { de: "Geburtstag oder Jahrestag", en: "Birthday or anniversary" },
  geld_konto: { de: "Finanz- oder Kontoinformation", en: "Financial or account information" },
  gesundheit: { de: "Gesundheitsinformation", en: "Health information" },
  zugang_passwort: { de: "Möglicherweise sensible Zugangsinformation", en: "Possibly sensitive access information" },
});

/**
 * Übersetzt einen internen Critical-Typ in eine verständliche Bezeichnung.
 * Unbekannte Typen werden nie roh angezeigt, sondern sicher fallback-iert.
 *
 * @param {string} type Interner Typ (z. B. "person").
 * @param {string} [lang="de"]
 * @returns {string}
 */
export function translateType(type, lang = "de") {
  const entry = CRITICAL_TYPE_LABELS[type];
  if (!entry) return lang === "de" ? "Möglicherweise besonders wichtige Erinnerung" : "Possibly important memory";
  return entry[lang] || entry.de;
}

const REASON_TEXTS = Object.freeze({
  never_forget: {
    de: "Diese Information wurde ausdrücklich als dauerhaft wichtig markiert.",
    en: "This information was explicitly marked as permanently important.",
  },
  high_importance: {
    de: "PLUR1BUS hat diese Erinnerung als möglicherweise besonders wichtig eingestuft.",
    en: "PLUR1BUS rated this memory as possibly especially important.",
  },
  explicit_critical_language: {
    de: "Die Formulierung wurde als ausdrücklicher Merkwunsch erkannt.",
    en: "The wording was recognized as an explicit request to remember.",
  },
});

/**
 * Übersetzt einen internen Critical-Grund (OpenClaw-/Hermes-Reason) in einen
 * verständlichen Satz. Unbekannte Gründe fallen auf den Typ zurück, nie auf
 * den internen Rohwert.
 *
 * @param {string} reason Interner Grund (z. B. "high_importance").
 * @param {string} [typeFallback] Interner Typ als Fallback-Grund.
 * @param {string} [lang="de"]
 * @returns {string}
 */
export function translateReason(reason, typeFallback = "", lang = "de") {
  const entry = REASON_TEXTS[reason];
  if (entry) return entry[lang] || entry.de;
  if (typeFallback) return translateType(typeFallback, lang);
  return lang === "de" ? "Möglicherweise besonders wichtige Erinnerung" : "Possibly important memory";
}

// ─── Source-Role / Provenienz ───────────────────────────────────────────────

const SOURCE_ROLE_LABELS = Object.freeze({
  user: { de: "Benutzer", en: "User" },
  assistant: { de: "Assistent", en: "Assistant" },
  correction: { de: "Korrektur", en: "Correction" },
});

/**
 * Bestimmt die Quellrolle einer Memory-Karte aus den vorhandenen Feldern.
 *
 * @param {object} card
 * @returns {"user"|"assistant"|"correction"|"unknown"}
 */
export function resolveSourceRole(card = {}) {
  const role = String(card?.sourceMessageRole || "").toLowerCase();
  if (role === "user") return "user";
  if (role === "assistant" || role === "agent") return "assistant";
  const origin = String(card?.origin || "").toLowerCase();
  if (origin === "correction" || origin === "correct" || origin === "edit") return "correction";
  return "unknown";
}

/**
 * Übersetzt eine Quellrolle in eine verständliche Bezeichnung.
 *
 * @param {"user"|"assistant"|"correction"|"unknown"} role
 * @param {string} [lang="de"]
 * @returns {string}
 */
export function translateSourceRole(role, lang = "de") {
  const entry = SOURCE_ROLE_LABELS[role];
  if (entry) return entry[lang] || entry.de;
  return lang === "de" ? "Unbekannt" : "Unknown";
}

/**
 * Ist die Karte vom Assistenten (nicht vom Benutzer) stammend?
 *
 * @param {object} card
 * @returns {boolean}
 */
export function isAssistantSourced(card = {}) {
  return resolveSourceRole(card) === "assistant";
}

/**
 * Hat die Karte ein explizites Wichtigkeitssignal, das unabhängig von der
 * Quellrolle berücksichtigt werden muss (neverForget oder hohe Importance)?
 *
 * @param {object} card
 * @returns {boolean}
 */
export function hasExplicitImportanceSignal(card = {}) {
  if (card?.neverForget === true || card?.neverForget === 1) return true;
  const importance = Number(card?.importance);
  if (Number.isFinite(importance) && importance >= 0.9) return true;
  const coreMemoryScore = Number(card?.coreMemoryScore);
  if (Number.isFinite(coreMemoryScore) && coreMemoryScore >= 0.9) return true;
  return false;
}

/**
 * Entscheidet, ob eine Karte trotz Quellrolle für einen Critical-Push in
 * Frage kommt. Ein bloßer (LLM-)Klassifikations-Treffer in einer
 * Assistentenantwort reicht nicht aus; explizite Wichtigkeitssignale bleiben
 * aber wirksam.
 *
 * @param {object} card
 * @returns {boolean}
 */
export function isEligibleForCriticalHighlight(card = {}) {
  if (!isAssistantSourced(card)) return true;
  return hasExplicitImportanceSignal(card);
}

// ─── Vorschau- und Datenschutzpolitik ───────────────────────────────────────

const SENSITIVE_SUPPRESSED_TYPES = new Set(["zugang_passwort", "gesundheit", "geld_konto"]);

/**
 * Typen, deren Inhalt vollständig unterdrückt wird.
 *
 * @param {string} type
 * @returns {boolean}
 */
export function isSuppressedType(type) {
  return SENSITIVE_SUPPRESSED_TYPES.has(String(type || ""));
}

const PREVIEW_MAX_LEN = 160;

/**
 * Normalisiert und begrenzt eine Vorschau und neutralisiert Telegram-/Markdown-/
 * HTML-/Control-Character-Injection.
 *
 * @param {string} text
 * @param {number} [maxLen=PREVIEW_MAX_LEN]
 * @returns {string}
 */
export function sanitizePreview(text, maxLen = PREVIEW_MAX_LEN) {
  if (typeof text !== "string" || text.length === 0) return "";
  // 1. Control- und unsichtbare Zeichen entfernen.
  let s = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  // 2. Whitespace kollabieren (Zeilenumbrüche → Leerzeichen).
  s = s.replace(/\s+/g, " ").trim();
  // 3. Markdown/HTML-Sonderzeichen neutralisieren, damit sie nicht als
  //    Formatierung interpretiert werden können.
  s = s.replace(/[`*_\[\]<>#&|]/g, "");
  // 4. Längenbegrenzung.
  if (s.length > maxLen) s = `${s.slice(0, maxLen - 1).trimEnd()}…`;
  return s;
}

/**
 * Liefert eine sichere, begrenzte Vorschau gemäß Datenschutzvertrag.
 * Sensible Typen (Zugang/Passwort, Gesundheit, Finanzen) werden vollständig
 * unterdrückt.
 *
 * @param {object} card
 * @param {object} [opts]
 * @returns {{suppressed: boolean, text: string, reason: string}}
 */
export function buildPreview(card = {}, opts = {}) {
  const lang = opts.lang || "de";
  const type = String(card?.type || "");
  if (isSuppressedType(type)) {
    return {
      suppressed: true,
      text: "",
      reason: type === "zugang_passwort"
        ? (lang === "de"
          ? "Der Inhalt wird ausgeblendet, weil er möglicherweise Zugangsdaten oder andere sensible Angaben enthält."
          : "The content is hidden because it may contain credentials or other sensitive information.")
        : (lang === "de"
          ? "Der Inhalt wird aus Datenschutzgründen ausgeblendet."
          : "The content is hidden for privacy reasons."),
    };
  }
  const preview = sanitizePreview(card?.text || card?.summary || card?.title || "", opts.maxLen);
  return { suppressed: false, text: preview, reason: "" };
}

// ─── Kurzreferenzen ─────────────────────────────────────────────────────────

export const SHORT_REF_MIN_LEN = 5;
const HEX_SUFFIX_RE = /^[0-9a-f]+$/i;

/**
 * Liefert das kürzeste eindeutige Suffix einer UUID, mindestens `minLen` Zeichen
 * lang, das mit keinem bereits vergebenen Suffix kollidiert. Nicht-UUID-IDs
 * (z. B. Test-Fixtures) erhalten einen stabilen Fallback statt zu werfen.
 *
 * @param {string} uuid Vollständige kanonische UUID.
 * @param {Set<string>} takenSuffixes Bereits vergebene Suffixe (lowercase).
 * @param {number} [minLen=SHORT_REF_MIN_LEN]
 * @returns {string} Lowercase-Suffix.
 */
export function shortestUniqueSuffix(uuid, takenSuffixes, minLen = SHORT_REF_MIN_LEN) {
  const hex = String(uuid ?? "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    // Nicht-UUID: stabiler, kollisionsfreier Fallback.
    let base = hex.replace(/[^0-9a-f]/g, "").slice(-Math.max(1, minLen));
    if (!base) base = "mem";
    let candidate = base;
    let n = 0;
    while (takenSuffixes.has(candidate) && n < 10000) {
      n += 1;
      candidate = `${base}${n.toString(16)}`;
    }
    return candidate;
  }
  let len = Math.max(1, minLen);
  for (; len <= hex.length; len += 1) {
    const suffix = hex.slice(-len);
    if (!takenSuffixes.has(suffix)) return suffix;
  }
  // Vollständige UUID als allerletzten Fallback (Kollision über alle Zeichen).
  return hex;
}

/**
 * Weist einer Liste von UUIDs eindeutige Kurzreferenzen zu (gierig, stabil).
 *
 * @param {string[]} ids
 * @param {number} [minLen=SHORT_REF_MIN_LEN]
 * @returns {Map<string, string>} id → Kurzreferenz (lowercase).
 */
export function assignShortRefs(ids, minLen = SHORT_REF_MIN_LEN) {
  const result = new Map();
  const taken = new Set();
  for (const id of ids) {
    const ref = shortestUniqueSuffix(id, taken, minLen);
    taken.add(ref);
    result.set(id, ref);
  }
  return result;
}

/**
 * Normalisiert eine Benutzer-Kurzreferenz. Akzeptiert nur streng validierte
 * hexadezimale UUID-Suffixe mit der Mindestlänge (oder eine vollständige UUID).
 *
 * @param {string} input
 * @param {number} [minLen=SHORT_REF_MIN_LEN]
 * @returns {{ok: boolean, value?: string, kind?: "suffix"|"uuid", error?: string}}
 */
export function normalizeShortRef(input, minLen = SHORT_REF_MIN_LEN) {
  const raw = String(input ?? "").trim().toLowerCase();
  if (raw.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw)) {
    return { ok: true, value: raw, kind: "uuid" };
  }
  if (raw.length < minLen || raw.length > 32) {
    return { ok: false, error: "invalid_format" };
  }
  if (!HEX_SUFFIX_RE.test(raw)) {
    return { ok: false, error: "invalid_format" };
  }
  return { ok: true, value: raw, kind: "suffix" };
}

/**
 * Löst eine Kurzreferenz (oder vollständige UUID) gegen die ausstehenden
 * Reviews des autorisierten Scopes auf. Genau ein Treffer → vollständige,
 * validierte UUID; null Treffer → "not_found"; mehrere → "ambiguous" mit
 * eindeutigeren Vorschlägen.
 *
 * @param {string} input Benutzereingabe.
 * @param {Array<{id: string}>} pendingReviews Ausstehende Reviews (nur autorisierter Scope).
 * @param {number} [minLen=SHORT_REF_MIN_LEN]
 * @returns {{ok: boolean, id?: string, error?: string, suggestions?: string[]}}
 */
export function resolveShortRef(input, pendingReviews = [], minLen = SHORT_REF_MIN_LEN) {
  const normalized = normalizeShortRef(input, minLen);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  if (normalized.kind === "uuid") {
    const match = pendingReviews.some((r) => String(r?.id || "").toLowerCase() === normalized.value);
    if (!match) return { ok: false, error: "not_found" };
    try {
      return { ok: true, id: safeUuid(normalized.value) };
    } catch {
      return { ok: false, error: "not_found" };
    }
  }

  const suffix = normalized.value;
  const matches = pendingReviews
    .filter((r) => typeof r?.id === "string" && r.id.replace(/-/g, "").toLowerCase().endsWith(suffix));

  if (matches.length === 0) return { ok: false, error: "not_found" };
  if (matches.length === 1) {
    try {
      return { ok: true, id: safeUuid(matches[0].id) };
    } catch {
      return { ok: false, error: "not_found" };
    }
  }

  // Kollision: automatisch längere, im Scope eindeutige Referenzen vorschlagen.
  const suggestions = [];
  for (const match of matches) {
    const others = new Set(
      matches
        .filter((m) => m.id !== match.id)
        .map((m) => m.id.replace(/-/g, "").toLowerCase().slice(-32)),
    );
    const ref = shortestUniqueSuffix(match.id, others, suffix.length + 1);
    suggestions.push(ref);
  }
  return { ok: false, error: "ambiguous", suggestions };
}

// ─── Nachricht + Buttons (gemeinsamer UX-Vertrag) ───────────────────────────

/**
 * Baut die vollständige Critical-Review-Nachricht samt verständlichen Buttons
 * und Textbefehls-Fallback. Callback-Daten enthalten ausschließlich die
 * kanonische UUID (intern) — niemals Memory-Inhalte.
 *
 * @param {object} card — { id, type, title, text, summary, source, date, sourceMessageRole, shortRef }
 * @param {object} [opts] — { lang, tone }
 * @returns {{text: string, inline_keyboard: Array<Array<{text: string, callback_data: string}>>}}
 */
export function buildCriticalMessage(card = {}, opts = {}) {
  const lang = opts.lang || "de";
  const tone = opts.tone || "default";
  const id = card?.id || "";
  const shortRef = card?.shortRef || "";

  const preview = buildPreview(card, { lang });
  const reason = translateReason(card?.reason || "", card?.type || "", lang);
  const sourceRole = resolveSourceRole(card);
  const source = translateSourceRole(sourceRole, lang);

  const lines = [];
  lines.push(t("critical.headline", { lang, tone }));
  lines.push("");
  if (preview.suppressed) {
    lines.push(`„${preview.reason}“`);
  } else if (preview.text) {
    lines.push(`„${preview.text}“`);
  }
  lines.push(t("critical.reason", { lang, tone, vars: { reason } }));
  lines.push(t("critical.source", { lang, tone, vars: { source } }));
  if (shortRef) {
    lines.push(lang === "de" ? `Referenz: ${shortRef}` : `Reference: ${shortRef}`);
  }
  lines.push("");
  lines.push(t("critical.question", { lang, tone }));
  lines.push("");
  lines.push(t("critical.fallback_intro", { lang, tone }));
  lines.push(t("critical.fallback_accept", { lang, tone, vars: { command: `/plur1bus critical accept ${shortRef}` } }));
  lines.push(t("critical.fallback_reject", { lang, tone, vars: { command: `/plur1bus critical reject ${shortRef}` } }));
  lines.push(t("critical.fallback_edit", { lang, tone, vars: { command: `/plur1bus critical edit ${shortRef}` } }));
  lines.push("");
  lines.push(t("critical.reject_hint", { lang, tone }));

  const inline_keyboard = [[
    { text: t("critical.button_accept", { lang, tone }), callback_data: `crit:ok:${id}` },
    { text: t("critical.button_reject", { lang, tone }), callback_data: `crit:no:${id}` },
    { text: t("critical.button_edit", { lang, tone }), callback_data: `crit:edit:${id}` },
  ]];

  return { text: lines.join("\n"), inline_keyboard };
}
