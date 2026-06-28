/**
 * lib/jobs/feedback-analyzer.js — Observierender Feedback-Analyzer Job.
 *
 * Phase 1b: KEIN Auto-Tune. Nur Report-Generierung.
 * Läuft wöchentlich (empfohlen via cron/scheduler), produziert
 * feedback-report.json im .adaptive-learning/ Verzeichnis.
 */

import { generateFeedbackReport, readFeedbackLog } from "../feedback-log.js";

/**
 * Führt den Feedback-Analyzer aus und liefert den Report.
 * Enthält zusätzlich den Zeitraum der Auswertung.
 *
 * @param {string} workspaceDir
 * @returns {Promise<object>}
 */
export async function runFeedbackAnalyzer(workspaceDir) {
  const entries = readFeedbackLog(workspaceDir);

  if (entries.length === 0) {
    const emptyReport = generateFeedbackReport(workspaceDir);
    emptyReport.timeRange = { from: 0, to: 0 };
    return emptyReport;
  }

  const timestamps = entries.map((e) => e.timestamp).filter((t) => typeof t === "number");
  // reduce, not Math.min(...spread): spreading a very large timestamps array
  // (a big feedback log) into Math.min/max throws RangeError (call-stack/arg limit).
  const from = timestamps.length > 0 ? timestamps.reduce((a, b) => (a < b ? a : b)) : 0;
  const to = timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : 0;

  const report = generateFeedbackReport(workspaceDir);
  report.timeRange = { from, to };
  return report;
}
