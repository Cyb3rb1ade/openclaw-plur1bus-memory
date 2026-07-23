import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, resolve } from "node:path";

import { openDirectoryCapability } from "./directory-capability.js";
import { validateInput } from "./input-limits.js";
import {
  normalizeAndFreezeWorkspaceAliases,
  resolveCanonicalWorkspacePrincipal,
} from "./memory-request-context.js";
import { trySafeWarn } from "./safe-logging.js";
import { storeSharedMemory } from "./shared-memory.js";
import { resolveInside, safeAgentId, safeUuid, sqlString } from "./sql-safety.js";

const TOKEN_SCHEMA_VERSION = 1;
const MARKER_SCHEMA_VERSION = 1;
const MAX_ROWS = 250;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_CALLS = 100;
const MAX_ELAPSED_MS = 60_000;
const MAX_TOKEN_LENGTH = 2_048;
const MAX_REPAIR_ENTRIES = 1_000;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_REPORT_COLLISIONS = 8;
const REPORT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const SOURCE_PREDICATE = "scope = 'workspace_shared' AND (status IS NULL OR status = '' OR status = 'active')";
const SOURCE_COLUMNS = Object.freeze([
  "id", "text", "summary", "scope", "status", "agentId", "storedBy",
  "workspaceId", "workspaceKey", "category", "type", "memoryType",
  "criticalType", "criticalPushType", "importance", "importanceBand",
  "memoryClass", "neverForget", "ownerUserId", "origin", "createdAt",
  "expiresAt", "sourceTurnId", "sourceMessageRole", "sourceTimestamp",
  "sourceUrl", "evidenceQuote", "mergedFrom", "confirmed", "versionNumber",
  "previousVersion", "supersededBy", "updateSource", "updateEvidence",
  "reconsolidationConfidence", "versionCreatedAt", "updatedAt",
  "legacyShareMigrationMarker",
]);
const REQUIRED_SOURCE_COLUMNS = Object.freeze(["id", "text", "scope", "status"]);
const REPAIR_KEYS = Object.freeze([
  "memoryId", "agentId", "workspaceId", "workspaceKey", "reason",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function assertTrustedAliasSnapshot(value) {
  if (!value || typeof value !== "object" || !Object.isFrozen(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("workspaceAliases must be a deeply frozen trusted snapshot");
  }
  const pathsDescriptor = Object.getOwnPropertyDescriptor(value, "paths");
  const aliasesDescriptor = Object.getOwnPropertyDescriptor(value, "aliases");
  if (!pathsDescriptor || !("value" in pathsDescriptor)
    || !aliasesDescriptor || !("value" in aliasesDescriptor)
    || !Array.isArray(pathsDescriptor.value) || !Object.isFrozen(pathsDescriptor.value)
    || !Array.isArray(aliasesDescriptor.value) || !Object.isFrozen(aliasesDescriptor.value)) {
    throw new Error("workspaceAliases must be a deeply frozen trusted snapshot");
  }
  for (const entries of [pathsDescriptor.value, aliasesDescriptor.value]) {
    for (let index = 0; index < entries.length; index += 1) {
      const item = Object.getOwnPropertyDescriptor(entries, String(index));
      const entry = item && "value" in item ? item.value : null;
      if (!entry || typeof entry !== "object" || !Object.isFrozen(entry)
        || (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)
        || Reflect.ownKeys(entry).some((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(entry, key);
          return typeof key !== "string" || !descriptor || !("value" in descriptor);
        })) {
        throw new Error("workspaceAliases must be a deeply frozen trusted snapshot");
      }
    }
    if (entries.some((entry) => !entry || typeof entry !== "object" || !Object.isFrozen(entry))) {
      throw new Error("workspaceAliases must be a deeply frozen trusted snapshot");
    }
  }
  return normalizeAndFreezeWorkspaceAliases(value);
}

function assertBudget(value, maximum, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function validateReportName(value) {
  const validated = validateInput(value, {
    maxLength: 128,
    name: "migration report name",
    required: true,
  });
  if (!validated.ok) throw new Error(validated.error);
  if (!REPORT_NAME_PATTERN.test(value)
    || value === "." || value === ".."
    || value.includes("/") || value.includes("\\") || value.includes("\0")
    || basename(value) !== value) {
    throw new Error("invalid migration report name");
  }
  return value;
}

function generatedReportName(now = Date.now) {
  const compact = new Date(now()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `legacy-shared-repair-${compact}-${randomBytes(8).toString("hex")}.json`;
}

function sanitizeRepairEntry(entry) {
  const result = {};
  for (const key of REPAIR_KEYS) {
    const value = entry?.[key];
    result[key] = typeof value === "string" ? value.slice(0, key === "reason" ? 128 : 256) : "";
  }
  return result;
}

function boundedReport(report) {
  const repair = Array.isArray(report?.repair)
    ? report.repair.slice(0, MAX_REPAIR_ENTRIES).map(sanitizeRepairEntry)
    : [];
  const result = {
    schemaVersion: 1,
    generatedAt: typeof report?.generatedAt === "string"
      ? report.generatedAt
      : new Date().toISOString(),
    dryRun: report?.dryRun === true,
    incomplete: report?.incomplete === true,
    continuationToken: typeof report?.continuationToken === "string"
      ? report.continuationToken
      : null,
    budgets: report?.budgets && typeof report.budgets === "object" ? { ...report.budgets } : {},
    counts: report?.counts && typeof report.counts === "object" ? { ...report.counts } : {},
    truncated: report?.truncated === true || (report?.repair?.length || 0) > repair.length,
    repair,
  };
  let serialized = JSON.stringify(result);
  while (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES && result.repair.length) {
    result.repair.pop();
    result.truncated = true;
    serialized = JSON.stringify(result);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("migration report metadata exceeds hard size limit");
  }
  return { result, serialized };
}

function publishReport(workspaceDir, requestedName, report) {
  const workspacePath = resolve(workspaceDir);
  const explicitName = requestedName ? validateReportName(requestedName) : null;
  const { serialized } = boundedReport(report);
  let workspaceCapability;
  let plur1busCapability;
  let migrationCapability;
  try {
    workspaceCapability = openDirectoryCapability(workspacePath);
    const plur1busDisplay = resolveInside(workspacePath, ".plur1bus");
    plur1busCapability = workspaceCapability.openChild(".plur1bus", { create: true });
    if (resolve(plur1busCapability.displayPath) !== resolve(plur1busDisplay)) {
      throw new Error("migration report directory identity mismatch");
    }
    const migrationDisplay = resolveInside(plur1busDisplay, "migrations");
    migrationCapability = plur1busCapability.openChild("migrations", { create: true });
    if (resolve(migrationCapability.displayPath) !== resolve(migrationDisplay)) {
      throw new Error("migration report directory identity mismatch");
    }

    for (let attempt = 0; attempt < MAX_REPORT_COLLISIONS; attempt += 1) {
      const reportName = explicitName || generatedReportName();
      const tempName = validateReportName(
        `tmp-${randomBytes(12).toString("hex")}.json`,
      );
      resolveInside(migrationDisplay, tempName);
      resolveInside(migrationDisplay, reportName);
      const tempPath = `${migrationCapability.path}/${tempName}`;
      const targetPath = `${migrationCapability.path}/${reportName}`;
      let fd = null;
      let tempExists = false;
      try {
        fd = openSync(
          tempPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
            | constants.O_NOFOLLOW | constants.O_CLOEXEC,
          0o600,
        );
        fchmodSync(fd, 0o600);
        tempExists = true;
        const bytes = Buffer.from(serialized, "utf8");
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        migrationCapability.assertOpen();
        resolveInside(migrationDisplay, tempName);
        resolveInside(migrationDisplay, reportName);
        linkSync(tempPath, targetPath);
        unlinkSync(tempPath);
        tempExists = false;
        fsyncSync(migrationCapability.fd);
        return resolve(migrationDisplay, reportName);
      } catch (error) {
        if (fd !== null) closeSync(fd);
        if (tempExists) {
          try {
            unlinkSync(tempPath);
          } catch (cleanupError) {
            if (cleanupError?.code !== "ENOENT") {
              throw new AggregateError([error, cleanupError], "migration report cleanup failed");
            }
          }
        }
        if (!explicitName && error?.code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error("migration report name collision limit reached");
  } finally {
    migrationCapability?.close();
    plur1busCapability?.close();
    workspaceCapability?.close();
  }
}

/**
 * Atomically publish a bounded private migration report beneath the workspace.
 * @param {{workspaceDir: string, reportName?: string|null, report: object}} options
 * @returns {string} Published report path.
 */
export function writeLegacyRepairReport({ workspaceDir, reportName = null, report }) {
  if (typeof workspaceDir !== "string" || !workspaceDir) {
    throw new Error("migration workspace directory is required");
  }
  return publishReport(workspaceDir, reportName, report);
}

/**
 * Parse the deliberately narrow operator migration option grammar.
 * @param {string[]} tokens Command tokens after migrate-legacy-shared.
 * @returns {{apply: boolean, reportName: string|null, continuationToken: string|null}}
 */
export function parseLegacyMigrationArgs(tokens) {
  if (!Array.isArray(tokens)) throw new Error("invalid migration arguments");
  let apply = false;
  let reportName = null;
  let continuationToken = null;
  const seen = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!["--apply", "--report", "--cursor"].includes(token)) {
      throw new Error(`unknown migration option: ${String(token)}`);
    }
    if (seen.has(token)) throw new Error(`duplicate migration option: ${token}`);
    seen.add(token);
    if (token === "--apply") {
      apply = true;
      continue;
    }
    const value = tokens[++index];
    if (typeof value !== "string" || !value || value.startsWith("--")) {
      throw new Error(`invalid value for ${token}`);
    }
    if (token === "--report") reportName = validateReportName(value);
    else {
      if (value.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(value)) {
        throw new Error("invalid migration cursor");
      }
      continuationToken = value;
    }
  }
  return Object.freeze({ apply, reportName, continuationToken });
}

function tokenPayload({ mode, agentRouteHash, workspaceAliasesHash, sourceVersion, nextOffset }) {
  return {
    schemaVersion: TOKEN_SCHEMA_VERSION,
    mode,
    agentRouteHash,
    workspaceAliasesHash,
    sourceVersion,
    nextOffset,
  };
}

function encodeContinuationToken(payload) {
  const body = tokenPayload(payload);
  const token = { ...body, checksum: sha256(canonicalize(body)) };
  const encoded = Buffer.from(canonicalize(token), "utf8").toString("base64url");
  if (encoded.length > MAX_TOKEN_LENGTH) throw new Error("continuation token exceeds hard limit");
  return encoded;
}

function decodeContinuationToken(encoded, expected) {
  if (typeof encoded !== "string" || !encoded || encoded.length > MAX_TOKEN_LENGTH
    || !TOKEN_PATTERN.test(encoded)) {
    throw new Error("invalid continuation token; restart without a cursor");
  }
  let parsed;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) throw new Error("non-canonical");
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("malformed continuation token; restart without a cursor");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(",")
      !== "agentRouteHash,checksum,mode,nextOffset,schemaVersion,sourceVersion,workspaceAliasesHash"
    || parsed.schemaVersion !== TOKEN_SCHEMA_VERSION
    || !["dry-run", "apply"].includes(parsed.mode)
    || typeof parsed.agentRouteHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.agentRouteHash)
    || typeof parsed.workspaceAliasesHash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.workspaceAliasesHash)
    || !Number.isSafeInteger(parsed.sourceVersion) || parsed.sourceVersion < 0
    || !Number.isSafeInteger(parsed.nextOffset) || parsed.nextOffset < 0
    || typeof parsed.checksum !== "string" || !/^[a-f0-9]{64}$/.test(parsed.checksum)) {
    throw new Error("invalid continuation token fields; restart without a cursor");
  }
  const payload = tokenPayload(parsed);
  if (parsed.checksum !== sha256(canonicalize(payload))) {
    throw new Error("continuation token checksum mismatch; restart without a cursor");
  }
  if (parsed.mode !== expected.mode) {
    throw new Error("continuation token mode mismatch; apply must restart without a cursor");
  }
  if (parsed.agentRouteHash !== expected.agentRouteHash
    || parsed.workspaceAliasesHash !== expected.workspaceAliasesHash) {
    throw new Error("continuation token binding mismatch; restart without a cursor");
  }
  return Object.freeze(payload);
}

function fieldMap(schema) {
  return new Map((Array.isArray(schema?.fields) ? schema.fields : [])
    .map((field) => [field.name, field]));
}

function sameDataType(left, right) {
  if (left === right) return true;
  if (!left || !right || String(left) !== String(right)) return false;
  if (String(left) !== "[object Object]") return true;
  return left.constructor === right.constructor
    && left.name === right.name
    && left.typeId === right.typeId;
}

/**
 * Ensure the authoritative source marker uses the table's own text DataType.
 * @param {object} sourceDb Initialized writable MemoryDB-form source.
 * @returns {Promise<void>}
 */
export async function ensureLegacySourceMarkerColumn(sourceDb) {
  if (!sourceDb?.table || typeof sourceDb.table.schema !== "function") {
    throw new Error("authoritative source table is unavailable");
  }
  let fields = fieldMap(await sourceDb.table.schema());
  const textField = fields.get("text");
  if (!textField?.type) throw new Error("authoritative source schema has no text DataType");
  const existing = fields.get("legacyShareMigrationMarker");
  if (existing) {
    if (!sameDataType(existing.type, textField.type)) {
      throw new Error("legacy source marker column has an incompatible DataType");
    }
    await sourceDb.refreshSchemaFields();
    return;
  }
  try {
    await sourceDb.table.addColumns([{
      name: "legacyShareMigrationMarker",
      type: textField.type,
      valueSql: "'{}'",
    }]);
  } catch (error) {
    fields = fieldMap(await sourceDb.table.schema());
    const raced = fields.get("legacyShareMigrationMarker");
    if (!raced || !sameDataType(raced.type, textField.type)) throw error;
  }
  fields = fieldMap(await sourceDb.table.schema());
  if (!fields.get("legacyShareMigrationMarker")
    || !sameDataType(fields.get("legacyShareMigrationMarker").type, textField.type)) {
    throw new Error("legacy source marker column verification failed");
  }
  await sourceDb.refreshSchemaFields();
}

function rowFromArrow(value, selectedColumns) {
  if (!value || typeof value !== "object") return value;
  const row = {};
  for (const name of selectedColumns) row[name] = value[name];
  return row;
}

async function executePinnedPage(table, selectedColumns, offset, maxRows, remainingMs) {
  if (!table || typeof table.version !== "function" || typeof table.checkout !== "function") {
    throw new Error("installed LanceDB lacks pinned version support");
  }
  let query = table.query();
  if (!query || typeof query.where !== "function" || typeof query.offset !== "function"
    || typeof query.limit !== "function" || typeof query.execute !== "function") {
    throw new Error("installed LanceDB lacks bounded migration query support");
  }
  query = query.where(SOURCE_PREDICATE);
  if (typeof query.select === "function") query = query.select(selectedColumns);
  query = query.offset(offset).limit(maxRows + 1);
  const iterable = query.execute({
    maxBatchLength: Math.min(200, maxRows + 1),
    timeoutMs: Math.max(1, remainingMs),
  });
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
    throw new Error("migration query did not return an AsyncIterable");
  }
  const rows = [];
  for await (const batch of iterable) {
    const batchRows = Array.isArray(batch)
      ? batch
      : typeof batch?.toArray === "function"
        ? batch.toArray()
        : batch && typeof batch[Symbol.iterator] === "function"
          ? [...batch]
          : [];
    for (const value of batchRows) {
      if (rows.length >= maxRows + 1) break;
      rows.push(rowFromArrow(value, selectedColumns));
    }
    if (rows.length >= maxRows + 1) break;
  }
  return rows;
}

function migrationContentHash(row, columns = Object.keys(row || {})) {
  const included = new Set(columns);
  return sha256(canonicalize(Object.fromEntries(
    SOURCE_COLUMNS.filter((name) => name !== "legacyShareMigrationMarker" && included.has(name))
      .map((name) => [name, row?.[name] ?? null]),
  )));
}

function validateCurrentRow(snapshot, current, agentId) {
  if (!current) return "source_missing";
  if (current.id !== snapshot.id || current.scope !== "workspace_shared") return "source_identity_changed";
  for (const alias of [current.agentId, current.storedBy]) {
    if (alias != null && alias !== "" && alias !== agentId) return "source_owner_conflict";
  }
  const snapshotColumns = Object.keys(snapshot);
  if (migrationContentHash(current, snapshotColumns) !== migrationContentHash(snapshot, snapshotColumns)) {
    return "source_content_changed";
  }
  return "";
}

function expiryOutcome(value, migrationNow) {
  if (value === null || value === undefined || value === 0) return "live";
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "invalid";
  if (value <= migrationNow) return "expired";
  return "live";
}

function workspaceBinding(row, workspaceAliases) {
  const rawId = row.workspaceId;
  const rawKey = row.workspaceKey;
  const presentId = typeof rawId === "string" && rawId.trim() ? rawId.trim() : "";
  const presentKey = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : "";
  if (!presentId && !presentKey) return { error: "missing_workspace_binding" };
  try {
    const idPrincipal = presentId
      ? resolveCanonicalWorkspacePrincipal({ explicitId: presentId }, workspaceAliases)
      : "";
    const keyPrincipal = presentKey
      ? resolveCanonicalWorkspacePrincipal({ explicitKey: presentKey }, workspaceAliases)
      : "";
    if (idPrincipal && keyPrincipal && idPrincipal !== keyPrincipal) {
      return { error: "conflicting_workspace_binding" };
    }
    return { workspaceIdentity: idPrincipal || keyPrincipal };
  } catch {
    return { error: "conflicting_workspace_binding" };
  }
}

function validMarker(value) {
  if (value == null || value === "" || value === "{}") return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.schemaVersion !== 1
      || parsed.action !== "legacy_workspace_shared_migration"
      || typeof parsed.sharedId !== "string"
      || typeof parsed.shareIdempotencyKey !== "string"
      || typeof parsed.migratedAt !== "number") return false;
    safeUuid(parsed.sharedId);
    if (!/^[a-f0-9]{64}$/.test(parsed.shareIdempotencyKey)) return false;
    return parsed;
  } catch {
    return false;
  }
}

