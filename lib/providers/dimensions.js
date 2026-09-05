export const LEGACY_DEFAULT_MODEL = "text-embedding-3-small";
export const FRESH_OPENAI_DEFAULT_MODEL = "text-embedding-3-large";
export const DEFAULT_OPENAI_DIMENSIONS = 3072;
export const DEFAULT_LOCAL_E5_MODEL = "intfloat/multilingual-e5-small";
export const DEFAULT_LOCAL_E5_DIMENSIONS = 384;
/** Pinned optional multilingual local embedding model. */
export const DEFAULT_LOCAL_JINA_EMBEDDING_MODEL = "jinaai/jina-embeddings-v3";
/** Native output width of the pinned Jina v3 model. */
export const DEFAULT_LOCAL_JINA_EMBEDDING_DIMENSIONS = 1024;
/** Verified Matryoshka output widths advertised by the pinned Jina v3 revision. */
export const LOCAL_JINA_MATRYOSHKA_DIMENSIONS = Object.freeze([32, 64, 128, 256, 512, 768, 1024]);
/** Pinned optional Jina v5 Text Nano embedding (retrieval adapter merged). */
export const DEFAULT_LOCAL_JINA_V5_NANO_MODEL = "jinaai/jina-embeddings-v5-text-nano-retrieval";
/** Native output width of the pinned Jina v5 nano model. */
export const DEFAULT_LOCAL_JINA_V5_NANO_DIMENSIONS = 768;
/** Verified Matryoshka output widths advertised by the pinned Jina v5 nano revision. */
export const LOCAL_JINA_V5_NANO_MATRYOSHKA_DIMENSIONS = Object.freeze([32, 64, 128, 256, 512, 768]);
export const DEFAULT_LOCAL_MODEL_CACHE = "${OPENCLAW_HOME}/models/plur1bus";
export const DEFAULT_COHERE_RERANK_MODEL = "rerank-v3.5";
export const DEFAULT_LOCAL_RERANKER_MODEL = "woxpas-ai/bge-reranker-v2-m3-onnx";

export const EMBEDDING_DIMENSIONS = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  [DEFAULT_LOCAL_E5_MODEL]: DEFAULT_LOCAL_E5_DIMENSIONS,
  [DEFAULT_LOCAL_JINA_EMBEDDING_MODEL]: DEFAULT_LOCAL_JINA_EMBEDDING_DIMENSIONS,
  [DEFAULT_LOCAL_JINA_V5_NANO_MODEL]: DEFAULT_LOCAL_JINA_V5_NANO_DIMENSIONS,
};

const OPENAI_V3_DIMENSION_PROFILES = Object.freeze({
  "text-embedding-3-small": Object.freeze({
    defaultDimensions: 1536,
    maxDimensions: 1536,
    presets: Object.freeze([256, 512, 768, 1024, 1536]),
  }),
  "text-embedding-3-large": Object.freeze({
    defaultDimensions: 3072,
    maxDimensions: 3072,
    presets: Object.freeze([256, 512, 768, 1024, 1536, 2048, 3072]),
  }),
});

