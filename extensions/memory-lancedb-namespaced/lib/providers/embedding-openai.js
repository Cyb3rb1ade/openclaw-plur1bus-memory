import { defaultDimensionForOpenAiModel, isOpenAiEmbeddingModel } from "./dimensions.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __providerDir = dirname(fileURLToPath(import.meta.url));
const LEGACY_OPENAI_PATH = join(__providerDir, "../../../memory-lancedb-stock/node_modules/openai/index.js");

async function getOpenAI() {
  try {
    const m = await import("openai");
    return m.default;
  } catch (directErr) {
    if (!existsSync(LEGACY_OPENAI_PATH)) {
      throw directErr;
    }
    const m = await import(LEGACY_OPENAI_PATH);
    return m.default;
  }
}

function resolveEnvVars(value) {
  if (!value) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const v = process.env[envVar];
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
    return v.replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  });
}

function resolveOptionalEnvVars(value) {
  try {
    return resolveEnvVars(value);
  } catch (_) {
    return undefined;
  }
}

export class OpenAIEmbeddingProvider {
  constructor(cfg = {}) {
    this.id = cfg.provider || "openai";
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl;
    this.dim = cfg.dimensions || defaultDimensionForOpenAiModel(cfg.model || "");
    this.apiKeyRef = cfg.apiKey;
    this.fallbackCfg = cfg.fallback || null;
    this._client = null;
    this._fallbackClient = null;
    this._detectedDim = null;
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

  async _clientForFallback() {
    if (!this.fallbackCfg) return null;
    const apiKey = this.fallbackCfg.apiKey ? resolveEnvVars(this.fallbackCfg.apiKey) : resolveOptionalEnvVars("${OPENAI_API_KEY_FALLBACK}");
    if (!apiKey) return null;
    if (!this._fallbackClient) {
      const OpenAI = await getOpenAI();
      this._fallbackClient = new OpenAI({ apiKey, baseURL: this.fallbackCfg.baseUrl });
    }
    return this._fallbackClient;
  }

  _buildRequest(model, text) {
    const req = { model, input: text, encoding_format: "float" };
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

  async embedRaw(text, _purpose = "passage", retries = 3) {
    const client = await this._clientForPrimary();
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await client.embeddings.create(this._buildRequest(this.model, text));
        return this._validateDim(response.data[0].embedding);
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        const isRateLimit = err?.status === 429 || String(err).includes("rate");
        const delay = isRateLimit ? Math.min(1000 * 2 ** attempt, 16000) : 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    const fallbackClient = await this._clientForFallback();
    if (fallbackClient && this.fallbackCfg) {
      const fallbackModel = this.fallbackCfg.model || this.model;
      try {
        const response = await fallbackClient.embeddings.create(this._buildRequest(fallbackModel, text));
        return this._validateDim(response.data[0].embedding);
      } catch (_) {
        throw lastErr;
      }
    }
    throw lastErr;
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
