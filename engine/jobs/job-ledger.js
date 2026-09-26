/**
 * engine/jobs/job-ledger.js — the append-only run ledger (PR-08, spec 3.3).
 *
 * <root>/<agentId>/ledger.jsonl holds one JobRun per line;
 * <root>/<agentId>/running/<runId>.started exists exactly while a body runs.
 * A marker with no row at the next process start is a crash.
 *
 * Single-writer assumption (ADR-001): exactly one resident engine process is
 * expected per installation. `ledger.jsonl` and `running/*.started` are
 * plain files with no cross-process locking — two processes sharing the same
 * `baseDbPath` concurrently (e.g. two hosts pointed at one directory) is
 * unsupported and can produce interleaved or lost rows.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
      const line = `${JSON.stringify({ v: LEDGER_VERSION, ...row })}\n`;
      // Guard against a torn last line (a crash mid-append leaves a partial,
      // unterminated JSON fragment): checked on every append, not once per
      // ledger instance. Recovery can append a crash row for the very run
      // whose own append got torn — the fragment and the crash row would
      // otherwise land on the same physical line and both become
      // unparseable, silently losing that run from `readAll()`. The check
      // itself is one open + fstat + single-byte read, far cheaper than
      // anything else a job body does, so paying it on every append (instead
      // of caching "already terminated" per instance, which would miss a
      // tear introduced between two `createJobLedger` calls, e.g. across a
      // crash-and-restart within the same process's lifetime) is the
      // correct choice, not just the simple one.
      const fd = openSync(paths.ledger, "a+");
      try {
        const { size } = fstatSync(fd);
        if (size > 0) {
          const lastByte = Buffer.alloc(1);
          readSync(fd, lastByte, 0, 1, size - 1);
          if (lastByte[0] !== 0x0a) appendFileSync(fd, "\n");
        }
        appendFileSync(fd, line);
      } finally {
        closeSync(fd);
      }
    },
    // One read of ledger.jsonl: every non-empty line that fails JSON.parse or
    // does not parse to a plain object counts toward `unreadable` (job
    // health's unreadableLines, Task 2) — the torn-line warning itself stays
    // warn-once, unchanged from `readAll`'s prior behaviour.
    snapshot() {
      if (!existsSync(paths.ledger)) return { rows: [], unreadable: 0 };
      const rows = [];
      let unreadable = 0;
      for (const line of readFileSync(paths.ledger, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row === "object" && !Array.isArray(row)) {
            rows.push(row);
          } else {
            unreadable += 1;
          }
        } catch {
          unreadable += 1;
          if (!warnedTorn) {
            warnedTorn = true;
            logger.warn(`plur1bus jobs: ignoring an unreadable line in ${paths.ledger}`);
          }
        }
      }
      return { rows, unreadable };
    },
    readAll() {
      return this.snapshot().rows;
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
            return { runId, corrupt: true };
          }
        });
    },
  });
}
