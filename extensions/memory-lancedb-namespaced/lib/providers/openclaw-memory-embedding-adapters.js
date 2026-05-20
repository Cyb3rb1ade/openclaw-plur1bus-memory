import { join } from "node:path";
import {
  DEFAULT_LOCAL_E5_DIMENSIONS,
  DEFAULT_LOCAL_E5_MODEL,
  EMBEDDING_DIMENSIONS,
  defaultDimensionForOpenAiModel,
  embeddingDimensionsForModel,
  isOpenAiEmbeddingModel,
} from "./dimensions.js";
import { resolveEnvVars } from "./env.js";

export const OPENCLAW_MEMORY_EMBEDDING_PROVIDER_IDS = [
  "plur1bus-openai",
  "plur1bus-openai-compatible",
  "plur1bus-e5-small",
];

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "text-embedding-3-large";
const DEFAULT_INLINE_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_INLINE_BATCH_TIMEOUT_MS = 120_000;

function sanitizeHeaderValue(value) {
  return String(value).replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
}

function maybeString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function resolveSecretInputString(value, label) {
  if (typeof value === "string") return resolveEnvVars(value, { groups: ["openai"], label });
  if (value && typeof value === "object") {
    throw new Error(
      `memory-lancedb-namespaced: ${label} is an unresolved SecretInput reference. ` +
      "Resolve it through OpenClaw memorySearch.remote before creating the provider."
    );
  }
  return undefined;
}

function resolveHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const resolved = resolveSecretInputString(value, `remote.headers.${key}`);
    if (resolved) out[key] = sanitizeHeaderValue(resolved);
  }
  return out;
}

function resolveOpenClawHome() {
  return process.env.OPENCLAW_HOME || join(process.env.HOME || ".", ".openclaw");
}

function resolveLocalCacheDir(options, pluginConfig) {
  return (
    maybeString(options.local?.modelCacheDir) ||
    maybeString(pluginConfig.embedding?.local?.cacheDir) ||
    join(resolveOpenClawHome(), "models", "plur1bus")
  );
}

function resolveModel(options, fallbackModel) {
  return maybeString(options.model) || fallbackModel;
}

function resolveDimension(options, model, fallbackDim) {
  const requested = Number(options.outputDimensionality || 0);
  if (requested > 0) return requested;
  return embeddingDimensionsForModel(model) || fallbackDim || defaultDimensionForOpenAiModel(model);
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl ? baseUrl.replace(/\/+$/, "") : "";
}

function extractTextEmbeddingInputs(inputs) {
  return inputs.map((input, index) => {
    if (!input || typeof input !== "object") {
      throw new Error(`EmbeddingInput at index ${index} is not an object`);
    }
    if (Array.isArray(input.parts) && input.parts.some((part) => part?.type !== "text")) {
      throw new Error(
        "memory-lancedb-namespaced: structured non-text EmbeddingInput parts are not supported by PLUR1BUS adapters"
      );
    }
    if (Array.isArray(input.parts) && input.parts.length > 0) {
      return input.parts.map((part) => part.text || "").join("\n");
    }
    return String(input.text || "");
  });
}

function vectorFromOpenAiResponse(data, expectedCount) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  if (rows.length !== expectedCount) {
    throw new Error(
      `memory-lancedb-namespaced: embedding response count mismatch: expected ${expectedCount}, got ${rows.length}`
    );
  }
  return rows.map((row, index) => {
    if (!Array.isArray(row?.embedding)) {
      throw new Error(`memory-lancedb-namespaced: embedding response ${index} has no vector`);
    }
    return row.embedding.map(Number);
  });
}

function createRemoteProvider({ id, model, dim, baseUrl, apiKey, headers }) {
  const requestDimensions = isOpenAiEmbeddingModel(model) && dim ? dim : undefined;
  async function embedBatch(texts) {
    if (!apiKey) {
      throw new Error(
        `memory-lancedb-namespaced: ${id} API key is not configured. ` +
        "Set agents.defaults.memorySearch.remote.apiKey or the PLUR1BUS embedding.apiKey."
      );
    }
    if (!baseUrl) {
      throw new Error(
        `memory-lancedb-namespaced: ${id} base URL is not configured. ` +
        "Set agents.defaults.memorySearch.remote.baseUrl or the PLUR1BUS embedding.baseUrl."
      );
    }
    const body = {
      model,
      input: texts,
      encoding_format: "float",
      ...(requestDimensions ? { dimensions: requestDimensions } : {}),
    };
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `memory-lancedb-namespaced: ${id} embedding request failed (${response.status}): ${text}`
      );
    }
    return vectorFromOpenAiResponse(await response.json(), texts.length);
  }

  return {
    id,
    model,
    maxInputTokens: 8192,
    embedQuery: async (text) => (await embedBatch([text]))[0],
    embedBatch,
    embedBatchInputs: async (inputs) => embedBatch(extractTextEmbeddingInputs(inputs)),
  };
}

