/**
 * lib/jobs/skill-miner.js
 *
 * Phase 6 — Skill Miner Orchestrator.
 *
 * Runs weekly: scans agent memories for repeatable patterns, extracts skill
 * candidates via LLM, writes proposals to .adaptive-learning/skill-proposals.jsonl.
 *
 * Pattern: rate limit → lock → pipeline → report → recordJobRun
 */

import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { checkJobRateLimit, recordJobRun } from "../job-rate-limit.js";
import { acquireJobLock, releaseJobLock } from "../job-lock.js";
import { atomicJsonUpdate } from "../atomic-json.js";
import { safeDebug } from "../safe-logging.js";
import {
  aggregateEvidence,
  buildSkillMiningPartition,
  isSkillMemoryInPartition,
  isTrustedSkillEvidence,
  skillOwnershipTuple,
} from "./skill-miner/evidence-aggregator.js";
import { extractSkillFromEvidence } from "./skill-miner/llm-extractor.js";
import { writeProposal } from "./skill-miner/proposal-writer.js";
import { normalizeEpistemicStatus } from "../epistemic-status.js";

const DEFAULT_OPTS = {
  maxPerRun: 5,
  minConfidence: 0.6,
  minEvidenceScore: 3,
  lookbackDays: 30,
};
const DEFAULT_SKILL_MINER_LOCK_STALE_MS = 45 * 60 * 1000; // 45 minutes

const SKILL_EVIDENCE_CATEGORIES = Object.freeze([
  "decision", "fact", "strategy", "preference", "workspace_rule", "user_preference",
]);

// Obergrenze des Kandidatenscans. Greift erst NACH dem where-Pushdown, begrenzt
// also nur die Menge, nicht mehr die Auswahl.
const DEFAULT_SKILL_SCAN_LIMIT = 5000;
const DEFAULT_SKILL_MAX_SCAN_ROWS = 50_000;
const SKILL_MINER_SCAN_STATE_KEY = "skillMinerScan";
const EMPTY_WORKSPACE_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });

function boundedPositiveInteger(value, fallback, maximum = DEFAULT_SKILL_MAX_SCAN_ROWS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(numeric)), maximum);
}

