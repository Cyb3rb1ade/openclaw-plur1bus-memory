import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { connect as defaultConnect } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Schema } from "apache-arrow";

import { resolveInside, safeAgentId, safeUuid, safeUuidList } from "../sql-safety.js";

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAMESPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHARED_KEY_RE = /^(?:w|u)-[a-f0-9]{62}$/;
const SHARED_KIND_SEGMENTS = Object.freeze({ workspaces: "w-", users: "u-" });
const PRIVATE_RESERVED_SEGMENTS = new Set([".plur1bus-shared", "control", "generations"]);
const TABLE_NAME = "memories";

function generationId(value) {
  if (typeof value !== "string" || !GENERATION_RE.test(value)) throw new Error("invalid reembedding generation id");
  return value;
}

function parseTableId(value) {
  if (typeof value !== "string") throw new Error("invalid reembedding table id");
  const segments = value.split("/");
  if (segments.length === 2 && segments[1] === TABLE_NAME) {
    return { kind: "private", agentId: safeAgentId(segments[0]), tableName: TABLE_NAME, tableId: value };
  }
  if (
    segments.length === 4
    && segments[0] === "shared"
    && Object.hasOwn(SHARED_KIND_SEGMENTS, segments[1])
    && segments[3] === TABLE_NAME
    && SHARED_KEY_RE.test(segments[2])
    && segments[2].startsWith(SHARED_KIND_SEGMENTS[segments[1]])
  ) {
    return { kind: "shared", sharedKind: segments[1], sharedKey: segments[2], tableName: TABLE_NAME, tableId: value };
  }
  throw new Error("invalid reembedding table id");
}

function normalizeVector(value) {
  if (Array.isArray(value)) return value.slice();
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (value && typeof value.toArray === "function") return Array.from(value.toArray());
  if (value && ArrayBuffer.isView(value.values)) return Array.from(value.values);
  if (value && Array.isArray(value.values)) return value.values.slice();
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

/** Stable metadata hash excluding only vector-derived and query-only fields. */
export function stableNonVectorRowHash(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid migration row");
  const projected = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "vector" || key === "embeddingFingerprint" || key.startsWith("_")) continue;
    projected[key] = canonicalJson(value);
  }
  return createHash("sha256").update(JSON.stringify(canonicalJson(projected))).digest("hex");
}

function stableVectorHash(vector) {
  return createHash("sha256").update(JSON.stringify(normalizeVector(vector))).digest("hex");
}

function abortError(signal) {
  const error = new Error(signal?.reason?.message || "reembedding Lance operation aborted");
  error.name = "AbortError";
  if (signal?.reason !== undefined) error.cause = signal.reason;
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function lstatIfExists(path, { signal } = {}) {
  throwIfAborted(signal);
  try {
    const value = await lstat(path);
    throwIfAborted(signal);
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function directoryBytes(path, { signal } = {}) {
  const entry = await lstatIfExists(path, { signal });
  if (!entry) return 0;
  if (entry.isSymbolicLink()) throw new Error("symbolic links are not allowed in reembedding Lance paths");
  if (!entry.isDirectory()) return entry.size;
  const names = await readdir(path);
  let bytes = 0;
  for (const name of names) {
    throwIfAborted(signal);
    bytes += await directoryBytes(resolveInside(path, name), { signal });
  }
  return bytes;
}

function writeJsonMode600(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(value), "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function vectorDimensions(schema) {
  const vectorField = schema?.fields?.find((field) => field.name === "vector");
  const dimensions = vectorField?.type?.listSize;
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("Lance source vector schema is invalid");
  return dimensions;
}

function targetSchema(sourceSchema, dimensions) {
  const fields = sourceSchema.fields.map((field) => field.name === "vector"
    ? new Field("vector", new FixedSizeList(dimensions, new Field("item", new Float32(), true)), field.nullable, field.metadata)
    : field);
  return new Schema(fields, sourceSchema.metadata);
}

function validateTargetRows(rows, dimensions) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("target batch must contain rows");
  const ids = new Set();
  return rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid target row");
    const id = safeUuid(row.id);
    if (ids.has(id)) throw new Error(`duplicate target row id: ${id}`);
    ids.add(id);
    const vector = normalizeVector(row.vector);
    if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new Error(`finite target vector with dimension ${dimensions} required for ${id}`);
    }
    return { ...row, id, vector };
  });
}

