/**
 * engine/jobs/job-ledger.js — the append-only run ledger (PR-08, spec 3.3).
 *
 * <root>/<agentId>/ledger.jsonl holds one JobRun per line;
 * <root>/<agentId>/running/<runId>.started exists exactly while a body runs.
 * A marker with no row at the next start is a crash.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { safeAgentId } from "../../lib/sql-safety.js";

export const LEDGER_VERSION = 1;

/**
 * @param {{root: string, agentId: string, logger: {warn: (m: string) => void}}} options
 */
export function createJobLedger({ root, agentId, logger }) {
  const dir = join(root, safeAgentId(agentId));
  const paths = Object.freeze({ dir, ledger: join(dir, "ledger.jsonl"), markers: join(dir, "running") });
  const markerPath = (runId) => join(paths.markers, `${runId}.started`);
  let warnedTorn = false;

  return Object.freeze({
    paths,
    writeMarker(inflight) {
      mkdirSync(paths.markers, { recursive: true });
      writeFileSync(markerPath(inflight.runId), JSON.stringify({
        runId: inflight.runId,
        job: inflight.job,
        phase: inflight.phase,
        trigger: inflight.trigger,
        startedAt: inflight.startedAt,
      }), { flag: "wx" });
    },
    removeMarker(runId) {
      try {
        unlinkSync(markerPath(runId));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
    append(row) {
      mkdirSync(paths.dir, { recursive: true });
      appendFileSync(paths.ledger, `${JSON.stringify({ v: LEDGER_VERSION, ...row })}\n`);
    },
    readAll() {
      if (!existsSync(paths.ledger)) return [];
      const rows = [];
      for (const line of readFileSync(paths.ledger, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
        } catch {
          if (!warnedTorn) {
            warnedTorn = true;
            logger.warn(`plur1bus jobs: ignoring an unreadable line in ${paths.ledger}`);
          }
        }
      }
      return rows;
    },
    orphanMarkers() {
      if (!existsSync(paths.markers)) return [];
      return readdirSync(paths.markers)
        .filter((name) => name.endsWith(".started"))
        .map((name) => {
          const runId = name.slice(0, -".started".length);
          try {
            return { ...JSON.parse(readFileSync(join(paths.markers, name), "utf8")), runId };
          } catch {
            return { runId };
          }
        });
    },
  });
}
