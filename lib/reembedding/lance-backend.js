import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { connect as defaultConnect } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Schema } from "apache-arrow";

import { resolveInside, safeAgentId, safeUuid, safeUuidList } from "../sql-safety.js";

const GENERATION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TABLE_NAME = "memories";

function generationId(value) {
  if (typeof value !== "string" || !GENERATION_RE.test(value)) throw new Error("invalid reembedding generation id");
  return value;
}

function parseTableId(value) {
  if (typeof value !== "string") throw new Error("invalid reembedding table id");
  const segments = value.split("/");
  if (segments.length !== 2 || segments[1] !== TABLE_NAME) throw new Error("invalid reembedding table id");
  return { agentId: safeAgentId(segments[0]), tableName: TABLE_NAME, tableId: value };
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

function directoryBytes(path) {
  if (!existsSync(path)) return 0;
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error("symbolic links are not allowed in reembedding Lance paths");
  if (!entry.isDirectory()) return entry.size;
  return readdirSync(path).reduce((sum, name) => sum + directoryBytes(join(path, name)), 0);
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
  activeGeneration,
  activeFingerprint,
  configRevision = null,
  connect = defaultConnect,
} = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("reembedding stateRoot is required");
  if (typeof activeRoot !== "string" || !activeRoot) throw new Error("reembedding activeRoot is required");
  generationId(activeGeneration);
  if (!activeFingerprint || !Number.isSafeInteger(activeFingerprint.dimensions) || activeFingerprint.dimensions <= 0) {
    throw new Error("active embedding fingerprint is required");
  }
  if (typeof connect !== "function") throw new Error("Lance connection capability is required");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(activeRoot, { recursive: true, mode: 0o700 });
  const generationsRoot = resolveInside(stateRoot, "generations");
  mkdirSync(generationsRoot, { recursive: true, mode: 0o700 });
  const handles = new Map();
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error("reembedding Lance backend is closed");
  };
  const partitionPath = (root, agentId) => resolveInside(root, safeAgentId(agentId));
  const connectionFor = async (key, path) => {
    assertOpen();
    let entry = handles.get(key);
    if (!entry) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      entry = { db: await connect(path), tables: new Map() };
      handles.set(key, entry);
    }
    return entry;
  };
  const tableFor = async (root, keyPrefix, tableId) => {
    const parsed = parseTableId(tableId);
    const entry = await connectionFor(`${keyPrefix}:${parsed.agentId}`, partitionPath(root, parsed.agentId));
    let table = entry.tables.get(parsed.tableName);
    if (!table) {
      const names = await entry.db.tableNames();
      if (!names.includes(parsed.tableName)) throw new Error(`Lance table is missing: ${tableId}`);
      table = await entry.db.openTable(parsed.tableName);
      entry.tables.set(parsed.tableName, table);
    }
    return table;
  };
  const generationRoot = (generation) => resolveInside(generationsRoot, generationId(generation));
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

  const inventoryActiveGeneration = async () => {
    assertOpen();
    const agents = readdirSync(activeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => safeAgentId(entry.name))
      .sort();
    const tables = [];
    for (const agentId of agents) {
      const entry = await connectionFor(`source:${agentId}`, partitionPath(activeRoot, agentId));
      const names = await entry.db.tableNames();
      if (!names.includes(TABLE_NAME)) continue;
      const table = await tableFor(activeRoot, "source", `${agentId}/${TABLE_NAME}`);
      const schema = await table.schema();
      const dimensions = vectorDimensions(schema);
      if (dimensions !== activeFingerprint.dimensions) {
        throw new Error(`active Lance dimension mismatch for ${agentId}/${TABLE_NAME}`);
      }
      tables.push(Object.freeze({
        tableId: `${agentId}/${TABLE_NAME}`,
        version: String(await table.version()),
        rowCount: await table.countRows(),
        estimatedBytes: directoryBytes(partitionPath(activeRoot, agentId)),
        dimensions,
      }));
    }
    return [Object.freeze({
      generation: activeGeneration,
      configRevision,
      fingerprint: activeFingerprint,
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
    const manifest = createManifest({ generation, fingerprintId, dimensions, tables });
    for (const descriptor of tables) {
      const parsed = parseTableId(descriptor.tableId);
      const sourceTable = await tableFor(activeRoot, "source", parsed.tableId);
      const sourceSchema = await sourceTable.schema();
      const targetEntry = await connectionFor(`target:${generation}:${parsed.agentId}`, partitionPath(root, parsed.agentId));
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
    const table = await tableFor(activeRoot, "source", tableId);
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
    const table = await tableFor(generationRoot(generation), `target:${generation}`, tableId);
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
      const table = await tableFor(generationRoot(generation), `target:${generation}`, tableId);
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
      const target = await tableFor(generationRoot(generation), `target:${generation}`, tableId);
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
      const source = await tableFor(activeRoot, "source", tableId);
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

  const removeSyntheticProbe = async (generation, tableId, id) => {
    safeUuid(id);
    const table = await tableFor(generationRoot(generation), `target:${generation}`, tableId);
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
    readSourceBatch,
    writeTargetBatch,
    readBackTargetRows,
    validateGeneration,
    removeSyntheticProbe,
    close,
  });
}
