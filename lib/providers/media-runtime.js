const runtimes = new Map();
/** Acquire one process-wide model/revision/precision/variant instance, independent of index width.
 * @param {object} identity Immutable model/runtime identity.
 * @param {Function} load Runtime loader.
 * @returns {object} Reference-counted inference lease. */
export function acquireMediaRuntime(identity, load) {
  const key = JSON.stringify([identity.model, identity.revision, identity.precision, identity.variant || 'full', identity.cacheDir || null]);
  let entry = runtimes.get(key);
  if (!entry) { entry = { refs: 0, promise: null, active: new Set() }; runtimes.set(key, entry); }
  entry.refs++;
  let closed = false;
  const get = async () => {
    if (closed) throw new Error('media runtime closed');
    entry.promise ??= Promise.resolve().then(load);
    return await entry.promise;
  };
  return {
    get,
    async run(operation) {
      const runtime = await get();
      if (closed) throw new Error('media runtime closed');
      const task = Promise.resolve().then(() => operation(runtime));
      entry.active.add(task);
      try { return await task; } finally { entry.active.delete(task); }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (--entry.refs === 0) {
        if (runtimes.get(key) === entry) runtimes.delete(key);
        // Existing operations finish before their instance is disposed.
        await Promise.allSettled([...entry.active]);
        try { if (entry.promise) await (await entry.promise).dispose?.(); }
        finally { if (runtimes.get(key) === entry) runtimes.delete(key); }
      }
    },
  };
}
