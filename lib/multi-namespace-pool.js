import { join } from "node:path";
import { resolveWriteNamespace, resolveRecallReadNamespaces } from "./namespace-config.js";

export class MultiNamespacePool {
  /**
   * @param {string} baseDir — e.g. ~/.openclaw/memory (parent of namespace dirs)
   * @param {object} nsCfg   — namespace config from openclaw.json (cfg.namespaces)
   * @param {number} vectorDim — vector dimension
   * @param {Function} AgentDbPoolClass — AgentDbPool class (DI for tests)
   */
  constructor(baseDir, nsCfg = {}, vectorDim, AgentDbPoolClass) {
    this.baseDir = baseDir;
    this.nsCfg = nsCfg;
    this.vectorDim = vectorDim;
    this.AgentDbPool = AgentDbPoolClass;
    this._pools = new Map(); // namespace → AgentDbPool
  }

  _getPool(namespace) {
    if (!this._pools.has(namespace)) {
      const nsPath = join(this.baseDir, namespace);
      this._pools.set(namespace, new this.AgentDbPool(nsPath, this.vectorDim));
    }
    return this._pools.get(namespace);
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

  async shutdown() {
    const shutdowns = [...this._pools.values()].map(p =>
      typeof p.shutdown === "function" ? p.shutdown().catch(() => {}) : Promise.resolve()
    );
    await Promise.all(shutdowns);
    this._pools.clear();
  }
}
