/**
 * lib/providers/reranker-cohere.js — the Cohere preset of the remote reranker.
 *
 * Kept as its own class for existing callers. From contract 1.15.0 on it is the "cohere"
 * preset of RemoteRerankerProvider: default endpoint https://api.cohere.com/v2/rerank,
 * overridable with `baseUrl`/`protocol`, requests through HostServices.fetch
 * when the host injected one, key from `apiKeyRef` → `apiKeyEnv` → `apiKey` →
 * COHERE_API_KEY.
 */

import { RemoteRerankerProvider } from "./reranker-remote.js";

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
// Kleinster konfigurierbarer Wert (außer 0 = aus).
const COHERE_MIN_CONFIG_DOC_CHARS = 100;

/**
 * Normalisiert reranker.maxDocChars: ganze Zahl, Werte von 1 bis 99 zählen
 * als 100, 0 schaltet die Kürzung ab; fehlend, negativ oder ungültig ergibt 1400.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeCohereMaxDocChars(value) {
  if (value === 0) return 0;
  if (value === undefined || value === null || value === "") return DEFAULT_COHERE_MAX_DOC_CHARS;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_COHERE_MAX_DOC_CHARS;
  return Math.min(COHERE_MAX_DOC_CHARS_LIMIT, Math.max(COHERE_MIN_CONFIG_DOC_CHARS, Math.floor(n)));
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

export class CohereRerankerProvider extends RemoteRerankerProvider {
  constructor(cfg = {}) {
    super({ ...cfg, provider: "cohere" });
    this.maxDocChars = normalizeCohereMaxDocChars(cfg.maxDocChars);
  }

  /**
   * Request body per https://docs.cohere.com/reference/rerank (v2): model,
   * query, documents, top_n. return_documents is not part of it (v2 returns
   * only index and relevance_score anyway); max_tokens_per_doc stays at its
   * default 4096, documents are cut by characters beforehand.
   * @param {{model?: string, query: string, documents: string[], topN: number}} request
   * @returns {object}
   */
  buildRequestBody(request) {
    const body = super.buildRequestBody(request);
    if (this.protocol === "cohere") delete body.return_documents;
    return body;
  }

  /**
   * Rerank with every document cut to the per-request limit (7.20.10 cost
   * brake). Only the text sent to Cohere is cut: the indices of the answer
   * refer to the caller's list, and a fallback reranker gets the full
   * documents from its caller.
   * @param {string} query
   * @param {string[]} documents
   * @param {number} topN
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<Array<{index:number, relevance_score:number}>>}
   */
  async rerank(query, documents, topN, options) {
    if (!documents || documents.length === 0) return [];
    const docCharLimit = resolveCohereDocCharLimit(query, this.maxDocChars);
    const sent = docCharLimit ? documents.map((doc) => truncateCohereDocument(doc, docCharLimit)) : documents;
    return super.rerank(query, sent, topN, options);
  }
}
