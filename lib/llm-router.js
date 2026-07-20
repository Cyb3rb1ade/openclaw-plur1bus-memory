import { safeWarn } from "./safe-logging.js";

const DEFAULT_NATIVE_TIMEOUT_MS = 30_000;

/** Immutable route kinds returned by the feature LLM resolver. */
export const LLM_ROUTE_KINDS = Object.freeze({
  OPENCLAW_DEFAULT: "openclaw-default",
  OPENCLAW_OVERRIDE: "openclaw-override",
  DIRECT_OVERRIDE: "direct-override",
  UNAVAILABLE: "unavailable",
});

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeTimeoutMs(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.max(1, Math.floor(normalized));
}

function normalizeHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  return Object.freeze(Object.fromEntries(entries));
}

function routeDependencies(options) {
  return {
    feature: normalizeNonEmptyString(options?.feature) || "unknown",
    runtimeLlm: options?.runtimeLlm,
    logger: options?.logger,
    resultCache: options?.resultCache,
  };
}

function unavailableRoute(options, reason) {
  const dependencies = routeDependencies(options);
  safeWarn(options?.logger, "llm-router", reason, {
    feature: dependencies.feature,
  });
  return Object.freeze({
    kind: LLM_ROUTE_KINDS.UNAVAILABLE,
    ...dependencies,
    reason,
  });
}

function createTimeoutError(timeoutMs) {
  const error = new Error("OpenClaw LLM call timed out");
  error.name = "TimeoutError";
  error.code = "ETIMEOUT";
  error.timeoutMs = timeoutMs;
  return error;
}

