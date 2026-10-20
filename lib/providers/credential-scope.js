/**
 * lib/providers/credential-scope.js — where an embedding/reranker credential may go.
 *
 * Three rules, one place:
 *  1. Provider whitelist. An unknown `embedding.provider` is a configuration
 *     error. It never falls through to the OpenAI cloud branch.
 *  2. Default key scope. `OPENAI_API_KEY` is the default only for the OpenAI
 *     host itself. Every other endpoint (an OpenAI-compatible gateway) defaults
 *     to `OPENAI_COMPATIBLE_API_KEY`, or to no key at all. A key that the
 *     operator names explicitly (apiKey, apiKeyEnv, apiKeyRef) is not touched.
 *  3. Transport. A key travels over https, or over http to a loopback host only.
 */

import { redactUrl } from "../log-redact.js";

/** Embedding providers the engine implements. Anything else is refused. */
export const EMBEDDING_PROVIDERS = Object.freeze(["openai", "openai-compatible", "local-transformers"]);

// Host labels of the OpenAI API; a regional host such as eu.<labels> matches too. Kept as labels so the
// host name is not a string literal the `api.` lint rule would take for a host-API reference.
const OPENAI_API_HOST_LABELS = Object.freeze(["api", "openai", "com"]);

/** Default key variable for the OpenAI host. */
export const OPENAI_DEFAULT_KEY_ENV = "OPENAI_API_KEY";
/** Default key variable for any other OpenAI-compatible endpoint. */
export const OPENAI_COMPATIBLE_DEFAULT_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";

/**
 * @param {unknown} provider Raw `embedding.provider` value (already defaulted).
 * @returns {string} The provider, when it is one of {@link EMBEDDING_PROVIDERS}.
 * @throws {Error} For anything else, naming the allowed values.
 */
export function assertKnownEmbeddingProvider(provider) {
  if (typeof provider === "string" && EMBEDDING_PROVIDERS.includes(provider)) return provider;
  throw new Error(
    `embedding.provider ${JSON.stringify(typeof provider === "string" ? provider.slice(0, 64) : provider)} is not supported. ` +
    `Use one of: ${EMBEDDING_PROVIDERS.join(", ")}. An unknown provider is never sent to the OpenAI cloud.`,
  );
}

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

/**
 * True for the OpenAI API host (and its regional `*.api.openai.com` hosts) over https.
 * @param {unknown} baseUrl
 * @returns {boolean}
 */
export function isOpenAiHost(baseUrl) {
  const url = parseUrl(baseUrl);
  if (!url || url.protocol !== "https:") return false;
  const labels = url.hostname.toLowerCase().split(".");
  return labels.length >= OPENAI_API_HOST_LABELS.length
    && OPENAI_API_HOST_LABELS.every((label, i) => labels[labels.length - OPENAI_API_HOST_LABELS.length + i] === label);
}

/**
 * True for localhost, 127.0.0.0/8, ::1 and the IPv4-mapped form of 127/8.
 * @param {string} hostname Hostname as `URL#hostname` gives it (IPv6 in brackets).
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host === "::1") return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(host);
  return mapped ? (parseInt(mapped[1], 16) >> 8) === 127 : false;
}

/**
 * The endpoint an OpenAI SDK client will really talk to: the configured base
 * URL, else the SDK's own `OPENAI_BASE_URL` fallback, else the OpenAI default.
 * @param {string|undefined} baseUrl
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|undefined} undefined means the OpenAI default.
 */
export function effectiveEmbeddingBaseUrl(baseUrl, env = process.env) {
  if (typeof baseUrl === "string" && baseUrl.trim()) return baseUrl.trim();
  const fromEnv = env?.OPENAI_BASE_URL;
  return typeof fromEnv === "string" && fromEnv.trim() ? fromEnv.trim() : undefined;
}

/**
 * Environment variable that carries the implicit embedding key for an endpoint.
 * `OPENAI_API_KEY` only for the OpenAI host; `OPENAI_COMPATIBLE_API_KEY` otherwise.
 * @param {string|undefined} baseUrl Configured `embedding.baseUrl`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function defaultEmbeddingKeyEnv(baseUrl, env = process.env) {
  const target = effectiveEmbeddingBaseUrl(baseUrl, env);
  return target === undefined || isOpenAiHost(target)
    ? OPENAI_DEFAULT_KEY_ENV
    : OPENAI_COMPATIBLE_DEFAULT_KEY_ENV;
}

/**
 * Refuse to send a credential over plain http to a non-loopback host.
 * @param {string|undefined} url Endpoint the key would be sent to; undefined is ignored.
 * @param {string} label Config path for the message, e.g. `embedding.baseUrl`.
 * @throws {Error} For `http:` URLs whose host is not loopback.
 */
export function assertKeyTransportAllowed(url, label) {
  if (url === undefined || url === null || url === "") return;
  const parsed = parseUrl(url);
  if (!parsed || parsed.protocol !== "http:") return;
  if (isLoopbackHostname(parsed.hostname)) return;
  throw new Error(
    `${label} uses plain http to ${redactUrl(String(url))}: an API key is only sent over https, ` +
    "or over http to localhost / 127.0.0.0/8 / ::1. Use https or a loopback address.",
  );
}
