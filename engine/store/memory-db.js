/**
 * engine/store/memory-db.js — the per-agent LanceDB store (`MemoryDB`) and the epistemic-status / valid-time write helpers.
 *
 * Moved verbatim from index.js (engine extraction, step 9 part 1); index.js
 * imports what the host registration still uses and re-exports the public names.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { distanceToScore } from "../../lib/score.js";
import { normalizeImportanceStatus } from "../../lib/importance-status.js";
import { transitionEpistemicStatus } from "../../lib/epistemic-status.js";
import { buildValidTimeClosePatch } from "../../lib/valid-time.js";
import { checkAccess } from "../../lib/acl-middleware.js";
import { appendDestructiveOpLog, resolveInside, safeStatus, safeTimestamp, safeUuid } from "../../lib/sql-safety.js";
import { coerceNewWriteEpistemicStatus } from "../../lib/epistemic-capture.js";
import { readEpistemicCutoff } from "../../lib/epistemic-cutoff.js";
import { assertCardWriteAllowed, isContentChangingUpdate, splitAgentDbPath } from "../../lib/tombstone-write-guard.js";
import { isNeoRecordAccessible } from "../../lib/neo-arch.js";
import { TimeoutError, withTimeout } from "../../lib/with-timeout.js";
import { isAbortError } from "../../lib/abort.js";
import { safeDebug, settleSafeWarning } from "../../lib/safe-logging.js";
import { deserializeEmotionalValence } from "../../lib/emotion.js";
import { resolveHalfLifeDays } from "../../lib/memory-dynamics.js";
import { PURGE_THROTTLE_MS, purgeThrottleMap } from "../runtime/debug-log.js";
import { TABLE_NAME } from "../runtime/constants.js";
import { getLanceDB } from "./lancedb-loader.js";

// ============================================================================
// MemoryDB — pro Agent eine Instanz
// ============================================================================

const REINDEX_WRITE_THRESHOLD = 5000; // Rebuild ANN index every N writes (v6.2.1: increased from 500)
const REINDEX_MIN_ROWS = 256;         // Minimum rows before creating an index
const REINDEX_MIN_INTERVAL_MS = 3600000; // Max 1 reindex per hour (v6.2.1 P0-fix)

// Operation-level timeouts for LanceDB calls (P0 Performance-Audit K3).
const LANCEDB_READ_TIMEOUT_MS = 10_000;
const LANCEDB_WRITE_TIMEOUT_MS = 25_000;
const INIT_LATE_HANDLE_KIND = Symbol("MemoryDB.initLateHandleKind");
const MAX_BACKGROUND_LIFECYCLE_ERRORS = 50;

function logMemoryDbDebug(logger, scope, error, dbPath) {
  return safeDebug(logger, scope, error, { agent: basename(dbPath) });
}

async function waitForTimeoutSettlement(error) {
  let currentError = error;
  let waited = false;
  const seen = new Set();
  while (
    (currentError instanceof TimeoutError || isAbortError(currentError))
    && currentError.settlement
    && typeof currentError.settlement.then === "function"
    && !seen.has(currentError.settlement)
  ) {
    const settlement = currentError.settlement;
    seen.add(settlement);
    waited = true;
    try {
      const value = await settlement;
      return { waited, status: "fulfilled", value };
    } catch (settlementError) {
      currentError = settlementError;
    }
  }
  return waited
    ? { waited, status: "rejected", error: currentError }
    : { waited: false, status: "unavailable", error };
}

function normalizeVectorValue(vector) {
  if (!vector || Array.isArray(vector) || typeof vector !== "object") return vector;
  if (ArrayBuffer.isView(vector)) return Array.from(vector);
  if (Array.isArray(vector.values)) return vector.values.slice();
  if (ArrayBuffer.isView(vector.values)) return Array.from(vector.values);
  if (typeof vector.toArray === "function") {
    const arr = vector.toArray();
    if (Array.isArray(arr)) return arr.slice();
    if (ArrayBuffer.isView(arr)) return Array.from(arr);
    if (arr && typeof arr[Symbol.iterator] === "function") return Array.from(arr);
  }
  if (Number.isInteger(vector.length) && vector.length >= 0 && typeof vector.get === "function") {
    return Array.from({ length: vector.length }, (_, index) => vector.get(index));
  }
  return vector;
}

class MemoryDB {
  /**
   * @param {string} dbPath LanceDB agent path.
   * @param {number} vectorDim Vector dimension.
   * @param {object} [logger] Optional logger.
   * @param {{readOnly?: boolean, pathGuard?: (() => void), directoryCapability?: object|null, secureDirectoryRequired?: boolean, beforeLanceOperation?: ((operation: string, capability: object|null) => void), lancedbProvider?: (() => Promise<object>|object), halfLifeOverrides?: Record<string, number>}} [options] Non-mutating mode, trusted directory routing, an injectable DB provider for lifecycle tests, and the configured recall.halfLifeDaysMap that search() resolves a row's missing halfLifeDays against.
   */
  constructor(dbPath, vectorDim, logger = null, {
    readOnly = false,
    pathGuard = null,
    directoryCapability = null,
    secureDirectoryRequired = false,
    beforeLanceOperation = null,
    lancedbProvider = null,
    halfLifeOverrides = {},
  } = {}) {
    if (pathGuard !== null && typeof pathGuard !== "function") {
      throw new TypeError("MemoryDB pathGuard must be a function");
    }
    if (directoryCapability !== null && (
      typeof directoryCapability !== "object"
      || typeof directoryCapability.assertOpen !== "function"
      || typeof directoryCapability.close !== "function"
      || typeof directoryCapability.path !== "string"
    )) {
      throw new TypeError("MemoryDB directoryCapability must be a stable directory capability");
    }
    if (beforeLanceOperation !== null && typeof beforeLanceOperation !== "function") {
      throw new TypeError("MemoryDB beforeLanceOperation must be a function");
    }
    if (lancedbProvider !== null && typeof lancedbProvider !== "function") {
      throw new TypeError("MemoryDB lancedbProvider must be a function");
    }
    this.dbPath = dbPath;
    this.vectorDim = vectorDim;
    this.logger = logger;
    this.readOnly = readOnly === true;
    this.pathGuard = pathGuard;
    this.directoryCapability = directoryCapability;
    this.secureDirectoryRequired = secureDirectoryRequired === true;
    this.beforeLanceOperation = beforeLanceOperation;
    this.lancedbProvider = lancedbProvider;
    this.halfLifeOverrides = halfLifeOverrides && typeof halfLifeOverrides === "object" ? halfLifeOverrides : {};
    this.db = null;
    this.table = null;
    this.initPromise = null;
    this.shutdownPromise = null;
    this.pendingInitSettlements = new Set();
    this.pendingDebugSettlements = new Set();
    this.backgroundDiagnosticErrors = [];
    this.backgroundDiagnosticErrorOverflow = 0;
    this.initCleanupErrors = [];
    this.schemaFieldNames = null;
    this._writeCounter = 0;
    this._reindexing = false;
    this._lastReindexAt = 0;
    this.isShuttingDown = false;
    this.isShutdown = false;
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.isShutdown) return;
    this.isShuttingDown = true;
    const shutdownPromise = (async () => {
      const errors = [];
      const activeInit = this.initPromise;
      if (activeInit) {
        try {
          await activeInit;
        } catch (error) {
          errors.push(error);
          const logged = logMemoryDbDebug(this.logger, "MemoryDB.shutdown.activeInit", error, this.dbPath);
          const loggingOutcome = await settleSafeWarning(logged);
          if (!loggingOutcome.ok) errors.push(loggingOutcome.error);
        }
      }
      await this._drainPendingInitSettlements("shutdown");
      await this._drainPendingDebugSettlements();
      errors.push(...this._drainMemoryDbDiagnosticErrors());
      errors.push(...this.initCleanupErrors);
      this.initCleanupErrors = [];
      errors.push(...await this._closeHandles("shutdown"));
      try {
        this.directoryCapability?.close();
      } catch (error) {
        errors.push(error);
      } finally {
        this.directoryCapability = null;
      }
      this.initPromise = null;
      this.isShutdown = true;
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `MemoryDB shutdown failed for ${this.dbPath} (${errors.length} lifecycle error${errors.length === 1 ? "" : "s"})`,
        );
      }
    })();
    this.shutdownPromise = shutdownPromise;
    try {
      return await shutdownPromise;
    } finally {
      this.isShuttingDown = false;
      if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = null;
    }
  }

  async _acquireInitHandle(promise, label, kind, readOnly = this.readOnly) {
    try {
      return readOnly
        ? await this._read(promise, label)
        : await this._write(promise, label);
    } catch (error) {
      if (error instanceof TimeoutError && error.settlement) {
        error[INIT_LATE_HANDLE_KIND] = kind;
      }
      throw error;
    }
  }

  async _cleanupTimedOutInitHandles({
    rawStatus,
    rawValue,
    lateHandleKind,
    table,
    db,
  }) {
    const errors = [];
    const tables = new Set(table ? [table] : []);
    const connections = new Set(db ? [db] : []);
    let createdTable = null;

    if (rawStatus === "fulfilled") {
      if (lateHandleKind === "connection" && rawValue) connections.add(rawValue);
      if (lateHandleKind === "table" && rawValue) tables.add(rawValue);
      if (lateHandleKind === "created-table" && rawValue) {
        createdTable = rawValue;
        tables.add(rawValue);
      }
    }

    if (lateHandleKind === "created-table") {
      if (!createdTable && db) {
        try {
          const names = await db.tableNames();
          if (names.includes(TABLE_NAME)) {
            createdTable = await db.openTable(TABLE_NAME);
            tables.add(createdTable);
          }
        } catch (error) {
          errors.push(error);
        }
      }
      if (createdTable) {
        try {
          await createdTable.delete('id = "__schema__"');
        } catch (error) {
          errors.push(error);
        }
      }
    }

    for (const currentTable of tables) {
      try {
        if (typeof currentTable?.close === "function") await currentTable.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const connection of connections) {
      try {
        if (typeof connection?.close === "function") await connection.close();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  _deferTimedOutInitCleanup(error) {
    if (!(error instanceof TimeoutError) || !error.settlement) return false;
    const rawSettlement = error.settlement;
    const lateHandleKind = error[INIT_LATE_HANDLE_KIND] || null;
    const table = this.table;
    const db = this.db;
    this.table = null;
    this.db = null;
    this.schemaFieldNames = null;

    const completion = (async () => {
      let rawStatus = "fulfilled";
      let rawValue;
      let rawError;
      try {
        rawValue = await rawSettlement;
      } catch (settlementError) {
        rawStatus = "rejected";
        rawError = settlementError;
      }
      const cleanupErrors = await this._cleanupTimedOutInitHandles({
        rawStatus,
        rawValue,
        lateHandleKind,
        table,
        db,
      });
      return { rawStatus, rawValue, rawError, cleanupErrors };
    })();
    const settlement = completion.then((outcome) => {
      if (outcome.rawError && outcome.cleanupErrors.length > 0) {
        throw new AggregateError(
          [outcome.rawError, ...outcome.cleanupErrors],
          `MemoryDB timed-out initialization and late cleanup failed for ${this.dbPath}`,
        );
      }
      if (outcome.cleanupErrors.length > 0) {
        throw new AggregateError(
          outcome.cleanupErrors,
          `MemoryDB timed-out initialization cleanup failed for ${this.dbPath}`,
        );
      }
      if (outcome.rawError) throw outcome.rawError;
      return outcome.rawValue;
    });
    settlement.then(
      () => {},
      (settlementError) => {
        this._trackMemoryDbDebug("MemoryDB.init.lateSettlement", settlementError);
      },
    );
    const record = { completion };
    this.pendingInitSettlements.add(record);
    completion.then(
      (outcome) => {
        if (outcome.cleanupErrors.length === 0) this.pendingInitSettlements.delete(record);
      },
      (completionError) => {
        this._trackMemoryDbDebug("MemoryDB.init.cleanupCompletion", completionError);
      },
    );
    error.settlement = settlement;
    return true;
  }

  _trackMemoryDbDebug(scope, error) {
    const outcome = logMemoryDbDebug(this.logger, scope, error, this.dbPath);
    if (!outcome.ok) {
      this._recordMemoryDbDiagnosticError(outcome.error);
      return;
    }
    if (!outcome.pending) return;
    let pending;
    pending = (async () => {
      try {
        const settled = await settleSafeWarning(outcome);
        if (!settled.ok) this._recordMemoryDbDiagnosticError(settled.error);
      } catch (settlementError) {
        this._recordMemoryDbDiagnosticError(settlementError);
      } finally {
        this.pendingDebugSettlements.delete(pending);
      }
    })();
    this.pendingDebugSettlements.add(pending);
  }

  async _drainPendingDebugSettlements() {
    await Promise.allSettled([...this.pendingDebugSettlements]);
  }

  _recordMemoryDbDiagnosticError(error) {
    if (this.backgroundDiagnosticErrors.length < MAX_BACKGROUND_LIFECYCLE_ERRORS) {
      this.backgroundDiagnosticErrors.push(error);
      return;
    }
    this.backgroundDiagnosticErrorOverflow += 1;
  }

  _drainMemoryDbDiagnosticErrors() {
    const errors = this.backgroundDiagnosticErrors.splice(0, this.backgroundDiagnosticErrors.length);
    if (this.backgroundDiagnosticErrorOverflow > 0) {
      errors.push(new Error(
        `MemoryDB background diagnostic failures omitted (${this.backgroundDiagnosticErrorOverflow})`,
      ));
      this.backgroundDiagnosticErrorOverflow = 0;
    }
    return errors;
  }

  async _drainPendingInitSettlements(context) {
    const records = [...this.pendingInitSettlements];
    if (records.length === 0) return [];
    const outcomes = await Promise.all(records.map((record) => record.completion));
    for (const record of records) this.pendingInitSettlements.delete(record);
    const cleanupErrors = outcomes.flatMap((outcome) => outcome.cleanupErrors);
    if (cleanupErrors.length > 0) {
      const aggregate = new AggregateError(
        cleanupErrors,
        `MemoryDB ${context} blocked by timed-out initialization cleanup for ${this.dbPath}`,
      );
      this.initCleanupErrors.push(aggregate);
      return [aggregate];
    }
    return [];
  }

  async _closeHandles(_context) {
    const errors = [];
    const table = this.table;
    const db = this.db;
    try {
      if (table && typeof table.close === "function") {
        // Close is lifecycle settlement, not an ordinary DB write. A timeout
        // wrapper cannot abort it and must not let cleanup/retry run ahead.
        await table.close();
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (db && typeof db.close === "function") {
        await db.close();
      }
    } catch (error) {
      errors.push(error);
    } finally {
      this.table = null;
      this.db = null;
      this.schemaFieldNames = null;
    }
    return errors;
  }

  _read(promise, label) {
    return withTimeout(promise, LANCEDB_READ_TIMEOUT_MS, label);
  }

  _write(promise, label) {
    return withTimeout(promise, LANCEDB_WRITE_TIMEOUT_MS, label);
  }

  _assertWritable(operation) {
    if (this.readOnly) {
      throw new Error(`MemoryDB.${operation} rejected: database is read-only`);
    }
  }

  _assertTrustedPath() {
    if (this.isShuttingDown || this.isShutdown) {
      throw new Error(`MemoryDB is ${this.isShutdown ? "shutdown" : "shutting down"}: ${this.dbPath}`);
    }
    this.pathGuard?.();
    this.directoryCapability?.assertOpen();
  }

  _lancePath() {
    if (this.directoryCapability) return this.directoryCapability.path;
    if (this.secureDirectoryRequired) {
      throw new Error(`secure directory capability is unavailable for ${this.dbPath}`);
    }
    return this.dbPath;
  }

  _beforeLancePathOperation(operation) {
    this.beforeLanceOperation?.(operation, this.directoryCapability);
  }

  async refreshSchemaFields() {
    this._assertTrustedPath();
    if (!this.table) return;
    const schema = await this._read(this.table.schema(), "MemoryDB.schema");
    const fields = Array.isArray(schema?.fields) ? schema.fields : [];
    const textField = fields.find((field) => field.name === "text");
    if (!textField?.type) {
      throw new Error(`MemoryDB ownership schema verification failed: authoritative text field missing for ${this.dbPath}`);
    }
    // Utf8 vs. LargeUtf8 are both valid Arrow string types; LanceDB promotes a
    // column to LargeUtf8 once written values exceed the 32-bit offset range,
    // which happens routinely for `text` (long memory content) but not for
    // short id columns. Requiring bit-identical DataTypes here rejected
    // legitimate tables where `text` had been promoted but `agentId`/
    // `workspaceId` correctly stayed Utf8 — both are string-family, so both
    // are acceptable ownership-column types.
    const STRING_TYPES = new Set(["Utf8", "LargeUtf8"]);
    if (!STRING_TYPES.has(String(textField.type))) {
      throw new Error(`MemoryDB ownership schema verification failed: authoritative text field is not a string type for ${this.dbPath}`);
    }
    if (!this.readOnly) {
      for (const fieldName of ["agentId", "workspaceId"]) {
        const field = fields.find((candidate) => candidate.name === fieldName);
        if (!field || !STRING_TYPES.has(String(field.type))) {
          throw new Error(`MemoryDB ownership schema verification failed: ${fieldName} must match text DataType for ${this.dbPath}`);
        }
      }
    }
    this.schemaFieldNames = new Set(fields.map(f => f.name));
  }

  normalizeEntryForTable(entry) {
    const normalized = { ...entry, id: entry.id || randomUUID() };
    if (
      normalized.vector &&
      !Array.isArray(normalized.vector) &&
      typeof normalized.vector === "object"
    ) {
      normalized.vector = normalizeVectorValue(normalized.vector);
    }
    if (!normalized.type) normalized.type = "memory";
    if (typeof normalized.confirmed !== "boolean") normalized.confirmed = false;
    // All schema column defaults — LanceDB requires every field present on insert.
    // These cover both partial entries (e.g. reminders) and base memory fields.
    if (normalized.summary == null) normalized.summary = "";
    if (normalized.origin == null) normalized.origin = "dm";
    if (normalized.mergedFrom == null) normalized.mergedFrom = "[]";
    if (normalized.expiresAt == null) normalized.expiresAt = 0;
    if (normalized.agentId == null) normalized.agentId = "";
    if (normalized.storedBy == null) normalized.storedBy = "";
    if (normalized.sourceTurnId == null) normalized.sourceTurnId = "";
    if (normalized.sourceMessageRole == null) normalized.sourceMessageRole = "";
    if (normalized.sourceTimestamp == null) normalized.sourceTimestamp = 0;
    if (normalized.sourceUrl == null) normalized.sourceUrl = "";
    if (normalized.evidenceQuote == null) normalized.evidenceQuote = "";
    if (normalized.scope == null) normalized.scope = "agent-private";
    if (normalized.ownerUserId == null) normalized.ownerUserId = "";
    if (normalized.emotionalValence == null) normalized.emotionalValence = "";
    if (normalized.emotionalIntensity == null) normalized.emotionalIntensity = 0.0;
    if (normalized.emotionalDominant == null) normalized.emotionalDominant = "neutral";
    if (normalized.moodContextAtCapture == null) normalized.moodContextAtCapture = "";
    if (normalized.emotionStatus == null) normalized.emotionStatus = "final";
    normalized.importanceStatus = normalizeImportanceStatus(normalized.importanceStatus);
    if (normalized.replayCount == null) normalized.replayCount = 0;
    if (normalized.lastReplayed == null) normalized.lastReplayed = 0;
    if (normalized.retrievalCount == null) normalized.retrievalCount = 0;
    if (normalized.lastRetrievedAt == null) normalized.lastRetrievedAt = 0;
    if (normalized.memoryStrength == null) normalized.memoryStrength = 1.0;
    if (normalized.halfLifeDays == null) normalized.halfLifeDays = 30;
    if (normalized.lastStrengthenedAt == null) normalized.lastStrengthenedAt = 0;
    if (normalized.lastDynamicsAt == null) normalized.lastDynamicsAt = 0;
    if (normalized.memoryClass == null) normalized.memoryClass = "standard";
    if (normalized.neverForget == null) normalized.neverForget = 0;
    if (normalized.coreMemoryScore == null) normalized.coreMemoryScore = 0.0;
    if (normalized.coreMemoryReason == null) normalized.coreMemoryReason = "";
    if (normalized.versionNumber == null) normalized.versionNumber = 1;
    if (normalized.previousVersion == null) normalized.previousVersion = "";
    if (normalized.supersededBy == null) normalized.supersededBy = "";
    if (normalized.updateSource == null) normalized.updateSource = "";
    if (normalized.updateEvidence == null) normalized.updateEvidence = "";
    if (normalized.reconsolidationConfidence == null) normalized.reconsolidationConfidence = 0.0;
    if (normalized.status == null) normalized.status = "active";
    else if (normalized.status !== "") normalized.status = safeStatus(normalized.status);
    if (normalized.versionCreatedAt == null) normalized.versionCreatedAt = 0;
    if (normalized.updatedAt == null) normalized.updatedAt = 0;
    // createdAt war als einziges Zeitfeld ohne Default. Ein Writer, der es
    // vergisst, würde eine Zeile ohne Alter erzeugen, die im Recall dauerhaft
    // als age="unknown" erscheint. Jetzt-Zeitpunkt ist die einzig sinnvolle
    // Näherung für eine gerade entstehende Zeile.
    if (normalized.createdAt == null) normalized.createdAt = Date.now();
    if (normalized.workspaceId == null) normalized.workspaceId = "";
    if (normalized.workspaceKey == null) normalized.workspaceKey = "";
    if (normalized.memoryKind == null) normalized.memoryKind = "memory";
    if (normalized.reminderStatus == null) normalized.reminderStatus = "";
    if (normalized.remindAt == null) normalized.remindAt = 0;
    if (normalized.remindedAt == null) normalized.remindedAt = 0;
    if (normalized.dispatchedAt == null) normalized.dispatchedAt = 0;
    if (normalized.acknowledgedAt == null) normalized.acknowledgedAt = 0;
    if (normalized.cancelledAt == null) normalized.cancelledAt = 0;
    if (normalized.reminderKey == null) normalized.reminderKey = "";
    if (normalized.dispatchCount == null) normalized.dispatchCount = 0;
    if (normalized.lastDispatchAttemptAt == null) normalized.lastDispatchAttemptAt = 0;
    if (normalized.nextDispatchAttemptAt == null) normalized.nextDispatchAttemptAt = 0;
    if (normalized.epistemicStatus == null) normalized.epistemicStatus = "";
    if (normalized.epistemicStatusUpdatedAt == null) normalized.epistemicStatusUpdatedAt = 0;
    if (normalized.epistemicStatusActor == null) normalized.epistemicStatusActor = "";
    if (normalized.epistemicStatusReason == null) normalized.epistemicStatusReason = "";
    if (normalized.previousEpistemicStatus == null) normalized.previousEpistemicStatus = "";
    // Phase 2 — Bi-Temporal Memory. `0` = "no known bound in that direction",
    // never derived from createdAt/updatedAt (see lib/valid-time.js).
    if (normalized.validFrom == null) normalized.validFrom = 0;
    if (normalized.validUntil == null) normalized.validUntil = 0;
    if (!this.schemaFieldNames) return normalized;
    const filtered = {};
    for (const [key, value] of Object.entries(normalized)) {
      if (this.schemaFieldNames.has(key)) filtered[key] = value;
    }
    return filtered;
  }

  async init() {
    this._assertTrustedPath();
    if (this.initPromise) return this.initPromise;
    const generationPromise = (async () => {
      try {
        await this._drainPendingInitSettlements("retry");
        await this._drainPendingDebugSettlements();
        if (this.initCleanupErrors.length > 0) {
          throw new AggregateError(
            [...this.initCleanupErrors],
            `MemoryDB initialization blocked by prior cleanup failure for ${this.dbPath}`,
          );
        }
        this._assertTrustedPath();
        if (this.readOnly && this.secureDirectoryRequired && !this.directoryCapability) return false;
        if (this.readOnly && !this.secureDirectoryRequired && !existsSync(this.dbPath)) return false;
        const lancedb = this.lancedbProvider ? await this.lancedbProvider() : await getLanceDB();
        this._assertTrustedPath();
        this._beforeLancePathOperation("connect");
        const lancePath = this._lancePath();
        this.db = await this._acquireInitHandle(
          // Strong read consistency: without an interval a LanceDB table
          // object keeps the version it was opened with, so rows written
          // through another handle (memory_store in the gateway, another
          // process) stay invisible to it. On OpenClaw 2026.8.2 the gateway's
          // rem-dream reader missed three rows committed eight seconds
          // earlier for more than two minutes; a fresh process saw them
          // after 1.3 s. Zero checks the latest version on every read.
          lancedb.connect(lancePath, { readConsistencyInterval: 0 }),
          "MemoryDB.connect",
          "connection",
        );
      this._assertTrustedPath();
      const tables = await this._read(this.db.tableNames(), "MemoryDB.tableNames");
      if (tables.includes(TABLE_NAME)) {
        this._assertTrustedPath();
        this._beforeLancePathOperation("openTable");
        this.table = await this._acquireInitHandle(
          this.db.openTable(TABLE_NAME),
          "MemoryDB.openTable",
          "table",
        );
        this._assertTrustedPath();
        if (this.readOnly) {
          await this.refreshSchemaFields();
          return true;
        }
        // Migrate: add missing columns
        // Statt eines großen try/catch: Schema einmal lesen, dann pro Spalte
        // einzeln migrieren. So verhindert ein Fehler bei einer Spalte nicht
        // die Migration der übrigen.
        const schema = await this._read(this.table.schema(), "MemoryDB.schema");

        if (schema) {
          const textField = schema.fields?.find((field) => field.name === "text");
          if (!textField?.type) {
            throw new Error(`MemoryDB ownership migration failed: authoritative text field missing for ${this.dbPath}`);
          }
          const allColumns = [
            { name: 'summary', valueSql: "''" },
            { name: 'origin', valueSql: "'dm'" },
            { name: 'mergedFrom', valueSql: "'[]'" },
            { name: 'expiresAt', valueSql: '0' },
            { name: 'agentId', type: textField.type, valueSql: "''", securityCritical: true },
            { name: 'storedBy', valueSql: "''" },
            { name: 'sourceTurnId', valueSql: "''" },
            { name: 'sourceMessageRole', valueSql: "''" },
            { name: 'sourceTimestamp', valueSql: '0' },
            { name: 'sourceUrl', valueSql: "''" },
            { name: 'evidenceQuote', valueSql: "''" },
            { name: 'scope', valueSql: "'agent-private'" },
            { name: 'ownerUserId', valueSql: "''" },
            { name: 'type', valueSql: "'memory'" },
            { name: 'confirmed', valueSql: 'false' },
            { name: 'emotionalValence', valueSql: "''" },
            { name: 'emotionalIntensity', valueSql: '0.0' },
            { name: 'emotionalDominant', valueSql: "'neutral'" },
            { name: 'moodContextAtCapture', valueSql: "''" },
            // 7.12.22: Bestand gilt als fertig klassifiziert; nur neue Zeilen
            // aus dem entkoppelten Capture stehen auf pending_t3.
            { name: 'emotionStatus', valueSql: "'final'" },
            // Bestand gilt als geklaert; Phase 1 der Migration setzt ihn
            // ausdruecklich auf pending_backfill.
            { name: 'importanceStatus', valueSql: "'final'" },
            { name: 'replayCount', valueSql: '0' },
            { name: 'lastReplayed', valueSql: '0' },
            { name: 'retrievalCount', valueSql: '0' },
            { name: 'lastRetrievedAt', valueSql: '0' },
            { name: 'memoryStrength', valueSql: '1.0' },
            { name: 'halfLifeDays', valueSql: '30' },
            { name: 'lastStrengthenedAt', valueSql: '0' },
            { name: 'lastDynamicsAt', valueSql: '0' },
            { name: 'memoryClass', valueSql: "'standard'" },
            { name: 'neverForget', valueSql: '0' },
            { name: 'coreMemoryScore', valueSql: '0.0' },
            { name: 'coreMemoryReason', valueSql: "''" },
            { name: 'versionNumber', valueSql: '1' },
            { name: 'previousVersion', valueSql: "''" },
            { name: 'supersededBy', valueSql: "''" },
            { name: 'updateSource', valueSql: "''" },
            { name: 'updateEvidence', valueSql: "''" },
            { name: 'reconsolidationConfidence', valueSql: '0.0' },
            { name: 'status', valueSql: "'active'" },
            { name: 'versionCreatedAt', valueSql: '0' },
            { name: 'updatedAt', valueSql: '0' },
            { name: 'memoryKind', valueSql: "'memory'" },
            { name: 'reminderStatus', valueSql: "''" },
            { name: 'remindAt', valueSql: '0' },
            { name: 'remindedAt', valueSql: '0' },
            { name: 'dispatchedAt', valueSql: '0' },
            { name: 'acknowledgedAt', valueSql: '0' },
            { name: 'cancelledAt', valueSql: '0' },
            { name: 'reminderKey', valueSql: "''" },
            { name: 'dispatchCount', valueSql: '0' },
            { name: 'lastDispatchAttemptAt', valueSql: '0' },
            { name: 'nextDispatchAttemptAt', valueSql: '0' },
            { name: 'workspaceId', type: textField.type, valueSql: "''", securityCritical: true },
            { name: 'workspaceKey', valueSql: "''" },
            // Phase 1 — Explicit Trust State (epistemicStatus). See
            // lib/epistemic-status.js for the enum/matrix; absent/'' means
            // "legacy, resolves conservatively" (see plan §5), never "trusted".
            { name: 'epistemicStatus', valueSql: "''" },
            { name: 'epistemicStatusUpdatedAt', valueSql: '0' },
            { name: 'epistemicStatusActor', valueSql: "''" },
            { name: 'epistemicStatusReason', valueSql: "''" },
            { name: 'previousEpistemicStatus', valueSql: "''" },
            // Phase 2 — Bi-Temporal Memory (validFrom/validUntil). See
            // lib/valid-time.js for the semantics; `0` = "no known bound in
            // that direction", not the Unix epoch.
            { name: 'validFrom', valueSql: '0' },
            { name: 'validUntil', valueSql: '0' },
            // 7.12.70 chunking: '' = not split. db-adapter's ensureChunkColumns
            // adds the same column through its own handle; a table MemoryDB
            // created without it then refused every later append from this
            // instance ("missing=[chunkGroupId]", E1 Task 8 fix round 1).
            { name: 'chunkGroupId', valueSql: "''" },
          ];

          for (const col of allColumns) {
            const hasCol = schema.fields.some(f => f.name === col.name);
            if (hasCol) continue;
            if (col.securityCritical) {
              const { securityCritical: _securityCritical, ...column } = col;
              await this._write(this.table.addColumns([column]), `MemoryDB.addColumns:${col.name}`);
              continue;
            }
            try {
              await this._write(this.table.addColumns([col]), `MemoryDB.addColumns:${col.name}`);
            } catch (e) {
              if (e instanceof TimeoutError) throw e;
              console.error(`[memory-lancedb-namespaced] migration error for column '${col.name}' in ${this.dbPath}: ${e.message}`);
            }
          }
        }
      } else if (this.readOnly) {
        const cleanupErrors = await this._closeHandles("read-only-missing-table");
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            cleanupErrors,
            `MemoryDB read-only missing-table cleanup failed for ${this.dbPath}`,
          );
        }
        return false;
      } else {
        this._assertTrustedPath();
        this._beforeLancePathOperation("createTable");
        this.table = await this._acquireInitHandle(this.db.createTable(TABLE_NAME, [
          {
            id: "__schema__",
            type: "memory",
            confirmed: false,
            text: "",
            summary: "",
            origin: "dm",
            vector: Array(this.vectorDim).fill(0),
            importance: 0,
            category: "other",
            createdAt: 0,
            mergedFrom: "[]",
            expiresAt: 0,
            agentId: "",
            storedBy: "",
            sourceTurnId: "",
            sourceMessageRole: "",
            sourceTimestamp: 0,
            sourceUrl: "",
            evidenceQuote: "",
            scope: "agent-private",
            ownerUserId: "",
            emotionalValence: "",
            emotionalIntensity: 0,
            emotionalDominant: "neutral",
            moodContextAtCapture: "",
            emotionStatus: "final",
            importanceStatus: "final",
            replayCount: 0,
            lastReplayed: 0,
            retrievalCount: 0,
            lastRetrievedAt: 0,
            memoryStrength: 1.0,
            halfLifeDays: 180,
            lastStrengthenedAt: 0,
            lastDynamicsAt: 0,
            memoryClass: "standard",
            neverForget: 0,
            coreMemoryScore: 0.0,
            coreMemoryReason: "",
            versionNumber: 1,
            previousVersion: "",
            supersededBy: "",
            updateSource: "",
            updateEvidence: "",
            reconsolidationConfidence: 0.0,
            status: "active",
            versionCreatedAt: 0,
            updatedAt: 0,
            workspaceId: "",
            workspaceKey: "",
            memoryKind: "memory",
            reminderStatus: "",
            remindAt: 0,
            remindedAt: 0,
            dispatchedAt: 0,
            acknowledgedAt: 0,
            cancelledAt: 0,
            reminderKey: "",
            dispatchCount: 0,
            lastDispatchAttemptAt: 0,
            nextDispatchAttemptAt: 0,
            // Phase 1 — Explicit Trust State (epistemicStatus). See
            // lib/epistemic-status.js for the enum/matrix; absent/'' means
            // "legacy, resolves conservatively" (see plan §5), never "trusted".
            epistemicStatus: "",
            epistemicStatusUpdatedAt: 0,
            epistemicStatusActor: "",
            epistemicStatusReason: "",
            previousEpistemicStatus: "",
            // Phase 2 — Bi-Temporal Memory (validFrom/validUntil). See
            // lib/valid-time.js for the semantics; `0` = "no known bound in
            // that direction", not the Unix epoch.
            validFrom: 0,
            validUntil: 0,
            // 7.12.70 chunking; see the migration list above.
            chunkGroupId: "",
          },
        ]), "MemoryDB.createTable", "created-table", false);
      }
        if (!this.readOnly) {
          this._assertTrustedPath();
          // A prior process may have stopped after table creation but before
          // deleting the bootstrap row. Recovery is safe and idempotent.
          await this._write(this.table.delete('id = "__schema__"'), "MemoryDB.deleteSchemaRow");
        }
        await this.refreshSchemaFields();
      } catch (error) {
        if (this._deferTimedOutInitCleanup(error)) throw error;
        const cleanupErrors = await this._closeHandles("failed-init");
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            `MemoryDB initialization and cleanup failed for ${this.dbPath}`,
          );
        }
        throw error;
      }
    })();
    this.initPromise = generationPromise;
    try {
      const initialized = await generationPromise;
      if (initialized === false && this.initPromise === generationPromise) {
        // A read-only namespace may legitimately appear after this non-mutating
        // probe. Keep concurrent callers coalesced for this generation, but do
        // not turn an absent table into a process-lifetime negative cache.
        this.initPromise = null;
      }
      return initialized;
    } catch (error) {
      if (this.initPromise === generationPromise) this.initPromise = null;
      throw error;
    }
  }

  async store(entry) {
    this._assertWritable("store");
    await this.init();
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    const summary = typeof entry?.summary === "string" ? entry.summary.trim() : "";
    if (!text && !summary) {
      throw new Error("store() rejected: entry text and summary are both empty — refusing to store a memory without content.");
    }
    if (entry && (entry.epistemicStatus == null || entry.epistemicStatus === "")) {
      entry.epistemicStatus = coerceNewWriteEpistemicStatus(entry.epistemicStatus);
    }
    // Seit 7.12.70 fuehrt die Tabelle die Spalte chunkGroupId. Fehlt sie in
    // einer geschriebenen Zeile, weicht der Append vom Schema ab und LanceDB
    // lehnt ihn ab ("Append with different schema: missing=[chunkGroupId]") —
    // und zwar fuer JEDEN Schreiber, nicht nur fuer das Capture. Acht Stellen
    // bauen Zeilen aus expliziten Feldlisten; der Standardwert gehoert deshalb
    // hierher, an dieselbe Stelle, an der schon epistemicStatus nachgezogen
    // wird. Leer heisst "nicht aufgeteilt"; wer eine Gruppe hat, behaelt sie.
    if (entry && entry.chunkGroupId == null) entry.chunkGroupId = "";
    const { baseDbPath, agentId } = splitAgentDbPath(this.dbPath);
    const cutoffState = readEpistemicCutoff(baseDbPath);
    if (
      (cutoffState.reason === "cutoff_missing_after_upgrade" || cutoffState.reason === "cutoff_read_error")
      && entry.epistemicStatus === "observed"
    ) {
      entry.epistemicStatus = "untrusted";
    }
    const guard = assertCardWriteAllowed({
      baseDbPath,
      agentId: entry.agentId || entry.storedBy || agentId,
      text: text || summary,
      scope: entry.scope || "agent-private",
      workspaceIdentity: entry.workspaceId || entry.workspaceKey || "",
      ownerUserId: entry.ownerUserId || "",
    });
    if (!guard.allowed) {
      const error = new Error("tombstone_blocked");
      error.action = "tombstone_blocked";
      error.reason = "tombstone_blocked";
      throw error;
    }
    await this._write(this.table.add([this.normalizeEntryForTable(entry)]), "MemoryDB.store");
    this._writeCounter++;
    if (this._writeCounter % REINDEX_WRITE_THRESHOLD === 0) {
      this._maybeReindex().catch((err) => {
        this.logger?.warn?.(`memory-lancedb-namespaced: reindex scheduling failed: ${String(err)}`);
      });
    }
  }

  /**
   * Lädt die letzten N Memories für Graph-Edge-Building.
   * @param {Object} opts
   * @param {number} opts.limit — max Rows (default 100)
   * @param {string} [opts.sessionId] — optional Session-ID für temporal Filter
   * @param {boolean} [opts.includeGlobalRecent] — auch session-übergreifende laden
   * @param {string[]} [opts.fields] — Felder, die benötigt werden
   */
  /**
   * where-Klausel für den Graph-Scan, gebaut aus dem LIVE-Schema.
   *
   * Eine feste Klausel bricht, sobald eine referenzierte Spalte fehlt, und der
   * `catch` unten liefert dann stilles `[]` — `recentExisting` bliebe leer und
   * buildEdgesForSession verbände neue Erinnerungen nur untereinander, nie mit
   * dem Bestand. `epistemicStatus` fehlt auf allen produktiven Tabellen, bis das
   * Release die Spalte migriert; im readOnly-Modus wird die Migration ohnehin
   * übersprungen (siehe init).
   *
   * `epistemicStatus` zusätzlich NULL-sicher: `!= 'invalidated'` allein ist in
   * SQL dreiwertig und verwürfe Zeilen ohne gesetzten Wert.
   */
  _buildRecentGraphWhere() {
    const felder = this.schemaFieldNames;
    const hat = (name) => !felder || felder.size === 0 || felder.has(name);
    const teile = [];
    if (hat("memoryKind")) teile.push("(memoryKind = 'memory' OR memoryKind IS NULL OR memoryKind = '')");
    if (hat("status")) teile.push("(status IS NULL OR status = 'active' OR status = '')");
    if (hat("epistemicStatus")) teile.push("(epistemicStatus IS NULL OR epistemicStatus != 'invalidated')");
    return teile.length > 0 ? teile.join(" AND ") : "true";
  }

  async getRecentForGraph({ limit = 100, sessionId = "", includeGlobalRecent = true, fields = null } = {}) {
    await this.init();
    if (!this.table) return [];
    try {
      let rows = await this._read(
        this.table.query()
          .where(this._buildRecentGraphWhere())
          .limit(limit * 2)
          .toArray(),
        "MemoryDB.getRecentForGraph",
      );

      // Sort by createdAt DESC
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      // If includeGlobalRecent: take top N regardless of session
      // If not: filter to same session first, fill rest with global
      if (sessionId && !includeGlobalRecent) {
        rows = rows.filter(r => r.sessionId === sessionId || r.sourceTurnId?.startsWith(sessionId));
      } else if (sessionId) {
        const sameSession = rows.filter(r => r.sessionId === sessionId || r.sourceTurnId?.startsWith(sessionId));
        const other = rows.filter(r => r.sessionId !== sessionId && !r.sourceTurnId?.startsWith(sessionId));
        rows = [...sameSession, ...other].slice(0, limit);
      }

      rows = rows.slice(0, limit);

      if (fields && Array.isArray(fields)) {
        return rows.map(r => {
          const obj = { id: r.id };
          for (const f of fields) {
            obj[f] = r[f];
          }
          return obj;
        });
      }
      return rows;
    } catch (e) {
      // Nicht stumm: ein leeres Ergebnis hier bedeutet, dass der Graph-Aufbau
      // keine Bestandserinnerungen sieht — das darf nicht unbemerkt bleiben.
      this.logger?.warn?.(`memory-lancedb-namespaced: getRecentForGraph failed for ${this.dbPath}: ${String(e?.message || e)}`);
      return [];
    }
  }

  async _maybeReindex() {
    this._assertWritable("reindex");
    this._assertTrustedPath();
    if (this._reindexing) return;
    // v6.2.1 — Zeitbasiertes Intervall enforce (P0-Fix)
    if (Date.now() - this._lastReindexAt < REINDEX_MIN_INTERVAL_MS) return;
    this._reindexing = true;
    try {
      const count = await this._read(this.table.countRows(), "MemoryDB.countRows");
      if (count < REINDEX_MIN_ROWS) return;
      const lance = await getLanceDB();
      await this._write(this.table.createIndex("vector", {
        config: lance.Index.hnswPq({ m: 16, efConstruction: 100, numSubVectors: 96 }),
        replace: true,
      }), "MemoryDB.createIndex");
      // v6.2.1 — Counter reset nach erfolgreichem Reindex (P0-Fix)
      this._writeCounter = 0;
      this._lastReindexAt = Date.now();
    } catch (err) {
      // Non-fatal: falls back to flat scan if reindex fails
      this.logger?.warn?.(`memory-lancedb-namespaced: reindex failed; falling back to flat scan: ${String(err)}`);
    } finally {
      this._reindexing = false;
    }
  }

  async search(vector, limit = 5, minScore = 0.3) {
    await this.init();
    const count = await this._read(this.table.countRows(), "MemoryDB.search.countRows");
    if (count === 0) return [];
    const results = await this.vectorSearchActive(vector, limit);
    const mapped = results.map((r) => ({
      entry: {
        id: r.id,
        type: r.type || "memory",
        confirmed: r.confirmed === true,
        text: r.text,
        summary: r.summary || "",
        origin: r.origin || "dm",
        category: r.category,
        importance: r.importance ?? 0.5,
        createdAt: r.createdAt,
        sourceUrl: r.sourceUrl || "",
        evidenceQuote: r.evidenceQuote || "",
        scope: r.scope || "agent-private",
        ownerUserId: r.ownerUserId || "",
        storedBy: r.storedBy || "",
        workspaceKey: r.workspaceKey || "",
        agentId: r.agentId || r.storedBy || "",
        workspaceId: r.workspaceId || r.workspaceKey || "",
        emotionalValence: deserializeEmotionalValence(r.emotionalValence),
        emotionalIntensity: r.emotionalIntensity ?? 0,
        emotionalDominant: r.emotionalDominant || "neutral",
        moodContextAtCapture: deserializeEmotionalValence(r.moodContextAtCapture),
        emotionStatus: r.emotionStatus || "final",
        replayCount: r.replayCount ?? 0,
        lastReplayed: r.lastReplayed ?? 0,
        retrievalCount: r.retrievalCount ?? 0,
        lastRetrievedAt: r.lastRetrievedAt ?? 0,
        memoryStrength: r.memoryStrength ?? 1.0,
        halfLifeDays: r.halfLifeDays ?? resolveHalfLifeDays(r.category, r.memoryClass, this.halfLifeOverrides),
        lastStrengthenedAt: r.lastStrengthenedAt ?? 0,
        lastDynamicsAt: r.lastDynamicsAt ?? 0,
        memoryClass: r.memoryClass || "standard",
        neverForget: r.neverForget ?? 0,
        coreMemoryScore: r.coreMemoryScore ?? 0.0,
        coreMemoryReason: r.coreMemoryReason || "",
        versionNumber: r.versionNumber ?? 1,
        previousVersion: r.previousVersion || "",
        supersededBy: r.supersededBy || "",
        updateSource: r.updateSource || "",
        updateEvidence: r.updateEvidence || "",
        reconsolidationConfidence: r.reconsolidationConfidence ?? 0.0,
        status: r.status || "active",
        versionCreatedAt: r.versionCreatedAt ?? 0,
        updatedAt: r.updatedAt ?? 0,
        memoryKind: r.memoryKind || "memory",
        reminderStatus: r.reminderStatus || "",
        remindAt: r.remindAt ?? 0,
        remindedAt: r.remindedAt ?? 0,
        dispatchedAt: r.dispatchedAt ?? 0,
        acknowledgedAt: r.acknowledgedAt ?? 0,
        cancelledAt: r.cancelledAt ?? 0,
        reminderKey: r.reminderKey || "",
        dispatchCount: r.dispatchCount ?? 0,
        lastDispatchAttemptAt: r.lastDispatchAttemptAt ?? 0,
        nextDispatchAttemptAt: r.nextDispatchAttemptAt ?? 0,
        epistemicStatus: r.epistemicStatus || "",
      },
      score: distanceToScore(r._distance),
    }));
    return mapped.filter((r) => r.score >= minScore);
  }

  async findSimilar(vector, text, threshold = 0.95) {
    await this.init();
    const count = await this._read(this.table.countRows(), "MemoryDB.findSimilar.countRows");
    if (count === 0) return [];
    const results = await this.vectorSearchActive(vector, 10);
    return results
      .filter((r) => {
        const score = distanceToScore(r._distance);
        return score >= threshold || r.text === text;
      })
      .map((r) => ({ entry: r, score: distanceToScore(r._distance) }));
  }

  async findMergeCandidate(vector, mergeThreshold, duplicateThreshold) {
    await this.init();
    const count = await this._read(this.table.countRows(), "MemoryDB.findMergeCandidate.countRows");
    if (count === 0) return null;
    const results = await this.vectorSearchActive(vector, 5);
    const candidates = results
      .map(r => ({
        entry: {
          id: r.id,
          text: r.text,
          importance: r.importance ?? 0.5,
          agentId: r.agentId || "",
          storedBy: r.storedBy || "",
          workspaceId: r.workspaceId || "",
          workspaceKey: r.workspaceKey || "",
          scope: r.scope || "agent-private",
          ownerUserId: r.ownerUserId || "",
          epistemicStatus: r.epistemicStatus || "",
          epistemicStatusActor: r.epistemicStatusActor || "",
          epistemicStatusReason: r.epistemicStatusReason || "",
          epistemicStatusUpdatedAt: r.epistemicStatusUpdatedAt ?? 0,
          previousEpistemicStatus: r.previousEpistemicStatus || "",
          validFrom: r.validFrom ?? 0,
          validUntil: r.validUntil ?? 0,
        },
        score: distanceToScore(r._distance),
      }))
      .filter(r => r.score >= mergeThreshold && r.score < duplicateThreshold)
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  async vectorSearchActive(vector, limit) {
    this._assertTrustedPath();
    const fetchLimit = Math.max(limit, Math.min(limit * 3, 100));
    try {
      const builder = this.table.vectorSearch(vector);
      if (typeof builder.where === "function") {
        // (status = 'active' OR status IS NULL) parenthesized on its own —
        // AND binds tighter than OR in SQL, so appending the epistemicStatus
        // clause unparenthesized here would let an invalidated row with
        // status='active' through.
        return await this._read(builder.where("(status = 'active' OR status IS NULL) AND epistemicStatus != 'invalidated'").limit(limit).toArray(), "MemoryDB.vectorSearchActive");
      }
    } catch (err) {
      // Older LanceDB/query-builder surfaces and old schemas fall back here.
      // Timeouts must not be swallowed by the fallback path.
      if (err instanceof TimeoutError) throw err;
    }
    const rows = await this._read(this.table.vectorSearch(vector).limit(fetchLimit).toArray(), "MemoryDB.vectorSearchActive.fallback");
    return rows.filter((row) => (!row.status || row.status === "active") && row.epistemicStatus !== "invalidated").slice(0, limit);
  }

  /**
   * Audit-Recovery-Suche: findet bereits soft-deleted Zeilen (status="deleted").
   * Nur für die Idempotenz-/Audit-Recovery des memory_forget-Query-Pfads gedacht —
   * normale Suche verwendet ausschließlich vectorSearchActive. Bewertet
   * `_distance` exakt wie `search()` und filtert nach `minScore`. Liefert nur
   * IDs + Score, niemals Klartext gelöschter Inhalte.
   */
  async searchDeleted(vector, limit, minScore = 0.3) {
    this._assertTrustedPath();
    await this.init();
    const count = await this._read(this.table.countRows(), "MemoryDB.searchDeleted.countRows");
    if (count === 0) return [];
    const fetchLimit = Math.max(limit, Math.min(limit * 3, 100));
    let rows = null;
    try {
      const builder = this.table.vectorSearch(vector);
      if (typeof builder.where === "function") {
        rows = await this._read(builder.where("status = 'deleted'").limit(limit).toArray(), "MemoryDB.searchDeleted");
      }
    } catch (err) {
      if (err instanceof TimeoutError) throw err;
    }
    if (rows === null) {
      rows = await this._read(this.table.vectorSearch(vector).limit(fetchLimit).toArray(), "MemoryDB.searchDeleted.fallback");
    }
    return (rows || [])
      .filter((row) => row.status === "deleted")
      .map((row) => ({ id: row.id, score: distanceToScore(row._distance) }))
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  }

  async delete(id) {
    this._assertWritable("delete");
    await this.init();
    // safeUuid wirft Error wenn id nicht exakt UUID-Format hat
    const safe = safeUuid(id);
    await this._write(this.table.delete(`id = "${safe}"`), `MemoryDB.delete:${safe}`);
  }

  /**
   * Kanonischer Tombstone-Vorgang (soft-delete statt physischer Löschung).
   * Setzt `status="deleted"` und `epistemicStatus="invalidated"`; die Zeile
   * bleibt erhalten (Fingerprint/Audit), ist aber aus Active-Scans ausgeschlossen.
   *
   * @param {string} id
   * @param {object} [patch] zusätzliche Spaltenwerte
   * @returns {Promise<{ok: boolean, id: string, alreadyTombstoned?: boolean, notFound?: boolean}>}
   */
  async tombstone(id, patch = {}) {
    this._assertWritable("tombstone");
    await this.init();
    const safe = safeUuid(id);
    const rows = await this._read(this.table.query().where(`id = "${safe}"`).limit(1).toArray(), `MemoryDB.tombstone.query:${safe}`);
    if (!rows || rows.length === 0) {
      return { ok: false, notFound: true, id: safe };
    }
    if (String(rows[0].status || "") === "deleted") {
      return { ok: true, alreadyTombstoned: true, id: safe };
    }
    const values = { ...(patch || {}) };
    values.status = safeStatus("deleted");
    values.epistemicStatus = "invalidated";
    await this._write(this.table.update({ where: `id = "${safe}"`, values }), `MemoryDB.tombstone:${safe}`);
    return { ok: true, id: safe };
  }

  async getById(id) {
    await this.init();
    const safe = safeUuid(id);
    const rows = await this._read(this.table.query().where(`id = "${safe}"`).limit(1).toArray(), `MemoryDB.getById:${safe}`);
    return rows && rows.length > 0 ? rows[0] : null;
  }

  async update(id, patch) {
    this._assertWritable("update");
    await this.init();
    const safe = safeUuid(id);
    const rows = await this._read(this.table.query().where(`id = "${safe}"`).limit(1).toArray(), `MemoryDB.update.query:${safe}`);
    if (!rows || rows.length === 0) {
      throw new Error(`Memory not found: ${id}`);
    }
    const existing = rows[0];
    const patchObject = patch && typeof patch === "object" ? patch : {};
    if (isContentChangingUpdate(existing, patchObject)) {
      const { baseDbPath, agentId } = splitAgentDbPath(this.dbPath);
      const nextText = Object.hasOwn(patchObject, "text") ? patchObject.text : existing.text;
      const guard = assertCardWriteAllowed({
        baseDbPath,
        agentId: existing.agentId || existing.storedBy || agentId,
        text: nextText || patchObject.summary || existing.summary || "",
        scope: existing.scope || "agent-private",
        workspaceIdentity: existing.workspaceId || existing.workspaceKey || "",
        ownerUserId: existing.ownerUserId || "",
      });
      if (!guard.allowed) {
        const error = new Error("tombstone_blocked");
        error.action = "tombstone_blocked";
        error.reason = "tombstone_blocked";
        throw error;
      }
    }
    // Statusvalidierung: unbekannte Statuswerte dürfen nie gespeichert werden.
    if (Object.hasOwn(patchObject, "status") && patchObject.status !== "") {
      patchObject.status = safeStatus(patchObject.status);
    }
    const schemaFields = this.schemaFieldNames || new Set(Object.keys(existing));
    if (typeof this.table.update === "function") {
      const values = {};
      for (const [key, value] of Object.entries(patchObject)) {
        if (key === "id" || !schemaFields.has(key)) continue;
        values[key] = key === "vector" ? normalizeVectorValue(value) : value;
      }
      if (Object.keys(values).length > 0) {
        await this._write(
          this.table.update({ where: `id = "${safe}"`, values }),
          `MemoryDB.update.inPlace:${safe}`,
        );
      }
      return;
    }

    const updated = { ...existing, ...patchObject, id: existing.id };
    const normalizedUpdated = this.normalizeEntryForTable(updated);
    await this._write(this.table.delete(`id = "${safe}"`), `MemoryDB.update.delete:${safe}`);
    try {
      await this._write(this.table.add([normalizedUpdated]), `MemoryDB.update.add:${safe}`);
    } catch (addErr) {
      // delete+add ist nicht atomar — wenn das add fehlschlägt, würde die Row
      // verloren gehen. Best-effort: das Original wiederherstellen, dann den
      // Fehler weiterreichen.
      try {
        await this._write(this.table.add([this.normalizeEntryForTable(existing)]), `MemoryDB.update.restore:${safe}`);
      } catch (restoreErr) {
        this.logger?.warn?.(
          `memory-lancedb-namespaced: MemoryDB.update restore failed dbPath=${this.dbPath} id=${safe}: ${String(restoreErr)}`,
        );
        throw new AggregateError(
          [addErr, restoreErr],
          `MemoryDB.update replacement and restore failed for ${safe} at ${this.dbPath}`,
        );
      }
      throw addErr;
    }
  }

  normalizeActiveScanRow(r) {
    return {
      id: r.id,
      type: r.type || "memory",
      vector: (Array.isArray(r.vector) && r.vector.length > 0) ? r.vector : null,
      text: r.text || "",
      summary: r.summary || "",
      category: r.category || "",
      importance: r.importance ?? 0.5,
      createdAt: r.createdAt || "",
      scope: r.scope || "agent-private",
      agentId: r.agentId || "",
      storedBy: r.storedBy || "",
      workspaceId: r.workspaceId || "",
      workspaceKey: r.workspaceKey || "",
      memoryKind: r.memoryKind ?? "memory",
      ownerUserId: r.ownerUserId || "",
      status: r.status || "active",
      updatedAt: r.updatedAt ?? 0,
      versionCreatedAt: r.versionCreatedAt ?? 0,
      sourceTimestamp: r.sourceTimestamp ?? 0,
      // Carry protection flags so GC can honor the neverForget/core contract.
      neverForget: r.neverForget,
      memoryClass: r.memoryClass,
    };
  }

  // Scan-Spalten sind für Active- und Collectable-Scan identisch.
  _buildScanQuery(statusWhere) {
    this._assertTrustedPath();
    let query = this.table.query().where(statusWhere);
    if (typeof query.select === "function") {
      query = query.select([
        "id", "type", "vector", "text", "summary", "category", "importance", "createdAt",
        "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "memoryKind", "ownerUserId", "status",
        "updatedAt", "versionCreatedAt", "sourceTimestamp", "neverForget", "memoryClass",
      ]);
    }
    return query;
  }

  buildActiveScanQuery() {
    // Fail-closed Whitelist: NUR "active" (oder legacy NULL/leer) gilt als aktiv.
    // Ein unbekannter/falsch geschriebener Status (z. B. "archvied") wird NICHT
    // als aktiv interpretiert. (Vorher: Negativliste != deleted/archived, die
    // jeden Tippfehler als aktiv durchließ.)
    //
    // `superseded` ist hier bewusst NICHT enthalten: Recall, Shared Search und
    // die Vault-Notizen sollen keine überholten Fassungen sehen. Der GC braucht
    // sie trotzdem — dafür gibt es buildCollectableScanQuery().
    return this._buildScanQuery("status IS NULL OR status = 'active' OR status = ''");
  }

  /**
   * Scan für die Garbage Collection: alles, was noch Platz belegt und noch nicht
   * archiviert oder getombsteint ist — also zusätzlich `superseded`.
   *
   * Muss mit der Sammelbarkeits-Definition in lib/garbage-collector.js
   * (alles außer "archived"/"deleted") übereinstimmen. Seit Forget nur noch
   * soft-deleted, ist dies der einzige Pfad, über den überholte Fassungen
   * überhaupt noch Archivkandidaten werden können.
   */
  buildCollectableScanQuery() {
    return this._buildScanQuery("status IS NULL OR status = 'active' OR status = '' OR status = 'superseded'");
  }

  async *_scanBatches(buildQuery, label, options = {}) {
    await this.init();
    const batchSize = Math.max(1, Math.min(Number(options.batchSize || 500), 5000));
    let offset = 0;
    while (true) {
      let query = buildQuery().limit(batchSize);
      if (offset > 0) {
        if (typeof query.offset !== "function") break;
        query = query.offset(offset);
      }
      const rows = await this._read(
        query.toArray({ maxBatchLength: batchSize }),
        `${label}:${offset}`,
      );
      if (!rows || rows.length === 0) break;
      yield rows.map((r) => this.normalizeActiveScanRow(r));
      if (rows.length < batchSize) break;
      offset += rows.length;
    }
  }

  async *scanActiveBatches(options = {}) {
    yield* this._scanBatches(() => this.buildActiveScanQuery(), "MemoryDB.scanActiveBatches", options);
  }

  async *scanCollectableBatches(options = {}) {
    yield* this._scanBatches(() => this.buildCollectableScanQuery(), "MemoryDB.scanCollectableBatches", options);
  }

  async scanActive(options = {}) {
    const rows = [];
    for await (const batch of this.scanActiveBatches(options)) {
      rows.push(...batch);
    }
    return rows;
  }

  async scanCollectable(options = {}) {
    const rows = [];
    for await (const batch of this.scanCollectableBatches(options)) {
      rows.push(...batch);
    }
    return rows;
  }

  async purgeExpired() {
    this._assertWritable("purgeExpired");
    await this.init();
    const now = safeTimestamp(Date.now());
    const protectedWhere = "(neverForget IS NULL OR neverForget = 0) AND (memoryClass IS NULL OR memoryClass != 'core')";
    await this._write(this.table.delete(`expiresAt > 0 AND expiresAt < ${now} AND ${protectedWhere}`), "MemoryDB.purgeExpired");
  }

  /**
   * Hot-path wrapper that skips purgeExpired() if it ran for this DB recently.
   * Used by before_prompt_build; explicit/admin calls still use purgeExpired().
   */
  purgeExpiredThrottled(logger) {
    this._assertWritable("purgeExpiredThrottled");
    const last = purgeThrottleMap.get(this.dbPath);
    if (last && Date.now() - last < PURGE_THROTTLE_MS) {
      return Promise.resolve();
    }
    purgeThrottleMap.set(this.dbPath, Date.now());
    return this.purgeExpired().catch((e) => {
      logger?.warn?.(`memory-lancedb-namespaced: purgeExpired failed: ${String(e)}`);
    });
  }
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function deriveExpectedCanonicalTarget(path) {
  const missingParts = [];
  const absolutePath = resolve(path);
  let existingAncestor = absolutePath;
  while (!pathEntryExists(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(`No existing ancestor for DB path: ${path}`);
    missingParts.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync(existingAncestor);
  return {
    absolutePath,
    expectedTarget: missingParts.length > 0
      ? resolveInside(canonicalAncestor, ...missingParts)
      : canonicalAncestor,
  };
}

/**
 * Applies an epistemic-status transition to a LanceDB memory row.
 *
 * Thin persistence adapter — the actual matrix/actor-tier/authorization
 * validation lives in transitionEpistemicStatus() (lib/epistemic-status.js).
 * This function only: (1) enforces the same fail-closed checkAccess() gate
 * every other memory mutation goes through, (2) persists via the existing
 * MemoryDB.update() in-place patch mechanism, (3) writes the existing
 * destructive-op audit log — no new authorization surface, no new audit file.
 *
 * @param {object} db MemoryDB instance (getById()/update()).
 * @param {string} id memory id
 * @param {string} nextStatus target epistemicStatus
 * @param {{ctx: object, actor: string, actorTier?: string, reason?: string, evidence?: string, authorized?: boolean, workspaceDir?: string, now?: number}} opts
 * @returns {Promise<{ok: boolean, patch?: object, reason?: string}>}
 */
export async function applyEpistemicStatusToLanceDb(db, id, nextStatus, opts = {}) {
  const record = await db.getById(id);
  if (!record) return { ok: false, reason: "not_found" };
  const acl = checkAccess(opts.ctx, record);
  if (!acl.allowed) return { ok: false, reason: acl.reason };
  const patch = transitionEpistemicStatus(record, nextStatus, opts);
  // Log before mutating, not after. appendDestructiveOpLog is synchronous
  // and swallows its own errors (lib/sql-safety.js), so this ordering costs
  // nothing on the happy path. It matters on the unhappy path: if the
  // process dies between the two calls, "log written, mutation never
  // happened" is audit noise (a stray line describing an attempt), while
  // "mutation happened, log never written" is a silent, unaudited trust
  // change — worse for a feature whose purpose is to make trust changes
  // legible. This is a narrower, simpler ordering choice than
  // deleteWithAuditContinuation's late-settlement machinery, which is not
  // replicated here (out of scope, see plan §9).
  appendDestructiveOpLog(opts.workspaceDir, {
    operation: "trust_transition",
    memoryId: id,
    previousEpistemicStatus: patch.previousEpistemicStatus,
    newEpistemicStatus: patch.epistemicStatus,
    actor: patch.epistemicStatusActor,
    reason: patch.epistemicStatusReason,
    evidence: opts.evidence || "",
    agentId: opts.ctx?.agentId || null,
    userPrincipal: opts.ctx?.userPrincipal || null,
    timestamp: new Date().toISOString(),
  });
  await db.update(id, patch);
  return { ok: true, patch };
}

/**
 * Closes an existing memory row's validity window (Phase 2 — Bi-Temporal
 * Memory) with a real, asserted boundary — NOT a version-chain edit (see
 * plan §0/§7a): "Firma A" stays `status: "active"`, only its `validUntil`
 * is set. Mirrors applyEpistemicStatusToLanceDb()'s structure exactly: same
 * fail-closed checkAccess() gate, same in-place MemoryDB.update() patch
 * mechanism, same destructive-op audit log (no new audit file).
 *
 * @param {object} db MemoryDB instance (getById()/update()).
 * @param {string} id memory id
 * @param {*} validUntil caller-asserted end-of-validity boundary (ISO date/ms/etc.)
 * @param {{ctx: object, actor: string, reason?: string, workspaceDir?: string, now?: number}} opts
 * @returns {Promise<{ok: boolean, patch?: object, reason?: string}>}
 */
export async function applyValidTimeCloseToLanceDb(db, id, validUntil, opts = {}) {
  const safeId = safeUuid(id);
  const record = await db.getById(safeId);
  if (!record) return { ok: false, reason: "not_found" };
  const acl = checkAccess(opts.ctx, record);
  if (!acl.allowed) return { ok: false, reason: acl.reason };
  const patch = buildValidTimeClosePatch(record, {
    validUntil,
    actor: opts.actor,
    reason: opts.reason,
    now: opts.now,
  });
  appendDestructiveOpLog(opts.workspaceDir, {
    operation: "validity_close",
    memoryId: safeId,
    previousValidUntil: Number(record.validUntil || 0),
    newValidUntil: patch.validUntil,
    actor: opts.actor,
    reason: opts.reason || "",
    agentId: opts.ctx?.agentId || null,
    userPrincipal: opts.ctx?.userPrincipal || null,
    timestamp: new Date().toISOString(),
  });
  await db.update(safeId, patch);
  return { ok: true, patch };
}

/**
 * Maps a canonical memory request ctx onto the requester shape
 * isNeoRecordAccessible() expects. Same field-precedence style as the
 * plugin-internal neoRequester(ctx, event) helper (workspaceKey preferred
 * over a bare workspaceId; this module-level function has no access to
 * that closure, so the mapping is duplicated rather than shared) — but NOT
 * an exact copy: this accepts the canonical memory-request-context shape
 * (ctx.workspaceIdentity, ctx.userPrincipal) that checkAccess() and
 * applyEpistemicStatusToLanceDb() already use, since that is the ctx shape
 * a symmetric caller of this function's LanceDB sibling would pass, not
 * the narrower ctx+event shape neoRequester() is tuned for.
 *
 * @param {object} [ctx]
 * @returns {{requesterAgentId: string, requesterWorkspaceKey: string, requesterOwnerId: string}}
 */
function deriveNeoRequesterFromCtx(ctx = {}) {
  return {
    requesterAgentId: typeof ctx?.agentId === "string" ? ctx.agentId.trim() : "",
    requesterWorkspaceKey: [ctx?.workspaceKey, ctx?.workspaceIdentity, ctx?.workspaceId]
      .find((value) => typeof value === "string" && value.trim()) || "",
    requesterOwnerId: [ctx?.ownerId, ctx?.userPrincipal, ctx?.userId]
      .find((value) => typeof value === "string" && value.trim()) || "",
  };
}

/**
 * Applies an epistemic-status transition to a NEO record (candidate or
 * behavior card), persisted the same way transitionRecordStatus() results
 * already are — an append to the NEO store's candidates/behavior-cards log.
 *
 * Fail-closed like its LanceDB sibling applyEpistemicStatusToLanceDb(): NEO
 * records use their own scope model (visibility.scope / origin.scope +
 * isNeoRecordAccessible()), not checkAccess(), so this calls that instead.
 * This function is not wired into any command handler yet (see plan §11/
 * final report) — the gate exists anyway, on the same "no unauthorized
 * mutation API, wired or not" principle as every other mutation path in
 * this file.
 *
 * @param {object} store NEO store (appendCandidates()/appendBehaviorCards()/appendEmbeddingQueue()).
 * @param {object} item current NEO record.
 * @param {string} nextStatus target epistemicStatus.
 * @param {{ctx?: object, actor: string, actorTier?: string, reason?: string, evidence?: string, authorized?: boolean, now?: number, isBehaviorCard?: boolean}} opts
 * @returns {{ok: boolean, updated?: object, reason?: string}}
 */
export function applyEpistemicStatusToNeo(store, item, nextStatus, opts = {}) {
  const requester = deriveNeoRequesterFromCtx(opts.ctx);
  if (!isNeoRecordAccessible(item, requester)) {
    return { ok: false, reason: "acl.denied" };
  }
  const patch = transitionEpistemicStatus(item, nextStatus, opts);
  const updated = { ...item, ...patch };
  if (opts.isBehaviorCard) {
    store.appendBehaviorCards([updated]);
  } else {
    store.appendCandidates([updated]);
  }
  store.appendEmbeddingQueue?.([updated]);
  return { ok: true, updated };
}

export { MAX_BACKGROUND_LIFECYCLE_ERRORS, waitForTimeoutSettlement, MemoryDB, pathEntryExists, deriveExpectedCanonicalTarget };
