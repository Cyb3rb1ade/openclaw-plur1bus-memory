import { redactError, safeWarn } from "./safe-logging.js";
import { appendFileSync } from "node:fs";

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
    // 7.12.55: Pfad der schaltbaren Fehlerdiagnose; leer heisst aus.
    diagnosticsPath: normalizeNonEmptyString(options?.diagnosticsPath) || "",
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

function createAbortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error("OpenClaw LLM call aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
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
  let rejectAbort;
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const rejectFromAbort = () => {
    rejectAbort(createAbortError(controller.signal.reason));
  };
  controller.signal.addEventListener("abort", rejectFromAbort, { once: true });

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
    waitFor(operation) {
      return Promise.race([operation, abortPromise]);
    },
    cleanup() {
      clearTimer(timer);
      controller.signal.removeEventListener("abort", rejectFromAbort);
      if (callerAbortListener && typeof callerSignal?.removeEventListener === "function") {
        callerSignal.removeEventListener("abort", callerAbortListener);
      }
    },
  };
}

function safeDataString(value, property, maxLength = 80) {
  if (value === null || value === undefined) return null;
  try {
    let current = Object(value);
    for (let depth = 0; current && depth < MAX_SAFE_STRING_PROTOTYPES; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, property);
      if (descriptor) {
        if (!("value" in descriptor) || typeof descriptor.value !== "string") return null;
        const redacted = redactError(descriptor.value).message;
        return redacted.slice(0, maxLength) || null;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch {
    return null;
  }
  return null;
}

function normalizedErrorClass(error) {
  try {
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof RangeError) return "RangeError";
    if (error instanceof SyntaxError) return "SyntaxError";
    if (safeDataString(error, "name") === "TimeoutError"
      && safeDataString(error, "code") === "ETIMEOUT") return "TimeoutError";
    if (typeof DOMException === "function" && error instanceof DOMException) {
      // DOMException exposes name through a platform-defined getter. Call the
      // native getter directly so an own property on the thrown instance
      // cannot spoof or hide the abort classification; foreign objects remain
      // protected by safeDataString's descriptor-only access.
      const domExceptionNameGetter = Object.getOwnPropertyDescriptor(
        DOMException.prototype,
        "name",
      )?.get;
      if (typeof domExceptionNameGetter === "function"
        && domExceptionNameGetter.call(error) === "AbortError") {
        return "AbortError";
      }
    }
    if (error instanceof Error) return "Error";
  } catch {
    return "NonError";
  }
  return "NonError";
}

// 7.12.54: Die Meldung des Fremdsystems darf nicht ins Log — sie kann
// Prompt-Inhalte oder Zugangsdaten tragen, und genau deshalb stand hier bisher
// nur das Etikett "transport-failed". Damit war aber auch nicht zu erkennen,
// WORAN ein Aufruf scheiterte: Am 12.09.2026 standen 30 solcher Zeilen im Log,
// ohne jeden Hinweis. Diese Liste ordnet die Meldung einer festen Kategorie zu
// und gibt ausschliesslich diese Kategorie aus, nie den Text selbst.
const ERROR_HINTS = Object.freeze([
  // Zuerst die festen Wortlaute des Hosts: sie benennen die Ursache genau.
  [/requires an injected runtime config scope/i, "no-config-scope"],
  [/configured agent runtime is unavailable/i, "runtime-unavailable"],
  [/does not support isolated completion|unavailable for isolated completion/i, "harness-unsupported"],
  [/isolated completion input was rejected|input was rejected/i, "input-rejected"],
  [/isolated completion output was rejected|stop reason/i, "output-rejected"],
  [/isolated completion timed out|completion timed out after/i, "host-timeout"],
  [/isolated completion was aborted|completion was aborted/i, "host-aborted"],
  [/plugin llm completion failed/i, "host-failed"],
  [/abort/i, "aborted"],
  [/timeout|timed out|etimedout/i, "timeout"],
  [/rate.?limit|too many requests|\b429\b/i, "rate-limited"],
  [/quota|budget|credit|exhaust/i, "quota"],
  [/unauthor|forbidden|\b401\b|\b403\b|api[_ -]?key|credential/i, "auth"],
  [/busy|concurrent|in flight|already running|queue/i, "busy"],
  [/not allowed|permission|policy|override|denied/i, "denied"],
  [/unavailable|not available|no runtime|disposed|closed|destroyed|shut ?down/i, "unavailable"],
  [/network|socket|econn|fetch failed|dns|tls/i, "network"],
  [/\b5\d\d\b|internal server/i, "server-error"],
  [/\b4\d\d\b|invalid|malformed|unsupported/i, "request-rejected"],
]);
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,40}$/;
const MAX_SAFE_STRING_PROTOTYPES = 8;

