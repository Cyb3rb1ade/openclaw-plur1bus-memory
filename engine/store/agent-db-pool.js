/**
 * engine/store/agent-db-pool.js — the per-agent `MemoryDB` pool (`AgentDbPool`).
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { makeBoundedCache } from "../../lib/bounded-cache.js";
import { openDirectoryCapability, pathMatchesDirectoryCapability, stableDirectoryCapabilitiesSupported } from "../../lib/directory-capability.js";
import { resolveInside, safeAgentId } from "../../lib/sql-safety.js";
import { redactError, settleSafeWarning, trySafeWarn } from "../../lib/safe-logging.js";
import { MAX_BACKGROUND_LIFECYCLE_ERRORS, MemoryDB, deriveExpectedCanonicalTarget, pathEntryExists, waitForTimeoutSettlement } from "./memory-db.js";

/** Per-agent MemoryDB cache with callback-scoped operation leases. */
export class AgentDbPool {
  /**
   * @param {string} basePath Validated namespace base path.
   * @param {number} vectorDim Vector dimension.
   * @param {object} [logger] Optional logger.
   * @param {{readOnly?: boolean, pathGuard?: (() => void), secureRouting?: boolean, parentDirectoryCapability?: object|null, baseSegment?: string|null}} [options] Non-mutating mode and optional descriptor-bound namespace route.
   */
  constructor(basePath, vectorDim, logger = null, {
    readOnly = false,
    pathGuard = null,
    secureRouting = null,
    parentDirectoryCapability = null,
    baseSegment = null,
  } = {}) {
    if (pathGuard !== null && typeof pathGuard !== "function") {
      throw new TypeError("AgentDbPool pathGuard must be a function");
    }
    const parentRouted = parentDirectoryCapability !== null || baseSegment !== null;
    const stableRouting = secureRouting === true
      || (secureRouting !== false && stableDirectoryCapabilitiesSupported());
    if (parentRouted && !stableRouting) {
      throw new Error("explicit named namespace routing requires stable directory capabilities");
    }
    if (parentRouted && (
      !parentDirectoryCapability
      || typeof parentDirectoryCapability.openChild !== "function"
      || typeof parentDirectoryCapability.childMatches !== "function"
    )) {
      throw new TypeError("secure AgentDbPool routing requires a parent directory capability");
    }
    if (parentRouted && (typeof baseSegment !== "string" || !baseSegment)) {
      throw new TypeError("secure AgentDbPool routing requires a base segment");
    }
    pathGuard?.();
    const basePin = deriveExpectedCanonicalTarget(basePath);
    this.basePath = basePin.absolutePath;
    this.canonicalBasePath = basePin.expectedTarget;
    this.vectorDim = vectorDim;
    this.logger = logger;
    this.readOnly = readOnly === true;
    this.pathGuard = pathGuard;
    this.secureRouting = stableRouting;
    this.parentRouted = parentRouted;
    this.parentDirectoryCapability = parentDirectoryCapability;
    this.baseSegment = baseSegment;
    this.baseDirectoryCapability = null;
    this.agentPathPins = new Map();
    this.backgroundLifecycleErrors = [];
    this.backgroundLifecycleErrorOverflow = 0;
    if (this.secureRouting && this.parentRouted) {
      try {
        this.baseDirectoryCapability = this.parentDirectoryCapability.openChild(
          this.baseSegment,
          { create: !this.readOnly },
        );
      } catch (error) {
        if (!(this.readOnly && (error?.code === "ENOENT" || error?.code === "ENOTDIR"))) throw error;
      }
    }
    this.dbs = makeBoundedCache(50, async (id, db) => {
      if (db && typeof db.shutdown === "function") {
        try {
          await db.shutdown();
        } catch (error) {
          const contextual = this._contextualizeDbError(id, "eviction", error);
          const loggingError = await this._warnLifecycle(id, "eviction", contextual);
          if (loggingError) {
            throw new AggregateError(
              [contextual, loggingError],
              `agent=${id} eviction and warning delivery failed`,
            );
          }
          throw contextual;
        }
      }
    });
    this.activeOperations = new Set();
    this.clearPromise = null;
    this.shutdownPromise = null;
    this.isShutdown = false;
  }

