/**
 * lib/log-redact.js
 *
 * Content-free descriptors for log lines. Logs may carry ids, lengths, counts
 * and short hashes, but never memory text, user prompts, reminder text or a
 * plain channel peer id (privacy rule; N2 leak audit I-1..I-4).
 */

import { createHash } from "node:crypto";

/**
 * @param {unknown} value Any value; stringified before hashing.
 * @returns {string} First 12 hex chars of sha256.
 */
export function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12);
}

/**
 * @param {unknown} text Memory text, prompt or reminder text.
 * @returns {string} `textLen=<n> sha=<12 hex>`; reveals neither content nor prefix.
 */
export function describeText(text) {
  const s = typeof text === "string" ? text : String(text ?? "");
  return `textLen=${s.length} sha=${shortHash(s)}`;
}

/**
 * Webhook and provider URLs carry secrets in userinfo, path or query (Discord,
 * Slack, Telegram webhooks; `?key=` provider endpoints). Only scheme and host
 * may reach an error message or a log line (N2 leak audit U-4, M-5).
 *
 * @param {unknown} url URL string or URL object.
 * @returns {string} `<scheme>//<host[:port]>` plus ` pathHash=<12 hex>` when a path or query exists; `url=<invalid> hash=<12 hex>` when it does not parse. Never userinfo, path or query.
 */
export function redactUrl(url) {
  const raw = String(url ?? "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return `url=<invalid> hash=${shortHash(raw)}`;
  }
  const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  const origin = parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  return rest ? `${origin} pathHash=${shortHash(rest)}` : origin;
}

const URL_IN_TEXT_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/gi;

/**
 * Replaces every absolute URL inside free text (for example a runtime error
 * message such as `Failed to parse URL from <url>`) with its redacted form.
 *
 * @param {unknown} text Error message or other free text.
 * @returns {string} Text with each `scheme://...` run passed through {@link redactUrl}.
 */
export function redactUrlsInText(text) {
  return String(text ?? "").replace(URL_IN_TEXT_RE, (m) => redactUrl(m));
}

const SESSION_KINDS = new Set(["direct", "group", "channel", "dm", "thread", "topic"]);

/**
 * Session keys look like `agent:<id>:<channel>:<account>:<kind>:<peer>`. The
 * peer is a plain channel user or chat id, so only a hash of it is kept.
 *
 * @param {unknown} sessionKey Raw session key.
 * @returns {string} `agent=<id> channel=<ch> kind=<kind> peer=<hash>`, or `sessionKeyHash=<hash>` when unparseable.
 */
export function describeSessionKey(sessionKey) {
  const key = String(sessionKey ?? "");
  if (!key) return "none";
  const parts = key.split(":");
  if (parts[0] === "agent" && parts.length >= 5) {
    const kindAt = parts.findIndex((p, i) => i >= 3 && SESSION_KINDS.has(p));
    if (kindAt > 0 && kindAt < parts.length - 1) {
      return `agent=${parts[1]} channel=${parts[2]} kind=${parts[kindAt]} peer=${shortHash(parts.slice(kindAt + 1).join(":"))}`;
    }
  }
  return `sessionKeyHash=${shortHash(key)}`;
}

/**
 * Allowlist summary of a reminder-dispatch result: ids, counts and lengths only.
 *
 * @param {object} result Result of runReminderDispatch.
 * @returns {object} Result with reminder text replaced by `textLen`.
 */
export function summarizeReminderResultForLog(result) {
  if (!result || typeof result !== "object") return result;
  const { details, ...rest } = result;
  if (!Array.isArray(details)) return rest;
  return {
    ...rest,
    details: details.map((d) => ({ id: d?.id, textLen: String(d?.text ?? "").length, remindAt: d?.remindAt, deliveryOk: d?.deliveryOk })),
  };
}

/**
 * @param {object} result Result of runAfterthoughtJob.
 * @returns {object} Result with topic and text replaced by lengths.
 */
export function summarizeAfterthoughtResultForLog(result) {
  if (!result || typeof result !== "object") return result;
  const { text, topic, ...rest } = result;
  const out = { ...rest };
  if (typeof text === "string") out.textLen = text.length;
  if (typeof topic === "string") out.topicLen = topic.length;
  return out;
}

/**
 * @param {object} result Result of evolvePersonaVoice.
 * @returns {object} Result with the distilled marker replaced by its length.
 */
export function summarizePersonaResultForLog(result) {
  if (!result || typeof result !== "object") return result;
  const { marker, ...rest } = result;
  return typeof marker === "string" ? { ...rest, markerLen: marker.length } : rest;
}

const LOG_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// `E_TIMEOUT`, `ECONNRESET`, `llm_error`: Konstanten ohne Leerzeichen; ein einzelnes Wort ohne Unterstrich zählt nicht.
const ERROR_CONSTANT_RE = /^(?:[A-Z][A-Z0-9_]{2,63}|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;

/**
 * Gemeinsame Formatierung für {@link describeError} und `redactErrorForLog`.
 * Reine Konstanten-Meldungen (`E_TIMEOUT`) bleiben lesbar; jede andere Meldung wird zu Länge
 * und Hash. URLs in der Meldung bleiben als `redactUrl` (Schema/Host + Pfad-Hash) sichtbar,
 * damit erkennbar ist, welcher Endpunkt ausfiel.
 *
 * @param {{name?: unknown, code?: unknown, message?: unknown}} parts Bereits gelesene Fehlerfelder.
 * @returns {string} `<name>[ code=<code>] <E_CONST | textLen=<n> sha=<12 hex>>[ urls=<a>,<b>]`.
 */
export function formatErrorForLog({ name, code, message }) {
  const cls = typeof name === "string" && LOG_CODE_RE.test(name) ? name : "Error";
  const codePart = typeof code === "string" && LOG_CODE_RE.test(code) ? ` code=${code}` : "";
  const text = typeof message === "string" ? message : String(message ?? "");
  const body = ERROR_CONSTANT_RE.test(text) ? text : describeText(text);
  const urls = [...new Set(text.match(URL_IN_TEXT_RE) ?? [])].slice(0, 3).map((u) => redactUrl(u));
  return `${cls}${codePart} ${body}${urls.length ? ` urls=${urls.join(",")}` : ""}`;
}

/**
 * Fehler für Logs: Klasse/Code plus Länge und Hash der Meldung. Meldungen aus DB-, Host-
 * und Dateisystem-Schichten können Filter, Pfade, Chat-IDs oder Notiztitel enthalten.
 *
 * @param {unknown} err Gefangener Fehler oder beliebiger Wert.
 * @returns {string} Siehe {@link formatErrorForLog}.
 */
export function describeError(err) {
  return formatErrorForLog({ name: err?.name, code: err?.code, message: err?.message ?? err });
}