function createLocalE5Provider({ model, dim, cacheDir }) {
  let pipelinePromise = null;
  async function getPipeline() {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        let mod;
        try {
          mod = await import("@huggingface/transformers");
        } catch (err) {
          throw new Error(
            "memory-lancedb-namespaced: plur1bus-e5-small requires optional dependency @huggingface/transformers. " +
            "Install it for local embeddings or choose plur1bus-openai/plur1bus-openai-compatible. " +
            `Import failed: ${err?.message || String(err)}`
          );
        }
        if (cacheDir && mod.env) mod.env.cacheDir = cacheDir;
        return mod.pipeline("feature-extraction", model);
      })();
    }
    return pipelinePromise;
  }
  function vectorFromOutput(output) {
    if (output?.data && typeof output.data.length === "number") return Array.from(output.data);
    if (Array.isArray(output)) return Array.isArray(output[0]) ? output[0].map(Number) : output.map(Number);
    if (typeof output?.tolist === "function") {
      const list = output.tolist();
      return Array.isArray(list?.[0]) ? list[0].map(Number) : list.map(Number);
    }
    throw new Error("memory-lancedb-namespaced: local E5 embedding output shape is unsupported");
  }
  async function embedWithPrefix(text, prefix) {
    const extractor = await getPipeline();
    const output = await extractor(`${prefix}${text}`, { pooling: "mean", normalize: true });
    const vector = vectorFromOutput(output);
    if (vector.length !== dim) {
      throw new Error(`memory-lancedb-namespaced: local E5 dimension mismatch: expected ${dim}, got ${vector.length}`);
    }
    return vector;
  }
  async function embedBatch(texts, prefix = "passage: ") {
    const vectors = [];
    for (const text of texts) vectors.push(await embedWithPrefix(text, prefix));
    return vectors;
  }
  return {
    id: "plur1bus-e5-small",
    model,
    maxInputTokens: 512,
    embedQuery: (text) => embedWithPrefix(text, "query: "),
    embedBatch: (texts) => embedBatch(texts, "passage: "),
    embedBatchInputs: (inputs) => embedBatch(extractTextEmbeddingInputs(inputs), "passage: "),
  };
}

function remoteResult({ id, model, dim, baseUrl, apiKey, headers }) {
  return {
    provider: createRemoteProvider({ id, model, dim, baseUrl, apiKey, headers }),
    runtime: {
      id,
      inlineQueryTimeoutMs: DEFAULT_INLINE_QUERY_TIMEOUT_MS,
      inlineBatchTimeoutMs: DEFAULT_INLINE_BATCH_TIMEOUT_MS,
      cacheKeyData: { provider: id, model, dimensions: dim },
    },
  };
}

export function createOpenClawMemoryEmbeddingProviderAdapters(pluginConfig = {}) {
  const embeddingCfg = pluginConfig.embedding || {};
  return [
    {
      id: "plur1bus-openai",
      defaultModel: OPENAI_DEFAULT_MODEL,
      transport: "remote",
      authProviderId: "openai",
      create: async (options) => {
        const model = resolveModel(options, OPENAI_DEFAULT_MODEL);
        const dim = resolveDimension(options, model, EMBEDDING_DIMENSIONS[model]);
        const apiKey = resolveSecretInputString(options.remote?.apiKey, "remote.apiKey") ||
          resolveSecretInputString(embeddingCfg.apiKey, "embedding.apiKey");
        return remoteResult({
          id: "plur1bus-openai",
          model,
          dim,
          baseUrl: normalizeBaseUrl(options.remote?.baseUrl || embeddingCfg.baseUrl || OPENAI_BASE_URL),
          apiKey,
          headers: resolveHeaders(options.remote?.headers),
        });
      },
      formatSetupError: (err) => err?.message || String(err),
      shouldContinueAutoSelection: () => false,
    },
    {
      id: "plur1bus-openai-compatible",
      transport: "remote",
      create: async (options) => {
        const model = resolveModel(options, embeddingCfg.model || OPENAI_DEFAULT_MODEL);
        const dim = resolveDimension(options, model, Number(embeddingCfg.dimensions || 0) || undefined);
        const apiKey = resolveSecretInputString(options.remote?.apiKey, "remote.apiKey") ||
          resolveSecretInputString(embeddingCfg.apiKey, "embedding.apiKey");
        const baseUrl = normalizeBaseUrl(options.remote?.baseUrl || embeddingCfg.baseUrl);
        return remoteResult({
          id: "plur1bus-openai-compatible",
          model,
          dim,
          baseUrl,
          apiKey,
          headers: resolveHeaders(options.remote?.headers),
        });
      },
      formatSetupError: (err) => err?.message || String(err),
      shouldContinueAutoSelection: () => false,
    },
    {
      id: "plur1bus-e5-small",
      defaultModel: DEFAULT_LOCAL_E5_MODEL,
      transport: "local",
      create: async (options) => {
        const model = resolveModel(options, DEFAULT_LOCAL_E5_MODEL);
        const dim = EMBEDDING_DIMENSIONS[model] || DEFAULT_LOCAL_E5_DIMENSIONS;
        return {
          provider: createLocalE5Provider({
            model,
            dim,
            cacheDir: resolveLocalCacheDir(options, pluginConfig),
          }),
          runtime: {
            id: "plur1bus-e5-small",
            inlineQueryTimeoutMs: 5 * 60_000,
            inlineBatchTimeoutMs: 10 * 60_000,
            cacheKeyData: { provider: "plur1bus-e5-small", model, dimensions: dim },
          },
        };
      },
      formatSetupError: (err) => err?.message || String(err),
      shouldContinueAutoSelection: () => false,
    },
  ];
}

export function registerOpenClawMemoryEmbeddingProviders(api, pluginConfig = {}) {
  if (typeof api.registerMemoryEmbeddingProvider !== "function") {
    api.logger?.warn?.(
      "memory-lancedb-namespaced: OpenClaw registerMemoryEmbeddingProvider API unavailable; PLUR1BUS embedding provider bridge is inactive."
    );
    return [];
  }
  const adapters = createOpenClawMemoryEmbeddingProviderAdapters(pluginConfig);
  for (const adapter of adapters) api.registerMemoryEmbeddingProvider(adapter);
  return adapters;
}