function canonicalOpenAiModel(model = "") {
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

export function embeddingDimensionsForModel(model) {
  return EMBEDDING_DIMENSIONS[model] || null;
}

export function isOpenAiEmbeddingModel(model = "") {
  return !model.includes("/") || model.startsWith("openai/") || model.startsWith("text-embedding-");
}

/** Return whether the model accepts OpenAI's optional dimensions request field. */
export function supportsOpenAiCustomDimensions(model = "") {
  return Object.hasOwn(OPENAI_V3_DIMENSION_PROFILES, canonicalOpenAiModel(model));
}

export function defaultDimensionForOpenAiModel(model = "") {
  if (model.includes("small") || model.includes("ada")) return 1536;
  return DEFAULT_OPENAI_DIMENSIONS;
}

/** Describe the verified dimension behavior for an embedding provider/model pair. */
export function embeddingDimensionCapability({ provider, model } = {}) {
  const canonicalModel = canonicalOpenAiModel(model);
  if (provider === "openai" && Object.hasOwn(OPENAI_V3_DIMENSION_PROFILES, canonicalModel)) {
    const profile = OPENAI_V3_DIMENSION_PROFILES[canonicalModel];
    return {
      mode: "selectable",
      defaultDimensions: profile.defaultDimensions,
      minDimensions: 1,
      maxDimensions: profile.maxDimensions,
      presets: [...profile.presets],
      verification: "runtime_vector",
    };
  }
  if (provider === "openai" && canonicalModel === "text-embedding-ada-002") {
    return {
      mode: "fixed",
      defaultDimensions: 1536,
      minDimensions: 1536,
      maxDimensions: 1536,
      presets: [1536],
      verification: "runtime_vector",
    };
  }
  if (provider === "local-transformers" && model === DEFAULT_LOCAL_E5_MODEL) {
    return {
      mode: "fixed",
      defaultDimensions: DEFAULT_LOCAL_E5_DIMENSIONS,
      minDimensions: DEFAULT_LOCAL_E5_DIMENSIONS,
      maxDimensions: DEFAULT_LOCAL_E5_DIMENSIONS,
      presets: [DEFAULT_LOCAL_E5_DIMENSIONS],
      verification: "runtime_vector",
    };
  }
  if (provider === "local-transformers" && model === DEFAULT_LOCAL_JINA_EMBEDDING_MODEL) {
    return {
      mode: "selectable",
      defaultDimensions: DEFAULT_LOCAL_JINA_EMBEDDING_DIMENSIONS,
      minDimensions: LOCAL_JINA_MATRYOSHKA_DIMENSIONS[0],
      maxDimensions: DEFAULT_LOCAL_JINA_EMBEDDING_DIMENSIONS,
      presets: [...LOCAL_JINA_MATRYOSHKA_DIMENSIONS],
      presetOnly: true,
      verification: "runtime_vector",
    };
  }
  if (provider === "local-transformers" && model === DEFAULT_LOCAL_JINA_V5_NANO_MODEL) {
    return {
      mode: "selectable",
      defaultDimensions: DEFAULT_LOCAL_JINA_V5_NANO_DIMENSIONS,
      minDimensions: LOCAL_JINA_V5_NANO_MATRYOSHKA_DIMENSIONS[0],
      maxDimensions: DEFAULT_LOCAL_JINA_V5_NANO_DIMENSIONS,
      presets: [...LOCAL_JINA_V5_NANO_MATRYOSHKA_DIMENSIONS],
      presetOnly: true,
      verification: "runtime_vector",
    };
  }
  return {
    mode: "probe_required",
    defaultDimensions: null,
    minDimensions: null,
    maxDimensions: null,
    presets: [],
    verification: "runtime_vector",
  };
}

/** Return the closed model/dimension catalog projected into operator read surfaces. */
export function embeddingDimensionProfiles(current = {}) {
  const offered = [
    { id: "openai-text-embedding-3-small", provider: "openai", model: "text-embedding-3-small" },
    { id: "openai-text-embedding-3-large", provider: "openai", model: "text-embedding-3-large" },
    { id: "local-multilingual-e5-small", provider: "local-transformers", model: DEFAULT_LOCAL_E5_MODEL },
    {
      id: "local-jina-embeddings-v3",
      provider: "local-transformers",
      model: DEFAULT_LOCAL_JINA_EMBEDDING_MODEL,
      license: "CC-BY-NC-4.0",
      commercialUse: false,
    },
    {
      id: "local-jina-embeddings-v5-nano",
      provider: "local-transformers",
      model: DEFAULT_LOCAL_JINA_V5_NANO_MODEL,
      license: "CC-BY-NC-4.0",
      commercialUse: false,
    },
    { id: "openai-compatible-runtime-probe", provider: "openai-compatible", model: "runtime-probed-model" },
  ];
  return offered.map((entry) => {
    const active = entry.provider === current.provider && entry.model === current.model;
    return {
      ...entry,
      ...embeddingDimensionCapability(entry),
      current: active,
      ...(active && Number.isSafeInteger(current.dimensions) && current.dimensions > 0
        ? { selectedDimensions: current.dimensions }
        : {}),
    };
  });
}
