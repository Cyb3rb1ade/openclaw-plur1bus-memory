/**
 * lib/jev-chunk-decider.js — decides per captured message whether splitting
 * it into parts makes sense, using TypeSafe's Jev decision model.
 *
 * The structural splitter (lib/memory-chunking.js) cuts at lists, headings and
 * paragraphs. That is right for a message with several independent points and
 * wrong for one coherent piece: a stored recipe became fourteen rows such as
 * "1 Prise Salz". Jev answers one Choice question — coherent, independent or
 * mixed — with a calibrated confidence:
 *
 *   coherent, confident     -> "whole": keep the message as one row
 *   independent, confident  -> "parts": store only the parts
 *   anything else, or error -> "both":  whole row plus parts (the 7.12.70 default)
 *
 * Measured 04.10.2026 on German text: recipe and explanation "coherent", four
 * unrelated requests "independent", each at confidence 1.00, 200–450 ms.
 * Jev is an external HTTP service, not a host plugin LLM, so it is not subject
 * to the post-turn caller-authority refusal (openclaw/openclaw#162941).
 */

import { safeWarn } from "./safe-logging.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_DEFAULT_MIN_CONFIDENCE = 0.85;
export const JEV_DEFAULT_TIMEOUT_MS = 5000;
// Jev takes 32k tokens for state plus the longest question; stay well below.
const JEV_MAX_STATE_CHARS = 60_000;

const STRUCTURE_QUESTION = Object.freeze({
  type: "choice",
  instructions: "Is this message one coherent unit that should be kept together (e.g. a recipe, instructions, one explanation or argument), or a collection of independent statements or requests that each make sense on their own?",
  criteria: Object.freeze({
    coherent: "One topic or one connected piece: parts depend on each other and lose meaning when separated (recipe with ingredients and steps, how-to, single explanation).",
    independent: "Several unrelated statements, facts or requests that each make sense alone.",
    mixed: "Partly connected, partly independent.",
  }),
});

/**
 * Map one Jev answer to a storage decision.
 *
 * @param {{choice?: string, confidence?: number} | null | undefined} answer
 * @param {number} [minConfidence]
 * @returns {"whole" | "parts" | "both"}
 */
export function storageForJevAnswer(answer, minConfidence = JEV_DEFAULT_MIN_CONFIDENCE) {
  const confidence = Number(answer?.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) return "both";
  if (answer?.choice === "coherent") return "whole";
  if (answer?.choice === "independent") return "parts";
  return "both";
}

/**
 * Create the per-message decider used by the capture path.
 *
 * @param {{apiKey?: string, model?: string, minConfidence?: number, timeoutMs?: number, fetchImpl?: Function, logger?: object}} [opts]
 * @returns {((text: string) => Promise<{storage: "whole"|"parts"|"both", choice?: string, confidence?: number, reason?: string}>) | null}
 *   null when no API key is configured.
 */
export function createJevChunkDecider(opts = {}) {
  const apiKey = typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";
  if (!apiKey) return null;
  const model = typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : JEV_DEFAULT_MODEL;
  const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : JEV_DEFAULT_MIN_CONFIDENCE;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : JEV_DEFAULT_TIMEOUT_MS;
  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch;
  const logger = opts.logger;

  return async (text) => {
    const state = String(text || "").slice(0, JEV_MAX_STATE_CHARS);
    if (!state.trim()) return { storage: "both", reason: "empty" };
    try {
      const response = await fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, state, questions: { structure: STRUCTURE_QUESTION } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response?.ok) {
        // Status only: the body may echo the request.
        safeWarn(logger, "jev-chunk-decider", `http ${response?.status ?? "?"}`);
        return { storage: "both", reason: `http_${response?.status ?? "unknown"}` };
      }
      const body = await response.json();
      const answer = body?.answers?.structure;
      return {
        storage: storageForJevAnswer(answer, minConfidence),
        choice: typeof answer?.choice === "string" ? answer.choice : undefined,
        confidence: Number.isFinite(Number(answer?.confidence)) ? Number(answer.confidence) : undefined,
      };
    } catch (err) {
      safeWarn(logger, "jev-chunk-decider", err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : err);
      return { storage: "both", reason: err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "error" };
    }
  };
}
