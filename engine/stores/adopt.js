/**
 * engine/stores/adopt.js — `Engine.stores.adopt` (contract 1.11.0).
 *
 * Inspect a copied store (copy-never-move). Schema mismatches are reported;
 * the host calls `admin.migrate`. Identity for legacy stores (no generation
 * manifest) is a sample cosine probe: re-embed stored texts with the engine
 * provider and compare against stored vectors. That catches "same dimension,
 * different model". The engine does not take `state/core.lock`.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { cosineSimilarityVec } from "../../lib/text-utils.js";
import { isSafeAgentId, resolveInside } from "../../lib/sql-safety.js";
import { canonicalIdentityPath } from "../../lib/platform.js";
import { resolveNamespaceLayout } from "../../lib/namespace-config.js";
import { resolveEmbeddingGenerationLayout } from "../../lib/reembedding/generation-layout.js";
import {
  STORE_SCHEMA_VERSION,
  readStoreSchemaVersion,
  schemaMarkerPath,
} from "../store/schema-version.js";
import { memoryOpError } from "../memory-ops/errors.js";

export const ADOPT_PROBE_SIZE = 16;
export const ADOPT_PROBE_MIN_COSINE = 0.999;
export const ADOPT_PROBE_MEDIAN_COSINE = 0.9995;
export const ADOPT_PROBE_MIN_ROWS = 1;

const GENERATIONS_DIR = "generations";

/**
 * Probe floors sit just below 1.0 so float32 rounding of a deterministic
 * provider still passes, and far above the ~0 cosine of two unrelated 384-d
 * unit vectors, which is the case this check exists to catch (same dimension,
 * different model). A positive gate is required: NaN comparisons are false,
 * so `min < T || median < T2` would fail-open.
 */

function hasPathDotDot(path) {
  return String(path).split(/[\\/]/).includes("..");
}

function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function sameRealPath(a, b) {
  if (!a || !b) return false;
  return canonicalIdentityPath(a) === canonicalIdentityPath(b);
}

function vectorOf(row) {
  const v = row?.vector;
  if (!v || typeof v !== "object") return null;
  let converted = null;
  // LanceDB 0.26 returns apache-arrow Vector: iterable, not Array.isArray,
  // and index access is undefined. toArray() yields Float32Array.
  if (typeof v.toArray === "function") {
    try {
      const arr = v.toArray();
      if (arr && typeof arr.length === "number" && arr.length > 0) {
        converted = Array.from(arr, Number);
      }
    } catch {
      // fall through to iterable / array-like
    }
  }
  if (!converted && Array.isArray(v) && v.length > 0) converted = v.map(Number);
  if (!converted && typeof v.length === "number" && v.length > 0) {
    const fromIter = Array.from(v, Number);
    if (fromIter.length === v.length) converted = fromIter;
  }
  if (!converted || converted.length === 0) return null;
  if (!converted.every(Number.isFinite)) return null;
  let normSq = 0;
  for (const x of converted) normSq += x * x;
  if (!(normSq > 0)) return null;
  return converted;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function isOrdinaryTableChild(root, name, child) {
  const target = join(root, name, child);
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) return false;
  return st.isDirectory();
}

function looksLikeAgentTable(root, name) {
  return isOrdinaryTableChild(root, name, "memories.lance")
    || isOrdinaryTableChild(root, name, "memories");
}

/**
 * Agent tables sit at `{store}/{agentId}/memories.lance` (legacy-flat) or
 * `{store}/{namespace}/{agentId}/memories.lance` (named layout). Each hit
 * records the pool base (parent of the agent directory).
 * `generations/` is scanned separately so tables under
 * `{store}/generations/<id>/` are reached.
 * @param {string} storePath
 * @returns {{poolBase: string, agentId: string}[]}
 */
