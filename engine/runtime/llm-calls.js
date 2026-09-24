/**
 * engine/runtime/llm-calls.js — the feature LLM call wrappers (`callLlm`, deterministic context, merge check).
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { callLlm as callOpenAiLlm } from "../../lib/llm-call.js";
import { completeFeatureLlm } from "../../lib/llm-router.js";
import { LLM_RESULT_CACHE_PURPOSES, withLlmCallContext, withLlmResultCacheContext } from "../../lib/llm-result-cache.js";
import { getOpenAI } from "../store/lancedb-loader.js";

// ============================================================================
// LLM helper — shared for merge-check and KNOWLEDGE.md updates
// ============================================================================

async function callLlm(messages, llmCfg) {
  const result = await completeFeatureLlm(messages, llmCfg, {
    runtimeLlm: llmCfg?.callContext?.runtimeLlm,
    agentId: llmCfg?.callContext?.agentId,
    purpose: llmCfg?.callContext?.purpose,
    maxTokens: llmCfg?.maxTokens,
    temperature: llmCfg?.temperature,
    jsonMode: llmCfg?.jsonMode,
    disableThinking: llmCfg?.disableThinking,
    timeoutMs: llmCfg?.timeoutMs,
    signal: llmCfg?.callContext?.signal ?? llmCfg?.signal,
    resultCacheContext: llmCfg?.resultCacheContext,
  }, {
    directCall: (directMessages, directCfg) => callOpenAiLlm(directMessages, directCfg, {
      loadOpenAI: getOpenAI,
      resultCache: directCfg?.resultCache,
    }),
  });
  if (result.status === "failed") throw result.error;
  return result.status === "ok" ? result.text : null;
}

/**
 * Compose deterministic result caching before call-local routing context.
 * @param {object} llmCfg
 * @param {string} agentId
 * @param {string} purpose
 * @param {object} overrides
 * @param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [callContext]
 * @returns {object}
 */
function withDeterministicLlmContext(llmCfg, agentId, purpose, overrides = {}, callContext = {}) {
  return withLlmCallContext(
    withLlmResultCacheContext({ ...llmCfg, ...overrides }, agentId, purpose),
    callContext?.agentId || agentId,
    purpose,
    { runtimeLlm: callContext?.runtimeLlm, signal: callContext?.signal },
  );
}

/**
 * Ask the LLM for one deterministic agent-scoped merge decision.
 * @param {string} existingText
 * @param {string} newText
 * @param {object} llmCfg
 * @param {string} agentId
 * @param {{runtimeLlm?: object}} [callContext]
 * @returns {Promise<object|null>}
 */
async function callMergeCheck(existingText, newText, llmCfg, agentId, callContext = {}) {
  const A = String(existingText || "").slice(0, 2000);
  const B = String(newText || "").slice(0, 2000);
  const content = await callLlm([
    {
      role: "user",
      content: `Two memory fragments — should they be merged into one?\n\nFragment A: ${A}\nFragment B: ${B}\n\nRespond with JSON only: {"merge": boolean, "reason": "brief explanation", "mergedText": "merged version (only if merge=true)"}\nRules:\n- merge=true only if both fragments describe the same subject/fact from different angles\n- mergedText must contain ALL information from both fragments\n- mergedText must be longer than the shorter of the two fragments`,
    },
  ], withDeterministicLlmContext(
    llmCfg,
    agentId,
    LLM_RESULT_CACHE_PURPOSES.MERGE_DECISION,
    // No temperature: providers like the Kimi coding endpoint allow exactly
    // one value per thinking mode and answer HTTP 400 for anything else.
    { jsonMode: true, maxTokens: 300 },
    callContext,
  ));
  if (!content) return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    return null; // LLM returned invalid JSON — treat as no-merge
  }
  // Schema-Validierung: merge muss boolean sein, reason string, mergedText optional string
  if (typeof parsed?.merge !== "boolean" || typeof parsed?.reason !== "string") return null;
  if (parsed.merge && typeof parsed.mergedText !== "string") return null;
  return parsed;
}

export { callLlm, withDeterministicLlmContext, callMergeCheck };
