import { join } from "node:path";
import { resolveWriteNamespace, resolveRecallReadNamespaces } from "./namespace-config.js";

export class MultiNamespacePool {
  /**
   * @param {string} baseDir — e.g. ~/.openclaw/memory (parent of namespace dirs)
   * @param {object} nsCfg   — namespace config from openclaw.json (cfg.namespaces)
   * @param {number} vectorDim — vector dimension
   * @param {Function} AgentDbPoolClass — AgentDbPool class (DI for tests)
   * @param {object} [logger] — optional plugin logger
   */
  constructor(baseDir, nsCfg = {}, vectorDim, AgentDbPoolClass, logger = null) {
    this.baseDir = baseDir;
    this.nsCfg = nsCfg;
    this.vectorDim = vectorDim;
    this.AgentDbPool = AgentDbPoolClass;
    this.logger = logger;
    this._pools = new Map(); // namespace → AgentDbPool
    this.activeOperations = new Set();
    this.shutdownPromise = null;
    this.isShutdown = false;
  }

  _assertOpen() {
    if (this.isShutdown) throw new Error("MultiNamespacePool is shutdown");
  }

  _getPool(namespace) {
    this._assertOpen();
    if (!this._pools.has(namespace)) {
      const nsPath = join(this.baseDir, namespace);
      this._pools.set(namespace, new this.AgentDbPool(nsPath, this.vectorDim, this.logger));
    }
    return this._pools.get(namespace);
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
    const writeNs = resolveWriteNamespace(this.nsCfg);
    return this._getPool(writeNs).getDb(agentId);
  }

  getReadDbs(agentId) {
    const readNs = resolveRecallReadNamespaces(this.nsCfg);
    return readNs.map(ns => ({
      namespace: ns,
      db: this._getPool(ns).getDb(agentId),
    }));
  }

  /** Backward-compat alias — delegates to getWriteDb */
  getDb(agentId) {
    return this.getWriteDb(agentId);
  }

  /**
   * Lease the active write namespace for the complete callback operation.
   * @param {string} agentId Agent identity passed unchanged to the namespace pool.
   * @param {(db: object) => unknown} fn Operation to run while the DB is leased.
   * @returns {Promise<unknown>} Callback result.
   */
  async withWriteDb(agentId, fn) {
    this._assertOpen();
    const writeNs = resolveWriteNamespace(this.nsCfg);
    const writePool = this._getPool(writeNs);
    return this._trackOperation(() => writePool.withDb(agentId, fn));
  }

  /**
   * Lease every configured recall namespace in configured order.
   * @param {string} agentId Agent identity passed unchanged to every namespace.
   * @param {(dbs: Array<{namespace: string, db: object}>) => unknown} fn Operation to run while all DBs are leased.
   * @returns {Promise<unknown>} Callback result.
   */
  async withReadDbs(agentId, fn) {
    this._assertOpen();
    const readNamespaces = resolveRecallReadNamespaces(this.nsCfg);
    const readPools = readNamespaces.map((namespace) => ({
      namespace,
      pool: this._getPool(namespace),
    }));
    const leased = [];
    const acquireAt = async (index) => {
      if (index >= readPools.length) return fn(leased.slice());
      const { namespace, pool } = readPools[index];
      return pool.withDb(agentId, async (db) => {
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

  /**
   * Backward-compatible leased alias for the active write namespace.
   * @param {string} agentId Agent identity passed unchanged to the write namespace.
   * @param {(db: object) => unknown} fn Operation to run while the DB is leased.
   * @returns {Promise<unknown>} Callback result.
   */
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
      const results = await Promise.all(pools.map(async ([namespace, pool]) => {
        if (typeof pool.shutdown !== "function") return null;
        try {
          await pool.shutdown();
          return null;
        } catch (error) {
          const cause = error instanceof Error ? error : new Error(String(error));
          const contextual = new Error(
            `namespace=${namespace} shutdown failed: ${cause.message}`,
            { cause },
          );
          contextual.namespace = namespace;
          this.logger?.warn?.(`memory-lancedb-namespaced: ${contextual.message}`);
          return contextual;
        }
      }));
      this._pools.clear();
      const errors = results.filter(Boolean);
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
