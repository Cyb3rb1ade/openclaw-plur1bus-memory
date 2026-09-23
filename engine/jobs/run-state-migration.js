/**
 * engine/jobs/run-state-migration.js — PR-08 part 3 (spec 3.3 "Migration").
 *
 * The spec names runs.json; the code's file is each Neo store's
 * run-state.json, shared with other jobs' state. So: keep a one-time copy
 * (run-state.json.migrated), import this agent's REM completions as
 * completed ledger rows, and mark the file per agent. The file itself stays
 * for its other readers; REM completion is read from the ledger only.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { sweepKey } from "./job-registry.js";

export const MIGRATION_MARKER_KEY = "plur1busLedgerMigratedAt";
const MIGRATED_SUFFIX = ".migrated";

function keepCopy(path, raw) {
  const copy = `${path}${MIGRATED_SUFFIX}`;
  if (!existsSync(copy)) writeFileSync(copy, raw);
}

/**
 * @param {{store: {paths?: {runs?: string}, writeRunState: (state: object) => unknown}, agentId: string, appendRow: (row: object) => void, clock: () => number, logger: {warn: (m: string) => void}}} options
 * @returns {{migrated: number, status: "absent"|"already"|"corrupt"|"migrated"}}
 */
export function migrateRunStateCompletions({ store, agentId, appendRow, clock, logger }) {
  const path = store?.paths?.runs;
  if (!path || !existsSync(path)) return { migrated: 0, status: "absent" };
  const raw = readFileSync(path, "utf8");
  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    logger.warn(`plur1bus jobs: ${path} is not valid JSON; REM completions not migrated (${String(error?.message || error)})`);
    keepCopy(path, raw);
    return { migrated: 0, status: "corrupt" };
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    logger.warn(`plur1bus jobs: ${path} is not a JSON object; REM completions not migrated`);
    keepCopy(path, raw);
    return { migrated: 0, status: "corrupt" };
  }
  const marks = state[MIGRATION_MARKER_KEY] && typeof state[MIGRATION_MARKER_KEY] === "object" ? state[MIGRATION_MARKER_KEY] : {};
  if (marks[agentId]) return { migrated: 0, status: "already" };
  keepCopy(path, raw);
  let migrated = 0;
  for (const [runKey, meta] of Object.entries(state.completed || {})) {
    if (!runKey.startsWith("rem:") || !runKey.includes(`:${agentId}:`)) continue;
    const parsed = Date.parse(meta?.completedAt);
    const at = Number.isFinite(parsed) ? parsed : clock();
    const counts = {};
    for (const field of ["patternsFound", "memoriesProcessed"]) {
      if (Number.isFinite(meta?.[field])) counts[field] = meta[field];
    }
    appendRow({
      runId: `migrated:${runKey}`,
      job: "rem-dream",
      phase: "rem",
      agentId,
      trigger: "cron",
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      outcome: "completed",
      reason: "migrated",
      attempt: 1,
      cost: { ms: 0 },
      counts,
      keys: [runKey],
      idempotencyKey: runKey,
      migrated: true,
      sweep: sweepKey(at),
      llmSession: false,
    });
    migrated += 1;
  }
  store.writeRunState({ ...state, [MIGRATION_MARKER_KEY]: { ...marks, [agentId]: new Date(clock()).toISOString() } });
  return { migrated, status: "migrated" };
}
