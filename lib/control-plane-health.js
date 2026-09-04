const HEALTH_STATUSES = new Set(["ready", "degraded", "unavailable"]);
const PUBLIC_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const NAMESPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_:-]{0,63}$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid PLUR1BUS health ${name}`);
  return value;
}

function publicId(value, name, pattern = PUBLIC_ID_RE) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid PLUR1BUS health ${name}`);
  }
  return value;
}

function freezeArray(values) {
  return Object.freeze(values);
}

function projectCountGroup(value, name) {
  if (!Array.isArray(value)) throw new Error(`invalid PLUR1BUS health ${name}`);
  const seen = new Set();
  const projected = value.map((entry) => {
    if (!isPlainObject(entry)) throw new Error(`invalid PLUR1BUS health ${name} entry`);
    const id = publicId(entry.id, `${name} id`);
    if (seen.has(id)) throw new Error(`duplicate PLUR1BUS health ${name} id`);
    seen.add(id);
    return Object.freeze({ id, cards: nonNegativeSafeInteger(entry.cards, `${name} cards`) });
  });
  return freezeArray(projected.toSorted((left, right) => left.id.localeCompare(right.id)));
}

function projectNamespaces(value) {
  if (!Array.isArray(value)) throw new Error("invalid PLUR1BUS health namespaces");
  const seen = new Set();
  const projected = value.map((entry) => {
    if (!isPlainObject(entry)) throw new Error("invalid PLUR1BUS health namespace entry");
    const id = publicId(entry.id, "namespace id", NAMESPACE_ID_RE);
    if (seen.has(id)) throw new Error("duplicate PLUR1BUS health namespace id");
    seen.add(id);
    const dimensions = nonNegativeSafeInteger(entry.dimensions, "namespace dimensions");
    if (dimensions === 0) throw new Error("invalid PLUR1BUS health namespace dimensions");
    return Object.freeze({
      id,
      dimensions,
      rows: nonNegativeSafeInteger(entry.rows, "namespace rows"),
    });
  });
  return freezeArray(projected.toSorted((left, right) => left.id.localeCompare(right.id)));
}

function projectLastError(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new Error("invalid PLUR1BUS health last error");
  return Object.freeze({
    component: publicId(value.component, "error component", ERROR_CODE_RE),
    code: publicId(value.code, "error code", ERROR_CODE_RE),
  });
}

function projectSnapshot(value, observedAt) {
  if (!isPlainObject(value)) throw new Error("invalid PLUR1BUS health snapshot");
  if (!HEALTH_STATUSES.has(value.status)) throw new Error("invalid PLUR1BUS health status");
  if (!isPlainObject(value.cards)) throw new Error("invalid PLUR1BUS health cards");
  if (!isPlainObject(value.storage)) throw new Error("invalid PLUR1BUS health storage");
  if (typeof value.storage.complete !== "boolean") throw new Error("invalid PLUR1BUS health storage completeness");
  const storageBytes = value.storage.bytes === null && value.storage.complete === false
    ? null
    : nonNegativeSafeInteger(value.storage.bytes, "storage bytes");
  return Object.freeze({
    status: value.status,
    namespaces: projectNamespaces(value.namespaces),
    cards: Object.freeze({
      byAgent: projectCountGroup(value.cards.byAgent, "agent cards"),
      byWorkspace: projectCountGroup(value.cards.byWorkspace, "workspace cards"),
      byUser: projectCountGroup(value.cards.byUser, "user cards"),
    }),
    storage: Object.freeze({
      bytes: storageBytes,
      complete: value.storage.complete,
    }),
    lastError: projectLastError(value.lastError),
    observedAt,
  });
}

function safeObservedAt(now) {
  try {
    return nonNegativeSafeInteger(now(), "timestamp");
  } catch {
    return 0;
  }
}

