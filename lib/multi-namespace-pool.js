import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { resolveInside, safeAgentId } from "./sql-safety.js";
import { openDirectoryCapability, pathMatchesDirectoryCapability } from "./directory-capability.js";

const LEGACY_FLAT_KEY = Symbol("legacy-flat");
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LAYOUT_KEYS = Object.freeze([
  "mode",
  "baseDir",
  "baseDbPath",
  "activeWriteNamespace",
  "activeRecallNamespaces",
  "legacyReadOnlyNamespaces",
  "recallReadNamespaces",
  "crossNamespaceRecall",
]);

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function assertPlainDataObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`);
  }
}

function readOwnDataProperty(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${label}.${key} must be an own plain data property; accessors are not allowed`);
  }
  return descriptor.value;
}

function materializeFrozenArray(value, field) {
  if (!Array.isArray(value) || !Object.isFrozen(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`invalid namespace layout: ${field} must be a frozen array of plain data items`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`invalid namespace layout: ${field} has an invalid length`);
  }
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError(`invalid namespace layout: ${field}[${index}] must be a plain data item`);
    }
    copy.push(descriptor.value);
  }
  return copy;
}

function assertNamespace(namespace, field) {
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw new TypeError(`invalid namespace layout: ${field} contains an invalid namespace identifier`);
  }
}

function assertUniqueNamespaces(namespaces, field) {
  const seen = new Set();
  for (const namespace of namespaces) {
    assertNamespace(namespace, field);
    if (seen.has(namespace)) throw new TypeError(`invalid namespace layout: ${field} contains duplicates`);
    seen.add(namespace);
  }
}

function assertExactArray(actual, expected, field) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new TypeError(`invalid namespace layout: ${field} has inconsistent order or membership`);
  }
}

function validateLayout(layout) {
  if (!layout || typeof layout !== "object" || !Object.isFrozen(layout)) {
    throw new TypeError("MultiNamespacePool requires a frozen normalized namespace layout");
  }
  const activeRecall = layout.activeRecallNamespaces;
  const legacyReadOnly = layout.legacyReadOnlyNamespaces;
  const recallRead = layout.recallReadNamespaces;
  if (typeof layout.baseDir !== "string" || !layout.baseDir || typeof layout.baseDbPath !== "string" || !layout.baseDbPath) {
    throw new TypeError("invalid namespace layout: baseDir and baseDbPath must be non-empty strings");
  }

  if (layout.mode === "legacy-flat") {
    if (
      layout.baseDir !== layout.baseDbPath
      || layout.activeWriteNamespace !== null
      || activeRecall.length !== 0
      || legacyReadOnly.length !== 0
      || recallRead.length !== 0
      || layout.crossNamespaceRecall !== false
    ) {
      throw new TypeError("invalid legacy-flat namespace layout invariants");
    }
    return;
  }
  if (layout.mode !== "named") throw new TypeError(`unsupported namespace layout mode: ${String(layout.mode)}`);
  if (typeof layout.crossNamespaceRecall !== "boolean") {
    throw new TypeError("invalid namespace layout: crossNamespaceRecall must be boolean");
  }

  assertNamespace(layout.activeWriteNamespace, "activeWriteNamespace");
  assertUniqueNamespaces(activeRecall, "activeRecallNamespaces");
  assertUniqueNamespaces(legacyReadOnly, "legacyReadOnlyNamespaces");
  assertUniqueNamespaces(recallRead, "recallReadNamespaces");
  if (!activeRecall.includes(layout.activeWriteNamespace)) {
    throw new TypeError("invalid namespace layout: active recall must include the active writer");
  }
  const activeSet = new Set(activeRecall);
  if (legacyReadOnly.some((namespace) => activeSet.has(namespace))) {
    throw new TypeError("invalid namespace layout: active and legacy namespaces overlap");
  }
  const expectedRecall = layout.crossNamespaceRecall
    ? [...activeRecall, ...legacyReadOnly]
    : [...activeRecall];
  assertExactArray(recallRead, expectedRecall, "recallReadNamespaces");

  const resolvedBase = resolve(layout.baseDir);
  const resolvedConfiguredPath = resolve(layout.baseDbPath);
  const resolvedWriterPath = resolve(layout.baseDir, layout.activeWriteNamespace);
  if (resolvedConfiguredPath !== resolvedBase && resolvedConfiguredPath !== resolvedWriterPath) {
    throw new TypeError("invalid namespace layout: baseDbPath is neither the named root nor active writer leaf");
  }
}

