import { existsSync, mkdirSync, mkdtempSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createEmbeddingCache } from "/root/openclaw-plur1bus-memory/lib/embedding-cache.js";
import { LocalTransformersEmbeddingProvider } from "/root/openclaw-plur1bus-memory/lib/providers/embedding-local-transformers.js";

const silentLogger = { debug() {}, warn() {} };

function cachePath(baseDir, agentId = "agent-a") {
  return join(baseDir, "embedding-cache-v2", `${agentId}.db`);
}

function physicalBytes(dbPath) {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .filter(existsSync)
    .reduce((sum, path) => sum + statSync(path).size, 0);
}

function hugeVector() {
  return Array.from({ length: 180_000 }, (_, index) => index % 10_000);
}

async function reproducePreInsertOvershoot() {
  const baseDir = mkdtempSync(join(tmpdir(), "plur1bus-preinsert-"));
  const dbPath = cachePath(baseDir);
  const cache = createEmbeddingCache({
    persist: true,
    metrics: true,
    cacheBasePath: baseDir,
    maxBytes: 50_000_000,
    logger: silentLogger,
  });
  await cache.setMany([{ text: "seed", vector: [1] }], { agentId: "agent-a", maxBytes: 50_000_000 });
  const beforeBytes = physicalBytes(dbPath);
  const maxBytes = beforeBytes + 100_000;
  await cache.setMany([{ text: "oversized", vector: hugeVector() }], { agentId: "agent-a", maxBytes });
  const afterBytes = physicalBytes(dbPath);
  const result = {
    beforeBytes,
    maxBytes,
    afterBytes,
    overLimitBytes: afterBytes - maxBytes,
    persistWrites: cache.getMetrics().persistWrites,
    persistWriteSkipped: cache.getMetrics().persistWriteSkipped,
  };
  cache.close();
  return result;
}

async function reproduceSoftCleanupPoisoning() {
  const baseDir = mkdtempSync(join(tmpdir(), "plur1bus-soft-cleanup-"));
  const dbPath = cachePath(baseDir);
  const cache = createEmbeddingCache({
    persist: true,
    metrics: true,
    cacheBasePath: baseDir,
    maxBytes: 50_000_000,
    logger: silentLogger,
  });
  await cache.setMany([{ text: "seed", vector: [1] }], { agentId: "agent-a", maxBytes: 50_000_000 });
  const beforeBytes = physicalBytes(dbPath);
  const maxBytes = beforeBytes + 100_000;
  await cache.setMany([{ text: "triggers-cleanup", vector: hugeVector() }], { agentId: "agent-a", maxBytes });
  const database = new DatabaseSync(dbPath);
  const rowsAfterCleanup = database.prepare("SELECT COUNT(*) AS count FROM embeddings").get().count;
  database.close();
  const bytesAfterCleanup = physicalBytes(dbPath);
  await cache.setMany([{ text: "future-write", vector: [2] }], { agentId: "agent-a", maxBytes });
  const metrics = cache.getMetrics();
  const result = {
    beforeBytes,
    maxBytes,
    bytesAfterCleanup,
    rowsAfterCleanup,
    persistWrites: metrics.persistWrites,
    persistWriteSkipped: metrics.persistWriteSkipped,
  };
  cache.close();
  return result;
}

async function reproduceExplicitZeroReplacement() {
  const directMaxZero = createEmbeddingCache({ maxEntries: 0 });
  await directMaxZero.setMany([{ text: "direct", vector: [1] }]);

  let directTtlComputes = 0;
  const directTtlZero = createEmbeddingCache({ ttlMs: 0 });
  const computeDirect = async (texts) => {
    directTtlComputes += 1;
    return texts.map(() => [1]);
  };
  await directTtlZero.getMany(["direct-ttl"], {}, computeDirect);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await directTtlZero.getMany(["direct-ttl"], {}, computeDirect);

  let providerComputes = 0;
  const provider = new LocalTransformersEmbeddingProvider({
    model: "audit-model",
    dimensions: 1,
    cacheMaxEntries: 0,
    cacheTtlMs: 0,
  });
  provider._computeBatch = async (texts) => {
    providerComputes += 1;
    return texts.map(() => [1]);
  };
  await provider.embed("provider-zero");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await provider.embed("provider-zero");

  return {
    directMaxEntriesZeroSize: directMaxZero.size,
    directTtlZeroComputes: directTtlComputes,
    providerZeroComputes: providerComputes,
    providerZeroCacheSize: provider._cache.size,
  };
}

async function reproduceFailedPathPoisoning() {
  const baseDir = mkdtempSync(join(tmpdir(), "plur1bus-failed-path-"));
  const blocker = join(baseDir, "embedding-cache-v2");
  writeFileSync(blocker, "blocks cache directory creation");

  const sameCache = createEmbeddingCache({
    persist: true,
    metrics: true,
    cacheBasePath: baseDir,
    logger: silentLogger,
  });
  await sameCache.setMany([{ text: "initial-failure", vector: [1] }], { agentId: "agent-a" });

  renameSync(blocker, `${blocker}.moved`);
  mkdirSync(blocker);
  await sameCache.setMany([{ text: "same-instance-after-recovery", vector: [2] }], { agentId: "agent-a" });
  const sameRecovered = existsSync(cachePath(baseDir));

  const freshCache = createEmbeddingCache({
    persist: true,
    metrics: true,
    cacheBasePath: baseDir,
    logger: silentLogger,
  });
  await freshCache.setMany([{ text: "fresh-instance-after-recovery", vector: [3] }], { agentId: "agent-a" });
  const freshRecovered = existsSync(cachePath(baseDir));

  const result = {
    sameRecovered,
    freshRecovered,
    samePersistWrites: sameCache.getMetrics().persistWrites,
    freshPersistWrites: freshCache.getMetrics().persistWrites,
  };
  sameCache.close();
  freshCache.close();
  return result;
}

console.log(JSON.stringify({
  preInsertOvershoot: await reproducePreInsertOvershoot(),
  softCleanupPoisoning: await reproduceSoftCleanupPoisoning(),
  explicitZeroReplacement: await reproduceExplicitZeroReplacement(),
  failedPathPoisoning: await reproduceFailedPathPoisoning(),
}, null, 2));
