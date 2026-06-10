/**
 * lib/jobs/reflection-job.js — Hintergrund-Job für Meta-Reflexion.
 *
 * Läuft wöchentlich oder nach Session-Threshold, aggregiert Feedback,
 * findet Coverage-Gaps und aktualisiert Behavior-Cards.
 * Idempotent via run-state.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  reflectOnSession,
  updateBehaviorCards,
  computeRecallMetrics,
  findCoverageGaps,
} from "../meta-cognition.js";
import { readJsonl } from "../jsonl-utils.js";

const META_REPORT_FILE = "meta-cognition-report.json";
const META_METRICS_FILE = "meta-cognition-metrics.json";

function getAdaptiveDir(workspaceDir) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Führt den Meta-Reflexions-Job aus.
 *
 * @param {object} opts
 * @param {object} [opts.store] — Neo-Arch Store
 * @param {string} [opts.workspaceDir]
 * @param {object} [opts.logger]
 * @param {boolean} [opts.llmReport=false] — Optionaler LLM-Report (nicht in v1)
 * @returns {Promise<{ok:boolean, metrics?:object, gaps?:object[], reason?:string}>}
 */
export async function runReflectionJob({ store, workspaceDir, logger = console, llmReport = false }) {
  if (!store) {
    logger?.warn?.("reflection-job: no store provided");
    return { ok: false, reason: "no_store" };
  }

  const turns = store.readTurns ? store.readTurns(200) : [];
  if (turns.length === 0) {
    return { ok: false, reason: "no_turns" };
  }

  // Neuesten Turn finden (readTurns liefert jüngste zuletzt)
  const lastTurn = turns[turns.length - 1];
  const sessionId = lastTurn.sessionId || lastTurn.id || "unknown";
  const runKey = `reflection:${sessionId}`;

  if (store.hasCompletedRun && store.hasCompletedRun(runKey)) {
    return { ok: true, reason: "already_reflected", sessionId };
  }

  // Retrieved Memories für diese Session aus Retrieval-Ledger sammeln
  const ledger = store.readRetrievalLedger ? store.readRetrievalLedger(500) : [];
  const retrievedMemories = ledger
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.memory || entry)
    .filter(Boolean);

  // Session-Reflexion
  const reflection = reflectOnSession({ id: sessionId }, retrievedMemories);
  if (store.appendBehaviorCards) {
    updateBehaviorCards(reflection, store);
  }

  // Feedback-Log lesen und Metriken berechnen
  let metrics = null;
  if (workspaceDir) {
    const feedbackPath = join(getAdaptiveDir(workspaceDir), "feedback-log.jsonl");
    if (existsSync(feedbackPath)) {
      const feedbackEntries = readJsonl(feedbackPath);
      metrics = computeRecallMetrics(feedbackEntries);
    }
  }

  // Coverage-Gaps aus allen Memories berechnen
  let gaps = [];
  if (store.readMemories) {
    const allMemories = store.readMemories(1000);
    gaps = findCoverageGaps(allMemories, { minMemories: 3, minStrength: 0.5 });
  }

  // Persistiere Metriken und Gaps
  if (workspaceDir) {
    const adaptiveDir = getAdaptiveDir(workspaceDir);
    const metricsPath = join(adaptiveDir, META_METRICS_FILE);
    writeFileSync(
      metricsPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sessionId,
          metrics,
          gapCount: gaps.length,
          gaps: gaps.slice(0, 20), // bounded
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (store.markRunCompleted) {
    store.markRunCompleted(runKey, { reflectedAt: new Date().toISOString() });
  }

  logger?.info?.(`reflection-job[${sessionId}]: classification=${reflection.classification}, metrics=${metrics ? "present" : "none"}, gaps=${gaps.length}`);

  return {
    ok: true,
    sessionId,
    classification: reflection.classification,
    metrics,
    gaps,
  };
}