function establishNamedBaseDir(baseDir) {
  return openDirectoryCapability(resolve(baseDir), { create: true });
}

function materializeLayout(layout) {
  if (!layout || typeof layout !== "object" || !Object.isFrozen(layout)) {
    throw new TypeError("MultiNamespacePool requires a frozen normalized namespace layout");
  }
  assertPlainDataObject(layout, "namespace layout");
  const allowed = new Set(LAYOUT_KEYS);
  for (const key of Reflect.ownKeys(layout)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`invalid namespace layout: unexpected property ${String(key)}`);
    }
  }
  const values = Object.create(null);
  for (const key of LAYOUT_KEYS) values[key] = readOwnDataProperty(layout, key, "namespace layout");
  const copy = {
    mode: values.mode,
    baseDir: values.baseDir,
    baseDbPath: values.baseDbPath,
    activeWriteNamespace: values.activeWriteNamespace ?? null,
    activeRecallNamespaces: materializeFrozenArray(values.activeRecallNamespaces, "activeRecallNamespaces"),
    legacyReadOnlyNamespaces: materializeFrozenArray(values.legacyReadOnlyNamespaces, "legacyReadOnlyNamespaces"),
    recallReadNamespaces: materializeFrozenArray(values.recallReadNamespaces, "recallReadNamespaces"),
    crossNamespaceRecall: values.crossNamespaceRecall,
  };
  Object.freeze(copy.activeRecallNamespaces);
  Object.freeze(copy.legacyReadOnlyNamespaces);
  Object.freeze(copy.recallReadNamespaces);
  Object.freeze(copy);
  validateLayout(copy);
  return copy;
}

/** Callback-leased DB pool over an immutable, prevalidated namespace layout. */
export class MultiNamespacePool {
  /**
   * @param {object} layout Frozen normalized layout from resolveNamespaceLayout().
   * @param {number} vectorDim Vector dimension.
   * @param {Function} AgentDbPoolClass AgentDbPool class (DI for tests).
   * @param {object} [logger] Optional plugin logger.
   */
  constructor(layout, vectorDim, AgentDbPoolClass, logger = null) {
    this.layout = materializeLayout(layout);
    this.vectorDim = vectorDim;
    this.AgentDbPool = AgentDbPoolClass;
    this.logger = logger;
    this._pools = new Map();
    this._routePaths = new Map();
    this._routePins = new Map();
    this._canonicalBaseDir = null;
    this._baseCapability = null;
    this.activeOperations = new Set();
    this.shutdownPromise = null;
    this.isShutdown = false;

    if (this.layout.mode === "legacy-flat") {
      if (typeof this.layout.baseDbPath !== "string" || !this.layout.baseDbPath) {
        throw new TypeError("legacy-flat namespace layout requires baseDbPath");
      }
      this._routePaths.set(LEGACY_FLAT_KEY, this.layout.baseDbPath);
    } else if (this.layout.mode === "named") {
      try {
        this._baseCapability = establishNamedBaseDir(this.layout.baseDir);
        this._canonicalBaseDir = resolve(this.layout.baseDir);
        this._pinNamedRoutes();
      } catch (error) {
        this._baseCapability?.close();
        this._baseCapability = null;
        throw error;
      }
    } else {
      throw new TypeError(`unsupported namespace layout mode: ${String(this.layout.mode)}`);
    }
  }