function failedSnapshot(observedAt) {
  return Object.freeze({
    status: "degraded",
    namespaces: freezeArray([]),
    cards: Object.freeze({
      byAgent: freezeArray([]),
      byWorkspace: freezeArray([]),
      byUser: freezeArray([]),
    }),
    storage: Object.freeze({ bytes: null, complete: false }),
    lastError: Object.freeze({ component: "health", code: "health_scan_failed" }),
    observedAt,
  });
}

function normalizeScanRoot(value, name) {
  if (!isPlainObject(value)) throw new Error(`invalid PLUR1BUS health ${name} root`);
  if (typeof value.path !== "string" || !value.path) throw new Error(`invalid PLUR1BUS health ${name} path`);
  const dimensions = nonNegativeSafeInteger(value.dimensions, `${name} dimensions`);
  if (dimensions === 0) throw new Error(`invalid PLUR1BUS health ${name} dimensions`);
  return Object.freeze({
    id: publicId(value.id, `${name} id`, NAMESPACE_ID_RE),
    path: value.path,
    dimensions,
  });
}

function normalizePartitionIds(value, kind) {
  if (!Array.isArray(value)) throw new Error(`invalid PLUR1BUS health ${kind} partitions`);
  const seen = new Set();
  return value.map((entry) => {
    const id = publicId(entry, `${kind} partition`);
    if (seen.has(id)) throw new Error(`duplicate PLUR1BUS health ${kind} partition`);
    seen.add(id);
    return id;
  });
}

function incrementCount(counts, id, cards) {
  counts.set(id, (counts.get(id) ?? 0) + cards);
}

