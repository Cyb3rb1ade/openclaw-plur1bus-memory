import { DEFAULT_COHERE_RERANK_MODEL } from "./dimensions.js";
import { resolveApiKey } from "./env.js";

// 7.20.10 — Kostenbremse. Cohere rechnet eine Suche als bis zu 100 Dokumente
// ab; ein Dokument, das zusammen mit der Anfrage über 500 Tokens kommt, wird
// geteilt und zählt mehrfach. Bei rerankCandidates = 100 kippt schon ein
// geteiltes Dokument die Suche in die zweite Einheit. Gekürzt wird nur der an
// Cohere gesendete Text; der lokale Rückfall-Reranker bekommt die vollen
// Dokumente, und die Indizes der Antwort bleiben dieselben.

/** Standardlänge je Dokument (reranker.maxDocChars), etwa 350–400 Tokens. */
export const DEFAULT_COHERE_MAX_DOC_CHARS = 1400;
// So viele Zeichen Anfrage sind in maxDocChars schon eingeplant; was die
// Anfrage darüber hinaus braucht, geht vom Dokument ab.
const COHERE_QUERY_ALLOWANCE_CHARS = 400;
// Kürzer wird ein Dokument auch bei langer Anfrage nicht.
const COHERE_MIN_DOC_CHARS = 300;
const COHERE_MAX_DOC_CHARS_LIMIT = 100_000;

/**
 * Normalisiert reranker.maxDocChars: ganze Zahl ab 100, 0 schaltet die
 * Kürzung ab; fehlend oder ungültig ergibt 1400.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeCohereMaxDocChars(value) {
  if (value === 0) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 100) return DEFAULT_COHERE_MAX_DOC_CHARS;
  return Math.min(COHERE_MAX_DOC_CHARS_LIMIT, Math.floor(n));
}

/**
 * Zeichengrenze je Dokument für eine Anfrage: maxDocChars, abzüglich dessen,
 * was die Anfrage über 400 Zeichen hinaus belegt, nicht unter 300 Zeichen
 * (bzw. maxDocChars, wenn das kleiner ist). 0 = keine Grenze.
 * @param {string} query
 * @param {number} maxDocChars normalisierter Wert
 * @returns {number}
 */
export function resolveCohereDocCharLimit(query, maxDocChars) {
  if (!maxDocChars) return 0;
  const overshoot = Math.max(0, String(query ?? "").length - COHERE_QUERY_ALLOWANCE_CHARS);
  return Math.max(Math.min(COHERE_MIN_DOC_CHARS, maxDocChars), maxDocChars - overshoot);
}

/**
 * Kürzt ein Dokument auf `limit` Zeichen, nach Möglichkeit an einer
 * Wortgrenze in den letzten 15 %, ohne ein Surrogatpaar zu teilen.
 * @param {string} text
 * @param {number} limit 0 = unverändert
 * @returns {string}
 */
export function truncateCohereDocument(text, limit) {
  const value = String(text ?? "");
  if (!limit || value.length <= limit) return value;
  let cut = limit;
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  const head = value.slice(0, cut);
  const space = head.lastIndexOf(" ");
  return space >= Math.floor(cut * 0.85) ? head.slice(0, space) : head;
}

export class CohereRerankerProvider {
  constructor(cfg = {}) {
    this.id = "cohere";
    this.apiKeyRef = cfg.apiKey;
    this.apiKeyEnv = cfg.apiKeyEnv;
    this.credentialResolver = cfg.credentialResolver;
    this._resolvedApiKey = null;
    this._apiKeyPromise = null;
    this.model = cfg.model || DEFAULT_COHERE_RERANK_MODEL;
    // Honor the configured timeout (normalizeRerankerConfig default: 5000)
    // instead of the previous hardcoded 30s, which ignored config entirely.
    this.timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : 5000;
    this.maxDocChars = normalizeCohereMaxDocChars(cfg.maxDocChars);
  }

  async _resolveApiKey() {
    if (this._resolvedApiKey) return this._resolvedApiKey;
    if (!this._apiKeyPromise) {
      this._apiKeyPromise = Promise.resolve().then(async () => {
        const apiKey = typeof this.credentialResolver === "function"
          ? await this.credentialResolver({
              value: this.apiKeyRef,
              apiKeyEnv: this.apiKeyEnv,
              defaultEnv: "COHERE_API_KEY",
              path: "plugins.entries.memory-lancedb-namespaced.config.reranker.apiKey",
            })
          : resolveApiKey(
              { apiKeyEnv: this.apiKeyEnv, apiKey: this.apiKeyRef },
              { defaultEnv: "COHERE_API_KEY", label: "Cohere reranker" },
            );
        if (typeof apiKey !== "string" || !apiKey.trim()) {
          throw new Error("Cohere reranker credential is unavailable");
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

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];
    const apiKey = await this._resolveApiKey();
    const docCharLimit = resolveCohereDocCharLimit(query, this.maxDocChars);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch("https://api.cohere.com/v2/rerank", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        // Parameter nach https://docs.cohere.com/reference/rerank (v2): model,
        // query, documents, top_n. return_documents gehört nicht mehr dazu
        // (v2 liefert ohnehin nur index und relevance_score); max_tokens_per_doc
        // bleibt beim Default 4096, gekürzt wird vorher nach Zeichen.
        body: JSON.stringify({
          model: this.model,
          query,
          documents: documents.map((doc) => truncateCohereDocument(doc, docCharLimit)),
          top_n: topN,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Cohere rerank failed (${response.status}): ${err}`);
      }
      return (await response.json()).results;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Forget resolved credentials when the plugin runtime is disposed. */
  async shutdown() {
    this._resolvedApiKey = null;
    this._apiKeyPromise = null;
  }
}
