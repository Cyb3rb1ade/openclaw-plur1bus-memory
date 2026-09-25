/**
 * engine/runtime/env-config.js — environment-variable and config resolution, summaries and small command helpers.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { generateSummary as libGenerateSummary } from "../../lib/text-utils.js";
import { safeWarnLlmFailure } from "../../lib/llm-failure.js";
import { LLM_RESULT_CACHE_PURPOSES, withLlmCallContext, withLlmResultCacheContext } from "../../lib/llm-result-cache.js";
import { callLlm } from "./llm-calls.js";

function resolveEnvVars(value) {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const v = process.env[envVar];
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
    // Strip control chars that could corrupt HTTP headers or JSON strings
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

function resolveConfiguredApiKey(cfg = {}, defaultRef = "") {
  if (typeof cfg.apiKeyEnv === "string" && cfg.apiKeyEnv.trim()) {
    return process.env[cfg.apiKeyEnv.trim()] || undefined;
  }
  if (typeof cfg.apiKey === "string" && cfg.apiKey.trim()) {
    return resolveEnvVars(cfg.apiKey);
  }
  return defaultRef ? resolveOptionalEnvVars(defaultRef) : undefined;
}

function normalizedLlmErrorClass(error) {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error?.name === "TimeoutError" && error?.code === "ETIMEOUT") return "TimeoutError";
  if (typeof DOMException === "function"
    && error instanceof DOMException
    && error.name === "AbortError") {
    return "AbortError";
  }
  if (error instanceof Error) return "Error";
  return "NonError";
}

function commandOption(tokens = [], flag, fallback = "") {
  const index = tokens.indexOf(flag);
  if (index >= 0 && typeof tokens[index + 1] === "string" && !tokens[index + 1].startsWith("--")) {
    return tokens[index + 1];
  }
  return fallback;
}

// generateSummary kommt jetzt aus lib/text-utils.js — re-export für Tests
const generateSummary = libGenerateSummary;

// Liest die ersten `maxBytes` einer Datei synchron als String.
// Verwendet explizite Datei-Handles, um große Dateien nicht komplett in den
// Speicher zu laden (P1 Performance-Audit H1).
function readFileHeadSync(path, maxBytes = 8192) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const toRead = Math.min(size, maxBytes);
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, 0);
    return buf.toString("utf8", 0, bytesRead);
  } catch (_) {
    return "";
  } finally {
    if (typeof fd === "number") closeSync(fd);
  }
}

// ============================================================================
// LLM-based summarization for long messages (auto-capture)
// ============================================================================

/**
 * Summarize oversized captured text with deterministic agent-scoped LLM settings.
 * @param {string} text
 * @param {number} maxChars
 * @param {object} llmCfg
 * @param {object} logger
 * @param {string} agentId
 * @param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [callContext]
 * @returns {Promise<string>}
 */
async function summarizeForCapture(text, maxChars, llmCfg, logger, agentId, callContext = {}) {
  try {
    const result = await callLlm([
      {
        role: "user",
        content: `Summarize this text into the most important facts, decisions, preferences, and actionable information. Keep all specific names, numbers, URLs, dates, technical details, and configuration values. Output ONLY the summary, no preamble. Target length: ${Math.round(maxChars / 4)} characters.\n\n${text.slice(0, 60000)}`,
      },
    ], withLlmCallContext(
      withLlmResultCacheContext(
        { ...llmCfg, maxTokens: Math.round(maxChars / 3), temperature: 0 },
        agentId,
        LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
      ),
      callContext?.agentId || agentId,
      LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
      { runtimeLlm: callContext?.runtimeLlm, signal: callContext?.signal },
    ));
    if (result && result.length > 20) return result;
  } catch (e) {
    safeWarnLlmFailure(logger, "capture-summary.llm", e, { fallback: "truncate" });
  }
  // Fallback: truncate if LLM fails
  return text.slice(0, maxChars);
}

// Baut eine querySummarizer-Funktion für runRecallPipeline.
// Fasst einen langen Prompt auf die semantisch wichtigsten Themen/Schlüsselwörter
// zusammen, statt ihn hart zu kürzen — so gehen keine Suchinformationen verloren.
/**
 * Build an agent-scoped deterministic recall query summarizer.
 * @param {object|null} llmCfg
 * @param {object} logger
 * @param {string} agentId
 * @param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [callContext]
 * @returns {Function|null}
 */
function makeQuerySummarizer(llmCfg, logger, agentId, callContext = {}) {
  if (!llmCfg) return null;
  return async (query) => {
    const result = await callLlm([
      {
        role: "user",
        content: `Extract the key topics, names, events, decisions, and facts from the following text that are relevant for a semantic memory search. Output ONLY a compact summary (2-4 sentences, max 800 chars) capturing the most searchable information. Do not add commentary.\n\n${query.slice(0, 60000)}`,
      },
    ], withLlmCallContext(
      withLlmResultCacheContext(
        { ...llmCfg, maxTokens: 300, temperature: 0 },
        agentId,
        LLM_RESULT_CACHE_PURPOSES.RECALL_QUERY_SUMMARY,
      ),
      callContext?.agentId || agentId,
      LLM_RESULT_CACHE_PURPOSES.RECALL_QUERY_SUMMARY,
      { runtimeLlm: callContext?.runtimeLlm, signal: callContext?.signal },
    ));
    if (result && result.length > 20) return result;
    throw new Error("empty summarizer response");
  };
}

export { resolveEnvVars, resolveOptionalEnvVars, resolveConfiguredApiKey, normalizedLlmErrorClass, commandOption, generateSummary, readFileHeadSync, summarizeForCapture, makeQuerySummarizer };