function countEntries(counts) {
  return [...counts.entries()]
    .map(([id, cards]) => ({ id, cards }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function normalizeStorage(value) {
  if (!isPlainObject(value) || typeof value.complete !== "boolean") {
    throw new Error("invalid PLUR1BUS health storage measurement");
  }
  const bytes = value.bytes === null && value.complete === false
    ? null
    : nonNegativeSafeInteger(value.bytes, "storage bytes");
  return {
    bytes,
    complete: value.complete,
  };
}

/**
 * Create an aggregate-only health scan over injected, read-only partition primitives.
 * @param {{namespaceRoots: object[], sharedRoots?: object, listPartitions: Function, inspectRows: Function, measureStorage: Function, workspaceIdentityForKey?: Function, maxPartitions?: number}} options Scan dependencies.
 * @returns {() => Promise<object>} A scanner returning no card content or filesystem paths.
 */
export function createControlPlaneHealthScan({
  namespaceRoots,
  sharedRoots = {},
  listPartitions,
  inspectRows,
  measureStorage,
  workspaceIdentityForKey = () => null,
  maxPartitions = 128,
} = {}) {
  if (!Array.isArray(namespaceRoots)) throw new Error("PLUR1BUS health namespace roots are required");
  if (!isPlainObject(sharedRoots)) throw new Error("invalid PLUR1BUS health shared roots");
  if (typeof listPartitions !== "function") throw new Error("PLUR1BUS health partition lister is required");
  if (typeof inspectRows !== "function") throw new Error("PLUR1BUS health row inspector is required");
  if (typeof measureStorage !== "function") throw new Error("PLUR1BUS health storage inspector is required");
  if (typeof workspaceIdentityForKey !== "function") {
    throw new Error("PLUR1BUS health workspace identity resolver is required");
  }
  if (!Number.isSafeInteger(maxPartitions) || maxPartitions < 1) {
    throw new Error("invalid PLUR1BUS health partition limit");
  }

  const roots = namespaceRoots.map((root) => normalizeScanRoot(root, "namespace"));
  const workspaceRoot = sharedRoots.workspace === undefined
    ? null
    : normalizeScanRoot({ id: "shared-workspaces", ...sharedRoots.workspace }, "workspace");
  const userRoot = sharedRoots.user === undefined
    ? null
    : normalizeScanRoot({ id: "shared-users", ...sharedRoots.user }, "user");

  return async () => {
    const namespaces = [];
    const agentCards = new Map();
    const workspaceCards = new Map();
    const userCards = new Map();
    let inspectedPartitions = 0;
    let failure = null;

    const recordFailure = (component, code) => {
      if (failure === null) failure = { component, code };
    };

    const scanRoot = async (root, kind, counts) => {
      let rows = 0;
      let partitionIds = [];
      try {
        // The directory filter admits names that the public-id contract
        // rejects (leading "_" or digit). Dropping just those keeps one
        // unsupported partition from discarding every sibling count.
        const listed = await listPartitions({ kind, basePath: root.path });
        let usable = listed;
        if (Array.isArray(listed)) {
          // Names with a leading underscore are PLUR1BUS's own reserved
          // directories inside the store (`_neo` for the Neo workspace), not
          // partitions. They are skipped silently; flagging them pinned
          // "degraded" on every dashboard that had a Neo workspace.
          const candidates = listed.filter((entry) => !(typeof entry === "string" && entry.startsWith("_")));
          usable = candidates.filter((entry) => typeof entry === "string" && PUBLIC_ID_RE.test(entry));
          if (usable.length !== candidates.length) recordFailure("health", "partition_id_unsupported");
        }
        partitionIds = normalizePartitionIds(usable, kind);
      } catch {
        recordFailure("lancedb", "partition_list_failed");
      }
      for (const partitionId of partitionIds) {
        if (inspectedPartitions >= maxPartitions) {
          recordFailure("health", "partition_limit_reached");
          break;
        }
        inspectedPartitions += 1;
        try {
          const cards = nonNegativeSafeInteger(
            await inspectRows({
              kind,
              basePath: root.path,
              partitionId,
              namespaceId: root.id,
              dimensions: root.dimensions,
            }),
            "partition rows",
          );
          rows += cards;
          let publicPartitionId = partitionId;
          if (kind === "workspace") {
            try {
              const resolved = workspaceIdentityForKey(partitionId);
              if (typeof resolved === "string" && PUBLIC_ID_RE.test(resolved)) publicPartitionId = resolved;
              else if (resolved !== null && resolved !== undefined) recordFailure("health", "workspace_identity_invalid");
            } catch {
              recordFailure("health", "workspace_identity_unavailable");
            }
          }
          incrementCount(counts, publicPartitionId, cards);
        } catch {
          recordFailure("lancedb", "partition_count_failed");
        }
      }
      namespaces.push({ id: root.id, dimensions: root.dimensions, rows });
    };

    for (const root of roots) await scanRoot(root, "agent", agentCards);
    if (workspaceRoot) await scanRoot(workspaceRoot, "workspace", workspaceCards);
    if (userRoot) await scanRoot(userRoot, "user", userCards);

    let storage;
    try {
      storage = normalizeStorage(await measureStorage());
      if (!storage.complete) recordFailure("storage", "storage_scan_incomplete");
    } catch {
      storage = { bytes: null, complete: false };
      recordFailure("storage", "storage_measure_failed");
    }

    return {
      status: failure ? "degraded" : "ready",
      namespaces,
      cards: {
        byAgent: countEntries(agentCards),
        byWorkspace: countEntries(workspaceCards),
        byUser: countEntries(userCards),
      },
      storage,
      lastError: failure,
    };
  };
}

/**
 * Create a bounded, redacted cache around an aggregate-only memory health scan.
 *
 * Two serving modes share one coalesced scan:
 * - default: a caller past the TTL waits for a new scan (the pre-7.5.4 contract);
 * - stale-while-revalidate: a caller past the TTL gets the last snapshot at once
 *   and the scan runs behind it. `start()` warms the cache without a caller and
 *   keeps it warm on `refreshIntervalMs`; a failed scan is retried after
 *   `failedRetryMs` instead of being served for a whole interval.
 * @param {{scan: () => Promise<object>, now?: () => number, ttlMs?: number, staleWhileRevalidate?: boolean, refreshIntervalMs?: number, failedRetryMs?: number|null, setTimer?: Function, clearTimer?: Function, onRefresh?: Function|null}} options Inspector dependencies.
 * @returns {{snapshot: () => Promise<object>, invalidate: () => void, start: () => void, stop: () => void}} Health inspector methods.
 */
export function createControlPlaneHealthInspector({
  scan,
  now = Date.now,
  ttlMs = 10_000,
  staleWhileRevalidate = false,
  refreshIntervalMs = 0,
  failedRetryMs = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRefresh = null,
} = {}) {
  if (typeof scan !== "function") throw new Error("PLUR1BUS health scan is required");
  if (typeof now !== "function") throw new Error("PLUR1BUS health clock is required");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error("invalid PLUR1BUS health cache TTL");
  if (typeof staleWhileRevalidate !== "boolean") throw new Error("invalid PLUR1BUS health serving mode");
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 0) {
    throw new Error("invalid PLUR1BUS health refresh interval");
  }
  if (failedRetryMs !== null && (!Number.isSafeInteger(failedRetryMs) || failedRetryMs < 0)) {
    throw new Error("invalid PLUR1BUS health failed-scan retry delay");
  }
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw new Error("PLUR1BUS health timers are required");
  }
  if (onRefresh !== null && typeof onRefresh !== "function") throw new Error("invalid PLUR1BUS health refresh hook");

  let cached = null;
  let cachedAt = null;
  let cachedFailed = false;
  let inFlight = null;
  let timer = null;
  let started = false;

  // A failed snapshot stays "fresh" only for the shorter retry window, so a
  // cold LanceDB at gateway start does not pin "degraded" on the page for a
  // whole refresh interval.
  const freshWindowMs = () => (cachedFailed && failedRetryMs !== null ? Math.min(ttlMs, failedRetryMs) : ttlMs);
  const isFresh = (at) => cached !== null && cachedAt !== null && at - cachedAt <= freshWindowMs();

  const schedule = () => {
    if (!started || refreshIntervalMs <= 0) return;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const delayMs = cachedFailed && failedRetryMs !== null ? Math.min(refreshIntervalMs, failedRetryMs) : refreshIntervalMs;
    timer = setTimer(() => {
      timer = null;
      refresh();
    }, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  };

  const refresh = () => {
    if (inFlight) return inFlight;
    const current = (async () => {
      const observedAt = safeObservedAt(now);
      let next;
      let failed = false;
      try {
        next = projectSnapshot(await scan(), observedAt);
      } catch {
        next = failedSnapshot(observedAt);
        failed = true;
      }
      cached = next;
      cachedAt = observedAt;
      cachedFailed = failed;
      if (onRefresh) {
        try {
          onRefresh({ status: next.status, failed, durationMs: Math.max(0, safeObservedAt(now) - observedAt) });
        } catch {
          // A logging hook must never break the cache.
        }
      }
      return next;
    })();
    inFlight = current;
    current.then(() => {
      if (inFlight === current) inFlight = null;
      schedule();
    });
    return current;
  };

  const snapshot = async () => {
    const requestedAt = safeObservedAt(now);
    if (isFresh(requestedAt)) return cached;
    // Serving a stale failure would keep a real caller from ever seeing the
    // store recover; a stale success is fine to show while the scan runs.
    if (staleWhileRevalidate && cached !== null && !cachedFailed) {
      refresh();
      return cached;
    }
    return await refresh();
  };

  return Object.freeze({
    snapshot,
    invalidate() {
      cached = null;
      cachedAt = null;
      cachedFailed = false;
    },
    /** Warm the cache now and keep it warm; idempotent. */
    start() {
      if (started) return;
      started = true;
      if (!isFresh(safeObservedAt(now))) refresh();
      else schedule();
    },
    /** Stop background refreshes; an in-flight scan still completes. */
    stop() {
      started = false;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  });
}
