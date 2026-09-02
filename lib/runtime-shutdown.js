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
 * Hand back the OpenClaw runtime only when it can actually be touched.
 *
 * Outside "full" registration OpenClaw substitutes a proxy that throws on every
 * property access, so `api.runtime?.x` is not safe: the optional chain guards
 * against null, not against a throwing getter. Every read of the runtime during
 * registration must go through here, or one probe aborts the whole plugin and
 * takes all of its CLI commands with it.
 *
 * @param {object} api OpenClaw plugin API capability surface.
 * @returns {object|undefined} The runtime, or undefined when it is unavailable.
 */
export function runtimeIfUsable(api) {
  const runtime = api?.runtime;
  if (runtime === undefined || runtime === null) return undefined;
  try {
    // Probe rather than match on api.registrationMode. The host has more modes
    // than the two that substitute the proxy -- "discovery" carries a perfectly
    // usable runtime -- and a name list silently hides a live runtime the next
    // time OpenClaw adds one. Reading any property is enough: the substitute
    // throws on every one of them.
    void runtime.config;
  } catch {
    return undefined;
  }
  return runtime;
}

/**
 * Decide whether this registration owns a replaceable OpenClaw runtime generation.
 * @param {object} api OpenClaw plugin API capability surface.
 * @returns {boolean} Whether local-model acquisition must wait for prior runtime cleanup.
 */
export function shouldCoordinateLocalModelGeneration(api) {
  // The registration-mode check has to come first. Outside "full" mode OpenClaw
  // hands the plugin a runtime proxy that throws on every property access, so
  // probing api.runtime before this point aborts the entire registration -- and
  // with it every CLI command the plugin would otherwise declare. The result is
  // unchanged: a non-full registration never coordinates a model generation.
  const runtime = runtimeIfUsable(api);
  const hasRuntimeConfig = typeof runtime?.config?.current === "function";
  const hasLifecycle = typeof api?.lifecycle?.registerRuntimeLifecycle === "function"
    || typeof api?.registerRuntimeLifecycle === "function";
  if (!hasRuntimeConfig || !hasLifecycle) return false;
  if (typeof api.registrationMode !== "string") return true;
  return api.registrationMode === "full";
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
 * @param {{shutdown: () => Promise<void>}} [dependencies.scopedEmbeddingServer]
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
  scopedEmbeddingServer = null,
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
      const localModelResources = (async () => {
        if (typeof scopedEmbeddingServer?.shutdown === "function") {
          await cleanup(
            "memory-lancedb-namespaced: scoped embedding IPC shutdown failed",
            () => scopedEmbeddingServer.shutdown(),
          );
        }
        if (typeof embeddings?.shutdown === "function") {
          await cleanup(
            "memory-lancedb-namespaced: embedding provider shutdown failed",
            () => embeddings.shutdown(),
          );
        }
        if (typeof reranker?.shutdown === "function") {
          await cleanup(
            "memory-lancedb-namespaced: reranker shutdown failed",
            () => reranker.shutdown(),
          );
        }
        if (typeof localModelGeneration?.releaseModels === "function") {
          await cleanup(
            "memory-lancedb-namespaced: local model generation shutdown failed",
            () => localModelGeneration.releaseModels(),
          );
        }
      })();
      const immediate = [
        typeof modelPreparationCoordinator?.shutdown === "function"
          ? cleanup("memory-lancedb-namespaced: model preparation shutdown failed", () => modelPreparationCoordinator.shutdown())
          : null,
        typeof reembeddingCoordinator?.shutdown === "function"
          ? cleanup("memory-lancedb-namespaced: reembedding coordinator shutdown failed", () => reembeddingCoordinator.shutdown())
          : null,
        localModelResources,
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

/**
 * Attach shared local-model ownership only after OpenClaw activates the full registry.
 * @param {object} api OpenClaw plugin API with activation-owned service registration.
 * @param {object} options Lifecycle and embedding-provider inputs.
 * @param {boolean} options.enabled Whether this is the full runtime generation.
 * @param {boolean} options.lifecycleRegistered Whether gateway-stop ownership exists.
 * @param {{activateSharedModelOwner: () => Promise<boolean>, shutdown: () => Promise<void>}|null} [options.embeddings] Full embedding provider.
 * @returns {boolean} Whether the activation-owned service was registered.
 */
export function registerLocalModelOwnershipServiceAfterLifecycle(api, {
  enabled,
  lifecycleRegistered,
  embeddings = null,
}) {
  if (!enabled || !embeddings) return false;
  if (!lifecycleRegistered) {
    api.logger?.warn?.(
      "memory-lancedb-namespaced: shared local-model ownership disabled because the OpenClaw gateway lifecycle capability is unavailable",
    );
    return false;
  }
  if (
    typeof api.registerService !== "function"
    || typeof embeddings.activateSharedModelOwner !== "function"
    || typeof embeddings.shutdown !== "function"
  ) {
    api.logger?.warn?.(
      "memory-lancedb-namespaced: shared local-model ownership disabled because the OpenClaw plugin service capability is unavailable",
    );
    return false;
  }
  let startPromise = null;
  api.registerService({
    id: "plur1bus-local-model-owner",
    start() {
      if (!startPromise) startPromise = embeddings.activateSharedModelOwner();
      return startPromise;
    },
    async stop() {
      await embeddings.shutdown();
    },
  });
  return true;
}

/**
 * Register durable re-embedding switch recovery only after host activation.
 * @param {object} api OpenClaw plugin API with service registration and logger.
 * @param {object} options Lifecycle gate and recovery coordinator.
 * @param {boolean} options.lifecycleRegistered Whether gateway-stop ownership exists.
 * @param {{start: () => Promise<object|null>, shutdown: () => Promise<void>}|null} [options.recovery] Recovery coordinator.
 * @returns {boolean} Whether the activation-owned service was registered.
 */
export function registerReembeddingRecoveryServiceAfterLifecycle(api, {
  lifecycleRegistered,
  recovery = null,
}) {
  if (!recovery) return false;
  if (!lifecycleRegistered) {
    api.logger?.warn?.(
      "memory-lancedb-namespaced: reembedding switch recovery disabled because the OpenClaw gateway lifecycle capability is unavailable",
    );
    return false;
  }
  if (typeof api.registerService !== "function") {
    api.logger?.warn?.(
      "memory-lancedb-namespaced: reembedding switch recovery disabled because the OpenClaw plugin service capability is unavailable",
    );
    return false;
  }
  let started = false;
  api.registerService({
    id: "plur1bus-reembedding-switch-recovery",
    start() {
      if (started) return;
      started = true;
      void recovery.start().then((record) => {
        if (record?.state === "completed") {
          api.logger?.info?.(
            `memory-lancedb-namespaced: reembedding switch recovered (${record.id})`,
          );
        }
      }).catch((error) => {
        safeWarn(api.logger, "reembedding-switch-recovery.start", error);
      });
    },
    async stop() {
      await recovery.shutdown();
    },
  });
  return true;
}
