/**
 * lib/local-model-generation.js — local-model ownership across OpenClaw
 * runtime generations (was lib/runtime-shutdown.js:3-21 and :71-198, moved
 * verbatim). Host-neutral: the engine builds the lifecycle in createEngine();
 * lib/runtime-shutdown.js re-exports it for its existing importers.
 */

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
