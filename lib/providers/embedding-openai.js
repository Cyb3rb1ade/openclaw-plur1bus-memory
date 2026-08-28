import { defaultDimensionForOpenAiModel, supportsOpenAiCustomDimensions } from "./dimensions.js";
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
    this.apiKeyEnv = cfg.apiKeyEnv;
    this.credentialResolver = cfg.credentialResolver;
    this._resolvedApiKey = null;
    this._apiKeyPromise = null;
    this._client = null;
    this._detectedDim = null;
    this._shutdownPromise = null;
    this._isShutdown = false;
    // v6.2.1 — Embedding-Cache aktivieren (P0-Fix); explicit false opts out.
    this._cache = cfg.embeddingCacheEnabled === false ? null : createEmbeddingCache({
      maxEntries: cfg.cacheMaxEntries ?? 128,
      ttlMs: cfg.cacheTtlMs ?? 300000,
      coalesce: cfg.embeddingCacheCoalesce !== false,
      persist: cfg.embeddingCachePersist === true,
      persistDebug: cfg.embeddingCachePersistDebug === true,
      metrics: cfg.embeddingCacheMetrics === true,
      scope: cfg.embeddingCacheScope || "agent",
      maxBytes: cfg.embeddingCacheMaxBytes,
      cacheBasePath: cfg.cacheBasePath,
      provider: this.id,
      model: this.model,
      dimensions: this.dim,
      logger: cfg.logger,
    });
  }

  dimensions() {
    return this.dim;
  }

  async _resolveApiKey() {
    if (this._resolvedApiKey) return this._resolvedApiKey;
    if (!this._apiKeyPromise) {
      this._apiKeyPromise = Promise.resolve().then(async () => {
        const apiKey = typeof this.credentialResolver === "function"
          ? await this.credentialResolver({
              value: this.apiKeyRef,
              apiKeyEnv: this.apiKeyEnv,
              defaultEnv: "OPENAI_API_KEY",
              path: "plugins.entries.memory-lancedb-namespaced.config.embedding.apiKey",
            })
          : this.apiKeyEnv
            ? process.env[this.apiKeyEnv] || undefined
            : typeof this.apiKeyRef === "string"
              ? resolveEnvVars(this.apiKeyRef)
              : this.apiKeyRef == null
                ? resolveOptionalEnvVars("${OPENAI_API_KEY}")
                : undefined;
        if (typeof apiKey !== "string" || !apiKey.trim()) return undefined;
        this._resolvedApiKey = apiKey.trim();
        return this._resolvedApiKey;
      }).catch((error) => {
        this._apiKeyPromise = null;
        throw error;
      });
    }
    return this._apiKeyPromise;
  }

  async _clientForPrimary() {
    if (this._isShutdown) {
      throw new Error("memory-lancedb-namespaced: OpenAI embedding provider has been shut down");
    }
    const apiKey = await this._resolveApiKey();
    if (!apiKey) {
      throw new Error(
        "memory-lancedb-namespaced: embedding API key is not configured. " +
        "Set embedding.apiKey, embedding.apiKeyEnv, or OPENAI_API_KEY, or choose embedding.provider=local-transformers."
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
    if (supportsOpenAiCustomDimensions(model) && this.dim) req.dimensions = this.dim;
    return req;
  }

  _validateDim(vec) {
    const expectedDim = this._detectedDim ?? this.dim;
    if (expectedDim && vec.length !== expectedDim) {
      throw new Error(`Embedding-Dimension-Mismatch: erwartet ${expectedDim}, bekam ${vec.length} (Modell: ${this.model}). Provider-Wechsel ohne fresh DB?`);
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

  async _computeBatch(texts, retries = 3) {
    const input = Array.isArray(texts) ? texts : [texts];
    if (input.length === 0) return [];

    const client = await this._clientForPrimary();
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await client.embeddings.create(this._buildRequest(this.model, input));
        if (!Array.isArray(response?.data)) throw new Error("OpenAI embedding batch response missing data array");
        return response.data.map((entry, i) => {
          if (!entry || !Array.isArray(entry.embedding)) throw new Error(`OpenAI embedding batch missing entry ${i}`);
          return this._validateDim(entry.embedding);
        });
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        const isRateLimit = err?.status === 429 || String(err).includes("rate");
        const delay = isRateLimit ? Math.min(1000 * 2 ** attempt, 16000) : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Fallback: einzelne Embeddings nacheinander (für Robustheit bei Providern,
    // die kein Batch-Array unterstützen, oder bei Teilausfällen).
    try {
      const results = new Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const singleResponse = await client.embeddings.create(this._buildRequest(this.model, input[i]));
        results[i] = this._validateDim(singleResponse.data[0].embedding);
      }
      return results;
    } catch (_) {
      // Wenn auch der Einzelfallback scheitert, werfen wir den ursprünglichen
      // Batch-Fehler für Klarheit.
      throw lastErr;
    }
  }

  async embedBatch(texts, retries = 3, options = {}) {
    const input = Array.isArray(texts) ? texts : [texts];
    if (input.length === 0) return [];

    if (!this._cache) {
      return this._computeBatch(input, retries);
    }

    const cacheOptions = {
      provider: this.id,
      model: this.model,
      dimensions: this.dim,
      agentId: options.agentId,
    };

    return this._cache.getMany(input, cacheOptions, (missing) => this._computeBatch(missing, retries));
  }

  async embedRaw(text, _purpose = "passage", retries = 3, options = {}) {
    const [vector] = await this.embedBatch([text], retries, options);
    return vector;
  }

  embedQuery(text, options) {
    return this.embedRaw(text, "query", 3, options);
  }

  embedPassage(text, options) {
    return this.embedRaw(text, "passage", 3, options);
  }

  embed(text, options) {
    return this.embedPassage(text, options);
  }

  /** Close the provider-owned embedding cache and release the API client. */
  async shutdown() {
    if (this._shutdownPromise) return this._shutdownPromise;
    this._isShutdown = true;
    this._shutdownPromise = (async () => {
      try {
        await this._cache?.close?.();
      } finally {
        this._client = null;
        this._resolvedApiKey = null;
        this._apiKeyPromise = null;
      }
    })();
    return this._shutdownPromise;
  }
}
