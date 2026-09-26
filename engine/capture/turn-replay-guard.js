/**
 * engine/capture/turn-replay-guard.js — Q3 (E4 Task 5): a replayed turn never
 * runs the capture pipeline twice.
 *
 * The pipeline's own replay protection is the vector dedup, and several
 * LLM-bearing steps run before it or depend on it being exact: an oversized
 * text is summarised by the `capture-summary` route before embedding, and
 * that summary is not deterministic, so a replay would embed different text,
 * escape the dedup, store a second row, classify emotion again and advance
 * the meta-reflection session counter. A host journal replay (a new process
 * re-delivering turns it could not confirm) is therefore recognised here, at
 * the turn level, before any of that runs.
 *
 * A turn is identified by `turnKeyOf` (agent, runId, sessionKey, messages).
 * Keys of completed captures are persisted per agent under
 * `<baseDbPath>/_capture-turns/<agent>.json` so a replay after a restart is
 * still recognised; entries expire after `REPLAY_GUARD_TTL_MS` and at most
 * `REPLAY_GUARD_MAX_ENTRIES` are kept per agent.
 *
 * Fail-open: an unreadable or corrupt file is warned about once and treated
 * as empty, and a failed write is warned about and ignored — the vector dedup
 * still applies, and a capture is never blocked on the guard. A capture whose
 * result carries a `reason` (it did not complete: aborted, embedder down,
 * engine closed, ...) is not recorded, so its replay is captured.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAbortError, raceAbort } from "../../lib/abort.js";

export const REPLAY_GUARD_MAX_ENTRIES = 512;
export const REPLAY_GUARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const FILE_VERSION = 1;

/**
 * sha256 hex of JSON.stringify([agentId, runId ?? null, sessionKey ?? null,
 * messages.map((m) => [m.role, typeof m.content === "string" ? m.content : JSON.stringify(m.content)])]).
 *
 * @param {{ agentId?: string, runId?: string, sessionKey?: string, messages?: Array<{ role?: string, content?: unknown }> }} t
 * @returns {string}
 */
export function turnKeyOf(t) {
  const messages = Array.isArray(t?.messages) ? t.messages : [];
  const material = JSON.stringify([
    t?.agentId,
    t?.runId ?? null,
    t?.sessionKey ?? null,
    messages.map((m) => [m?.role, typeof m?.content === "string" ? m.content : JSON.stringify(m?.content)]),
  ]);
  return createHash("sha256").update(material).digest("hex");
}

const duplicateTurn = () => ({ stored: 0, skipped: 1, reason: "duplicate-turn" });
// Same shape the capture pipeline itself gives an aborted turn
// (engine/create-engine.js's capture(), capture-turn.js's `opts.report.incomplete`).
const abortedTurn = () => ({ stored: 0, skipped: 1, reason: "aborted" });

// Agent ids match /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/ (safeAgentId); ":" is
// not a valid file-name character on Windows, so the name is URI-encoded
// (letters, digits, ".", "_" and "-" stay as they are).
const fileNameOf = (agentId) => `${encodeURIComponent(String(agentId))}.json`;

function validEntries(parsed) {
  if (!parsed || parsed.v !== FILE_VERSION || !Array.isArray(parsed.entries)) return null;
  return parsed.entries.filter((e) => e && typeof e.key === "string" && Number.isFinite(e.at));
}

/**
 * @param {{ root: string, clock?: () => number, logger?: { warn?: (m: string) => void } }} options
 * @returns {{ run(agentId: string, key: string, fn: () => Promise<{ stored: number, skipped: number, reason?: string }>, opts?: { signal?: AbortSignal }): Promise<{ stored: number, skipped: number, reason?: string }> }}
 *   (the result is a CaptureResult, types/engine.d.ts). `opts.signal`, when
 *   given, only bounds a *waiter's* time in the queue behind an identical
 *   in-flight capture (M4, fix wave 1): the caller's own signal aborting
 *   while waiting resolves immediately with the same `{ reason: "aborted" }`
 *   shape the capture pipeline itself gives an aborted turn, rather than the
 *   waiter silently ignoring its own cancellation and waiting out the whole
 *   in-flight capture regardless. It never cancels the in-flight capture
 *   itself, only this call's own wait.
 */
export function createTurnReplayGuard({ root, clock = Date.now, logger }) {
  /** agentId → [{ key, at }], oldest first. */
  const byAgent = new Map();
  /** `${agentId}\0${key}` → Promise<boolean> (true when that capture was recorded). */
  const inFlight = new Map();
  const warn = (message) => {
    try { logger?.warn?.(message); } catch { /* a logger failure never blocks a capture */ }
  };

  const fresh = (entries, now) => entries.filter((e) => now - e.at <= REPLAY_GUARD_TTL_MS);

  function load(agentId) {
    let entries = byAgent.get(agentId);
    if (entries) return entries;
    entries = [];
    let raw = null;
    try {
      raw = readFileSync(join(root, fileNameOf(agentId)), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        warn(`plur1bus: capture replay guard state unreadable for agent=${agentId}; treating it as empty (${String(error?.code || error?.message || error).slice(0, 120)})`);
      }
    }
    if (raw !== null) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* reported below */ }
      const valid = validEntries(parsed);
      if (valid) entries = valid;
      else warn(`plur1bus: capture replay guard state corrupt for agent=${agentId}; treating it as empty`);
    }
    byAgent.set(agentId, entries);
    return entries;
  }

  const isRecorded = (agentId, key) => {
    const now = clock();
    return load(agentId).some((e) => e.key === key && now - e.at <= REPLAY_GUARD_TTL_MS);
  };

  function persist(agentId, entries) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = join(root, fileNameOf(agentId));
    const tmp = join(root, `.${fileNameOf(agentId)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify({ v: FILE_VERSION, entries }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(tmp, target);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  function record(agentId, key) {
    const now = clock();
    const entries = fresh(load(agentId), now).filter((e) => e.key !== key);
    entries.push({ key, at: now });
    const kept = entries.slice(-REPLAY_GUARD_MAX_ENTRIES);
    // Kept in memory even if the write fails: this process still recognises
    // the replay, only a restart would not.
    byAgent.set(agentId, kept);
    try {
      persist(agentId, kept);
    } catch (error) {
      warn(`plur1bus: capture replay guard state not written for agent=${agentId} (${String(error?.code || error?.message || error).slice(0, 120)})`);
    }
  }

  return Object.freeze({
    async run(agentId, key, fn, { signal } = {}) {
      const flightKey = `${agentId}\0${key}`;
      // Wait out an identical capture already running; if it recorded the
      // turn this one is a duplicate, otherwise it runs itself (only one
      // waiter takes over — the others find its flight and wait again).
      for (;;) {
        if (isRecorded(agentId, key)) return duplicateTurn();
        const pending = inFlight.get(flightKey);
        if (!pending) break;
        if (signal) {
          try {
            await raceAbort(pending, signal);
          } catch (error) {
            // `pending` itself never rejects (see `flight` below); only the
            // caller's own signal can reject this race.
            if (isAbortError(error)) return abortedTurn();
            throw error;
          }
        } else {
          await pending;
        }
      }
      let settle;
      const flight = new Promise((resolve) => { settle = resolve; });
      inFlight.set(flightKey, flight);
      let recorded = false;
      try {
        const result = await fn();
        if (result && result.reason === undefined) {
          record(agentId, key);
          recorded = true;
        }
        return result;
      } finally {
        settle(recorded);
        if (inFlight.get(flightKey) === flight) inFlight.delete(flightKey);
      }
    },
  });
}