function sqlLiteral(value) {
  return `'${String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

async function readSchemaFields(table, logger) {
  try {
    const schema = await table.schema();
    return Array.isArray(schema?.fields) ? schema.fields.map((field) => field.name).filter(Boolean) : [];
  } catch (error) {
    safeDebug(logger, "skill-miner.schema", error);
    return [];
  }
}

function isLegacySkillRow(row, expectedAgentId = "") {
  const scope = row?.scope || "agent-private";
  if (scope === "user" || scope === "workspace") return false;
  if (row?.ownerUserId || row?.workspaceId || row?.workspaceKey) return false;
  const tuple = skillOwnershipTuple(row, EMPTY_WORKSPACE_ALIASES);
  if (!tuple || tuple.scope !== "agent-private") return false;
  return !expectedAgentId || !tuple.agentId || tuple.agentId === expectedAgentId;
}

function resolveSkillLoadScope(opts = {}) {
  const requestedPartition = opts.aclPartition || opts.ownershipPartition || opts.partition || null;
  const requestContext = opts.requestContext || null;
  if (requestedPartition) {
    try {
      const context = requestContext || (
        requestedPartition.scope === "agent-private" && requestedPartition.agentId
          ? { agentId: requestedPartition.agentId, workspaceAliases: EMPTY_WORKSPACE_ALIASES }
          : null
      );
      if (!context) return { partition: null, requestContext: null, strict: true, expectedAgentId: "" };
      return {
        partition: buildSkillMiningPartition(requestedPartition, context),
        requestContext: context,
        strict: true,
        expectedAgentId: context.agentId || requestedPartition.agentId || "",
      };
    } catch (error) {
      safeDebug(opts.logger, "skill-miner.partition", error);
      return { partition: null, requestContext: null, strict: true, expectedAgentId: "" };
    }
  }

  if (requestContext?.agentId) {
    try {
      return {
        partition: buildSkillMiningPartition({ scope: "agent-private", agentId: requestContext.agentId }, requestContext),
        requestContext,
        strict: true,
        expectedAgentId: requestContext.agentId,
      };
    } catch (error) {
      safeDebug(opts.logger, "skill-miner.request-context", error);
      return { partition: null, requestContext: null, strict: true, expectedAgentId: "" };
    }
  }

  // The legacy path is limited to rows that carry no protected ownership
  // binding. A later integrator can pass requestContext + aclPartition to
  // authorize workspace/user runs without changing this job's public entry.
  return {
    partition: null,
    requestContext: null,
    strict: false,
    expectedAgentId: opts.agentId || "",
  };
}

/**
 * Baut die Kandidaten-where-Klausel anhand des LIVE-Schemas.
 *
 * `epistemicStatus` bleibt bewusst DRAUSSEN: die Spalte existiert auf den
 * produktiven Tabellen noch nicht (sie kommt mit dem Release), und eine feste
 * Referenz darauf würde die Query werfen lassen — genau der Fehler, der den
 * Traum-Job stillgelegt hat. Das Trust-Gate bleibt der JS-Filter.
 */
async function buildEvidenceWhere(table, cutoff, partition, logger) {
  const felder = await readSchemaFields(table, logger);
  const hat = name => felder.includes(name);

  const teile = [];
  if (hat("createdAt")) teile.push(`createdAt >= ${Math.floor(cutoff)}`);
  if (hat("status")) teile.push("(status = 'active' OR status IS NULL OR status = '')");
  if (hat("category")) {
    // Literale aus einer eingefrorenen Konstante, keine Nutzereingabe.
    teile.push(`(${SKILL_EVIDENCE_CATEGORIES.map(c => `category = '${c}'`).join(" OR ")})`);
  }
  if (partition && hat("scope")) teile.push(`scope = ${sqlLiteral(partition.scope)}`);
  if (partition && partition.agentId) {
    const agentPredicates = [];
    if (hat("agentId")) agentPredicates.push(`agentId = ${sqlLiteral(partition.agentId)}`);
    if (hat("storedBy")) agentPredicates.push(`storedBy = ${sqlLiteral(partition.agentId)}`);
    if (agentPredicates.length > 0) teile.push(`(${agentPredicates.join(" OR ")})`);
  }
  if (partition?.scope === "workspace" && partition.workspaceIdentity) {
    const workspacePredicates = [];
    if (hat("workspaceId")) workspacePredicates.push(`workspaceId = ${sqlLiteral(partition.workspaceIdentity)}`);
    if (hat("workspaceKey")) workspacePredicates.push(`workspaceKey = ${sqlLiteral(partition.workspaceIdentity)}`);
    if (workspacePredicates.length > 0) teile.push(`(${workspacePredicates.join(" OR ")})`);
  }
  if (partition?.scope === "user" && partition.ownerUserId && hat("ownerUserId")) {
    teile.push(`ownerUserId = ${sqlLiteral(partition.ownerUserId)}`);
  }
  return teile.length > 0 ? teile.join(" AND ") : "true";
}

function normalizeSkillScanCursor(value) {
  if (!value || typeof value !== "object") return null;
  const offset = Number(value.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return { offset };
}

function skillScanStateId(agent, workspaceKey, partition) {
  return createHash("sha256")
    .update(JSON.stringify({
      agent: agent || "",
      workspaceKey: workspaceKey || "",
      partition: partition
        ? {
          scope: partition.scope || "",
          agentId: partition.agentId || "",
          workspaceIdentity: partition.workspaceIdentity || "",
          ownerUserId: partition.ownerUserId || "",
        }
        : "legacy",
    }))
    .digest("hex")
    .slice(0, 32);
}

function readSkillScanCursor(statePath, stateId, logger) {
  if (!statePath || !existsSync(statePath)) return null;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return normalizeSkillScanCursor(state?.[SKILL_MINER_SCAN_STATE_KEY]?.[stateId]?.cursor);
  } catch (error) {
    safeDebug(logger, "skill-miner.scan-state-read", error);
    return null;
  }
}

async function writeSkillScanCursor(statePath, stateId, cursor, partition) {
  const normalized = normalizeSkillScanCursor(cursor);
  if (!normalized) throw new Error("skill-miner cannot persist an invalid scan cursor");
  await atomicJsonUpdate(statePath, (data) => {
    const state = data || {};
    state[SKILL_MINER_SCAN_STATE_KEY] = state[SKILL_MINER_SCAN_STATE_KEY] || {};
    state[SKILL_MINER_SCAN_STATE_KEY][stateId] = {
      cursor: normalized,
      complete: false,
      updatedAt: Date.now(),
      aclBindings: partition || null,
    };
    return state;
  });
}

async function clearSkillScanCursor(statePath, stateId) {
  await atomicJsonUpdate(statePath, (data) => {
    const state = data || {};
    if (state[SKILL_MINER_SCAN_STATE_KEY]) {
      delete state[SKILL_MINER_SCAN_STATE_KEY][stateId];
      if (Object.keys(state[SKILL_MINER_SCAN_STATE_KEY]).length === 0) {
        delete state[SKILL_MINER_SCAN_STATE_KEY];
      }
    }
    return state;
  });
}

async function readPagedRows(table, whereClause, { pageSize, maxRows, startOffset = 0, logger }) {
  const rows = [];
  const seenIds = new Set();
  let offset = startOffset;
  let useWhere = true;

  while (rows.length < maxRows) {
    const requested = Math.min(pageSize, maxRows - rows.length);
    let query;
    let pageLimit = requested;
    try {
      query = table.query();
      if (useWhere && typeof query.where === "function") {
        query = query.where(whereClause);
      } else if (useWhere) {
        useWhere = false;
      }
      if (offset > 0) {
        if (typeof query.offset !== "function") {
          throw new Error("skill-miner paged scan requires query offset support");
        }
        query = query.offset(offset);
      } else if (typeof query.offset !== "function") {
        // A table implementation without offset gets one bounded, larger
        // read so it cannot silently return only the first page forever.
        pageLimit = maxRows;
      }
      if (typeof query.limit === "function") query = query.limit(pageLimit);
      const offsetSupported = typeof query.offset === "function";
      let page = await query.toArray();
      if (!Array.isArray(page)) throw new Error("skill-miner query returned a non-array page");
      if (page.length === 0) return { rows, complete: true, nextCursor: null };
      if (page.length > pageLimit) page = page.slice(0, pageLimit);
      const rowsBeforePage = rows.length;
      for (const row of page) {
        const id = row?.id;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        rows.push(row);
        if (rows.length >= maxRows) break;
      }
      offset += page.length;
      if (rows.length === rowsBeforePage) {
        throw new Error("skill-miner query repeated a page without advancing");
      }
      if (page.length < pageLimit) return { rows, complete: true, nextCursor: null };
      if (rows.length >= maxRows) {
        if (!offsetSupported) {
          throw new Error("skill-miner bounded scan cannot continue without query offset support");
        }
        return { rows, complete: false, nextCursor: { offset } };
      }
    } catch (error) {
      if (useWhere) {
        safeDebug(logger, "skill-miner.where-fallback", error);
        useWhere = false;
        rows.length = 0;
        seenIds.clear();
        offset = startOffset;
        continue;
      }
      safeDebug(logger, "skill-miner.page", error, { offset });
      throw error;
    }
  }
  return {
    rows,
    complete: false,
    nextCursor: { offset },
  };
}

function filterSkillRows(rows, cutoff, loadScope) {
  return rows
    .filter(r => r.status === "active" || !r.status)
    .filter(r => SKILL_EVIDENCE_CATEGORIES.includes(r.category))
    .filter(r => (r.createdAt || 0) >= cutoff)
    .filter(isTrustedSkillEvidence)
    .filter((row) => {
      if (loadScope.partition) {
        if (isSkillMemoryInPartition(row, loadScope.requestContext, loadScope.partition)) return true;
        return !loadScope.strict && isLegacySkillRow(row, loadScope.expectedAgentId);
      }
      return !loadScope.strict && isLegacySkillRow(row, loadScope.expectedAgentId);
    })
    .map(r => ({
      id: r.id,
      text: r.text || "",
      category: r.category,
      origin: r.origin || "dm",
      epistemicStatus: normalizeEpistemicStatus(r.epistemicStatus),
      retrievalCount: r.retrievalCount || 0,
      contradictory: r.contradictory === true,
      status: r.status || "",
      scope: r.scope || "agent-private",
      agentId: r.agentId || "",
      storedBy: r.storedBy || "",
      workspaceId: r.workspaceId || "",
      workspaceKey: r.workspaceKey || "",
      ownerUserId: r.ownerUserId || "",
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function scanMemories(db, lookbackDays, opts = {}) {
  if (!db || !db.table) return { memories: [], complete: true, nextCursor: null };
  const cutoff = Date.now() - lookbackDays * 86400000;
  const pageSize = boundedPositiveInteger(opts.scanLimit, DEFAULT_SKILL_SCAN_LIMIT);
  const maxRows = boundedPositiveInteger(opts.maxScanRows, DEFAULT_SKILL_MAX_SCAN_ROWS);
  const loadScope = resolveSkillLoadScope(opts);
  const whereClause = await buildEvidenceWhere(db.table, cutoff, loadScope.partition, opts.logger);
  const scan = await readPagedRows(db.table, whereClause, {
    pageSize,
    maxRows,
    startOffset: normalizeSkillScanCursor(opts.scanCursor)?.offset || 0,
    logger: opts.logger,
  });
  return {
    memories: filterSkillRows(scan.rows, cutoff, loadScope),
    complete: scan.complete,
    nextCursor: scan.nextCursor,
  };
}

/**
 * Lädt Kandidaten-Evidenz für das Skill-Mining.
 *
 * Pushdown statt Nachfiltern: vorher entschied der Deckel, WELCHE Zeilen
 * überhaupt betrachtet wurden. LanceDB liefert in Einfügereihenfolge, der Präfix
 * waren also die ältesten Zeilen — auf Tabellen über dem Deckel lagen sie
 * sämtlich außerhalb des Rückschaufensters. Live gemessen erreichte der Scan auf
 * bernhardine und main 0 Zeilen, mit Pushdown 589 bzw. 323. Das Epistemic-Gate
 * wurde damit nie erreicht.
 *
 * @param {object} db Objekt mit `.table`.
 * @param {number} lookbackDays
 * @param {{scanLimit?: number, maxScanRows?: number, requestContext?: object, aclPartition?: object, ownershipPartition?: object, agentId?: string, logger?: object}} [opts]
 */
export async function loadMemories(db, lookbackDays, opts = {}) {
  const scan = await scanMemories(db, lookbackDays, opts);
  return scan.memories;
}

/**
 * Mine deterministic skill candidates for one agent from trusted memories.
 * @param {object} db
 * @param {string} agent
 * @param {{requestContext?: object, aclPartition?: object, ownershipPartition?: object, workspaceDir?: string, workspaceKey?: string, logger?: object}} [opts]
 * @returns {Promise<object>}
 */
export async function runSkillMiner(db, agent, opts = {}) {
  const logger = opts.logger || { info: () => {}, warn: () => {} };
  const workspaceDir = opts.workspaceDir;
  const workspaceKey = opts.workspaceKey || workspaceDir || null;

  if (!workspaceDir) {
    logger.warn?.(`skill-miner[${agent}]: skipped — missing workspaceDir`);
    return { timestamp: new Date().toISOString(), agent, skipped: true, reason: "missing_workspace_dir" };
  }

  const mergedOpts = { ...DEFAULT_OPTS, ...opts };
  const { maxPerRun, minConfidence, minEvidenceScore, lookbackDays, llmCfg, callLlm } = mergedOpts;
  const loadScope = resolveSkillLoadScope({ ...mergedOpts, agentId: agent, logger });
  const hasPartitionIntent = Boolean(opts.requestContext || opts.aclPartition || opts.ownershipPartition || opts.partition);
  if (hasPartitionIntent && !loadScope.partition) {
    logger.warn?.(`skill-miner[${agent}]: skipped — ACL partition unavailable`);
    return { timestamp: new Date().toISOString(), agent, skipped: true, reason: "acl_partition_missing" };
  }
  const partitionKey = loadScope.partition?.key || "legacy";
  const rateLimitWorkspaceKey = loadScope.partition
    ? `${workspaceKey || "default"}:acl:${partitionKey}`
    : workspaceKey;
  const scanStateId = skillScanStateId(agent, workspaceKey, loadScope.partition);
  const lockStaleMs = Number.isFinite(mergedOpts.lockStaleMs)
    ? mergedOpts.lockStaleMs
    : DEFAULT_SKILL_MINER_LOCK_STALE_MS;

  // Rate limit: 1× pro Woche pro Agent
  const statePath = join(workspaceDir, "run-state.json");
  const rateLimit = checkJobRateLimit("skill-miner", agent, rateLimitWorkspaceKey, 7 * 86400000, statePath);
  if (!rateLimit.allowed) {
    logger.warn?.(`skill-miner[${agent}]: rate limited — ${Math.ceil(rateLimit.remainingMs / 3600000)}h remaining`);
    return { timestamp: new Date().toISOString(), agent, skipped: true, reason: "rate_limited", remainingMs: rateLimit.remainingMs };
  }

  // Atomic Lock
  const lockPath = join(workspaceDir, "locks", `skill-miner-${agent}-${partitionKey}.lock`);
  let lockAcquired = null;
  try {
    lockAcquired = acquireJobLock(lockPath, { staleMs: lockStaleMs });
  } catch (lockErr) {
    logger.warn?.(`skill-miner[${agent}]: lock held — ${lockErr.message}`);
    return { timestamp: new Date().toISOString(), agent, skipped: true, reason: "lock_held" };
  }

  let proposalsCreated = 0;
  let scanned = 0;
  let skippedLowConfidence = 0;
  let skippedLowEvidence = 0;
  let skippedDuplicate = 0;
  const pushMessages = [];

  try {
    if (db && typeof db.init === "function") {
      await db.init();
    }

    const scan = await scanMemories(db, lookbackDays, {
      ...opts,
      agentId: agent,
      requestContext: opts.requestContext,
      aclPartition: opts.aclPartition || opts.ownershipPartition || opts.partition,
      scanCursor: readSkillScanCursor(statePath, scanStateId, logger),
      logger,
    });
    const memories = scan.memories;
    scanned = memories.length;
    logger.info?.(`skill-miner[${agent}]: ${scanned} memories scanned (last ${lookbackDays}d)`);

    const groups = aggregateEvidence(memories, {
      trustedOnly: true,
      workspaceAliases: loadScope.requestContext?.workspaceAliases,
      requestContext: loadScope.requestContext,
      aclPartition: loadScope.partition,
    });
    logger.info?.(`skill-miner[${agent}]: ${groups.length} evidence groups formed`);

    for (const group of groups) {
      if (proposalsCreated >= maxPerRun) break;
      if (group.score < minEvidenceScore) {
        skippedLowEvidence++;
        continue;
      }

      const candidate = await extractSkillFromEvidence(group, {
        agentId: agent,
        callLlm,
        llmCfg,
        timeoutMs: 30000,
        logger,
      });
      if (candidate.skip) {
        skippedLowConfidence++;
        continue;
      }
      if (candidate.confidence < minConfidence) {
        skippedLowConfidence++;
        continue;
      }

      const proposal = {
        id: randomUUID(),
        proposedAt: new Date().toISOString(),
        skillName: candidate.skillName,
        skillTitle: candidate.skillTitle,
        description: candidate.description,
        instructions: candidate.instructions,
        examples: candidate.examples,
        evidence: {
          memoryIds: group.memories.map(m => m.id),
          score: group.score,
          llmConfidence: candidate.confidence,
        },
        category: candidate.category,
        status: "pending_review",
        agentId: agent,
        workspaceKey,
        aclBindings: group.ownership || null,
      };

      const writeResult = writeProposal(workspaceDir, proposal);
      if (writeResult.written) {
        proposalsCreated++;
        pushMessages.push({
          skillName: proposal.skillName,
          skillTitle: proposal.skillTitle,
          confidence: candidate.confidence,
        });
      } else {
        skippedDuplicate++;
      }
    }

    logger.info?.(`skill-miner[${agent}]: ${proposalsCreated} proposals created, ${skippedLowEvidence} low-evidence skipped, ${skippedLowConfidence} low-confidence skipped, ${skippedDuplicate} duplicate skipped`);

    const report = {
      timestamp: new Date().toISOString(),
      agent,
      scanned,
      proposalsCreated,
      skippedLowEvidence,
      skippedLowConfidence,
      skippedDuplicate,
      pushMessages,
      dryRun: opts.dryRun === true,
      scanComplete: scan.complete,
      aclBindings: loadScope.partition || null,
    };

    if (!scan.complete) {
      if (!opts.dryRun) {
        await writeSkillScanCursor(statePath, scanStateId, scan.nextCursor, loadScope.partition);
      }
      logger.info?.(`skill-miner[${agent}]: scan bounded at ${scanned} memories; continuation cursor persisted`);
      return report;
    }

    if (!opts.dryRun) {
      // EOF is the only point at which an old continuation can be retired.
      await clearSkillScanCursor(statePath, scanStateId);
    }

    if (workspaceDir && !opts.dryRun) {
      try {
        const reportPath = join(workspaceDir, ".adaptive-learning", "skill-miner-report.jsonl");
        appendFileSync(reportPath, JSON.stringify(report) + "\n", "utf8");
      } catch (err) {
        logger.warn?.(`skill-miner[${agent}]: report append failed: ${err.message}`);
      }
    }

    if (!opts.dryRun) {
      await recordJobRun("skill-miner", agent, rateLimitWorkspaceKey, statePath);
    }

    return report;
  } finally {
    releaseJobLock(lockAcquired);
  }
}
