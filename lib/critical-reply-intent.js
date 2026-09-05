/**
 * lib/critical-reply-intent.js — turn a quoted reply to a Critical Push into
 * a critical-review command.
 *
 * A push names each card by its short reference ("Referenz: 9a019"). When the
 * user quotes such a push and writes "bitte alle akzeptieren" or "alle
 * ablehnen", the host hands the quoted text over as `replyToBody`; this
 * module reads the references out of the quote and the decision out of the
 * reply, nothing else. It never guesses: no references in the quote, no clear
 * verb, or several references without "alle" mean "not for me" and the
 * message goes to the agent as usual.
 */

import { t } from "./i18n.js";

const REF_LINE_RE = /^\s*(?:Referenz|Reference)\s*:\s*([0-9a-f]{5,32})\s*$/gim;
const PUSH_LANGUAGES = ["de", "en"];

const squash = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Is the quoted text one of PLUR1BUS's own pushes? The host names the quoted
 * message's sender only as a display label, so the fixed headline the push
 * always carries is the check: a hand-typed "Referenz: …" line in some other
 * message is not a push and never triggers a decision.
 */
export function looksLikeCriticalPush(text) {
  const haystack = squash(text);
  if (!haystack) return false;
  return PUSH_LANGUAGES.some((lang) => {
    const headline = squash(t("critical.headline", { lang }));
    return headline.length > 0 && haystack.includes(headline);
  });
}
const MAX_REPLY_LENGTH = 200;

// German and English, with the inflections a chat message actually uses.
const REJECT_RE = /\b(ablehn\w*|abgelehnt|verwerf\w*|verworfen|reject\w*|dismiss\w*|declin\w*)\b|\bnicht\s+hervorheb\w*|\bdon'?t\s+highlight\b/i;
const ACCEPT_RE = /\b(akzeptier\w*|annehm\w*|angenommen|bestätig\w*|übernehm\w*|übernommen|hervorheb\w*|accept\w*|approv\w*|confirm\w*|highlight\w*)\b/i;
const NEGATED_ACCEPT_RE = /\b(nicht|kein\w*|not|don'?t|no)\b[^.!?\n]{0,24}\b(akzeptier|annehm|bestätig|übernehm|accept|approv|confirm)/i;
const ALL_RE = /\b(alle|alles|allesamt|sämtliche|beide|all|both|everything)\b/i;
// The reply's own words decide the language of the answer: a German verb or
// "alle"/"bitte" reads as German, otherwise English.
const GERMAN_RE = /\b(akzeptier\w*|annehm\w*|angenommen|bestätig\w*|übernehm\w*|übernommen|hervorheb\w*|ablehn\w*|abgelehnt|verwerf\w*|verworfen|alle|alles|sämtliche|beide|bitte|nicht)\b/i;

/** "de" when the reply uses German words, else "en". */
export function detectReplyLanguage(body) {
  return GERMAN_RE.test(typeof body === "string" ? body : "") ? "de" : "en";
}

/** Short references named in a push, in order, without duplicates. */
export function extractCriticalRefs(text) {
  const refs = [];
  const seen = new Set();
  const source = typeof text === "string" ? text : "";
  for (const match of source.matchAll(REF_LINE_RE)) {
    const ref = match[1].toLowerCase();
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

/**
 * The decision a short reply expresses.
 * @returns {{action: "accept"|"reject", all: boolean} | null}
 */
export function parseCriticalReplyIntent(body) {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text || text.length > MAX_REPLY_LENGTH) return null;
  const all = ALL_RE.test(text);
  if (REJECT_RE.test(text)) return { action: "reject", all };
  if (NEGATED_ACCEPT_RE.test(text)) return null;
  if (ACCEPT_RE.test(text)) return { action: "accept", all };
  return null;
}

/**
 * The critical-review command a quoted reply stands for, or null when the
 * message is not an unambiguous decision about a quoted push.
 * @returns {{action: string, refs: string[], args: string} | null}
 */
export function buildCriticalReplyCommand({ body, replyToBody } = {}) {
  if (!looksLikeCriticalPush(replyToBody)) return null;
  const refs = extractCriticalRefs(replyToBody);
  if (refs.length === 0) return null;
  const intent = parseCriticalReplyIntent(body);
  if (!intent) return null;
  if (!intent.all && refs.length > 1) return null;
  return Object.freeze({
    action: intent.action,
    refs,
    args: `critical ${intent.action} ${refs.join(" ")}`,
    lang: detectReplyLanguage(body),
  });
}
