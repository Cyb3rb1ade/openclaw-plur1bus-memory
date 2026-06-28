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
import { aggregateEvidence } from "./skill-miner/evidence-aggregator.js";
import { extractSkillFromEvidence } from "./skill-miner/llm-extractor.js";
import { writeProposal } from "./skill-miner/proposal-writer.js";

const DEFAULT_OPTS = {
  maxPerRun: 5,
  minConfidence: 0.6,
  minEvidenceScore: 3,
  lookbackDays: 30,
};
const DEFAULT_SKILL_MINER_LOCK_STALE_MS = 45 * 60 * 1000; // 45 minutes

function isTrustedSkillEvidence(row) {
  return row?.origin === "user_confirmation" || ["validated", "curated"].includes(row?.trustLevel);
}

async function loadMemories(db, lookbackDays) {
  if (!db || !db.table) return [];
  const rows = await db.table.query().limit(5000).toArray();
  const cutoff = Date.now() - lookbackDays * 86400000;
  return rows
    .filter(r => r.status === "active" || !r.status)
    .filter(r => ["decision", "fact", "strategy", "preference", "workspace_rule", "user_preference"].includes(r.category))
    .filter(r => (r.createdAt || 0) >= cutoff)
    .filter(isTrustedSkillEvidence)
    .map(r => ({
      id: r.id,
      text: r.text || "",
      category: r.category,
      origin: r.origin || "dm",
      trustLevel: r.trustLevel || "untrusted",
      retrievalCount: r.retrievalCount || 0,
      contradictory: r.contradictory === true,
    }));
}

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

      const candidate = await extractSkillFromEvidence(group, { callLlm, llmCfg, timeoutMs: 30000, logger });
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