  _assertOpen() {
    if (this.isShutdown) throw new Error("MultiNamespacePool is shutdown");
  }

  _agentId(agentId) {
    return safeAgentId(agentId || "default");
  }

  _configuredNamespaces() {
    return [...new Set([
      this.layout.activeWriteNamespace,
      ...this.layout.activeRecallNamespaces,
      ...this.layout.legacyReadOnlyNamespaces,
    ].filter(Boolean))];
  }

  _pinNamedRoutes() {
    const routePaths = new Map();
    const routePins = new Map();
    const canonicalOwners = new Map();
    for (const namespace of this._configuredNamespaces()) {
      const configuredPath = resolve(this._canonicalBaseDir, namespace);
      const existed = pathEntryExists(configuredPath);
      const canonicalTarget = resolveInside(this._canonicalBaseDir, namespace);
      const previous = canonicalOwners.get(canonicalTarget);
      if (previous && previous !== namespace) {
        throw new Error(
          `namespace route collision: ${JSON.stringify(previous)} and ${JSON.stringify(namespace)} resolve to the same canonical in-root target`,
        );
      }
      canonicalOwners.set(canonicalTarget, namespace);
      routePaths.set(namespace, canonicalTarget);
      routePins.set(namespace, Object.freeze({ configuredPath, canonicalTarget, existed }));
    }
    this._routePaths = routePaths;
    this._routePins = routePins;
    this._validateNamedRoutes();
  }

  _validateNamedRoutes() {
    if (!pathMatchesDirectoryCapability(this.layout.baseDir, this._baseCapability)) {
      throw new Error("named namespace root canonical target changed after initialization");
    }
    const legacy = new Set(this.layout.legacyReadOnlyNamespaces);
    if (!this.layout.activeWriteNamespace || legacy.has(this.layout.activeWriteNamespace)) {
      throw new Error("active write namespace must be active and never legacy read-only");
    }
    const canonicalOwners = new Map();
    for (const namespace of this._configuredNamespaces()) {
      const pin = this._routePins.get(namespace);
      if (!pin) throw new Error(`namespace route pin is missing: ${namespace}`);
      const entryExists = pathEntryExists(pin.configuredPath);
      if (!entryExists) {
        if (pin.existed) throw new Error(`namespace route canonical target changed: ${namespace} is now missing`);
        continue;
      }
      const currentTarget = resolveInside(this._canonicalBaseDir, namespace);
      if (currentTarget !== pin.canonicalTarget) {
        throw new Error(`namespace route canonical target changed after initialization: ${namespace}`);
      }
      const previous = canonicalOwners.get(currentTarget);
      if (previous && previous !== namespace) {
        throw new Error(
          `namespace route collision: ${JSON.stringify(previous)} and ${JSON.stringify(namespace)} resolve to the same canonical in-root target`,
        );
      }
      canonicalOwners.set(currentTarget, namespace);
    }
  }

  _getPool(namespace) {
    this._assertOpen();
    const key = this.layout.mode === "legacy-flat" ? LEGACY_FLAT_KEY : namespace;
    if (this.layout.mode === "named") this._validateNamedRoutes();
    if (!this._pools.has(key)) {
      const routePath = this._routePaths.get(key);
      if (!routePath) throw new Error(`namespace route is not configured: ${String(namespace)}`);
      const readOnly = this.layout.mode === "named"
        && this.layout.legacyReadOnlyNamespaces.includes(namespace);
      const pathGuard = this.layout.mode === "named"
        ? () => this._validateNamedRoutes()
        : null;
      const secureOptions = this.layout.mode === "named"
        ? {
            secureRouting: true,
            parentDirectoryCapability: this._baseCapability,
            baseSegment: namespace,
          }
        : {};
      const child = readOnly
        ? new this.AgentDbPool(routePath, this.vectorDim, this.logger, {
            ...secureOptions,
            readOnly: true,
            pathGuard,
          })
        : new this.AgentDbPool(routePath, this.vectorDim, this.logger, { ...secureOptions, pathGuard });
      this._pools.set(key, child);
    }
    return this._pools.get(key);
  }

