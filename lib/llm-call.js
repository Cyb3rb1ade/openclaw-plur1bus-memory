import { withTimeout } from "./with-timeout.js";

const DEFAULT_LLM_TIMEOUT_MS = 30_000;

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.max(1, Math.floor(parsed));
}

async function loadDefaultOpenAI() {
  const module = await import("openai");
  return module.default;
}

/**
 * Call an OpenAI-compatible chat completion endpoint with a bounded timeout.
 *
 * @param {Array<object>} messages
 * @param {object} llmCfg
 * @param {object} [options]
 * @param {Function} [options.OpenAI] — injected OpenAI-compatible class for tests
 * @param {Function} [options.loadOpenAI] — async loader used by index.js fallback paths
 * @param {object} [options.resultCache] — exact LLM result cache
 * @returns {Promise<string|null>}
 */
export async function callLlm(messages, llmCfg = {}, options = {}) {
  const compute = async () => {
    const loadOpenAI = options.loadOpenAI || loadDefaultOpenAI;
    const OpenAI = options.OpenAI || await loadOpenAI();
    const clientOpts = { apiKey: llmCfg.apiKey, baseURL: llmCfg.baseUrl };
    if (llmCfg.headers) clientOpts.defaultHeaders = llmCfg.headers;
    const client = new OpenAI(clientOpts);
    const body = {
      model: llmCfg.model,
      max_tokens: llmCfg.maxTokens || 300,
      ...(Number.isFinite(llmCfg.temperature) ? { temperature: llmCfg.temperature } : {}),
      ...(llmCfg.jsonMode ? { response_format: { type: "json_object" } } : {}),
      messages,
    };
    // kimi-for-coding: omitting thinking defaults to ON, then content may be empty
    // and the answer can arrive in reasoning_content instead.
    if (llmCfg.disableThinking) body.thinking = { type: "disabled" };
    const timeoutMs = normalizeTimeoutMs(llmCfg.timeoutMs);
    const response = await withTimeout(
      client.chat.completions.create(body),
      timeoutMs,
      "callLlm",
    );
    const msg = response.choices[0]?.message;
    const content = msg?.content?.trim();
    const reasoning = msg?.reasoning_content;
    const text = content
      || ((typeof reasoning === "string" && reasoning.trim()) ? reasoning.trim() : null);
    const inputTokens = response.usage?.prompt_tokens ?? response.usage?.input_tokens;
    const outputTokens = response.usage?.completion_tokens ?? response.usage?.output_tokens;
    const providerCachedInputTokens = response.usage?.prompt_tokens_details?.cached_tokens
      ?? response.usage?.input_tokens_details?.cached_tokens;
    return {
      text,
      usage: {
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
        providerCachedInputTokens: Number.isFinite(providerCachedInputTokens)
          ? providerCachedInputTokens
          : null,
      },
    };
  };

  const cacheRequest = {
    scopeId: llmCfg.resultCacheContext?.scopeId,
    purpose: llmCfg.resultCacheContext?.purpose,
    endpoint: llmCfg.baseUrl || "https://api.openai.com/v1",
    credential: llmCfg.apiKey || "",
    model: llmCfg.model || "",
    messages,
    maxTokens: llmCfg.maxTokens || 300,
    temperature: llmCfg.temperature,
    jsonMode: llmCfg.jsonMode === true,
    disableThinking: llmCfg.disableThinking === true,
    headers: llmCfg.headers || {},
  };
  const result = options.resultCache
    ? await options.resultCache.getOrCompute(cacheRequest, compute)
    : await compute();
  return result.text;
}
