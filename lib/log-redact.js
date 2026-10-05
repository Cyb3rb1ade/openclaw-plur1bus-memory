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
