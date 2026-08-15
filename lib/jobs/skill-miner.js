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
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { checkJobRateLimit, recordJobRun } from "../job-rate-limit.js";
import { acquireJobLock, releaseJobLock } from "../job-lock.js";
import { aggregateEvidence, isTrustedSkillEvidence } from "./skill-miner/evidence-aggregator.js";
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

/**
 * Baut die Kandidaten-where-Klausel anhand des LIVE-Schemas.
 *
 * `epistemicStatus` bleibt bewusst DRAUSSEN: die Spalte existiert auf den
 * produktiven Tabellen noch nicht (sie kommt mit dem Release), und eine feste
 * Referenz darauf würde die Query werfen lassen — genau der Fehler, der den
 * Traum-Job stillgelegt hat. Das Trust-Gate bleibt der JS-Filter.
 */
async function buildEvidenceWhere(table, cutoff) {
  let felder = [];
  try {
    felder = (await table.schema()).fields.map(f => f.name);
  } catch {
    felder = [];
  }
  const hat = name => felder.length === 0 || felder.includes(name);

  const teile = [];
  if (hat("createdAt")) teile.push(`createdAt >= ${Math.floor(cutoff)}`);
  if (hat("status")) teile.push("(status = 'active' OR status IS NULL OR status = '')");
  if (hat("category")) {
    // Literale aus einer eingefrorenen Konstante, keine Nutzereingabe.
    teile.push(`(${SKILL_EVIDENCE_CATEGORIES.map(c => `category = '${c}'`).join(" OR ")})`);
  }
  return teile.length > 0 ? teile.join(" AND ") : "true";
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
 * @param {{scanLimit?: number}} [opts]
 */
export async function loadMemories(db, lookbackDays, opts = {}) {
  if (!db || !db.table) return [];
  const cutoff = Date.now() - lookbackDays * 86400000;
  const scanLimit = Number(opts.scanLimit) > 0 ? Number(opts.scanLimit) : DEFAULT_SKILL_SCAN_LIMIT;

  let rows = null;
  try {
    const builder = db.table.query();
    if (typeof builder.where === "function") {
      rows = await builder.where(await buildEvidenceWhere(db.table, cutoff)).limit(scanLimit).toArray();
    }
  } catch {
    rows = null;
  }
  if (rows === null) rows = await db.table.query().limit(scanLimit).toArray();

  return rows
    .filter(r => r.status === "active" || !r.status)
    .filter(r => SKILL_EVIDENCE_CATEGORIES.includes(r.category))
    .filter(r => (r.createdAt || 0) >= cutoff)
    .filter(isTrustedSkillEvidence)
    .map(r => ({
      id: r.id,
      text: r.text || "",
      category: r.category,
      origin: r.origin || "dm",
      epistemicStatus: normalizeEpistemicStatus(r.epistemicStatus),
      retrievalCount: r.retrievalCount || 0,
      contradictory: r.contradictory === true,
    }));
}

/**
 * Mine deterministic skill candidates for one agent from trusted memories.
 * @param {object} db
 * @param {string} agent
 * @param {object} [opts]
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
  const lockStaleMs = Number.isFinite(mergedOpts.lockStaleMs)
    ? mergedOpts.lockStaleMs
    : DEFAULT_SKILL_MINER_LOCK_STALE_MS;

  // Rate limit: 1× pro Woche pro Agent
  const statePath = join(workspaceDir, "run-state.json");
  const rateLimit = checkJobRateLimit("skill-miner", agent, workspaceKey, 7 * 86400000, statePath);
  if (!rateLimit.allowed) {
    logger.warn?.(`skill-miner[${agent}]: rate limited — ${Math.ceil(rateLimit.remainingMs / 3600000)}h remaining`);
    return { timestamp: new Date().toISOString(), agent, skipped: true, reason: "rate_limited", remainingMs: rateLimit.remainingMs };
  }

  // Atomic Lock
  const lockPath = join(workspaceDir, "locks", `skill-miner-${agent}.lock`);
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
      try {
        await db.init();
      } catch (err) {
        logger.warn?.(`skill-miner[${agent}]: db init threw: ${err.message}`);
      }
    }

    const memories = await loadMemories(db, lookbackDays);
    scanned = memories.length;
    logger.info?.(`skill-miner[${agent}]: ${scanned} memories scanned (last ${lookbackDays}d)`);

    const groups = aggregateEvidence(memories);
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
    };

    if (workspaceDir && !opts.dryRun) {
      try {
        const reportPath = join(workspaceDir, ".adaptive-learning", "skill-miner-report.jsonl");
        appendFileSync(reportPath, JSON.stringify(report) + "\n", "utf8");
      } catch (err) {
        logger.warn?.(`skill-miner[${agent}]: report append failed: ${err.message}`);
      }
    }

    if (!opts.dryRun) {
      await recordJobRun("skill-miner", agent, workspaceKey, statePath);
    }

    return report;
  } finally {
    releaseJobLock(lockAcquired);
  }
}
