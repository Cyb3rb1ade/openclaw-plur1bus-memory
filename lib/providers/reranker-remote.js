/**
 * lib/providers/reranker-remote.js — configurable remote (HTTP) reranker.
 *
 * One provider for every hosted or self-hosted rerank API. The wire format is
 * chosen by `protocol`, the endpoint by `baseUrl`; the presets only supply
 * defaults, every field stays overridable and no vendor is preferred:
 *
 *   protocol "cohere" — POST {baseUrl}/rerank {model, query, documents, top_n}
 *                       → {results: [{index, relevance_score}]}. Cohere, vLLM,
 *                       Infinity, LocalAI, llama.cpp server and most
 *                       OpenAI-style gateways speak this.
 *   protocol "jina"   — same body and response as "cohere" (Jina AI).
 *   protocol "voyage" — {model, query, documents, top_k} → {data: [{index, relevance_score}]}.
 *   protocol "tei"    — Hugging Face text-embeddings-inference:
 *                       {query, texts} → [{index, score}].
 *
 * Every response is normalised to `[{index, relevance_score}]`, sorted by
 * score and cut to `topN`. Requests go through `hostFetch()` (HostServices.fetch
 * when the host injected one). The key comes from `apiKeyRef` (host secret
 * store, re-resolved after SECRET_REF_TTL_MS or a 401/403), else from the
 * legacy `apiKeyEnv`/`apiKey` chain (also re-resolved after a 401/403); the
 * "remote" preset may run keyless for a local server. A failure throws a
 * content-free error; the caller
 * (ChainedRerankerProvider) only falls back when `fallbackProvider` is set.
 */

import { DEFAULT_COHERE_RERANK_MODEL } from "./dimensions.js";
import { assertKeyTransportAllowed } from "./credential-scope.js";
import { resolveApiKey } from "./env.js";
import { rerankSignal } from "./rerank-signal.js";
import { createProviderHttpError } from "../provider-error.js";
import { redactUrl } from "../log-redact.js";
import {
  SECRET_PURPOSES,
  createSecretRefCache,
  hostFetch,
  isCredentialRejection,
  normalizeApiKeyRef,
} from "../host-network.js";

export const RERANK_PROTOCOLS = Object.freeze(["cohere", "jina", "voyage", "tei"]);

/** Provider presets. `remote` has no defaults: baseUrl is required, the key optional. */
export const RERANK_PRESETS = Object.freeze({
  cohere: Object.freeze({
    label: "Cohere",
    baseUrl: "https://api.cohere.com/v2",
    protocol: "cohere",
    model: DEFAULT_COHERE_RERANK_MODEL,
    defaultEnv: "COHERE_API_KEY",
    requiresKey: true,
  }),
  jina: Object.freeze({
    label: "Jina",
    baseUrl: "https://api.jina.ai/v1",
    protocol: "jina",
    model: "jina-reranker-v2-base-multilingual",
    defaultEnv: "JINA_API_KEY",
    requiresKey: true,
  }),
  voyage: Object.freeze({
    label: "Voyage",
    baseUrl: "https://api.voyageai.com/v1",
    protocol: "voyage",
    model: "rerank-2.5",
    defaultEnv: "VOYAGE_API_KEY",
    requiresKey: true,
  }),
  remote: Object.freeze({
    label: "Remote",
    baseUrl: null,
    protocol: "cohere",
    model: null,
    defaultEnv: null,
    requiresKey: false,
  }),
});

export const REMOTE_RERANK_PROVIDERS = Object.freeze(Object.keys(RERANK_PRESETS));

export const DEFAULT_RERANK_MAX_DOCUMENTS = 1000;
export const DEFAULT_RERANK_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const DEFAULT_RERANK_MAX_RESPONSE_BYTES = 1024 * 1024;

/** @param {string} provider @returns {boolean} */
export function isRemoteRerankProvider(provider) {
  return Object.hasOwn(RERANK_PRESETS, provider);
}

function positiveInt(value, fallback, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`reranker.${name} must be a positive integer`);
  return value;
}

/**
 * Resolve the rerank endpoint from a base URL: `{baseUrl}/rerank`, or the URL
 * itself when it already ends in `/rerank`. Credentials in the URL are refused.
 * @param {string} baseUrl
 * @returns {string}
 */