  _contextualizeDbError(agentId, phase, error) {
    const safeMessage = redactError(error).message;
    const contextual = new Error(
      `agent=${agentId} ${phase} failed: ${safeMessage}`,
      { cause: error },
    );
    contextual.agentId = agentId;
    contextual.phase = phase;
    return contextual;
  }

  async _warnLifecycle(agentId, phase, error) {
    const warning = trySafeWarn(
      this.logger,
      `memory-lancedb-namespaced agent=${agentId} phase=${phase}`,
      error,
      { agentId, phase },
    );
    const outcome = await settleSafeWarning(warning);
    return outcome.ok
      ? null
      : this._contextualizeDbError(agentId, `${phase}-warning`, outcome.error);
  }

  _recordBackgroundLifecycleError(error) {
    const normalized = this._contextualizeDbError("pool", "background-lifecycle", error);
    if (this.backgroundLifecycleErrors.length < MAX_BACKGROUND_LIFECYCLE_ERRORS) {
      this.backgroundLifecycleErrors.push(normalized);
      return;
    }
    this.backgroundLifecycleErrorOverflow += 1;
  }

  _drainBackgroundLifecycleErrors() {
    const errors = this.backgroundLifecycleErrors.splice(0, this.backgroundLifecycleErrors.length);
    if (this.backgroundLifecycleErrorOverflow > 0) {
      const overflow = new Error(
        `agent DB pool background lifecycle failures omitted (${this.backgroundLifecycleErrorOverflow})`,
      );
      overflow.phase = "background-lifecycle-overflow";
      errors.push(overflow);
      this.backgroundLifecycleErrorOverflow = 0;
    }
    return errors;
  }

  _getOrCreateDb(id) {
    const cached = this.dbs.get(id);
    if (cached) {
      if (this.secureRouting) this._assertSecureAgentCapability(id, cached.directoryCapability);
      else this._resolveAgentPath(id);
      return cached;
    }
    const dbPath = resolve(this.canonicalBasePath, id);
    let directoryCapability = null;
    if (this.secureRouting) {
      const baseExists = this._assertBasePath({ create: !this.readOnly });
      if (baseExists) {
        try {
          directoryCapability = this.baseDirectoryCapability.openChild(id, { create: !this.readOnly });
        } catch (error) {
          if (!this.readOnly && (error?.code === "ELOOP" || error?.code === "ENOTDIR")) {
            throw new Error(`Path traversal blocked: ${dbPath}`, { cause: error });
          }
          if (!(this.readOnly && (error?.code === "ENOENT" || error?.code === "ENOTDIR"))) throw error;
        }
      }
    } else {
      this._resolveAgentPath(id);
    }
    let db;
    try {
      db = new MemoryDB(dbPath, this.vectorDim, this.logger, {
        readOnly: this.readOnly,
        pathGuard: this.secureRouting
          ? () => this._assertSecureAgentCapability(id, directoryCapability)
          : () => this._assertAgentPath(id),
        directoryCapability,
        secureDirectoryRequired: this.secureRouting,
        beforeLanceOperation: this.secureRouting
          ? (operation, capability) => this._onBeforeAgentLanceOperation(id, operation, capability)
          : null,
      });
      if (!(this.secureRouting && this.readOnly && !directoryCapability)) {
        this.dbs.set(id, db);
      }
    } catch (error) {
      directoryCapability?.close();
      throw error;
    }
    return db;
  }

  _onBeforeAgentLanceOperation(_id, _operation, _capability) {}

  _assertSecureAgentCapability(id, capability) {
    const baseExists = this._assertBasePath({ create: !this.readOnly });
    if (!capability) {
      if (!this.readOnly) {
        throw new Error(`agent DB directory capability is missing: ${id}`);
      }
      return false;
    }
    if (!baseExists || !this.baseDirectoryCapability.childMatches(id, capability)) {
      throw new Error(`agent DB linked identity changed after initialization: ${id}`);
    }
    return true;
  }

