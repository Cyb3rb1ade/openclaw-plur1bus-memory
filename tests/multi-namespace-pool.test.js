import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MultiNamespacePool } from "../lib/multi-namespace-pool.js";
import { join } from "node:path";
import { homedir } from "node:os";

const TMP_BASE = join(homedir(), ".openclaw", "memory");

// FakeAgentDbPool — no real LanceDB, just path-tracking
class FakeAgentDbPool {
  constructor(basePath, _vectorDim) {
    this.basePath = basePath;
    this.isShutdown = false;
  }
  getDb(agentId) {
    if (this.isShutdown) throw new Error("FakeAgentDbPool is shutdown");
    return { dbPath: join(this.basePath, agentId) };
  }
  async shutdown() { this.isShutdown = true; }
}

describe("MultiNamespacePool", () => {
  it("getWriteDb gives DB from activeWriteNamespace", () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local", activeRecallNamespaces: ["lancedb-local"] };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const db = pool.getWriteDb("default");
    assert.ok(db);
    assert.ok(db.dbPath.includes("lancedb-local"), `Expected lancedb-local in: ${db.dbPath}`);
  });

  it("getWriteDb does NOT return a legacyReadOnly namespace", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      legacyReadOnlyNamespaces: ["lancedb-old"],
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const db = pool.getWriteDb("default");
    assert.ok(!db.dbPath.includes("lancedb-old"), `Write-DB points to legacyReadOnly: ${db.dbPath}`);
  });

  it("getReadDbs returns active + legacy when crossNamespaceRecall=true", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const dbs = pool.getReadDbs("default");
    assert.strictEqual(dbs.length, 2);
    assert.ok(dbs.some(d => d.namespace === "lancedb-new"));
    assert.ok(dbs.some(d => d.namespace === "lancedb-old"));
  });

  it("getReadDbs returns only active when crossNamespaceRecall=false", () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: false,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const dbs = pool.getReadDbs("default");
    assert.strictEqual(dbs.length, 1);
    assert.strictEqual(dbs[0].namespace, "lancedb-new");
  });

  it("getDb (backward-compat) delegates to getWriteDb", () => {
    const nsCfg = { activeWriteNamespace: "lancedb-local" };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    const a = pool.getDb("default");
    const b = pool.getWriteDb("default");
    assert.strictEqual(a.dbPath, b.dbPath);
  });

  it("shutdown destroys all pools", async () => {
    const nsCfg = {
      activeWriteNamespace: "lancedb-new",
      activeRecallNamespaces: ["lancedb-new"],
      legacyReadOnlyNamespaces: ["lancedb-old"],
      crossNamespaceRecall: true,
    };
    const pool = new MultiNamespacePool(TMP_BASE, nsCfg, 384, FakeAgentDbPool);
    pool.getReadDbs("default"); // initialize pools
    await assert.doesNotReject(() => pool.shutdown());
  });
});
