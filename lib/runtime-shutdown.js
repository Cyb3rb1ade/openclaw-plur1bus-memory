import { createResourceCloser } from "../engine/lifecycle/close-resources.js";
import { safeWarn } from "./safe-logging.js";

export { createLocalModelGenerationLifecycle } from "./local-model-generation.js";

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
 * @param {(() => Promise<void>)|null} [dependencies.closeResources] A ready closer (the engine's,
 *   engine/lifecycle/close-resources.js); when given, the resource members above are not read.
 * @returns {boolean} Whether an OpenClaw runtime cleanup owner was registered.
 */
export function registerGatewayShutdown(api, {
  closeResources = null,
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

  const shutdownOnce = typeof closeResources === "function"
    ? closeResources
    : createResourceCloser({
        logger: api.logger,
        memoryDbAdapter,
        pool,
        sharedMemoryPool,
        clearTurnRoutes,
        flushMetrics,
        llmResultCache,
        scopedEmbeddingServer,
        embeddings,
        reranker,
        modelPreparationCoordinator,
        reembeddingCoordinator,
        localModelGeneration,
      });

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

/**
 * Registrierungsmodi, in denen OpenClaw das Plugin außerhalb des Gateways
 * lädt (CLI-Aufrufe wie `openclaw plur1bus-obsidian status`). Dort gibt es
 * `config.mutateConfigFile` grundsätzlich nicht — der Re-Embedding-Switch und
 * das Rollback laufen im Gateway; beide Pfade werfen bei fehlender Fähigkeit
 * ohnehin einen expliziten Fehler.
 */
const NON_GATEWAY_REGISTRATION_MODES = new Set(["discovery", "cli-metadata", "setup-only"]);

/**
 * Log-Hinweis zur fehlenden Konfigurationsmutation, oder `null` wenn verfügbar.
 *
 * Im Gateway (oder bei unbekanntem Modus) bleibt es eine Warnung, weil dort
 * tatsächlich Funktionen ausfallen. In einem CLI-Prozess ist dieselbe Meldung
 * bei jedem Aufruf nur Rauschen und wurde deshalb auf `info` gesenkt; im
 * 2026.8.2-Labor tauchte sie bei jedem `openclaw plur1bus-feature-cron` in der
 * gemeinsamen Logdatei auf.
 *
 * @param {object} api OpenClaw Plugin-API
 * @returns {{level: "warn"|"info", message: string}|null}
 */
export function configMutationLogNotice(api) {
  if (typeof runtimeIfUsable(api)?.config?.mutateConfigFile === "function") return null;
  if (NON_GATEWAY_REGISTRATION_MODES.has(api?.registrationMode)) {
    return {
      level: "info",
      message: "memory-lancedb-namespaced: mutateConfigFile is not available in this process; reembedding switch and rollback run inside the gateway",
    };
  }
  return {
    level: "warn",
    message: "memory-lancedb-namespaced: OpenClaw mutateConfigFile capability unavailable; reembedding switch and rollback are disabled",
  };
}