function createManifest({ generation, fingerprintId, dimensions, tables }) {
  return {
    schemaVersion: 1,
    generation,
    fingerprintId: typeof fingerprintId === "string" ? fingerprintId : null,
    dimensions,
    tables: Object.fromEntries(tables.map((table) => [table.tableId, {
      sourceVersion: String(table.version),
      sourceRows: table.rowCount,
      writtenRows: 0,
    }])),
  };
}

/** Open an isolated copy-on-write LanceDB generation backend. */
export function createLanceGenerationBackend({
  stateRoot,
  activeRoot,
  activeSharedBaseDir = activeRoot,
  activeNamespace = null,
  activeGeneration,
  activeSelection = null,
  activeFingerprint,
  activeSecretRef,
  configRevision = null,
  connect = defaultConnect,
} = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("reembedding stateRoot is required");
  if (typeof activeRoot !== "string" || !activeRoot) throw new Error("reembedding activeRoot is required");
  if (typeof activeSharedBaseDir !== "string" || !activeSharedBaseDir) {
    throw new Error("reembedding activeSharedBaseDir is required");
  }
  generationId(activeGeneration);
  if (activeSelection !== null) {
    if (!activeSelection || typeof activeSelection !== "object" || Array.isArray(activeSelection)) {
      throw new Error("invalid active reembedding selection");
    }
    if (activeSelection.mode === "legacy") {
      if (Object.keys(activeSelection).length !== 1) throw new Error("invalid active reembedding selection");
    } else if (
      activeSelection.mode !== "generation"
      || activeSelection.generation !== activeGeneration
      || Object.keys(activeSelection).sort().join(",") !== "generation,mode"
    ) throw new Error("invalid active reembedding selection");
  }
  const normalizedActiveSelection = activeSelection
    ? Object.freeze(structuredClone(activeSelection))
    : Object.freeze({ mode: "generation", generation: activeGeneration });
  if (activeNamespace !== null && (typeof activeNamespace !== "string" || !NAMESPACE_RE.test(activeNamespace))) {
    throw new Error("invalid active reembedding namespace");
  }
  if (!activeFingerprint || !Number.isSafeInteger(activeFingerprint.dimensions) || activeFingerprint.dimensions <= 0) {
    throw new Error("active embedding fingerprint is required");
  }
  if (typeof connect !== "function") throw new Error("Lance connection capability is required");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(activeRoot, { recursive: true, mode: 0o700 });
  mkdirSync(activeSharedBaseDir, { recursive: true, mode: 0o700 });
  const generationsRoot = resolveInside(stateRoot, "generations");
  mkdirSync(generationsRoot, { recursive: true, mode: 0o700 });
  const handles = new Map();
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error("reembedding Lance backend is closed");
  };
  const partitionPath = (root, agentId) => resolveInside(root, safeAgentId(agentId));
  const sourcePartitionPath = (parsed) => parsed.kind === "private"
    ? partitionPath(activeRoot, parsed.agentId)
    : resolveInside(activeSharedBaseDir, ".plur1bus-shared", parsed.sharedKind, parsed.sharedKey);
  const targetPartitionPath = (generation, parsed) => parsed.kind === "private"
    ? partitionPath(generationDataRoot(generation), parsed.agentId)
    : resolveInside(generationRoot(generation), ".plur1bus-shared", parsed.sharedKind, parsed.sharedKey);
  const connectionFor = async (key, path, { signal } = {}) => {
    assertOpen();
    throwIfAborted(signal);
    let entry = handles.get(key);
    if (!entry) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const db = await connect(path);
      try {
        throwIfAborted(signal);
      } catch (error) {
        try {
          await db.close?.();
        } catch (closeError) {
          throw new AggregateError([error, closeError], "aborted Lance connection cleanup failed");
        }
        throw error;
      }
      entry = { db, tables: new Map() };
      handles.set(key, entry);
    }
    throwIfAborted(signal);
    return entry;
  };
  const tableForPath = async (path, keyPrefix, tableId, { signal } = {}) => {
    throwIfAborted(signal);
    const parsed = parseTableId(tableId);
    const entry = await connectionFor(`${keyPrefix}:${parsed.tableId}`, path, { signal });
    let table = entry.tables.get(parsed.tableName);
    if (!table) {
      const names = await entry.db.tableNames();
      throwIfAborted(signal);
      if (!names.includes(parsed.tableName)) throw new Error(`Lance table is missing: ${tableId}`);
      table = await entry.db.openTable(parsed.tableName);
      try {
        throwIfAborted(signal);
      } catch (error) {
        try {
          await table.close?.();
        } catch (closeError) {
          throw new AggregateError([error, closeError], "aborted Lance table cleanup failed");
        }
        throw error;
      }
      entry.tables.set(parsed.tableName, table);
    }
    throwIfAborted(signal);
    return table;
  };
  const generationRoot = (generation) => resolveInside(generationsRoot, generationId(generation));
  const generationDataRoot = (generation) => activeNamespace
    ? resolveInside(generationRoot(generation), activeNamespace)
    : generationRoot(generation);
  const manifestPath = (generation) => resolveInside(generationRoot(generation), "generation.json");
  const readManifest = (generation) => {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath(generation), "utf8"));
      if (manifest?.schemaVersion !== 1 || manifest.generation !== generation) throw new Error("invalid generation manifest");
      return manifest;
    } catch (cause) {
      const error = new Error(`invalid reembedding generation manifest: ${generation}`);
      error.cause = cause;
      throw error;
    }
  };
  const writeManifest = (generation, manifest) => writeJsonMode600(manifestPath(generation), manifest);
  const describeGeneration = async (generation) => structuredClone(readManifest(generation));
  const sourceTableFor = async (tableId, { signal } = {}) => {
    const parsed = parseTableId(tableId);
    return tableForPath(sourcePartitionPath(parsed), "source", tableId, { signal });
  };
  const targetTableFor = async (generation, tableId) => {
    const parsed = parseTableId(tableId);
    return tableForPath(targetPartitionPath(generation, parsed), `target:${generation}`, tableId);
  };

  const inventoryTable = async (tableId, path, { signal } = {}) => {
    throwIfAborted(signal);
    let lancePath = null;
    let lanceStat = null;
    for (const name of [`${TABLE_NAME}.lance`, TABLE_NAME]) {
      const candidate = resolveInside(path, name);
      const candidateStat = await lstatIfExists(candidate, { signal });
      if (candidateStat) {
        lancePath = candidate;
        lanceStat = candidateStat;
        break;
      }
    }
    if (!lancePath) return null;
    if (lanceStat.isSymbolicLink() || !lanceStat.isDirectory()) {
      throw new Error(`unsafe Lance table path: ${tableId}`);
    }
    const table = await sourceTableFor(tableId, { signal });
    const schema = await table.schema();
    throwIfAborted(signal);
    const dimensions = vectorDimensions(schema);
    if (dimensions !== activeFingerprint.dimensions) {
      throw new Error(`active Lance dimension mismatch for ${tableId}`);
    }
    const version = await table.version();
    throwIfAborted(signal);
    const rowCount = await table.countRows();
    throwIfAborted(signal);
    const estimatedBytes = await directoryBytes(path, { signal });
    return Object.freeze({
      tableId,
      version: String(version),
      rowCount,
      estimatedBytes,
      dimensions,
    });
  };

  const inventoryActiveGeneration = async ({ signal } = {}) => {
    assertOpen();
    throwIfAborted(signal);
    const tables = [];
    for (const entry of await readdir(activeRoot, { withFileTypes: true })) {
      throwIfAborted(signal);
      if (PRIVATE_RESERVED_SEGMENTS.has(entry.name) || entry.name.startsWith("_")) continue;
      if (entry.isSymbolicLink()) throw new Error(`unsafe private Lance partition: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const agentId = safeAgentId(entry.name);
      const descriptor = await inventoryTable(`${agentId}/${TABLE_NAME}`, partitionPath(activeRoot, agentId), { signal });
      if (descriptor) tables.push(descriptor);
    }
    const sharedRoot = resolveInside(activeSharedBaseDir, ".plur1bus-shared");
    const sharedStat = await lstatIfExists(sharedRoot, { signal });
    if (sharedStat) {
      if (sharedStat.isSymbolicLink() || !sharedStat.isDirectory()) throw new Error("unsafe shared Lance root");
      for (const [sharedKind, prefix] of Object.entries(SHARED_KIND_SEGMENTS)) {
        throwIfAborted(signal);
        const kindRoot = resolveInside(sharedRoot, sharedKind);
        const kindStat = await lstatIfExists(kindRoot, { signal });
        if (!kindStat) continue;
        if (kindStat.isSymbolicLink() || !kindStat.isDirectory()) throw new Error(`unsafe shared Lance kind: ${sharedKind}`);
        for (const entry of await readdir(kindRoot, { withFileTypes: true })) {
          throwIfAborted(signal);
          if (entry.isSymbolicLink()) throw new Error(`unsafe shared Lance partition: ${entry.name}`);
          if (!entry.isDirectory()) continue;
          if (!SHARED_KEY_RE.test(entry.name) || !entry.name.startsWith(prefix)) {
            throw new Error(`invalid shared Lance partition: ${entry.name}`);
          }
          const tableId = `shared/${sharedKind}/${entry.name}/${TABLE_NAME}`;
          const descriptor = await inventoryTable(tableId, resolveInside(kindRoot, entry.name), { signal });
          if (descriptor) tables.push(descriptor);
        }
      }
    }
    throwIfAborted(signal);
    tables.sort((left, right) => left.tableId.localeCompare(right.tableId));
    return [Object.freeze({
      generation: activeGeneration,
      selection: normalizedActiveSelection,
      configRevision,
      fingerprint: activeFingerprint,
      ...(activeSecretRef ? { secretRef: structuredClone(activeSecretRef) } : {}),
      tables: Object.freeze(tables),
    })];
  };

  const createQuarantinedGeneration = async ({ generation, fingerprintId, dimensions, tables } = {}) => {
    assertOpen();
    generationId(generation);
    if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("invalid target generation dimensions");
    if (!Array.isArray(tables)) throw new Error("target generation tables are required");
    const root = generationRoot(generation);
    if (existsSync(root)) throw new Error(`target generation already exists: ${generation}`);
    mkdirSync(root, { recursive: false, mode: 0o700 });
    if (activeNamespace) mkdirSync(resolveInside(root, activeNamespace), { recursive: false, mode: 0o700 });
    const manifest = createManifest({ generation, fingerprintId, dimensions, tables });
    for (const descriptor of tables) {
      const parsed = parseTableId(descriptor.tableId);
      const sourceTable = await sourceTableFor(parsed.tableId);
      const sourceSchema = await sourceTable.schema();
      const targetEntry = await connectionFor(
        `target:${generation}:${parsed.tableId}`,
        targetPartitionPath(generation, parsed),
      );
      const existing = await targetEntry.db.tableNames();
      if (existing.includes(TABLE_NAME)) throw new Error(`target table already exists: ${parsed.tableId}`);
      const targetTable = await targetEntry.db.createEmptyTable(TABLE_NAME, targetSchema(sourceSchema, dimensions));
      targetEntry.tables.set(TABLE_NAME, targetTable);
    }
    writeManifest(generation, manifest);
    return structuredClone(manifest);
  };

  const readSourceBatch = async (tableId, { offset = 0, limit = 100 } = {}) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("invalid source batch window");
    }
    const table = await sourceTableFor(tableId);
    const query = table.query().offset(offset).limit(limit);
    return (await query.toArray()).map((row) => ({ ...row, vector: normalizeVector(row.vector) }));
  };

  const readBackTargetRows = async (generation, tableId, ids) => {
    const manifest = readManifest(generation);
    if (!Object.hasOwn(manifest.tables, tableId)) throw new Error("target table is not declared");
    if (!Array.isArray(ids) || ids.length === 0) return [];
    ids.forEach(safeUuid);
    const inList = safeUuidList(ids, ids.length);
    if (!inList) return [];
    const table = await targetTableFor(generation, tableId);
    const rows = await table.query().where(`id IN (${inList})`).limit(ids.length + 1).toArray();
    const byId = new Map(rows.map((row) => [row.id, { ...row, vector: normalizeVector(row.vector) }]));
    return ids.flatMap((id) => byId.has(id) ? [byId.get(id)] : []);
  };

  const writeTargetBatch = async (generation, tableId, rawRows) => {
    const manifest = readManifest(generation);
    const tableState = manifest.tables[tableId];
    if (!tableState) throw new Error("target table is not declared");
    const rows = validateTargetRows(rawRows, manifest.dimensions);
    const existing = await readBackTargetRows(generation, tableId, rows.map((row) => row.id));
    const existingById = new Map(existing.map((row) => [row.id, row]));
    const additions = [];
    for (const row of rows) {
      const prior = existingById.get(row.id);
      if (!prior) {
        additions.push(row);
        continue;
      }
      if (stableNonVectorRowHash(prior) !== stableNonVectorRowHash(row) || stableVectorHash(prior.vector) !== stableVectorHash(row.vector)) {
        throw new Error(`target row conflict: ${row.id}`);
      }
    }
    if (additions.length > 0) {
      const table = await targetTableFor(generation, tableId);
      await table.add(additions);
      tableState.writtenRows += additions.length;
      writeManifest(generation, manifest);
    }
    return { added: additions.length, existing: rows.length - additions.length };
  };

  const validateGeneration = async (generation) => {
    const manifest = readManifest(generation);
    let rows = 0;
    for (const [tableId, descriptor] of Object.entries(manifest.tables)) {
      const target = await targetTableFor(generation, tableId);
      const schema = await target.schema();
      if (vectorDimensions(schema) !== manifest.dimensions) throw new Error(`target dimension mismatch: ${tableId}`);
      const targetRows = (await target.query().toArray()).map((row) => ({ ...row, vector: normalizeVector(row.vector) }));
      if (targetRows.length !== descriptor.sourceRows) throw new Error(`target row count mismatch: ${tableId}`);
      const ids = new Set();
      for (const row of targetRows) {
        safeUuid(row.id);
        if (ids.has(row.id)) throw new Error(`duplicate target row id: ${row.id}`);
        ids.add(row.id);
        validateTargetRows([row], manifest.dimensions);
      }
      const source = await sourceTableFor(tableId);
      if (String(await source.version()) !== descriptor.sourceVersion) throw new Error(`source table version drift: ${tableId}`);
      const sourceRows = (await source.query().toArray()).map((row) => ({ ...row, vector: normalizeVector(row.vector) }));
      const sourceHashes = new Map(sourceRows.map((row) => [row.id, stableNonVectorRowHash(row)]));
      for (const row of targetRows) {
        if (sourceHashes.get(row.id) !== stableNonVectorRowHash(row)) throw new Error(`target metadata mismatch: ${row.id}`);
      }
      rows += targetRows.length;
    }
    return { tables: Object.keys(manifest.tables).length, rows, dimensions: manifest.dimensions };
  };

  const searchTarget = async (generation, tableId, vector, { limit = 5 } = {}) => {
    const manifest = readManifest(generation);
    if (!Object.hasOwn(manifest.tables, tableId)) throw new Error("target table is not declared");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid target recall limit");
    const normalized = normalizeVector(vector);
    if (
      !Array.isArray(normalized)
      || normalized.length !== manifest.dimensions
      || normalized.some((item) => typeof item !== "number" || !Number.isFinite(item))
    ) throw new Error("invalid target recall vector");
    const table = await targetTableFor(generation, tableId);
    return (await table.vectorSearch(normalized).limit(limit).toArray())
      .map((row) => ({ ...row, vector: normalizeVector(row.vector) }));
  };

  const removeSyntheticProbe = async (generation, tableId, id) => {
    safeUuid(id);
    const table = await targetTableFor(generation, tableId);
    await table.delete(`id = '${id}'`);
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    const errors = [];
    for (const entry of handles.values()) {
      for (const table of entry.tables.values()) {
        try { await table.close?.(); } catch (error) { errors.push(error); }
      }
      try { await entry.db.close?.(); } catch (error) { errors.push(error); }
    }
    handles.clear();
    if (errors.length) throw new AggregateError(errors, "reembedding Lance backend close failed");
  };

  return Object.freeze({
    inventoryActiveGeneration,
    createQuarantinedGeneration,
    describeGeneration,
    readSourceBatch,
    writeTargetBatch,
    readBackTargetRows,
    validateGeneration,
    searchTarget,
    removeSyntheticProbe,
    close,
  });
}
