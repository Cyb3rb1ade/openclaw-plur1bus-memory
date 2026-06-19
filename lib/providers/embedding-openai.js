import { defaultDimensionForOpenAiModel, isOpenAiEmbeddingModel } from "./dimensions.js";
import { resolveEnvVars, resolveOptionalEnvVars } from "./env.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEmbeddingCache } from "../embedding-cache.js";

const __providerDir = dirname(fileURLToPath(import.meta.url));
const LEGACY_OPENAI_PATH = join(__providerDir, "../../../memory-lancedb-stock/node_modules/openai/index.js");
const PLUGIN_OPENAI_PATH = join(__providerDir, "../../node_modules/openai/index.js");

async function getOpenAI() {
  try {
    const m = await import("openai");
    return m.default;
  } catch (directErr) {
    // v6.2.1 — Plugin-eigenes node_modules als Fallback (P0-Fix)
    if (existsSync(PLUGIN_OPENAI_PATH)) {
      const m = await import(PLUGIN_OPENAI_PATH);
      return m.default;
    }
    if (existsSync(LEGACY_OPENAI_PATH)) {
      const m = await import(LEGACY_OPENAI_PATH);
      return m.default;
    }
    throw directErr;
  }
}

export class OpenAIEmbeddingProvider {
  constructor(cfg = {}) {
    this.id = cfg.provider || "openai";
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl;
    this.dim = cfg.dimensions || defaultDimensionForOpenAiModel(cfg.model || "");
    this.apiKeyRef = cfg.apiKey;
    this._client = null;
    this._detectedDim = null;
    // v6.2.1 — Embedding-Cache aktivieren (P0-Fix); explicit false opts out.
    this._cache = cfg.embeddingCacheEnabled === false ? null : createEmbeddingCache({
      maxEntries: cfg.cacheMaxEntries || 128,
      ttlMs: cfg.cacheTtlMs || 300000,
    });
  }

  dimensions() {
    return this.dim;
  }

  _resolveApiKey() {
    return this.apiKeyRef ? resolveEnvVars(this.apiKeyRef) : resolveOptionalEnvVars("${OPENAI_API_KEY}");
  }

  async _clientForPrimary() {
    const apiKey = this._resolveApiKey();
    if (!apiKey) {
      throw new Error(
        "memory-lancedb-namespaced: embedding API key is not configured. " +
        "Set embedding.apiKey or OPENAI_API_KEY, or choose embedding.provider=local-transformers."
      );
    }
    if (!this._client) {
      const OpenAI = await getOpenAI();
      this._client = new OpenAI({ apiKey, baseURL: this.baseUrl });
    }
    return this._client;
  }

  _buildRequest(model, textOrTexts) {
    const req = { model, input: textOrTexts, encoding_format: "float" };
    if (isOpenAiEmbeddingModel(model) && this.dim) req.dimensions = this.dim;
    return req;
  }

  _validateDim(vec) {
    if (this._detectedDim !== null && vec.length !== this._detectedDim) {
      throw new Error(`Embedding-Dimension-Mismatch: erwartet ${this._detectedDim}, bekam ${vec.length} (Modell: ${this.model}). Provider-Wechsel ohne fresh DB?`);
    }
    if (this._detectedDim === null) this._detectedDim = vec.length;
    return Array.from(vec);
  }

  async ensureDimensions(logger) {
    if (this._detectedDim !== null) return this._detectedDim;
    if (this.dim && this.dim > 0) {
      this._detectedDim = this.dim;
      return this.dim;
    }
    logger?.info?.(`memory-lancedb-namespaced: keine dimensions für '${this.model}' konfiguriert — ermittle via Test-Call…`);
    const client = await this._clientForPrimary();
    const r = await client.embeddings.create(this._buildRequest(this.model, "dim probe"));
    this._detectedDim = r.data[0].embedding.length;
    return this._detectedDim;
  }

  async embedBatch(texts, retries = 3) {
    const input = Array.isArray(texts) ? texts : [texts];
    if (input.length === 0) return [];

    if (!this._cache) {
      const client = await this._clientForPrimary();
      const response = await client.embeddings.create(this._buildRequest(this.model, input));
      if (!Array.isArray(response?.data)) throw new Error("OpenAI embedding batch response missing data array");
      return response.data.map((entry, i) => {
        if (!entry || !Array.isArray(entry.embedding)) throw new Error(`OpenAI embedding batch missing entry ${i}`);
        return this._validateDim(entry.embedding);
      });
    }

    // v6.2.1 — Cache-Lookup pro Text vor API-Call.
    const cacheKeys = input.map((t) => String(t ?? "").trim().toLowerCase());
    const results = new Array(input.length);
    const missing = [];
    for (let i = 0; i < input.length; i++) {
      const cached = this._cache.get("__global__", cacheKeys[i], this.model);
      if (cached) {
        results[i] = cached.vector;
      } else {
        missing.push({ index: i, text: input[i], cacheKey: cacheKeys[i] });
      }
    }
    if (missing.length === 0) return results;

    const missingTexts = missing.map((m) => m.text);
    const client = await this._clientForPrimary();
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await client.embeddings.create(this._buildRequest(this.model, missingTexts));
        if (!Array.isArray(response?.data)) throw new Error("OpenAI embedding batch response missing data array");
        // OpenAI liefert data in derselben Reihenfolge wie input.
        for (let i = 0; i < missing.length; i++) {
          const entry = response.data[i];
          if (!entry || !Array.isArray(entry.embedding)) throw new Error(`OpenAI embedding batch missing entry ${i}`);
          const vector = this._validateDim(entry.embedding);
          this._cache.set("__global__", missing[i].cacheKey, this.model, vector);
          results[missing[i].index] = vector;
        }
        return results;
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        const isRateLimit = err?.status === 429 || String(err).includes("rate");
        const delay = isRateLimit ? Math.min(1000 * 2 ** attempt, 16000) : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Fallback: einzelne Embeddings nacheinander (für Robustheit bei Providern,
    // die kein Batch-Array unterstützen, oder bei Teilausfällen). Direkter
    // API-Aufruf, nicht embedRaw/embedBatch, um Endlos-Rekursion zu vermeiden.
    try {
      for (const m of missing) {
        if (results[m.index]) continue;
        const singleResponse = await client.embeddings.create(this._buildRequest(this.model, m.text));
        const vector = this._validateDim(singleResponse.data[0].embedding);
        this._cache.set("__global__", m.cacheKey, this.model, vector);
        results[m.index] = vector;
      }
      return results;
    } catch (_) {
      // Wenn auch der Einzelfallback scheitert, werfen wir den ursprünglichen
      // Batch-Fehler für Klarheit.
      throw lastErr;
    }
  }

  async embedRaw(text, _purpose = "passage", retries = 3) {
    const [vector] = await this.embedBatch([text], retries);
    return vector;
  }

  embedQuery(text) {
    return this.embedRaw(text, "query");
  }

  embedPassage(text) {
    return this.embedRaw(text, "passage");
  }

  embed(text) {
    return this.embedPassage(text);
  }
}
