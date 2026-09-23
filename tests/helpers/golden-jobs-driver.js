/**
 * tests/helpers/golden-jobs-driver.js
 *
 * Runs one job-ledger scenario against the real registry and ledger with a
 * virtual clock. The REM body is a stub that reports "no narrative" exactly
 * like the real one does through remJobOutcome; what is under test is the
 * ledger's retry/abandon semantics and the diary line, not REM itself.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { createJobRegistry } from "../../engine/jobs/job-registry.js";
import { createStubHost } from "../../lib/host-services.js";
import { makeTempDir } from "./temp-dir.js";

const STABLE_FIELDS = ["runId", "job", "phase", "agentId", "trigger", "startedAt", "finishedAt", "outcome", "reason", "attempt", "keys", "pendingKeys", "diary", "sweep", "llmSession"];

/**
 * @param {object} scenario One of JOB_SCENARIOS.
 * @returns {Promise<string>} Normalized ledger rows, then the diary.
 */
export async function runJobScenario(scenario) {
  const root = makeTempDir("plur1bus-golden-jobs-");
  const workspaceDir = makeTempDir("plur1bus-golden-jobs-ws-");
  let now = scenario.sweeps[0];
  let n = 0;
  const host = createStubHost({ clock: () => now });
  const jobs = createJobRegistry({ host, jobsRoot: root, idFactory: () => `run-${++n}` });
  jobs.bind(scenario.job, async (_name, ctx) => {
    if (ctx.isAbandonedKey(scenario.runKey)) return ctx.skip("abandoned");
    if (ctx.hasCompletedKey(scenario.runKey)) return ctx.skip("already_processed");
    ctx.notePendingKey(scenario.runKey);
    ctx.setDiaryTarget(workspaceDir);
    return ctx.incomplete("no_narrative");
  });
  for (const at of scenario.sweeps) {
    now = at;
    await jobs.run(scenario.job, scenario.agentId, { trigger: "cron" });
  }
  const rows = (await jobs.history(scenario.agentId)).reverse().map((row) => {
    const stable = {};
    for (const field of STABLE_FIELDS) if (row[field] !== undefined) stable[field] = row[field];
    return JSON.stringify(stable);
  });
  const diaryPath = join(workspaceDir, "DREAMS.md");
  const diary = existsSync(diaryPath) ? readFileSync(diaryPath, "utf8") : "";
  return `${rows.join("\n")}\n--- DREAMS.md ---\n${diary}`;
}
