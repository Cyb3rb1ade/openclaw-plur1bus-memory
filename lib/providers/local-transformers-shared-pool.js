const SHARED_LOCAL_MODEL_POOL = Symbol.for(
  "@cyb3rb1ade/plur1bus-memory/shared-local-transformers-model-pool",
);
const SHARED_LOCAL_MODEL_POOL_ABI = 1;
const SHARED_LOCAL_MODEL_POOL_KIND = "@cyb3rb1ade/plur1bus-memory/local-transformers-pool-state";

function poolAbiError() {
  const error = new Error(
    "shared local model pool ABI mismatch; restart OpenClaw before loading this PLUR1BUS runtime",
  );
  error.code = "shared_local_model_pool_abi_mismatch";
  return error;
}

function poolState() {
  const existing = globalThis[SHARED_LOCAL_MODEL_POOL];
  if (existing === undefined) {
    globalThis[SHARED_LOCAL_MODEL_POOL] = {
      kind: SHARED_LOCAL_MODEL_POOL_KIND,
      abiVersion: SHARED_LOCAL_MODEL_POOL_ABI,
      entries: new Map(),
    };
  } else if (
    existing?.kind !== SHARED_LOCAL_MODEL_POOL_KIND
    || existing?.abiVersion !== SHARED_LOCAL_MODEL_POOL_ABI
    || !(existing?.entries instanceof Map)
  ) {
    throw poolAbiError();
  }
  return globalThis[SHARED_LOCAL_MODEL_POOL];
}

function closedError() {
  const error = new Error("shared local model runtime is closed");
  error.code = "shared_local_model_closed";
  return error;
}

function ownerUnavailableError() {
  const error = new Error("shared local model runtime has no activated full-runtime owner");
  error.code = "shared_local_model_owner_unavailable";
  return error;
}

function ownerNotActivatedError() {
  const error = new Error("shared local model full-runtime owner is not activated");
  error.code = "shared_local_model_owner_not_activated";
  return error;
}

function cleanupFailedError(cause) {
  const error = new Error(
    "shared local model cleanup failed; restart OpenClaw before loading another local model",
    cause ? { cause } : undefined,
  );
  error.code = "shared_local_model_cleanup_failed";
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
    failure: null,
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
      const state = poolState();
      entry.resource = null;
      entry.loadPromise = null;
      if (failure) {
        entry.failure = failure;
        entry.closing = false;
      } else {
        if (state.entries.get(entry.key) === entry) state.entries.delete(entry.key);
      }
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
 * @param {{key: string, owner?: boolean, requireOwner?: boolean, activationManagedOwner?: boolean}} options Immutable model identity and lifecycle role.
 * @returns {{activate: () => Promise<boolean>, acquire: (load: () => Promise<Function>) => Promise<Function>, beginOperation: () => () => void, release: () => Promise<boolean>}} Shared pipeline lease.
 */
export function createSharedLocalModelLease({
  key,
  owner = false,
  requireOwner = false,
  activationManagedOwner = false,
} = {}) {
  if (typeof key !== "string" || !key) throw new TypeError("shared local model key is required");
  let entry = null;
  let released = false;
  let invalidated = false;
  let ownerActivated = !owner || !activationManagedOwner;

  const lease = {
    invalidate() {
      invalidated = true;
      entry = null;
    },
  };

  if (!owner && requireOwner) {
    const candidate = poolState().entries.get(key);
    if (candidate?.failure) throw cleanupFailedError(candidate.failure);
    if (candidate && !candidate.closing && candidate.owners.size > 0) {
      entry = candidate;
      candidate.borrowers.add(lease);
    }
  }

  const attach = async () => {
    if (released || invalidated) throw closedError();
    if (entry) {
      if (entry.closing) throw closedError();
      return entry;
    }
    const state = poolState();
    while (true) {
      let candidate = state.entries.get(key);
      if (candidate?.failure) throw cleanupFailedError(candidate.failure);
      if (candidate?.closing) {
        await candidate.closedPromise;
        if (released || invalidated) throw closedError();
        continue;
      }
      if (owner && candidate?.owners.size > 0) {
        await candidate.closedPromise;
        if (released || invalidated) throw closedError();
        continue;
      }
      if (!candidate) {
        if (!owner && requireOwner) {
          invalidated = true;
          throw ownerUnavailableError();
        }
        candidate = createEntry(key);
        state.entries.set(key, candidate);
      }
      if (!owner && requireOwner && candidate.owners.size === 0) {
        invalidated = true;
        throw ownerUnavailableError();
      }
      entry = candidate;
      (owner ? candidate.owners : candidate.borrowers).add(lease);
      return candidate;
    }
  };

  const activate = async () => {
    if (!owner) return false;
    await attach();
    ownerActivated = true;
    return true;
  };

  const acquire = async (load) => {
    if (typeof load !== "function") throw new TypeError("shared local model loader is required");
    if (owner && !ownerActivated) throw ownerNotActivatedError();
    return await startLoad(await attach(), load);
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

  return Object.freeze({ activate, acquire, beginOperation, release });
}