async function getCurrentSourceRow(sourceDb, id) {
  safeUuid(id);
  if (typeof sourceDb.getById === "function") return sourceDb.getById(id);
  return (await sourceDb.table.query()
    .where(`id = ${sqlString(id)}`)
    .limit(2)
    .toArray())[0] || null;
}

async function verifySharedMarker(sharedPool, ctx, marker) {
  return sharedPool.withWorkspaceDb(ctx, async (targetDb) => {
    await targetDb.init();
    const rows = await targetDb.table.query()
      .where(`id = ${sqlString(marker.sharedId)} AND shareIdempotencyKey = ${sqlString(marker.shareIdempotencyKey)}`)
      .limit(2)
      .toArray();
    return rows.length === 1
      && rows[0].id === marker.sharedId
      && rows[0].shareIdempotencyKey === marker.shareIdempotencyKey;
  });
}

function remaining(deadline, now) {
  return deadline - now();
}

function stopped(signal, deadline, now) {
  return signal?.aborted === true || remaining(deadline, now) <= 0;
}

async function embedBounded(embeddings, text, agentId, timeoutMs, signal, logger) {
  const operation = Promise.resolve().then(() => embeddings.embed(text, { agentId }));
  let settled = false;
  operation.then(
    () => { settled = true; },
    (error) => {
      settled = true;
      if (signal?.aborted) trySafeWarn(logger, "legacy-shared-migration.late-embed", error);
    },
  );
  let timer = null;
  let abortHandler = null;
  const barrier = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("migration embedding timeout")), timeoutMs);
    timer.unref?.();
    if (signal) {
      abortHandler = () => reject(new Error("migration aborted"));
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  try {
    return await Promise.race([operation, barrier]);
  } catch (error) {
    if (!settled) {
      operation.catch((lateError) =>
        trySafeWarn(logger, "legacy-shared-migration.late-embed", lateError));
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

function repairEntry(row, agentId, reason) {
  return sanitizeRepairEntry({
    memoryId: typeof row?.id === "string" ? row.id : "",
    agentId,
    workspaceId: typeof row?.workspaceId === "string" ? row.workspaceId : "",
    workspaceKey: typeof row?.workspaceKey === "string" ? row.workspaceKey : "",
    reason,
  });
}

function markerFor(result, migratedAt) {
  return JSON.stringify({
    schemaVersion: MARKER_SCHEMA_VERSION,
    action: "legacy_workspace_shared_migration",
    sharedId: result.id,
    shareIdempotencyKey: result.shareIdempotencyKey,
    migratedAt,
  });
}

/**
 * Explicitly migrate legacy private-table workspace_shared rows.
 * @param {object} options Initialized runtime dependencies and hard bounds.
 * @returns {Promise<object>} Bounded migration result and report path.
 */
export async function migrateLegacySharedRows({
  privatePool,
  sharedPool,
  embeddings,
  agentId,
  workspaceAliases,
  apply = false,
  reportDir,
  reportName = null,
  continuationToken = null,
  signal = null,
  maxRows = MAX_ROWS,
  maxSourceBytes = MAX_SOURCE_BYTES,
  maxProviderCalls = MAX_PROVIDER_CALLS,
  maxElapsedMs = MAX_ELAPSED_MS,
  now = Date.now,
  logger = null,
}) {
  const sourceAgentId = safeAgentId(agentId);
  if (apply !== true && apply !== false) throw new Error("apply must be boolean");
  if (typeof now !== "function") throw new Error("migration clock is required");
  const aliases = assertTrustedAliasSnapshot(workspaceAliases);
  const budgets = Object.freeze({
    maxRows: assertBudget(maxRows, MAX_ROWS, "maxRows"),
    maxSourceBytes: assertBudget(maxSourceBytes, MAX_SOURCE_BYTES, "maxSourceBytes"),
    maxProviderCalls: assertBudget(maxProviderCalls, MAX_PROVIDER_CALLS, "maxProviderCalls"),
    maxElapsedMs: assertBudget(maxElapsedMs, MAX_ELAPSED_MS, "maxElapsedMs"),
  });
  if (!privatePool || typeof privatePool.withAuthoritativeReadDb !== "function"
    || typeof privatePool.authoritativeRouteDescriptor !== "function") {
    throw new Error("authoritative private pool route is unavailable");
  }
  if (apply && (typeof privatePool.withWriteDb !== "function"
    || typeof sharedPool?.withWorkspaceDb !== "function"
    || typeof embeddings?.embed !== "function")) {
    throw new Error("initialized migration runtime is unavailable");
  }

  const migrationNow = now();
  if (!Number.isFinite(migrationNow) || migrationNow < 0) throw new Error("invalid migration clock");
  const deadline = migrationNow + budgets.maxElapsedMs;
  const mode = apply ? "apply" : "dry-run";
  const route = privatePool.authoritativeRouteDescriptor(sourceAgentId);
  const agentRouteHash = sha256(canonicalize(route));
  const workspaceAliasesHash = sha256(canonicalize(aliases));
  const decoded = continuationToken
    ? decodeContinuationToken(continuationToken, { mode, agentRouteHash, workspaceAliasesHash })
    : null;
  const startOffset = decoded?.nextOffset || 0;
  const counts = {
    examinedRows: 0,
    terminallyConsumedRows: 0,
    sourceBytes: 0,
    providerCalls: 0,
    planned: 0,
    migrated: 0,
    alreadyMigrated: 0,
    expiredSkipped: 0,
    inactiveSkipped: 0,
    repairCount: 0,
    omittedRepairCount: 0,
  };
  const repair = [];
  let sourceVersion = decoded?.sourceVersion ?? null;
  let incomplete = signal?.aborted === true || remaining(deadline, now) <= 0;
  let operationalError = null;
  let hadExtra = false;
  let sourceAvailable = true;

  const addRepair = (source, reason) => {
    counts.repairCount += 1;
    if (repair.length < MAX_REPAIR_ENTRIES) repair.push(repairEntry(source, sourceAgentId, reason));
    else counts.omittedRepairCount += 1;
  };

  const scan = async (sourceDb, writerDb = null) => {
    if (incomplete) return;
    const initialized = await sourceDb.init();
    if (initialized === false || !sourceDb.table) {
      sourceAvailable = false;
      return;
    }
    const schemaFields = fieldMap(await sourceDb.table.schema());
    for (const required of REQUIRED_SOURCE_COLUMNS) {
      if (!schemaFields.has(required)) throw new Error(`authoritative source schema is missing ${required}`);
    }
    const selectedColumns = SOURCE_COLUMNS.filter((name) => schemaFields.has(name));
    if (sourceVersion === null) {
      sourceVersion = await sourceDb.table.version();
      if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 0) {
        throw new Error("authoritative source version is invalid");
      }
    }
    try {
      await sourceDb.table.checkout(sourceVersion);
    } catch (error) {
      throw new Error("pinned source version unavailable; restart without a cursor", { cause: error });
    }
    const beforeQuery = remaining(deadline, now);
    if (beforeQuery <= 0 || signal?.aborted) {
      incomplete = true;
      return;
    }
    let page;
    try {
      page = await executePinnedPage(
        sourceDb.table,
        selectedColumns,
        startOffset,
        budgets.maxRows,
        beforeQuery,
      );
    } catch (error) {
      operationalError = error;
      incomplete = true;
      return;
    }
    hadExtra = page.length > budgets.maxRows;
    const candidates = page.slice(0, budgets.maxRows);

    for (const snapshot of candidates) {
      if (stopped(signal, deadline, now)) {
        incomplete = true;
        break;
      }
      counts.examinedRows += 1;
      if (snapshot.status != null && snapshot.status !== "" && snapshot.status !== "active") {
        counts.inactiveSkipped += 1;
        counts.terminallyConsumedRows += 1;
        continue;
      }
      let sourceId;
      try {
        sourceId = safeUuid(snapshot.id);
      } catch {
        addRepair(snapshot, "invalid_memory_id");
        counts.terminallyConsumedRows += 1;
        continue;
      }
      for (const owner of [snapshot.agentId, snapshot.storedBy]) {
        if (owner != null && owner !== "" && owner !== sourceAgentId) {
          addRepair(snapshot, "source_owner_conflict");
          counts.terminallyConsumedRows += 1;
          sourceId = null;
          break;
        }
      }
      if (!sourceId) continue;
      const expiry = expiryOutcome(snapshot.expiresAt, migrationNow);
      if (expiry === "expired") {
        counts.expiredSkipped += 1;
        counts.terminallyConsumedRows += 1;
        continue;
      }
      if (expiry === "invalid") {
        addRepair(snapshot, "invalid_expiry");
        counts.terminallyConsumedRows += 1;
        continue;
      }
      const rowBytes = Buffer.byteLength(
        `${typeof snapshot.text === "string" ? snapshot.text : ""}${typeof snapshot.summary === "string" ? snapshot.summary : ""}`,
        "utf8",
      );
      if (rowBytes > budgets.maxSourceBytes) {
        addRepair(snapshot, "source_too_large");
        counts.terminallyConsumedRows += 1;
        continue;
      }
      if (counts.sourceBytes + rowBytes > budgets.maxSourceBytes) {
        incomplete = true;
        break;
      }
      const binding = workspaceBinding(snapshot, aliases);
      if (binding.error) {
        addRepair(snapshot, binding.error);
        counts.sourceBytes += rowBytes;
        counts.terminallyConsumedRows += 1;
        continue;
      }
      counts.sourceBytes += rowBytes;

      if (!apply) {
        counts.planned += 1;
        counts.terminallyConsumedRows += 1;
        continue;
      }
      if (stopped(signal, deadline, now)) {
        incomplete = true;
        break;
      }
      let current;
      try {
        current = await getCurrentSourceRow(writerDb, sourceId);
      } catch (error) {
        operationalError = error;
        incomplete = true;
        break;
      }
      const currentProblem = validateCurrentRow(snapshot, current, sourceAgentId);
      if (currentProblem) {
        addRepair(snapshot, currentProblem);
        counts.terminallyConsumedRows += 1;
        continue;
      }
      const existingMarker = validMarker(current.legacyShareMigrationMarker);
      if (existingMarker === false) {
        addRepair(snapshot, "invalid_migration_marker");
        counts.terminallyConsumedRows += 1;
        continue;
      }
      const targetCtx = Object.freeze({
        agentId: sourceAgentId,
        workspaceIdentity: binding.workspaceIdentity,
        workspaceId: binding.workspaceIdentity,
        workspaceAliases: aliases,
      });
      if (existingMarker) {
        if (stopped(signal, deadline, now)) {
          incomplete = true;
          break;
        }
        let verified;
        try {
          verified = await verifySharedMarker(sharedPool, targetCtx, existingMarker);
        } catch (error) {
          operationalError = error;
          incomplete = true;
          break;
        }
        if (!verified) addRepair(snapshot, "migration_marker_target_mismatch");
        else counts.alreadyMigrated += 1;
        counts.terminallyConsumedRows += 1;
        continue;
      }
      if (counts.providerCalls >= budgets.maxProviderCalls) {
        incomplete = true;
        break;
      }
      if (stopped(signal, deadline, now)) {
        incomplete = true;
        break;
      }
      counts.providerCalls += 1;
      let vector;
      try {
        vector = await embedBounded(
          embeddings,
          snapshot.text || snapshot.summary,
          sourceAgentId,
          Math.max(1, Math.min(15_000, remaining(deadline, now))),
          signal,
          logger,
        );
      } catch (error) {
        operationalError = error;
        incomplete = true;
        break;
      }
      if (stopped(signal, deadline, now)) {
        incomplete = true;
        break;
      }
      let beforeCopy;
      try {
        beforeCopy = await getCurrentSourceRow(writerDb, sourceId);
      } catch (error) {
        operationalError = error;
        incomplete = true;
        break;
      }
      const beforeCopyProblem = validateCurrentRow(snapshot, beforeCopy, sourceAgentId);
      if (beforeCopyProblem) {
        addRepair(snapshot, beforeCopyProblem);
        counts.terminallyConsumedRows += 1;
        continue;
      }
      try {
        const sharedResult = await sharedPool.withWorkspaceDb(targetCtx, async (targetDb) => {
          if (stopped(signal, deadline, now)) throw new Error("migration aborted before target write");
          await targetDb.init();
          return storeSharedMemory(targetDb, beforeCopy, targetCtx, {
            targetScope: "workspace",
            vector,
            sourceAgentId,
            action: "legacy_workspace_shared_migration",
            allowSensitiveShare: true,
            logger,
          });
        });
        if (stopped(signal, deadline, now)) {
          incomplete = true;
          break;
        }
        const marker = markerFor(sharedResult, migrationNow);
        if (stopped(signal, deadline, now)) {
          incomplete = true;
          break;
        }
        await writerDb.update(sourceId, { legacyShareMigrationMarker: marker });
        counts.migrated += 1;
        counts.terminallyConsumedRows += 1;
      } catch (error) {
        operationalError = error;
        incomplete = true;
        break;
      }
    }
    if (hadExtra) incomplete = true;
  };

  if (!incomplete) {
    if (apply) {
      const exists = await privatePool.withAuthoritativeReadDb(sourceAgentId, async (probeDb) => {
        const initialized = await probeDb.init();
        if (initialized === false || !probeDb.table) return false;
        const table = probeDb.table;
        if (typeof table.version !== "function" || typeof table.checkout !== "function") {
          throw new Error("installed LanceDB lacks pinned version support");
        }
        const probeQuery = table.query?.();
        if (!probeQuery || typeof probeQuery.where !== "function"
          || typeof probeQuery.offset !== "function"
          || typeof probeQuery.limit !== "function"
          || typeof probeQuery.execute !== "function") {
          throw new Error("installed LanceDB lacks bounded migration query support");
        }
        if (sourceVersion === null) {
          sourceVersion = await table.version();
          if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 0) {
            throw new Error("authoritative source version is invalid");
          }
        }
        try {
          await table.checkout(sourceVersion);
        } catch (error) {
          throw new Error("pinned source version unavailable; restart without a cursor", { cause: error });
        }
        return true;
      });
      if (!exists) sourceAvailable = false;
      else if (stopped(signal, deadline, now)) incomplete = true;
      else {
        await privatePool.withWriteDb(sourceAgentId, async (writerDb) => {
          if (stopped(signal, deadline, now)) {
            incomplete = true;
            return;
          }
          await writerDb.init();
          if (!writerDb.table) {
            sourceAvailable = false;
            return;
          }
          if (stopped(signal, deadline, now)) {
            incomplete = true;
            return;
          }
          await ensureLegacySourceMarkerColumn(writerDb);
          if (stopped(signal, deadline, now)) {
            incomplete = true;
            return;
          }
          await privatePool.withAuthoritativeReadDb(sourceAgentId, (sourceDb) =>
            scan(sourceDb, writerDb));
        });
      }
    } else {
      await privatePool.withAuthoritativeReadDb(sourceAgentId, (sourceDb) => scan(sourceDb));
    }
  }

  const nextOffset = startOffset + counts.terminallyConsumedRows;
  const hasContinuation = sourceAvailable && sourceVersion !== null
    && (incomplete || hadExtra);
  const nextToken = hasContinuation
    ? encodeContinuationToken({
        mode,
        agentRouteHash,
        workspaceAliasesHash,
        sourceVersion,
        nextOffset,
      })
    : null;
  const generatedAt = new Date(migrationNow).toISOString();
  const report = {
    schemaVersion: 1,
    generatedAt,
    dryRun: !apply,
    incomplete,
    continuationToken: nextToken,
    budgets,
    counts,
    truncated: counts.omittedRepairCount > 0,
    repair,
  };
  const reportPath = writeLegacyRepairReport({
    workspaceDir: reportDir,
    reportName,
    report,
  });
  if (operationalError) {
    trySafeWarn(logger, "legacy-shared-migration.row", operationalError, {
      agentId: sourceAgentId,
      nextOffset,
    });
  }
  return Object.freeze({
    ...counts,
    incomplete,
    continuationToken: nextToken,
    sourceVersion,
    nextOffset,
    reportPath,
  });
}