function createBoundedSignal(callerSignal, timeoutMs, dependencies) {
  const controller = new AbortController();
  const setTimer = typeof dependencies?.setTimer === "function"
    ? dependencies.setTimer
    : setTimeout;
  const clearTimer = typeof dependencies?.clearTimer === "function"
    ? dependencies.clearTimer
    : clearTimeout;
  let callerAbortListener = null;

  if (callerSignal?.aborted) {
    controller.abort(callerSignal.reason);
  } else if (typeof callerSignal?.addEventListener === "function") {
    callerAbortListener = () => controller.abort(callerSignal.reason);
    callerSignal.addEventListener("abort", callerAbortListener, { once: true });
  }

  const timer = setTimer(() => {
    if (!controller.signal.aborted) {
      controller.abort(createTimeoutError(timeoutMs));
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimer(timer);
      if (callerAbortListener && typeof callerSignal?.removeEventListener === "function") {
        callerSignal.removeEventListener("abort", callerAbortListener);
      }
    },
  };
}

function normalizedErrorClass(error) {
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

function logDispatchFailure(route, callOptions, error) {
  safeWarn(route?.logger, "llm-router", "transport-failed", {
    feature: route?.feature || "unknown",
    route: route?.kind || LLM_ROUTE_KINDS.UNAVAILABLE,
    ...(callOptions?.agentId ? { agentId: callOptions.agentId } : {}),
    errorClass: normalizedErrorClass(error),
  });
}

function normalizeText(result) {
  const rawText = typeof result === "string" ? result : result?.text;
  if (typeof rawText !== "string") return null;
  const text = rawText.trim();
  return text || null;
}

function okResult(result, route, callOptions) {
  const metadata = result && typeof result === "object" ? result : {};
  return {
    status: "ok",
    text: normalizeText(result),
    route: route.kind,
    provider: metadata.provider,
    model: metadata.model
      ?? (route.kind === LLM_ROUTE_KINDS.DIRECT_OVERRIDE ? route.model : undefined),
    agentId: metadata.agentId ?? callOptions?.agentId,
    usage: metadata.usage,
  };
}

function directCallConfig(route, callOptions) {
  const disableThinking = typeof callOptions?.disableThinking === "boolean"
    ? callOptions.disableThinking
    : route.disableThinking;
  const timeoutMs = normalizeTimeoutMs(callOptions?.timeoutMs) || route.timeoutMs;
  return {
    model: route.model,
    ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
    ...(route.apiKey ? { apiKey: route.apiKey } : {}),
    ...(route.headers ? { headers: route.headers } : {}),
    ...(Number.isFinite(callOptions?.maxTokens) ? { maxTokens: callOptions.maxTokens } : {}),
    ...(Number.isFinite(callOptions?.temperature)
      ? { temperature: callOptions.temperature }
      : {}),
    ...(typeof callOptions?.jsonMode === "boolean" ? { jsonMode: callOptions.jsonMode } : {}),
    ...(typeof disableThinking === "boolean" ? { disableThinking } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
    ...(route.resultCache ? { resultCache: route.resultCache } : {}),
    ...(callOptions?.resultCacheContext
      ? { resultCacheContext: callOptions.resultCacheContext }
      : {}),
  };
}

/**
 * Resolve one feature's chat-LLM configuration to an immutable route descriptor.
 *
 * @param {object} [featureConfig]
 * @param {object} [options]
 * @returns {Readonly<object>}
 */
export function resolveFeatureLlmRoute(featureConfig = {}, options = {}) {
  const model = normalizeNonEmptyString(featureConfig?.model);
  const baseUrl = normalizeNonEmptyString(featureConfig?.baseUrl);
  const apiKey = normalizeNonEmptyString(featureConfig?.apiKey);
  const headers = normalizeHeaders(featureConfig?.headers);
  const hasDirectTransport = Boolean(baseUrl || apiKey || headers);

  if (options?.credentialUnavailable === true) {
    return unavailableRoute(options, "direct-credential-unavailable");
  }

  if (hasDirectTransport && !model) {
    return unavailableRoute(options, "ambiguous-partial-override");
  }

  const dependencies = routeDependencies(options);
  if (hasDirectTransport) {
    const timeoutMs = normalizeTimeoutMs(featureConfig?.timeoutMs);
    return Object.freeze({
      kind: LLM_ROUTE_KINDS.DIRECT_OVERRIDE,
      ...dependencies,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
      ...(featureConfig?.disableThinking === true ? { disableThinking: true } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  const timeoutMs = normalizeTimeoutMs(featureConfig?.timeoutMs);
  return Object.freeze({
    kind: model
      ? LLM_ROUTE_KINDS.OPENCLAW_OVERRIDE
      : LLM_ROUTE_KINDS.OPENCLAW_DEFAULT,
    ...dependencies,
    ...(model ? { model } : {}),
    ...(featureConfig?.disableThinking === true ? { disableThinking: true } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

/**
 * Report whether a resolved route can dispatch an LLM call.
 *
 * @param {object|null|undefined} route
 * @returns {boolean}
 */
export function isLlmRouteAvailable(route) {
  return Boolean(route && route.kind !== LLM_ROUTE_KINDS.UNAVAILABLE);
}

/**
 * Dispatch a feature chat-LLM call through its resolved native or direct route.
 *
 * @param {Array<object>} messages
 * @param {Readonly<object>} route
 * @param {object} [callOptions]
 * @param {object} [dependencies]
 * @returns {Promise<object>}
 */
export async function completeFeatureLlm(
  messages,
  route,
  callOptions = {},
  dependencies = {},
) {
  if (!route || route.kind === LLM_ROUTE_KINDS.UNAVAILABLE) {
    return {
      status: "unavailable",
      text: null,
      route: LLM_ROUTE_KINDS.UNAVAILABLE,
      reason: route?.reason || "invalid-route",
    };
  }

  try {
    if (route.kind === LLM_ROUTE_KINDS.DIRECT_OVERRIDE) {
      const directCfg = directCallConfig(route, callOptions);
      const result = await dependencies.directCall(messages, directCfg, {
        resultCache: route.resultCache,
      });
      return okResult(result, route, callOptions);
    }

    const timeoutMs = normalizeTimeoutMs(callOptions?.timeoutMs)
      || route.timeoutMs
      || DEFAULT_NATIVE_TIMEOUT_MS;
    const runtimeLlm = typeof callOptions?.runtimeLlm?.complete === "function"
      ? callOptions.runtimeLlm
      : route.runtimeLlm;
    if (typeof runtimeLlm?.complete !== "function") {
      safeWarn(route.logger, "llm-router", "openclaw-runtime-unavailable", {
        feature: route.feature || "unknown",
      });
      return {
        status: "unavailable",
        text: null,
        route: LLM_ROUTE_KINDS.UNAVAILABLE,
        reason: "openclaw-runtime-unavailable",
      };
    }

    const bounded = createBoundedSignal(callOptions?.signal, timeoutMs, dependencies);
    try {
      const params = {
        messages,
        ...(callOptions?.agentId ? { agentId: callOptions.agentId } : {}),
        ...(callOptions?.purpose ? { purpose: callOptions.purpose } : {}),
        ...(Number.isFinite(callOptions?.maxTokens)
          ? { maxTokens: callOptions.maxTokens }
          : {}),
        ...(Number.isFinite(callOptions?.temperature)
          ? { temperature: callOptions.temperature }
          : {}),
        signal: bounded.signal,
      };
      if (route.kind === LLM_ROUTE_KINDS.OPENCLAW_OVERRIDE) {
        params.model = route.model;
      }
      const result = await runtimeLlm.complete(params);
      return okResult(result, route, callOptions);
    } finally {
      bounded.cleanup();
    }
  } catch (error) {
    logDispatchFailure(route, callOptions, error);
    return {
      status: "failed",
      text: null,
      route: route.kind,
      error,
    };
  }
}