export function rerankEndpoint(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw new Error(`reranker.baseUrl is not a valid URL (${redactUrl(baseUrl)})`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("reranker.baseUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("reranker.baseUrl must not carry credentials; use apiKeyRef or apiKeyEnv");
  }
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/rerank$/i.test(path) ? path : `${path}/rerank`;
  return url.href;
}

/**
 * Build the request body for one protocol.
 * @param {string} protocol
 * @param {{model?: string, query: string, documents: string[], topN: number}} request
 * @returns {object}
 */
export function buildRerankBody(protocol, { model, query, documents, topN }) {
  switch (protocol) {
    case "cohere":
    case "jina":
      return { ...(model ? { model } : {}), query, documents, top_n: topN, return_documents: false };
    case "voyage":
      return { ...(model ? { model } : {}), query, documents, top_k: topN, return_documents: false };
    case "tei":
      return { query, texts: documents, raw_scores: false, return_text: false };
    default:
      throw new Error(`unknown reranker protocol ${JSON.stringify(protocol)}`);
  }
}

/**
 * Normalise any supported rerank response to `[{index, relevance_score}]`,
 * best first, at most `topN` entries.
 * @param {unknown} payload Parsed JSON.
 * @param {number} documentCount
 * @param {number} topN
 * @returns {Array<{index:number, relevance_score:number}>}
 */
export function normalizeRerankResults(payload, documentCount, topN) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload?.data)
        ? payload.data
        : null;
  if (!rows) throw new Error("malformed rerank response: no results array");
  const seen = new Set();
  const out = rows.map((row, position) => {
    const index = row?.index;
    const score = row?.relevance_score ?? row?.score;
    if (!Number.isSafeInteger(index) || index < 0 || index >= documentCount) {
      throw new Error(`malformed rerank response: entry ${position} has an invalid index`);
    }
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error(`malformed rerank response: entry ${position} has an invalid score`);
    }
    if (seen.has(index)) throw new Error(`malformed rerank response: duplicate index ${index}`);
    seen.add(index);
    return { index, relevance_score: score };
  });
  out.sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index);
  return out.slice(0, Math.max(0, topN));
}

