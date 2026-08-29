import { safeWarn } from "./safe-logging.js";

const LOCAL_MODEL_GENERATION_STATE = Symbol.for(
  "@cyb3rb1ade/plur1bus-memory/local-model-generation-state",
);

function localModelGenerationState() {
  if (!globalThis[LOCAL_MODEL_GENERATION_STATE]) {
    globalThis[LOCAL_MODEL_GENERATION_STATE] = {
      tail: Promise.resolve(Object.freeze({ error: null })),
      sequence: 0,
    };
  }
  return globalThis[LOCAL_MODEL_GENERATION_STATE];
}

function lifecycleError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

/**
 * Coordinate local-model ownership across OpenClaw registry generations.
 * @param {{enabled?: boolean, waitTimeoutMs?: number}} [options] Gate options.
 * @returns {{beforeAcquire: () => Promise<void>, registerResource: (resource: {shutdown: () => Promise<void>}, label?: string) => false|(() => boolean), beginCleanup: () => void, releaseModels: () => Promise<void>}} Generation lifecycle.
 */
export function createLocalModelGenerationLifecycle({
  enabled = true,
  waitTimeoutMs = 5_000,
} = {}) {
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) {
    throw new TypeError("local model generation waitTimeoutMs must be positive");
  }
  let activated = false;
  let closing = false;
  let released = false;
  let releaseModelsPromise = null;
  let predecessorBarrier = null;
  let releaseError = null;
  let releaseResolve;
  const resources = new Map();
  const releasedPromise = new Promise((resolve) => { releaseResolve = resolve; });
  const record = {
    id: null,
    get error() { return releaseError; },
    released: releasedPromise,
  };

  const beforeAcquire = async () => {
    if (!enabled) return;
    if (closing) {
      throw lifecycleError(
        "local model acquisition refused because this PLUR1BUS runtime generation is closing",
        "local_model_generation_closing",
      );
    }
    if (!activated) {
      const state = localModelGenerationState();
      activated = true;
      predecessorBarrier = state.tail;
      record.id = ++state.sequence;
      state.tail = (async () => {
        const predecessorResult = await predecessorBarrier;
        await record.released;
        return Object.freeze({ error: predecessorResult.error || record.error || null });
      })();
    }
    if (predecessorBarrier) {
      let timer;
      let predecessorResult;
      try {
        predecessorResult = await Promise.race([
          predecessorBarrier,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(lifecycleError(
              "previous PLUR1BUS runtime generation did not release local models within the OpenClaw cleanup budget",
              "local_model_predecessor_cleanup_timeout",
            )), waitTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (predecessorResult.error) {
        throw lifecycleError(
          "previous PLUR1BUS runtime generation failed to release a local model",
          "local_model_predecessor_cleanup_failed",
          predecessorResult.error,
        );
      }
    }
    if (closing) {
      throw lifecycleError(
        "local model acquisition refused because this PLUR1BUS runtime generation is closing",
        "local_model_generation_closing",
      );
    }
  };

  const registerResource = (resource, label = "local model") => {
    if (!enabled) return false;
    if (!resource || typeof resource.shutdown !== "function") {
      throw new TypeError("local model lifecycle resource must expose shutdown()");
    }
    if (closing || released) {
      throw lifecycleError(
        "local model resource registration refused because this PLUR1BUS runtime generation is closing",
        "local_model_generation_closing",
      );
    }
    resources.set(resource, String(label || "local model"));
    let registered = true;
    return () => {
      if (!registered) return false;
      registered = false;
      return resources.delete(resource);
    };
  };

  const beginCleanup = () => { closing = true; };
  const releaseModels = () => {
    if (releaseModelsPromise) return releaseModelsPromise;
    beginCleanup();
    releaseModelsPromise = (async () => {
      const failures = [];
      const pending = [...resources].map(async ([resource, label]) => {
        try {
          await resource.shutdown();
        } catch (error) {
          failures.push(new Error(`${label} shutdown failed: ${error?.message || String(error)}`, { cause: error }));
        }
      });
      await Promise.all(pending);
      resources.clear();
      releaseError = failures.length === 0
        ? null
        : failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "local model generation cleanup failed");
      released = true;
      releaseResolve();
      if (releaseError) throw releaseError;
    })();
    return releaseModelsPromise;
  };

  return Object.freeze({ beforeAcquire, registerResource, beginCleanup, releaseModels });
}

/**
 * Register the bounded gateway-stop cleanup sequence for plugin-owned resources.
 * @param {object} api OpenClaw plugin API with `on` and `logger` members.
 * @param {object} dependencies Runtime resources to close.
 * @param {{shutdown: () => Promise<void>}} dependencies.memoryDbAdapter
 * @param {{shutdown: () => Promise<void>}} dependencies.pool
 * @param {{shutdown: () => Promise<void>}} [dependencies.sharedMemoryPool]
 * @param {(() => Promise<void>)|null} [dependencies.clearTurnRoutes] Clear an initialized turn registry without creating one.
 * @param {() => Promise<void>} dependencies.flushMetrics
 * @param {{close: () => Promise<void>}} dependencies.llmResultCache
 * @param {{shutdown: () => Promise<void>}} [dependencies.embeddings]
 * @param {{shutdown: () => Promise<void>}} [dependencies.reranker]
 * @param {{shutdown: () => Promise<void>}} [dependencies.modelPreparationCoordinator]
 * @param {{shutdown: () => Promise<void>}} [dependencies.reembeddingCoordinator]
 * @param {{beginCleanup: () => void, releaseModels: () => Promise<void>}} [dependencies.localModelGeneration]
 * @returns {boolean} Whether an OpenClaw runtime cleanup owner was registered.
 */
export function registerGatewayShutdown(api, {
  memoryDbAdapter,
  pool,
  sharedMemoryPool = null,
  clearTurnRoutes = null,
  flushMetrics,
  llmResultCache,
  embeddings = null,
  reranker = null,
  modelPreparationCoordinator = null,
  reembeddingCoordinator = null,
  localModelGeneration = null,
}) {
  const registerRuntimeLifecycle = typeof api.lifecycle?.registerRuntimeLifecycle === "function"
    ? api.lifecycle.registerRuntimeLifecycle.bind(api.lifecycle)
    : typeof api.registerRuntimeLifecycle === "function"
      ? api.registerRuntimeLifecycle.bind(api)
      : null;
  const canRegisterGatewayStop = typeof api.on === "function";
  if (!registerRuntimeLifecycle && !canRegisterGatewayStop) return false;

  let shutdownPromise = null;
  const shutdownOnce = () => {
    if (shutdownPromise) return shutdownPromise;
    localModelGeneration?.beginCleanup?.();
    shutdownPromise = (async () => {
      const cleanup = async (label, operation) => {
        try { await operation(); } catch (err) { api.logger.warn?.(`${label}: ${err?.message}`); }
      };
      const immediate = [
        typeof modelPreparationCoordinator?.shutdown === "function"
          ? cleanup("memory-lancedb-namespaced: model preparation shutdown failed", () => modelPreparationCoordinator.shutdown())
          : null,
        typeof reembeddingCoordinator?.shutdown === "function"
          ? cleanup("memory-lancedb-namespaced: reembedding coordinator shutdown failed", () => reembeddingCoordinator.shutdown())
          : null,
        typeof embeddings?.shutdown === "function"
          ? cleanup("memory-lancedb-namespaced: embedding provider shutdown failed", () => embeddings.shutdown())
          : null,
        typeof reranker?.shutdown === "function"
          ? cleanup("memory-lancedb-namespaced: reranker shutdown failed", () => reranker.shutdown())
          : null,
        typeof localModelGeneration?.releaseModels === "function"
          ? cleanup("memory-lancedb-namespaced: local model generation shutdown failed", () => localModelGeneration.releaseModels())
          : null,
      ].filter(Boolean);
      const ordered = (async () => {
        await cleanup("memory-lancedb-namespaced: adapter shutdown failed", () => memoryDbAdapter.shutdown());
        await cleanup("memory-lancedb-namespaced: pool shutdown failed", () => pool.shutdown());
        if (sharedMemoryPool) {
          await cleanup("memory-lancedb-namespaced: shared pool shutdown failed", () => sharedMemoryPool.shutdown());
        }
        if (typeof clearTurnRoutes === "function") {
          await cleanup("memory-lancedb-namespaced: turn route shutdown failed", () => clearTurnRoutes());
        }
        await cleanup("metrics flush failed", () => flushMetrics());
        await cleanup("memory-lancedb-namespaced: LLM result cache shutdown failed", () => llmResultCache.close());
      })();
      await Promise.all([...immediate, ordered]);
    })();
    return shutdownPromise;
  };

  if (registerRuntimeLifecycle) {
    registerRuntimeLifecycle({
      id: "plur1bus-runtime-resources",
      description: "Dispose PLUR1BUS databases, caches, local models, and background work on host cleanup.",
      cleanup: shutdownOnce,
    });
  }
  if (canRegisterGatewayStop) {
    api.on("gateway_stop", shutdownOnce, { timeoutMs: 30_000 });
  }
  return true;
}

/**
 * Register optional model preparation as an activation-owned OpenClaw service.
 * @param {object} api OpenClaw plugin API with service registration and logger.
 * @param {object} options Lifecycle gate and coordinator.
 * @param {boolean} options.lifecycleRegistered Whether gateway-stop ownership exists.
 * @param {{start: () => Promise<object>, shutdown: () => Promise<void>}|null} [options.coordinator] Preparation coordinator.
 * @returns {boolean} Whether the activation-owned service was registered.
 */
export function registerModelPreparationServiceAfterLifecycle(api, {
  lifecycleRegistered,
  coordinator = null,
}) {
  if (!coordinator) return false;
  if (!lifecycleRegistered) {
    api.logger?.warn?.(
      "memory-lancedb-namespaced: model preparation disabled because the OpenClaw gateway lifecycle capability is unavailable",
    );
    return false;
  }
  if (typeof api.registerService !== "function") {
    api.logger?.warn?.(
      "memory-lancedb-namespaced: model preparation disabled because the OpenClaw plugin service capability is unavailable",
    );
    return false;
  }
  let started = false;
  api.registerService({
    id: "plur1bus-model-preparation",
    start() {
      if (started) return;
      started = true;
      void coordinator.start().then((snapshot) => {
        if (snapshot?.state === "ready") {
          api.logger?.info?.(
            `memory-lancedb-namespaced: local embedding preparation ready (${snapshot.model}, ${snapshot.dimensions}d)`,
          );
        }
      }).catch((error) => {
        safeWarn(api.logger, "model-preparation.start", error);
      });
    },
    async stop() {
      await coordinator.shutdown();
    },
  });
  return true;
}