function listAgentTables(storePath) {
  const found = [];
  const seen = new Set();
  const add = (poolBase, agentId) => {
    const key = `${poolBase}\0${agentId}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ poolBase, agentId });
  };
  const consider = (root, entries) => {
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      if (entry.name === GENERATIONS_DIR) continue;
      if (!isSafeAgentId(entry.name) || !looksLikeAgentTable(root, entry.name)) continue;
      add(root, entry.name);
    }
  };
  if (!existsSync(storePath)) return found;
  let top;
  try {
    top = readdirSync(storePath, { withFileTypes: true });
  } catch {
    return found;
  }
  consider(storePath, top);
  for (const entry of top) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    if (entry.name === GENERATIONS_DIR) continue;
    if (isSafeAgentId(entry.name) && looksLikeAgentTable(storePath, entry.name)) continue;
    const nestedRoot = join(storePath, entry.name);
    let nested;
    try {
      nested = readdirSync(nestedRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    consider(nestedRoot, nested);
  }
  found.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.poolBase.localeCompare(b.poolBase));
  return found;
}

function readGenerationManifests(storePath) {
  const generationsDir = join(storePath, GENERATIONS_DIR);
  if (!existsSync(generationsDir)) return { present: false, manifests: [], unreadable: false };
  let names;
  try {
    names = readdirSync(generationsDir, { withFileTypes: true });
  } catch {
    return { present: true, manifests: [], unreadable: true };
  }
  const manifests = [];
  let unreadable = false;
  for (const entry of names) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let manifestPath;
    try {
      manifestPath = resolveInside(generationsDir, entry.name, "generation.json");
    } catch {
      unreadable = true;
      continue;
    }
    if (!existsSync(manifestPath)) continue;
    try {
      const st = lstatSync(manifestPath);
      if (!st.isFile() || st.isSymbolicLink()) {
        unreadable = true;
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        !manifest
        || typeof manifest.fingerprintId !== "string"
        || !Number.isSafeInteger(manifest.dimensions)
        || manifest.dimensions <= 0
      ) {
        unreadable = true;
        continue;
      }
      manifests.push({
        id: entry.name,
        fingerprintId: manifest.fingerprintId,
        provider: typeof manifest.provider === "string" ? manifest.provider : "",
        model: typeof manifest.model === "string" ? manifest.model : "",
        dimensions: manifest.dimensions,
      });
    } catch {
      unreadable = true;
    }
  }
  return { present: true, manifests, unreadable };
}

function generationProbeRoot(storePath, generationId, expectedIdentity) {
  try {
    const namespaceLayout = resolveNamespaceLayout(storePath);
    const layout = resolveEmbeddingGenerationLayout({
      stateRoot: storePath,
      namespaceLayout,
      selection: {
        activeGeneration: generationId,
        fingerprintId: expectedIdentity.fingerprintId,
        dimensions: expectedIdentity.dimensions,
      },
    });
    return layout.activeRoot || join(storePath, GENERATIONS_DIR, generationId);
  } catch {
    return null;
  }
}

function isStoreShape(storePath) {
  if (existsSync(schemaMarkerPath(storePath))) return true;
  if (listAgentTables(storePath).length > 0) return true;
  const gens = readGenerationManifests(storePath);
  return gens.present && (gens.manifests.length > 0 || gens.unreadable);
}

/**
 * Read up to ADOPT_PROBE_SIZE live rows with text+vector. Goes through the
 * table query, not `scanActiveBatches`: that normaliser drops LanceDB Vector
 * because it is not a JS array. Does not call `init()` when the table is
 * already open. Read-only `init()` does not add columns or create tables.
 * @param {object|null} db
 * @param {string} agentId
 * @returns {Promise<{text: string, vector: number[], agentId: string}[]>}
 */
async function readProbeRowsFromDb(db, agentId) {
  if (!db) return [];
  if (!db.table) {
    if (typeof db.init !== "function") return [];
    const initialized = await db.init();
    if (initialized === false || !db.table) return [];
  }
  const rows = [];
  const batchSize = 200;
  let offset = 0;
  let withStatus = true;
  while (rows.length < ADOPT_PROBE_SIZE) {
    let raw;
    try {
      let query = db.table.query();
      if (withStatus) {
        query = query.where("status IS NULL OR status = 'active' OR status = ''");
      }
      if (typeof query.limit === "function") query = query.limit(batchSize);
      if (offset > 0 && typeof query.offset === "function") query = query.offset(offset);
      if (typeof query.select === "function") query = query.select(["text", "vector"]);
      raw = await query.toArray({ maxBatchLength: batchSize });
    } catch {
      if (withStatus) {
        withStatus = false;
        offset = 0;
        continue;
      }
      break;
    }
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const row of raw) {
      const text = typeof row.text === "string" ? row.text.trim() : "";
      const vector = vectorOf(row);
      if (!text || !vector) continue;
      rows.push({ text, vector, agentId });
      if (rows.length >= ADOPT_PROBE_SIZE) break;
    }
    if (raw.length < batchSize) break;
    offset += raw.length;
  }
  return rows;
}

function sampleRows(tables, n) {
  const sample = [];
  let i = 0;
  let progressed = true;
  while (sample.length < n && progressed) {
    progressed = false;
    for (const table of tables) {
      if (i < table.rows.length) {
        sample.push(table.rows[i]);
        progressed = true;
        if (sample.length >= n) break;
      }
    }
    i += 1;
  }
  return sample;
}

function assertSafeAdoptPath(path, host) {
  if (typeof path !== "string" || !path || !isAbsolute(path) || hasPathDotDot(path)) {
    throw memoryOpError("invalid-input", "path must be an absolute store root");
  }
  const resolved = resolve(path);
  const check = host?.platform?.isUnsafeLink;
  if (typeof check !== "function") {
    throw memoryOpError("invalid-input", "path is not a safe store root");
  }
  let unsafe;
  try {
    unsafe = check(path) === true || check(resolved) === true;
  } catch {
    throw memoryOpError("invalid-input", "path is not a safe store root");
  }
  if (unsafe) {
    throw memoryOpError("invalid-input", "path is not a safe store root");
  }
  return resolved;
}

/**
 * @param {object} deps
 */
export function createStoreAdopt({
  baseDbPath,
  pool,
  embeddings,
  getIdentity,
  vectorDim,
  host,
  logger,
  expectedSchema = STORE_SCHEMA_VERSION,
  AgentDbPool,
} = {}) {
  async function collectProbeRows(scanRoots, enginePoolReal) {
    const locations = [];
    const seen = new Set();
    for (const root of scanRoots) {
      for (const loc of listAgentTables(root)) {
        const key = `${loc.poolBase}\0${loc.agentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        locations.push(loc);
      }
    }
    const tables = [];
    const scanOne = async (db, agentId) => {
      const rows = await readProbeRowsFromDb(db, agentId);
      if (rows.length > 0) tables.push({ agentId, rows });
    };

    const byBase = new Map();
    for (const loc of locations) {
      const list = byBase.get(loc.poolBase) ?? [];
      list.push(loc.agentId);
      byBase.set(loc.poolBase, list);
    }
    for (const [poolBase, agentIds] of byBase) {
      const useEnginePool = sameRealPath(realpathOrNull(poolBase), enginePoolReal);
      if (useEnginePool) {
        for (const agentId of [...new Set(agentIds)]) {
          await pool.withReadOnlyReadDbs(agentId, async (dbs) => {
            for (const lease of dbs) {
              await scanOne(lease?.db ?? null, agentId);
            }
          });
        }
        continue;
      }
      const tmp = new AgentDbPool(poolBase, vectorDim, logger, { readOnly: true });
      try {
        for (const agentId of [...new Set(agentIds)]) {
          await tmp.withDb(agentId, async (db) => {
            await scanOne(db, agentId);
          });
        }
      } finally {
        await tmp.shutdown();
      }
    }
    return tables;
  }

  async function embedPassages(texts) {
    if (texts.length === 0) return [];
    if (typeof embeddings.embedBatch === "function") {
      return embeddings.embedBatch(texts, 8, { purpose: "adopt-probe" });
    }
    const out = [];
    for (const text of texts) {
      if (typeof embeddings.embedPassage === "function") {
        out.push(await embeddings.embedPassage(text, { purpose: "adopt-probe" }));
      } else {
        out.push(await embeddings.embed(text, { purpose: "adopt-probe" }));
      }
    }
    return out;
  }

  async function adopt(req) {
    if (!req || typeof req !== "object") {
      throw memoryOpError("invalid-input", "adopt request is required");
    }
    const dryRun = req.dryRun === true;
    const expectedIdentity = req.expectedIdentity;
    if (
      !expectedIdentity
      || typeof expectedIdentity.fingerprintId !== "string"
      || typeof expectedIdentity.provider !== "string"
      || typeof expectedIdentity.model !== "string"
      || !Number.isSafeInteger(expectedIdentity.dimensions)
      || expectedIdentity.dimensions <= 0
    ) {
      throw memoryOpError("invalid-input", "expectedIdentity is invalid");
    }

    const path = assertSafeAdoptPath(req.path, host);

    const incompatible = (reason, extra = {}) => ({
      verdict: "incompatible",
      dryRun,
      reason,
      ...extra,
    });

    if (!existsSync(path)) {
      return incompatible("path-unreadable");
    }
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return incompatible("path-unreadable");
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw memoryOpError("invalid-input", "path is not a safe store root");
    }

    if (!isStoreShape(path)) {
      return incompatible("not-a-store");
    }

    const current = readStoreSchemaVersion(path, { logger });
    const storeSchema = { current, expected: expectedSchema };
    if (current === null) {
      return incompatible("schema-unreadable", { storeSchema });
    }
    if (current !== expectedSchema) {
      return incompatible("schema-mismatch", { storeSchema });
    }

    const engineIdentity = typeof getIdentity === "function" ? getIdentity() : null;
    if (!engineIdentity || !Number.isSafeInteger(engineIdentity.dimensions) || engineIdentity.dimensions <= 0) {
      return incompatible("identity-unverifiable", {
        storeSchema,
        identity: engineIdentity ?? null,
      });
    }
    if (engineIdentity.dimensions !== expectedIdentity.dimensions) {
      return incompatible("dimension-mismatch", {
        storeSchema,
        identity: engineIdentity,
      });
    }

    const gens = readGenerationManifests(path);
    let identitySource;
    let matchingGeneration = null;
    if (gens.present) {
      if (gens.unreadable && gens.manifests.length === 0) {
        return incompatible("identity-unreadable", { storeSchema, identity: engineIdentity });
      }
      const matching = gens.manifests.filter((manifest) => (
        manifest.fingerprintId === expectedIdentity.fingerprintId
        && manifest.dimensions === expectedIdentity.dimensions
      ));
      const mismatched = gens.manifests.filter((manifest) => (
        manifest.fingerprintId !== expectedIdentity.fingerprintId
        || manifest.dimensions !== expectedIdentity.dimensions
      ));
      if (matching.length === 0 && mismatched.length > 0) {
        const manifest = mismatched[0];
        const reason = manifest.dimensions !== expectedIdentity.dimensions
          ? "dimension-mismatch"
          : "identity-mismatch";
        return incompatible(reason, {
          storeSchema,
          identity: {
            fingerprintId: manifest.fingerprintId,
            provider: manifest.provider || expectedIdentity.provider,
            model: manifest.model || expectedIdentity.model,
            dimensions: manifest.dimensions,
          },
          identitySource: "manifest",
        });
      }
      if (matching.length > 0) {
        identitySource = "manifest";
        matchingGeneration = matching[0];
      }
    }

    if (!identitySource && engineIdentity.fingerprintId !== expectedIdentity.fingerprintId) {
      return incompatible("identity-mismatch", {
        storeSchema,
        identity: engineIdentity,
        identitySource: "probe",
      });
    }

    const scanRoots = [path];
    if (matchingGeneration) {
      const genRoot = generationProbeRoot(path, matchingGeneration.id, expectedIdentity);
      if (!genRoot) {
        return incompatible("identity-unreadable", {
          storeSchema,
          identity: engineIdentity,
          identitySource: "manifest",
        });
      }
      if (genRoot !== path) scanRoots.push(genRoot);
    }

    const pathReal = realpathOrNull(path);
    const baseReal = realpathOrNull(baseDbPath);
    const enginePoolReal = sameRealPath(pathReal, baseReal) ? baseReal : null;

    let tables;
    try {
      tables = await collectProbeRows(scanRoots, enginePoolReal);
    } catch (err) {
      logger?.warn?.(`stores.adopt: probe scan failed: ${err?.code || "error"}`);
      return incompatible("identity-unverifiable", { storeSchema, identity: engineIdentity, identitySource: identitySource || "probe" });
    }

    const sample = sampleRows(tables, ADOPT_PROBE_SIZE);
    if (sample.length === 0) {
      if (identitySource === "manifest") {
        return { verdict: "ok", dryRun, storeSchema, identity: engineIdentity, identitySource };
      }
      return incompatible("identity-unverifiable", {
        storeSchema,
        identity: engineIdentity,
        identitySource: "probe",
      });
    }

    for (const row of sample) {
      if (row.vector.length !== expectedIdentity.dimensions) {
        return incompatible("dimension-mismatch", {
          storeSchema,
          identity: engineIdentity,
          identitySource: "probe",
        });
      }
    }

    let reembedded;
    try {
      reembedded = await embedPassages(sample.map((row) => row.text));
    } catch (err) {
      logger?.warn?.(`stores.adopt: probe embed failed: ${err?.code || "error"}`);
      return incompatible("identity-unverifiable", {
        storeSchema,
        identity: engineIdentity,
        identitySource: "probe",
      });
    }
    if (!Array.isArray(reembedded) || reembedded.length !== sample.length) {
      return incompatible("identity-unverifiable", {
        storeSchema,
        identity: engineIdentity,
        identitySource: "probe",
      });
    }

    const scores = [];
    for (let i = 0; i < sample.length; i++) {
      const stored = sample[i].vector;
      const fresh = vectorOf({ vector: reembedded[i] });
      if (!fresh) {
        return incompatible("identity-unverifiable", {
          storeSchema,
          identity: engineIdentity,
          identitySource: "probe",
        });
      }
      if (fresh.length !== stored.length) {
        return incompatible("dimension-mismatch", {
          storeSchema,
          identity: engineIdentity,
          identitySource: "probe",
        });
      }
      scores.push(cosineSimilarityVec(stored, fresh));
    }
    const finite = scores.length >= ADOPT_PROBE_MIN_ROWS && scores.every(Number.isFinite);
    if (!finite) {
      return incompatible("identity-unverifiable", {
        storeSchema,
        identity: engineIdentity,
        identitySource: "probe",
      });
    }
    const minScore = Math.min(...scores);
    const medianScore = median(scores);
    const ok = minScore >= ADOPT_PROBE_MIN_COSINE && medianScore >= ADOPT_PROBE_MEDIAN_COSINE;
    if (!ok) {
      return incompatible("identity-mismatch", {
        storeSchema,
        identity: engineIdentity,
        identitySource: "probe",
      });
    }

    return {
      verdict: "ok",
      dryRun,
      storeSchema,
      identity: engineIdentity,
      identitySource: "probe",
    };
  }

  return { adopt };
}
