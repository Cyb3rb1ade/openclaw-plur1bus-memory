import { DEFAULT_LOCAL_E5_DIMENSIONS, DEFAULT_LOCAL_E5_MODEL } from "./dimensions.js";

function resolveEnvVars(value) {
  if (!value) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    if (envVar === "OPENCLAW_HOME" && !process.env.OPENCLAW_HOME) {
      return `${process.env.HOME || "."}/.openclaw`;
    }
    const v = process.env[envVar];
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
    return v.replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  });
}

function vectorFromOutput(output) {
  if (output?.data && typeof output.data.length === "number") return Array.from(output.data);
  if (Array.isArray(output)) return Array.isArray(output[0]) ? output[0].map(Number) : output.map(Number);
  if (typeof output?.tolist === "function") {
    const list = output.tolist();
    return Array.isArray(list?.[0]) ? list[0].map(Number) : list.map(Number);
  }
  throw new Error("local embedding output shape is unsupported");
}

export class LocalTransformersEmbeddingProvider {
  constructor(cfg = {}) {
    this.id = "local-transformers";
    this.model = cfg.model || DEFAULT_LOCAL_E5_MODEL;
    this.dim = Number(cfg.dimensions || DEFAULT_LOCAL_E5_DIMENSIONS);
    this.queryPrefix = cfg.queryPrefix ?? "query: ";
    this.passagePrefix = cfg.passagePrefix ?? "passage: ";
    this.cacheDir = cfg.cacheDir ? resolveEnvVars(cfg.cacheDir) : undefined;
    this._pipeline = null;
  }

  dimensions() {
    return this.dim;
  }

  async _getPipeline() {
    if (!this._pipeline) {
      let mod;
      try {
        mod = await import("@huggingface/transformers");
      } catch (e) {
        throw new Error(
          "local-transformers embedding provider requires optional dependency @huggingface/transformers. " +
          "Install it for this plugin or switch embedding.provider to openai/openai-compatible. " +
          `Import failed: ${e.message}`
        );
      }
      if (this.cacheDir && mod.env) mod.env.cacheDir = this.cacheDir;
      this._pipeline = await mod.pipeline("feature-extraction", this.model);
    }
    return this._pipeline;
  }

  _validateDim(vec) {
    if (this.dim && vec.length !== this.dim) {
      throw new Error(`Local embedding dimension mismatch for ${this.model}: expected ${this.dim}, got ${vec.length}`);
    }
    return vec;
  }

  async embedRaw(text, purpose = "passage") {
    const extractor = await this._getPipeline();
    const prefix = purpose === "query" ? this.queryPrefix : this.passagePrefix;
    const output = await extractor(`${prefix}${text}`, { pooling: "mean", normalize: true });
    return this._validateDim(vectorFromOutput(output));
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