  _assertBasePath({ create = false } = {}) {
    this.pathGuard?.();
    if (this.secureRouting) {
      if (!this.parentRouted) {
        const configuredBaseExists = pathEntryExists(this.basePath);
        if (!configuredBaseExists && !create) {
          if (this.baseDirectoryCapability) {
            throw new Error(`DB base linked identity changed after initialization: ${this.basePath}`);
          }
          return false;
        }
        if (!configuredBaseExists) {
          const beforeCreate = deriveExpectedCanonicalTarget(this.basePath);
          if (beforeCreate.expectedTarget !== this.canonicalBasePath) {
            throw new Error("DB base canonical target changed before creation");
          }
        }
        if (!this.baseDirectoryCapability) {
          this.baseDirectoryCapability = openDirectoryCapability(this.canonicalBasePath, { create });
        }
        const configuredTarget = realpathSync(this.basePath);
        const baseMatches = configuredTarget === this.canonicalBasePath
          && pathMatchesDirectoryCapability(this.canonicalBasePath, this.baseDirectoryCapability);
        if (!baseMatches) {
          throw new Error(`DB base linked identity changed after initialization: ${this.basePath}`);
        }
        this.pathGuard?.();
        return true;
      }
      if (!this.baseDirectoryCapability) {
        try {
          this.baseDirectoryCapability = this.parentDirectoryCapability.openChild(this.baseSegment, { create });
        } catch (error) {
          if (!create && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return false;
          throw error;
        }
      }
      const baseMatches = this.parentDirectoryCapability.childMatches(this.baseSegment, this.baseDirectoryCapability);
      if (!baseMatches) {
        throw new Error(`DB base linked identity changed after initialization: ${this.baseSegment ?? this.basePath}`);
      }
      this.pathGuard?.();
      return true;
    }
    const entryExists = pathEntryExists(this.basePath);
    if (!entryExists) {
      if (!create) return false;
      const beforeCreate = deriveExpectedCanonicalTarget(this.basePath);
      if (beforeCreate.expectedTarget !== this.canonicalBasePath) {
        throw new Error("DB base canonical target changed before creation");
      }
      // Create at the pinned canonical target; lexical ancestor substitution
      // cannot redirect this mkdir to a different tree.
      mkdirSync(this.canonicalBasePath, { recursive: true });
    }
    const currentTarget = realpathSync(this.basePath);
    if (currentTarget !== this.canonicalBasePath) {
      throw new Error("DB base canonical target changed after initialization");
    }
    this.pathGuard?.();
    return true;
  }

  _assertAgentPath(id) {
    const baseExists = this._assertBasePath({ create: !this.readOnly });
    const configuredPath = resolve(this.canonicalBasePath, id);
    let pin = this.agentPathPins.get(id);
    if (!pin) {
      const existed = baseExists && pathEntryExists(configuredPath);
      const canonicalTarget = existed
        ? resolveInside(this.canonicalBasePath, id)
        : configuredPath;
      pin = Object.freeze({ configuredPath, canonicalTarget, existed });
      this.agentPathPins.set(id, pin);
    }
    const entryExists = baseExists && pathEntryExists(pin.configuredPath);
    if (!entryExists) {
      if (pin.existed) throw new Error(`agent DB canonical target changed: ${id} is now missing`);
      return pin.canonicalTarget;
    }
    const currentTarget = resolveInside(this.canonicalBasePath, id);
    if (currentTarget !== pin.canonicalTarget) {
      throw new Error(`agent DB canonical target changed after initialization: ${id}`);
    }
    return pin.canonicalTarget;
  }

  _resolveAgentPath(id) {
    return this._assertAgentPath(id);
  }

  /** Compatibility accessor; production operations must prefer withDb(). */
  getDb(agentId) {
    if (this.isShutdown) throw new Error("AgentDbPool is shutdown");
    if (this.clearPromise) throw new Error("AgentDbPool is clearing; use withDb() after clear settles");
    const id = safeAgentId(agentId || "default");
    return this._getOrCreateDb(id);
  }

  /**
   * Lease an agent DB until the callback settles.
   * @param {string} agentId Agent identity used for path and cache isolation.
   * @param {(db: MemoryDB) => unknown} fn Operation to run while the DB is leased.
   * @returns {Promise<unknown>} Callback result.
   */
  async withDb(agentId, fn) {
    if (this.isShutdown) throw new Error("AgentDbPool is shutdown");
    if (typeof fn !== "function") throw new TypeError("AgentDbPool.withDb requires a callback");
    while (this.clearPromise) await this.clearPromise;
    if (this.isShutdown) throw new Error("AgentDbPool is shutdown");
    const id = safeAgentId(agentId || "default");
    let startLease;
    const startGate = new Promise((resolve) => { startLease = resolve; });
    let acquired = false;
    const callbackPromise = (async () => {
      await startGate;
      this.dbs.acquire(id);
      acquired = true;
      const db = this._getOrCreateDb(id);
      return fn(db);
    })();
    let leasePromise;
    leasePromise = (async () => {
      try {
        try {
          await callbackPromise;
        } catch (error) {
          const settlement = await waitForTimeoutSettlement(error);
          if (settlement.status === "rejected") {
            const lateError = this._contextualizeDbError(id, "late-settlement", settlement.error);
            this._recordBackgroundLifecycleError(lateError);
            const loggingError = await this._warnLifecycle(
              id,
              "late-settlement",
              new Error("late database operation failed"),
            );
            if (loggingError) this._recordBackgroundLifecycleError(loggingError);
          }
        }
      } catch (trackingError) {
        const contextual = this._contextualizeDbError(id, "lease-tracking", trackingError);
        this._recordBackgroundLifecycleError(contextual);
        try {
          const loggingError = await this._warnLifecycle(id, "lease-tracking", trackingError);
          if (loggingError) this._recordBackgroundLifecycleError(loggingError);
        } catch (containmentError) {
          this._recordBackgroundLifecycleError(containmentError);
        }
      } finally {
        if (acquired) this.dbs.release(id);
        this.activeOperations.delete(leasePromise);
      }
    })();
    this.activeOperations.add(leasePromise);
    startLease();
    try {
      return await callbackPromise;
    } catch (error) {
      // The caller observes the original timeout/error immediately. leasePromise
      // independently retains the B7 lease through any attached settlement.
      throw error;
    } finally {
      if (!acquired) {
        // Failed acquisition has no callback settlement to retain.
        await leasePromise;
      }
    }
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.isShutdown) return;
    this.isShutdown = true;
    const shutdownPromise = (async () => {
      const errors = [];
      if (this.clearPromise) {
        try {
          await this.clearPromise;
        } catch (error) {
          if (error instanceof AggregateError) errors.push(...error.errors);
          else errors.push(error);
        }
      }
      await Promise.allSettled([...this.activeOperations]);
      errors.push(...this._drainBackgroundLifecycleErrors());
      for (const [agentId, db] of this.dbs.entries()) {
        if (!db || typeof db.shutdown !== "function") continue;
        try {
          await db.shutdown();
        } catch (error) {
          const contextual = this._contextualizeDbError(agentId, "shutdown", error);
          errors.push(contextual);
          const loggingError = await this._warnLifecycle(agentId, "shutdown", contextual);
          if (loggingError) errors.push(loggingError);
        }
      }
      try {
        await this.dbs.awaitPendingEvictions();
      } catch (error) {
        if (error instanceof AggregateError) errors.push(...error.errors);
        else errors.push(error);
      }
      this.dbs.clear();
      try {
        this.baseDirectoryCapability?.close();
      } catch (error) {
        errors.push(error);
      } finally {
        this.baseDirectoryCapability = null;
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `agent DB pool shutdown failures (${errors.length})`);
      }
    })();
    this.shutdownPromise = shutdownPromise;
    try {
      return await shutdownPromise;
    } finally {
      if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = null;
    }
  }

  /** Close cached DBs and release their directory capabilities while keeping the pool reusable. */
  async clear() {
    if (this.isShutdown) return this.shutdownPromise;
    if (this.clearPromise) return this.clearPromise;
    const clearPromise = (async () => {
      await Promise.allSettled([...this.activeOperations]);
      const errors = this._drainBackgroundLifecycleErrors();
      for (const [agentId, db] of this.dbs.entries()) {
        if (!db || typeof db.shutdown !== "function") continue;
        try {
          await db.shutdown();
        } catch (error) {
          const contextual = this._contextualizeDbError(agentId, "clear", error);
          errors.push(contextual);
          const loggingError = await this._warnLifecycle(agentId, "clear", contextual);
          if (loggingError) errors.push(loggingError);
        }
      }
      try {
        await this.dbs.awaitPendingEvictions();
      } catch (error) {
        if (error instanceof AggregateError) errors.push(...error.errors);
        else errors.push(error);
      }
      this.dbs.clear();
      if (errors.length > 0) {
        throw new AggregateError(errors, `agent DB pool clear failures (${errors.length})`);
      }
    })();
    this.clearPromise = clearPromise;
    try {
      return await clearPromise;
    } finally {
      if (this.clearPromise === clearPromise) this.clearPromise = null;
    }
  }
}
