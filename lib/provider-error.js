/**
 * lib/provider-error.js
 *
 * Content-free errors for provider HTTP failures (N2 leak audit I-6). A
 * provider error body can echo request input (prompt or memory text) or carry
 * account details, and thrown messages end up in the gateway log and the
 * Harness core.log. The message therefore keeps only the status, a whitelisted
 * provider error type/code, the body length and a short hash of the body.
 *
 * Opt-in debugging: set PLUR1BUS_DEBUG_PROVIDER_BODIES=1 to append a bounded,
 * token-redacted body excerpt. It is off by default and must stay off in
 * production, because the excerpt can contain request content.
 */

import { redactError } from "./safe-logging.js";
import { shortHash } from "./log-redact.js";

export const PROVIDER_BODY_DEBUG_ENV = "PLUR1BUS_DEBUG_PROVIDER_BODIES";
const DEBUG_BODY_MAX = 200;
const SANITIZED = Symbol.for("plur1bus.providerErrorSanitized");
// A provider code is an enum-like token. Anything else could echo content.
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

function safeToken(value) {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

/**
 * Pull whitelisted `type` and `code` out of a provider error body. Only
 * `error.type`, `error.code`, and top-level `type`/`code` are read; `message`
 * and every other key are ignored.
 *
 * @param {unknown} body Raw body text or an already parsed object.
 * @returns {{type?: string, code?: string}}
 */
export function extractProviderErrorFields(body) {
  let parsed = body;
  if (typeof body === "string") {
    try { parsed = JSON.parse(body); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== "object") return {};
  const inner = parsed.error && typeof parsed.error === "object" ? parsed.error : {};
  const type = safeToken(inner.type) ?? safeToken(parsed.type);
  const code = safeToken(inner.code) ?? safeToken(parsed.code);
  return { ...(type ? { type } : {}), ...(code ? { code } : {}) };
}

function debugExcerpt(text) {
  if (process.env[PROVIDER_BODY_DEBUG_ENV] !== "1") return "";
  return ` bodyExcerpt=${JSON.stringify(redactError(String(text)).message.slice(0, DEBUG_BODY_MAX))}`;
}

function describe({ fields, bodyText }) {
  const parts = [];
  if (fields.type) parts.push(`type=${fields.type}`);
  if (fields.code) parts.push(`code=${fields.code}`);
  parts.push(`bodyLen=${bodyText.length}`, `bodySha=${shortHash(bodyText)}`);
  return parts.join(" ") + debugExcerpt(bodyText);
}

/**
 * Message for a provider HTTP failure whose response body was read.
 *
 * @param {string} prefix e.g. "Cohere rerank failed"; keeps the historical wording.
 * @param {number} status HTTP status.
 * @param {unknown} body Response body text.
 * @returns {string} `<prefix> (<status>): [type=..] [code=..] bodyLen=<n> bodySha=<12 hex>`
 */
export function providerHttpErrorMessage(prefix, status, body) {
  const bodyText = typeof body === "string" ? body : "";
  return `${prefix} (${status}): ${describe({ fields: extractProviderErrorFields(bodyText), bodyText })}`;
}

/**
 * Build the Error for a failed provider HTTP response. The class stays a plain
 * Error and `.status` is set, so retry code that reads `err.status` works.
 *
 * @param {string} prefix Message prefix without status.
 * @param {number} status HTTP status.
 * @param {unknown} body Response body text.
 * @returns {Error & {status: number, providerType?: string, providerCode?: string}}
 */
export function createProviderHttpError(prefix, status, body) {
  const err = new Error(providerHttpErrorMessage(prefix, status, body));
  err.status = status;
  const { type, code } = extractProviderErrorFields(body);
  if (type) err.providerType = type;
  if (code) err.providerCode = code;
  return err;
}

function define(err, key, value) {
  try {
    Object.defineProperty(err, key, { value, writable: true, configurable: true, enumerable: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Scrub an error thrown by a provider SDK (the OpenAI client builds its
 * message from the response body). Errors without a numeric `status` (network,
 * abort, timeout, local errors) are returned untouched. The same object is
 * kept, so class, `.status`, `.code` and `instanceof` are preserved; only
 * `message`, the first line of `stack` and the parsed `.error` body change.
 *
 * @template T
 * @param {T} err Thrown value.
 * @param {string} provider Provider label for the message.
 * @returns {T} The same value.
 */
export function sanitizeProviderSdkError(err, provider) {
  if (!err || typeof err !== "object" || err[SANITIZED]) return err;
  const status = err.status;
  if (typeof status !== "number" || !Number.isFinite(status)) return err;
  let original;
  try { original = typeof err.message === "string" ? err.message : ""; } catch { return err; }
  const bodyObj = err.error && typeof err.error === "object" ? err.error : null;
  const fields = extractProviderErrorFields(bodyObj ?? { type: err.type, code: err.code });
  const hashInput = bodyObj ? JSON.stringify(bodyObj) : original;
  const message = `${provider} request failed (${status}): ${describe({ fields, bodyText: hashInput })}`;
  try {
    if (typeof err.stack === "string" && original) {
      define(err, "stack", err.stack.split(original).join(message));
    }
    define(err, "message", message);
    if (bodyObj !== null) err.error = { ...fields };
  } catch {
    return err;
  }
  define(err, SANITIZED, true);
  return err;
}
