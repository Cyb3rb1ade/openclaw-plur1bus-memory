/**
 * engine/providers/legacy-providers.js — the legacy `Reranker` and `Embeddings` classes (unused at runtime; moved, not deleted).
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { createEmbeddingCache } from "../../lib/embedding-cache.js";
import { getOpenAI } from "../store/lancedb-loader.js";

// ============================================================================
// Legacy Reranker — Cohere Rerank API v2 (kept for old local test imports)
// ============================================================================

class Reranker {
  constructor(apiKey, model = "rerank-v3.5") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];

    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_n: topN,
        return_documents: false,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere rerank failed (${response.status}): ${err}`);
    }

    const data = await response.json();
    // Returns [{index, relevance_score}, ...]  sorted by relevance_score desc
    return data.results;
  }
}

class Embeddings {
  constructor(apiKey, model, baseUrl, dimensions, fallbackCfg, cacheOptions = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.dimensions = dimensions;
    this._client = null;
    // fallbackCfg: { apiKey, model, baseUrl } — must produce same dimensions as primary
    this._fallbackCfg = fallbackCfg || null;
    this._fallbackClient = null;
    this._detectedDim = null; // gesetzt nach erstem embed-Call
    // v6.2.1 — Embedding-Cache aktivieren (P0-Fix)
    this._cache = cacheOptions.enabled !== false ? createEmbeddingCache({
      maxEntries: cacheOptions.maxEntries || 500,
      ttlMs: cacheOptions.ttlMs || 1800000,
    }) : null;
  }

  /**
   * v2.1.1: stellt sicher dass dimensions vor dem ersten embed-Call bekannt
   * sind. Bei Nicht-OpenAI-Provider ohne explizite dimensions: macht einen
   * Test-Call und liest die echte Dimension. Bei Mismatch (Config sagt X,
   * API liefert Y): wirft mit klarer Fehlermeldung — verhindert silent
   * Daten-Korruption.
   */
  async ensureDimensions(logger) {
    if (this._detectedDim !== null) return this._detectedDim;
    if (this.dimensions && this.dimensions > 0) {
      this._detectedDim = this.dimensions;
      return this.dimensions;
    }
    // Keine dimensions konfiguriert → Test-Call
    const isOpenAi = !this.model.includes("/") || this.model.startsWith("openai/") || this.model.startsWith("text-embedding-");
    if (isOpenAi) {
      // OpenAI ohne explizite dimensions: 3072 für large, 1536 für small/ada
      this._detectedDim = (this.model.includes("small") || this.model.includes("ada")) ? 1536 : 3072;
      logger?.info?.(`memory-lancedb-namespaced: OpenAI-Modell '${this.model}' → assumed ${this._detectedDim} dimensions`);
      return this._detectedDim;
    }
    // Nicht-OpenAI Provider (OpenRouter, etc.) ohne dimensions → Test-Call
    logger?.info?.(`memory-lancedb-namespaced: no dimensions configured for '${this.model}' — probing via test call…`);
    try {
      const client = await this.getClient();
      const r = await client.embeddings.create({ model: this.model, input: "dim probe", encoding_format: "float" });
      this._detectedDim = r.data[0].embedding.length;
      logger?.info?.(`memory-lancedb-namespaced: model '${this.model}' yields ${this._detectedDim}-dim vectors`);
      return this._detectedDim;
    } catch (e) {
      throw new Error(`Cannot determine embedding dimension for '${this.model}' (${e.message}). Please set 'dimensions' explicitly in openclaw.json.`);
    }
  }

  async getClient() {
    if (!this.apiKey) {
      throw new Error(
        "memory-lancedb-namespaced: embedding API key is not configured. " +
        "Set plugins.entries.memory-lancedb-namespaced.config.embedding.apiKey or OPENAI_API_KEY."
      );
    }
    if (!this._client) {
      const OpenAI = await getOpenAI();
      this._client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
      });
    }
    return this._client;
  }

  async getFallbackClient() {
    if (!this._fallbackClient && this._fallbackCfg) {
      if (!this._fallbackCfg.apiKey) {
        return null;
      }
      const OpenAI = await getOpenAI();
      this._fallbackClient = new OpenAI({
        apiKey: this._fallbackCfg.apiKey,
        baseURL: this._fallbackCfg.baseUrl,
      });
    }
    return this._fallbackClient;
  }

  // v2.1.0 — Build embedding-request body. encoding_format: "float" ist explizit
  // gesetzt weil OpenAI-SDK default base64 nutzt, was viele OpenRouter-Provider
  // (NVIDIA, manche andere) mit 400 ablehnen. dimensions ist nur für OpenAI-
  // Modelle gültig — andere Provider werfen sonst "unknown parameter" → wir
  // omitten es bei Nicht-OpenAI-Modellen (heuristisch via Modell-ID-Prefix).
  _buildEmbeddingRequest(model, text) {
    const isOpenAi = !model.includes("/") || model.startsWith("openai/") || model.startsWith("text-embedding-");
    const req = { model, input: text, encoding_format: "float" };
    if (isOpenAi && this.dimensions) req.dimensions = this.dimensions;
    return req;
  }

  /**
   * v2.1.1: Hard-Fail bei Dim-Mismatch. Wenn _detectedDim gesetzt ist und
   * der Embedding-Call etwas anderes liefert: Throw statt silent korrupter
   * Vektor in der DB. Schützt vor Provider-Wechsel ohne fresh DB.
   */
  _validateDim(vec) {
    if (this._detectedDim !== null && vec.length !== this._detectedDim) {
      throw new Error(`Embedding-Dimension-Mismatch: erwartet ${this._detectedDim}, bekam ${vec.length} (Modell: ${this.model}). Provider-Wechsel ohne fresh DB? Siehe Migration in CHANGELOG v2.1.0.`);
    }
    if (this._detectedDim === null) this._detectedDim = vec.length;
    return vec;
  }

  async embed(text, retries = 3) {
    // v6.2.1 — Cache-Lookup vor API-Call (P0-Fix)
    const cacheKey = text.trim().toLowerCase();
    if (this._cache) {
      const cached = this._cache.get("__global__", cacheKey, this.model);
      if (cached) return cached.vector;
    }

    const client = await this.getClient();
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await client.embeddings.create(this._buildEmbeddingRequest(this.model, text));
        const vector = this._validateDim(response.data[0].embedding);
        if (this._cache) this._cache.set("__global__", cacheKey, this.model, vector);
        return vector;
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        const isRateLimit = err?.status === 429 || String(err).includes("rate");
        const delay = isRateLimit ? Math.min(1000 * 2 ** attempt, 16000) : 500 * (attempt + 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    // Primary failed — try fallback if configured
    const fallbackClient = await this.getFallbackClient();
    if (fallbackClient && this._fallbackCfg) {
      try {
        const fallbackModel = this._fallbackCfg.model || this.model;
        const response = await fallbackClient.embeddings.create(this._buildEmbeddingRequest(fallbackModel, text));
        const vector = this._validateDim(response.data[0].embedding);
        if (this._cache) this._cache.set("__global__", cacheKey, this.model, vector);
        return vector;
      } catch (fallbackErr) {
        // Both failed — throw original error for clarity
        throw lastErr;
      }
    }
    throw lastErr;
  }
}
