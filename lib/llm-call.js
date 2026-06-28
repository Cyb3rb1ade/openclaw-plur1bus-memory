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
 * @returns {Promise<string|null>}
 */
export async function callLlm(messages, llmCfg = {}, options = {}) {
  const loadOpenAI = options.loadOpenAI || loadDefaultOpenAI;
  const OpenAI = options.OpenAI || await loadOpenAI();
  const clientOpts = { apiKey: llmCfg.apiKey, baseURL: llmCfg.baseUrl };
  if (llmCfg.headers) clientOpts.defaultHeaders = llmCfg.headers;
  const client = new OpenAI(clientOpts);
  const body = {
    model: llmCfg.model,
    max_tokens: llmCfg.maxTokens || 300,
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
  if (content) return content;
  const reasoning = msg?.reasoning_content;
  return (typeof reasoning === "string" && reasoning.trim()) ? reasoning.trim() : null;
}
