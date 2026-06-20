#!/usr/bin/env node
// One-shot: run discoverSemanticLinks against the default workspace vault (maxPerRun=50 for safety)
import { readRecords } from "../lib/obsidian/record-index.js";
import { discoverSemanticLinks } from "../lib/obsidian/semantic-link-discoverer.js";
import { loadLinkIndex } from "../lib/obsidian/link-index.js";
import { MemoryDB } from "../index.js";
import { makeBoundedCache } from "../lib/bounded-cache.js";
import { join } from "node:path";

const VAULT_PATH = process.env.PLUR1BUS_VAULT_PATH || join(homedir(), ".openclaw", "workspace");
const DB_PATH = join(process.env.PLUR1BUS_DB_BASE || join(homedir(), ".openclaw", "memory"), "lancedb-namespaced");

// Minimal AgentDbPool built from exported MemoryDB + makeBoundedCache,
// since AgentDbPool itself is not exported from index.js.
class AgentDbPool {
  constructor(basePath, vectorDim) {
    this.basePath = basePath;
    this.vectorDim = vectorDim;
    this.dbs = makeBoundedCache(50);
    this.isShutdown = false;
  }

  getDb(agentId) {
    if (this.isShutdown) throw new Error("AgentDbPool is shutdown");
    const id = agentId || "default";
    this.dbs.acquire(id);
    try {
      const cached = this.dbs.get(id);
      if (cached) return cached;
      const dbPath = join(this.basePath, id);
      const db = new MemoryDB(dbPath, this.vectorDim);
      this.dbs.set(id, db);
      return db;
    } finally {
      this.dbs.release(id);
    }
  }

  async shutdown() {
    if (this.isShutdown) return;
    this.isShutdown = true;
    this.dbs.clear();
  }
}

const rawConfig = {
  vaultPath: VAULT_PATH,
  reviewRoot: "plur1bus",
  graphLinks: {
    includeSemantic: true,
    semanticDiscovery: { enabled: true, maxPerRun: 50, threshold: 0.78 },
  },
};

const pool = new AgentDbPool(DB_PATH, 1536);

console.log("Reading records...");
const records = readRecords(rawConfig);
console.log(`Found ${records.length} records. Running discoverSemanticLinks (maxPerRun=50)...`);

const result = await discoverSemanticLinks(rawConfig, records, {
  pool,
  logger: { info: console.log, warn: console.warn },
});

console.log("\n=== Result ===");
console.log(JSON.stringify(result, null, 2));

const idx = loadLinkIndex(rawConfig.vaultPath);
const filled = Object.values(idx.entries).filter((e) => e.similar?.length > 0).length;
console.log(`\nLink index: ${Object.keys(idx.entries).length} entries, ${filled} with similar links`);

if (pool.shutdown) await pool.shutdown();
