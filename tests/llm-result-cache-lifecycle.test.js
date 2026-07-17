import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexUrl = pathToFileURL(join(root, "index.js")).href;
const cacheUrl = pathToFileURL(join(root, "lib", "llm-result-cache.js")).href;
const mockCacheUrl = "mock:llm-result-cache";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url === cacheUrl && context.parentURL?.startsWith(indexUrl)) {
      return { url: mockCacheUrl, shortCircuit: true };
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    if (url !== mockCacheUrl) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export const LLM_RESULT_CACHE_PURPOSES = Object.freeze({
          CAPTURE_SUMMARY: "capture-summary",
          RECALL_QUERY_SUMMARY: "recall-query-summary",
          MERGE_DECISION: "merge-decision",
          CONFLICT_RESOLUTION: "conflict-resolution",
          EMOTION_CLASSIFICATION: "emotion-classification",
          EPISODE_ANALYSIS: "episode-analysis",
          CONVERSATION_INSIGHTS: "conversation-insights",
          SKILL_EXTRACTION: "skill-extraction",
          REM_PATTERN_ANALYSIS: "rem-pattern-analysis",
          KNOWLEDGE_UPDATE: "knowledge-update",
        });
        export function withLlmResultCacheContext(config, scopeId, purpose) {
          return { ...config, resultCacheContext: { scopeId, purpose } };
        }
        export function createLlmResultCache() {
          return {
            getOrCompute: (_request, compute) => compute(),
            getMetrics: () => ({ requests: 0, hits: 0, hitRate: 0 }),
            close: () => {
              globalThis.__llmResultCacheCloseCalls += 1;
              globalThis.__llmResultCacheCloseStarted();
              return globalThis.__llmResultCacheClosePromise;
            },
          };
        }
      `,
    };
  },
});

function makeMockApi(baseDbPath, gatewayStops) {
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: 8 } },
      emotion: { t3: { enabled: false } },
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (path) => path,
    registerCommand: noop,
    registerTool: noop,
    registerService: noop,
    on(event, handler) {
      if (event === "gateway_stop") gatewayStops.push(handler);
    },
  };
}

describe("LLM result cache lifecycle", () => {
  it("calls and awaits register-local cache close exactly once on gateway_stop", async (t) => {
    const gatewayStops = [];
    let releaseClose;
    let signalCloseStarted;
    const closeStarted = new Promise((resolve) => { signalCloseStarted = resolve; });
    globalThis.__llmResultCacheCloseCalls = 0;
    globalThis.__llmResultCacheCloseStarted = signalCloseStarted;
    globalThis.__llmResultCacheClosePromise = new Promise((resolve) => { releaseClose = resolve; });
    t.after(() => {
      delete globalThis.__llmResultCacheCloseCalls;
      delete globalThis.__llmResultCacheCloseStarted;
      delete globalThis.__llmResultCacheClosePromise;
    });

    const { default: plugin } = await import(`${indexUrl}?lifecycle=${Date.now()}`);
    plugin.register(makeMockApi("/tmp/plur1bus-llm-cache-lifecycle", gatewayStops));
    assert.ok(gatewayStops.length > 0, "plugin must register gateway_stop handlers");

    let shutdownSettled = false;
    const shutdown = Promise.all(gatewayStops.map((handler) => handler()))
      .then(() => { shutdownSettled = true; });
    let timeoutId;
    const closeWasCalled = await Promise.race([
      closeStarted.then(() => true),
      new Promise((resolve) => { timeoutId = setTimeout(() => resolve(false), 1_000); }),
    ]);
    clearTimeout(timeoutId);

    assert.strictEqual(closeWasCalled, true, "gateway_stop must call cache.close()");
    assert.strictEqual(globalThis.__llmResultCacheCloseCalls, 1);
    assert.strictEqual(shutdownSettled, false, "gateway_stop must await cache.close()");

    releaseClose();
    await shutdown;
    assert.strictEqual(shutdownSettled, true);
  });

  it("isolates cache close in its own logged try/catch", () => {
    const source = readFileSync(join(root, "index.js"), "utf8");
    const adapterStart = source.indexOf("const memoryDbAdapter = createDbAdapter");
    const handlerStart = source.indexOf('api.on("gateway_stop", async () => {', adapterStart);
    const handlerEnd = source.indexOf("}, { timeoutMs: 30_000 });", handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    assert.match(
      handler,
      /try\s*\{\s*await llmResultCache\.close\(\);\s*\}\s*catch\s*\(err\)\s*\{[^}]*logger\.warn/s
    );
  });
});