  _writeNamespace() {
    if (this.layout.mode === "legacy-flat") return null;
    const namespace = this.layout.activeWriteNamespace;
    if (this.layout.legacyReadOnlyNamespaces.includes(namespace)) {
      throw new Error(`write namespace ${JSON.stringify(namespace)} is legacy read-only`);
    }
    return namespace;
  }

  _readNamespaces() {
    return this.layout.mode === "legacy-flat" ? [null] : this.layout.recallReadNamespaces;
  }

  async _trackOperation(run) {
    this._assertOpen();
    const operation = Promise.resolve().then(run);
    this.activeOperations.add(operation);
    try {
      return await operation;
    } finally {
      this.activeOperations.delete(operation);
    }
  }

  getWriteDb(agentId) {
    const id = this._agentId(agentId);
    return this._getPool(this._writeNamespace()).getDb(id);
  }

  getReadDbs(agentId) {
    const id = this._agentId(agentId);
    return this._readNamespaces().map(namespace => ({
      namespace,
      db: this._getPool(namespace).getDb(id),
    }));
  }

  /** Backward-compatible alias for getWriteDb(). */
  getDb(agentId) {
    return this.getWriteDb(agentId);
  }

  /** Lease the active writer for the complete callback operation. */
  async withWriteDb(agentId, fn) {
    this._assertOpen();
    const id = this._agentId(agentId);
    const writePool = this._getPool(this._writeNamespace());
    return this._trackOperation(() => writePool.withDb(id, fn));
  }

  /** Lease every configured recall namespace in stable configured order. */
  async withReadDbs(agentId, fn) {
    this._assertOpen();
    const id = this._agentId(agentId);
    const readPools = this._readNamespaces().map((namespace) => ({
      namespace,
      pool: this._getPool(namespace),
    }));
    const leased = [];
    const acquireAt = async (index) => {
      if (index >= readPools.length) return fn(leased.slice());
      const { namespace, pool } = readPools[index];
      return pool.withDb(id, async (db) => {
        leased.push({ namespace, db });
        try {
          return await acquireAt(index + 1);
        } finally {
          leased.pop();
        }
      });
    };
    return this._trackOperation(() => acquireAt(0));
  }

  /** Backward-compatible leased alias for withWriteDb(). */
  async withDb(agentId, fn) {
    return this.withWriteDb(agentId, fn);
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.isShutdown) return;
    this.isShutdown = true;
    const shutdownPromise = (async () => {
      await Promise.allSettled([...this.activeOperations]);
      const pools = [...this._pools.entries()];
      const results = await Promise.all(pools.map(async ([key, pool]) => {
        if (typeof pool.shutdown !== "function") return null;
        try {
          await pool.shutdown();
          return null;
        } catch (error) {
          const namespace = key === LEGACY_FLAT_KEY ? null : key;
          const cause = error instanceof Error ? error : new Error(String(error));
          const contextual = new Error(
            `namespace=${namespace ?? "legacy-flat"} shutdown failed: ${cause.message}`,
            { cause },
          );
          contextual.namespace = namespace;
          this.logger?.warn?.(`memory-lancedb-namespaced: ${contextual.message}`);
          return contextual;
        }
      }));
      this._pools.clear();
      const errors = results.filter(Boolean);
      try {
        this._baseCapability?.close();
      } catch (error) {
        errors.push(error);
      } finally {
        this._baseCapability = null;
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `multi-namespace pool shutdown failures (${errors.length})`);
      }
    })();
    this.shutdownPromise = shutdownPromise;
    try {
      return await shutdownPromise;
    } finally {
      if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = null;
    }
  }
}