async function readCappedText(response, maxBytes, label) {
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* the size error below is what matters */ }
    throw new Error(`${label} rerank response exceeds ${maxBytes} bytes`);
  }
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* the size error below is what matters */ }
        throw new Error(`${label} rerank response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  if (typeof response?.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(String(text), "utf8") > maxBytes) {
      throw new Error(`${label} rerank response exceeds ${maxBytes} bytes`);
    }
    return String(text);
  }
  return null;
}

async function readJson(response, maxBytes, label) {
  const text = await readCappedText(response, maxBytes, label);
  if (text === null) {
    if (typeof response?.json === "function") return await response.json();
    throw new Error(`${label} rerank response has no body`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`malformed rerank response: ${label} returned invalid JSON (bodyLen=${text.length})`);
  }
}

async function readErrorBody(response, maxBytes) {
  try {
    return (await readCappedText(response, maxBytes, "error")) ?? "";
  } catch {
    return "";
  }
}

/** Remote HTTP reranker; see the module header for protocols and presets. */
export class RemoteRerankerProvider {
  /**
   * @param {object} cfg Normalised reranker config (normalizeRerankerConfig) plus
   *   optional `credentialResolver` (OpenClaw SecretInput resolver).
   */
  constructor(cfg = {}) {
    const provider = isRemoteRerankProvider(cfg.provider) ? cfg.provider : "remote";
    const preset = RERANK_PRESETS[provider];
    this.id = provider;
    this.label = preset.label;
    this.protocol = cfg.protocol || preset.protocol;
    if (!RERANK_PROTOCOLS.includes(this.protocol)) {
      throw new Error(`reranker.protocol must be one of ${RERANK_PROTOCOLS.join(", ")}`);
    }
    const baseUrl = cfg.baseUrl || preset.baseUrl;
    if (!baseUrl) throw new Error("reranker.baseUrl is required for provider=remote");
    this.endpoint = rerankEndpoint(baseUrl);
    this.model = cfg.model || preset.model || undefined;
    this.defaultEnv = preset.defaultEnv;
    this.requiresKey = preset.requiresKey;
    // `apiKeyRef` historically named the config `apiKey` value (literal or SecretInput) here.
    this.apiKeyRef = cfg.apiKey;
    this.apiKeyEnv = cfg.apiKeyEnv;
    this.hostSecretRef = normalizeApiKeyRef(cfg.apiKeyRef);
    this.credentialResolver = cfg.credentialResolver;
    this._secretRefCache = this.hostSecretRef
      ? createSecretRefCache({ ref: this.hostSecretRef, purpose: SECRET_PURPOSES.RERANKER, clock: cfg.clock })
      : null;
    this._resolvedApiKey = null;
    this._apiKeyPromise = null;
    // Honor the configured timeout (normalizeRerankerConfig default: 5000).
    this.timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : 5000;
    this.maxDocuments = positiveInt(cfg.maxDocuments, DEFAULT_RERANK_MAX_DOCUMENTS, "maxDocuments");
    this.maxRequestBytes = positiveInt(cfg.maxRequestBytes, DEFAULT_RERANK_MAX_REQUEST_BYTES, "maxRequestBytes");
    this.maxResponseBytes = positiveInt(cfg.maxResponseBytes, DEFAULT_RERANK_MAX_RESPONSE_BYTES, "maxResponseBytes");
  }

  _hasLegacyCredential() {
    const set = (value) => value !== undefined && value !== null && value !== "";
    return set(this.apiKeyRef) || set(this.apiKeyEnv);
  }

  async _resolveApiKey() {
    if (this._secretRefCache) return await this._secretRefCache.get();
    if (!this.requiresKey && !this._hasLegacyCredential()) return undefined;
    if (this._resolvedApiKey) return this._resolvedApiKey;
    if (!this._apiKeyPromise) {
      this._apiKeyPromise = Promise.resolve().then(async () => {
        const apiKey = typeof this.credentialResolver === "function"
          ? await this.credentialResolver({
              value: this.apiKeyRef,
              apiKeyEnv: this.apiKeyEnv,
              ...(this.defaultEnv ? { defaultEnv: this.defaultEnv } : {}),
              path: "plugins.entries.memory-lancedb-namespaced.config.reranker.apiKey",
            })
          : resolveApiKey(
              { apiKeyEnv: this.apiKeyEnv, apiKey: this.apiKeyRef },
              { ...(this.defaultEnv ? { defaultEnv: this.defaultEnv } : {}), label: `${this.label} reranker` },
            );
        if (typeof apiKey !== "string" || !apiKey.trim()) {
          throw new Error(`${this.label} reranker credential is unavailable`);
        }
        this._resolvedApiKey = apiKey.trim();
        return this._resolvedApiKey;
      }).catch((error) => {
        this._apiKeyPromise = null;
        throw error;
      });
    }
    return this._apiKeyPromise;
  }

  /**
   * Drop every cached credential after a 401/403, so the next request resolves
   * the key again: from the host store, from the current `apiKeyEnv` value or
   * from the credential resolver. A rotated key is picked up without a restart.
   */
  _forgetCredential() {
    this._secretRefCache?.invalidate();
    this._resolvedApiKey = null;
    this._apiKeyPromise = null;
  }

  /**
   * @param {string} query
   * @param {string[]} documents
   * @param {number} topN
   * @param {{ signal?: AbortSignal }} [options] When `signal` is given (the
   *   normal case: the recall pipeline always supplies one via
   *   `rerankSignal`), the request runs on that signal alone and
   *   `this.timeoutMs` is not consulted — the caller already owns exactly one
   *   timer for this rerank. `this.timeoutMs` only builds a timer of its own
   *   when called directly without a signal.
   * @returns {Promise<Array<{index:number, relevance_score:number}>>}
   */
  async rerank(query, documents, topN, { signal } = {}) {
    if (!documents || documents.length === 0) return [];
    if (documents.length > this.maxDocuments) {
      throw new Error(`${this.label} rerank refused: ${documents.length} documents exceed maxDocuments=${this.maxDocuments}`);
    }
    const n = Number.isSafeInteger(topN) && topN > 0 ? Math.min(topN, documents.length) : documents.length;
    const body = JSON.stringify(buildRerankBody(this.protocol, { model: this.model, query, documents, topN: n }));
    const bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > this.maxRequestBytes) {
      throw new Error(`${this.label} rerank refused: request of ${bodyBytes} bytes exceeds maxRequestBytes=${this.maxRequestBytes}`);
    }
    const apiKey = await this._resolveApiKey();
    // A Bearer key only over https, or over http to loopback (engine audit F3).
    if (apiKey) assertKeyTransportAllowed(this.endpoint, "reranker.baseUrl");
    const requestSignal = signal ?? rerankSignal(null, this.timeoutMs);
    const response = await hostFetch(this.endpoint, {
      method: "POST",
      headers: {
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body,
      signal: requestSignal,
    });
    if (!response.ok) {
      if (isCredentialRejection(response.status)) this._forgetCredential();
      const errorBody = await readErrorBody(response, 64 * 1024);
      throw createProviderHttpError(`${this.label} rerank failed`, response.status, errorBody);
    }
    const payload = await readJson(response, this.maxResponseBytes, this.label);
    return normalizeRerankResults(payload, documents.length, n);
  }

  /** Forget resolved credentials when the plugin runtime is disposed. */
  async shutdown() {
    this._resolvedApiKey = null;
    this._apiKeyPromise = null;
    this._secretRefCache?.invalidate();
  }
}

/**
 * Create the remote reranker for a normalised config.
 * @param {object} cfg
 * @returns {RemoteRerankerProvider}
 */
export function createRemoteRerankerProvider(cfg = {}) {
  return new RemoteRerankerProvider(cfg);
}