/**
 * Grobe Kategorie einer Fehlermeldung, ohne die Meldung selbst preiszugeben.
 * @param {*} error
 * @returns {string}
 */
export function errorHint(error) {
  const message = redactError(error).message;
  for (const [pattern, label] of ERROR_HINTS) {
    if (pattern.test(message)) return label;
  }
  return "other";
}

/**
 * 7.12.55: Schaltbare Fehlerdiagnose.
 *
 * Die Meldung des Fremdsystems gehoert nicht ins Log (sie kann Prompt-Inhalte
 * oder Zugangsdaten tragen), aber ohne sie laesst sich eine Ursache wie die 30
 * Fehlschlaege vom 12.09.2026 nicht klaeren. Ist `diagnosticsPath` gesetzt,
 * schreibt der Router die redigierte Meldung in genau diese Datei — nicht ins
 * Log, nicht in den Chat. Der Schalter gehoert dem Betreiber
 * (`llmRouter.errorDiagnostics`), steht standardmaessig aus und sollte nach
 * der Klaerung wieder aus.
 * @param {object} route
 * @param {*} error
 */
function appendErrorDiagnostics(route, error) {
  const target = typeof route?.diagnosticsPath === "string" ? route.diagnosticsPath.trim() : "";
  if (!target) return;
  try {
    const entry = {
      at: new Date().toISOString(),
      feature: route?.feature || "unknown",
      route: route?.kind || LLM_ROUTE_KINDS.UNAVAILABLE,
      name: safeDataString(error, "name"),
      code: safeDataString(error, "code"),
      message: redactError(error).message,
    };
    appendFileSync(target, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Diagnose darf den Aufruf nie zusaetzlich scheitern lassen.
  }
}

function logDispatchFailure(route, callOptions, error) {
  appendErrorDiagnostics(route, error);
  const code = safeDataString(error, "code");
  const safeCode = code && ERROR_CODE_RE.test(code) ? code : null;
  safeWarn(route?.logger, "llm-router", "transport-failed", {
    feature: route?.feature || "unknown",
    route: route?.kind || LLM_ROUTE_KINDS.UNAVAILABLE,
    ...(callOptions?.agentId ? { agentId: callOptions.agentId } : {}),
    errorClass: normalizedErrorClass(error),
    errorHint: errorHint(error),
    ...(safeCode ? { errorCode: safeCode } : {}),
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
    if (callOptions?.signal?.aborted) {
      throw createAbortError(callOptions.signal.reason);
    }
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
      // agentId is deliberately NOT forwarded. OpenClaw builds plugin LLM
      // runtimes with authority.allowAgentIdOverride === false, and the
      // registration-time handle used by hooks carries no bound agent at all,
      // so resolveAgentId() threw "Plugin LLM completion cannot override the
      // target agent." on every native call. Omitting it lets the host resolve
      // its own agent; per-agent separation still comes from the result-cache
      // scope, and callers read the effective agent off the result.
      const params = {
        messages,
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
      const result = await bounded.waitFor(runtimeLlm.complete(params));
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
