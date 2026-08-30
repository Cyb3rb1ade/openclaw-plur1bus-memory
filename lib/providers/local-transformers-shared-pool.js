const SHARED_LOCAL_MODEL_POOL = Symbol.for(
  "@cyb3rb1ade/plur1bus-memory/shared-local-transformers-model-pool",
);

function poolState() {
  if (!globalThis[SHARED_LOCAL_MODEL_POOL]) {
    globalThis[SHARED_LOCAL_MODEL_POOL] = { entries: new Map() };
  }
  return globalThis[SHARED_LOCAL_MODEL_POOL];
}

function closedError() {
  const error = new Error("shared local model runtime is closed");
  error.code = "shared_local_model_closed";
  return error;
}

function createEntry(key) {
  let resolveDrained;
  let resolveClosed;
  return {
    key,
    owners: new Set(),
    borrowers: new Set(),
    resource: null,
    loadPromise: null,
    activeOperations: 0,
    drainedPromise: null,
    resolveDrained,
    closing: false,
    closePromise: null,
    closedPromise: new Promise((resolve) => { resolveClosed = resolve; }),
    resolveClosed,
  };
}

function startLoad(entry, load) {
  if (entry.loadPromise) return entry.loadPromise;
  entry.loadPromise = Promise.resolve()
    .then(load)
    .then((resource) => {
      if (!resource || typeof resource !== "function") {
        throw new Error("shared local model loader must return a callable pipeline");
      }
      entry.resource = resource;
      return resource;
    })
    .catch((error) => {
      entry.resource = null;
      entry.loadPromise = null;
      throw error;
    });
  return entry.loadPromise;
}

function waitForOperations(entry) {
  if (entry.activeOperations === 0) return Promise.resolve();
  if (!entry.drainedPromise) {
    entry.drainedPromise = new Promise((resolve) => { entry.resolveDrained = resolve; });
  }
  return entry.drainedPromise;
}

function closeEntry(entry) {
  if (entry.closePromise) return entry.closePromise;
  entry.closing = true;
  entry.closePromise = (async () => {
    let failure = null;
    try {
      await waitForOperations(entry);
      let resource = entry.resource;
      if (!resource && entry.loadPromise) {
        try {
          resource = await entry.loadPromise;
        } catch (error) {
          failure = error;
        }
      }
      if (typeof resource?.dispose === "function") {
        try {
          await resource.dispose();
        } catch (error) {
          failure = failure
            ? new AggregateError([failure, error], "shared local model load and disposal failed")
            : error;
        }
      }
    } finally {
      entry.resource = null;
      entry.loadPromise = null;
      const state = poolState();
      if (state.entries.get(entry.key) === entry) state.entries.delete(entry.key);
      for (const lease of [...entry.owners, ...entry.borrowers]) lease.invalidate();
      entry.owners.clear();
      entry.borrowers.clear();
      entry.resolveClosed();
    }
    if (failure) throw failure;
  })();
  return entry.closePromise;
}

/**
 * Create a lazy process-wide lease for one exact Transformers.js pipeline.
 * @param {{key: string, owner?: boolean}} options Immutable model identity and lifecycle role.
 * @returns {{acquire: (load: () => Promise<Function>) => Promise<Function>, beginOperation: () => () => void, release: () => Promise<boolean>}} Shared pipeline lease.
 */
export function createSharedLocalModelLease({ key, owner = false } = {}) {
  if (typeof key !== "string" || !key) throw new TypeError("shared local model key is required");
  let entry = null;
  let released = false;
  let invalidated = false;

  const lease = {
    invalidate() {
      invalidated = true;
      entry = null;
    },
  };

  const acquire = async (load) => {
    if (typeof load !== "function") throw new TypeError("shared local model loader is required");
    if (released || invalidated) throw closedError();
    if (entry) {
      if (entry.closing) throw closedError();
      return await startLoad(entry, load);
    }
    const state = poolState();
    while (true) {
      let candidate = state.entries.get(key);
      if (candidate?.closing) {
        await candidate.closedPromise;
        if (released || invalidated) throw closedError();
        continue;
      }
      if (!candidate) {
        candidate = createEntry(key);
        state.entries.set(key, candidate);
      }
      entry = candidate;
      (owner ? candidate.owners : candidate.borrowers).add(lease);
      return await startLoad(candidate, load);
    }
  };

  const beginOperation = () => {
    if (released || invalidated || !entry || entry.closing || !entry.resource) throw closedError();
    const activeEntry = entry;
    activeEntry.activeOperations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activeEntry.activeOperations -= 1;
      if (activeEntry.activeOperations === 0 && activeEntry.resolveDrained) {
        const resolve = activeEntry.resolveDrained;
        activeEntry.resolveDrained = null;
        activeEntry.drainedPromise = null;
        resolve();
      }
    };
  };

  const release = async () => {
    if (released) return false;
    released = true;
    if (!entry || invalidated) return false;
    const activeEntry = entry;
    entry = null;
    (owner ? activeEntry.owners : activeEntry.borrowers).delete(lease);
    const ownerEnded = owner && activeEntry.owners.size === 0;
    const unused = activeEntry.owners.size === 0 && activeEntry.borrowers.size === 0;
    if (ownerEnded || unused) await closeEntry(activeEntry);
    return true;
  };

  return Object.freeze({ acquire, beginOperation, release });
}
