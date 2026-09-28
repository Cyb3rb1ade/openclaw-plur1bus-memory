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
 *
 * E4.1: the key is recorded as soon as the capture's rows have settled
 * successfully — `fn` receives an `onRowsSettled` callback that the capture
 * pipeline calls right after its store loop (rows stored, none failed),
 * before any post-store step (speaker pipeline, meta-cognition, graph build,
 * neo drain, scheduler settling). A process killed in that window has its
 * turn already recorded, so the host's journal replay answers
 * `duplicate-turn` instead of storing the row a second time; the only window
 * left is the guard's own atomic file write. The post-store steps are
 * best-effort: if they then fail, or the result still ends up carrying a
 * `reason`, the turn stays recorded — its rows are stored, and a replay would
 * only duplicate them. A capture that never calls `onRowsSettled` is
 * recorded, as before, only when its result carries no `reason`.
 *
 * E4.3: that last window — the row's LanceDB commit has resolved, the key is
 * not written yet — is closed by a *pending* entry. Before the first row is
 * written the pipeline fixes the row ids and hands them to `onRowsPlanned`,
 * which persists `{ key, at, pending: [ids] }` (fsync + atomic rename) before
 * it returns. A pending entry is not a recorded turn: a replay of that key is
 * captured again, and `fn` receives the pending row ids as `staleRowIds` so
 * the pipeline removes whichever of them were written before it stores the
 * turn — exactly once, whether the earlier process died before, during or
 * after its store loop. Marking the turn done (`onRowsSettled`) replaces the
 * pending entry. A capture that returns with its rows only partly stored
 * calls `onRowsKept` instead: those rows have been through the post-store
 * steps (graph edges reference them), so the pending entry is dropped and the
 * replay behaves as before E4.3 (see "A capture that fails or is only partly
 * completed" in docs/engine-api.md). A pending entry that is never replayed
 * expires with the same TTL and cap as every other entry; its rows, if any
 * were written, are then the turn's only copy and stay.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isAbortError, raceAbort } from "../../lib/abort.js";
import { selectSafeUuids } from "../../lib/sql-safety.js";

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

// A pending entry keeps only well-formed row ids: they reach LanceDB delete
// filters, and a turn plans at most one row per captured text and part.
const MAX_PENDING_ROW_IDS = 10_000;

function validEntries(parsed) {
  if (!parsed || parsed.v !== FILE_VERSION || !Array.isArray(parsed.entries)) return null;
  return parsed.entries
    .filter((e) => e && typeof e.key === "string" && Number.isFinite(e.at))
    .map((e) => (Array.isArray(e.pending)
      ? { key: e.key, at: e.at, pending: selectSafeUuids(e.pending, MAX_PENDING_ROW_IDS) }
      : { key: e.key, at: e.at }));
}

/**
 * @param {{ root: string, clock?: () => number, logger?: { warn?: (m: string) => void } }} options
 * @returns {{ run(agentId: string, key: string, fn: (onRowsSettled: () => void, pending: { staleRowIds: string[], onRowsPlanned: (ids: string[]) => void, onRowsKept: () => void }) => Promise<{ stored: number, skipped: number, reason?: string }>, opts?: { signal?: AbortSignal }): Promise<{ stored: number, skipped: number, reason?: string }> }}
 *   (the result is a CaptureResult, types/engine.d.ts). `onRowsSettled`
 *   records the key immediately (idempotent, never throws; see E4.1 in the
 *   module comment). `pending` (E4.3): `staleRowIds` are the row ids of an
 *   earlier, never-settled capture of this turn, for `fn` to remove before
 *   it stores; `onRowsPlanned(ids)` persists the turn as pending with those
 *   ids (plus `staleRowIds`) before the first row is written;
 *   `onRowsKept()` drops the pending entry. Neither throws, and both are
 *   no-ops once the turn is recorded. `opts.signal`, when
 *   given, only bounds a *waiter's* time in the queue behind an identical
 *   in-flight capture (M4, fix wave 1): the caller's own signal aborting
 *   while waiting resolves immediately with the same `{ reason: "aborted" }`
 *   shape the capture pipeline itself gives an aborted turn, rather than the
 *   waiter silently ignoring its own cancellation and waiting out the whole
 *   in-flight capture regardless. It never cancels the in-flight capture
 *   itself, only this call's own wait.
 */
export function createTurnReplayGuard({ root, clock = Date.now, logger }) {
  /** agentId → [{ key, at, pending? }], oldest first. */
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
    return load(agentId).some((e) => e.key === key && !e.pending && now - e.at <= REPLAY_GUARD_TTL_MS);
  };
  /** Row ids of a pending (planned, never settled) capture of this turn; [] when there is none. */
  const pendingRowIdsOf = (agentId, key) => {
    const now = clock();
    const entry = load(agentId).find((e) => e.key === key && e.pending && now - e.at <= REPLAY_GUARD_TTL_MS);
    return entry ? [...entry.pending] : [];
  };

  function persist(agentId, entries) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = join(root, fileNameOf(agentId));
    const tmp = join(root, `.${fileNameOf(agentId)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      // fsync before the rename (E4.3): a pending entry must be on disk before
      // the first row it announces is written.
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ v: FILE_VERSION, entries }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, target);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  /** Records `key` as done, as pending with `pending` row ids, or (`pending === null`) removes it. */
  function record(agentId, key, pending) {
    const now = clock();
    const entries = fresh(load(agentId), now).filter((e) => e.key !== key);
    if (pending === undefined) entries.push({ key, at: now });
    else if (pending !== null) entries.push({ key, at: now, pending });
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
      const recordOnce = () => {
        if (recorded) return;
        recorded = true;
        try {
          record(agentId, key);
        } catch (error) {
          // record() already fails open on the write; this only guards the
          // callback contract (the pipeline calls it mid-capture).
          warn(`plur1bus: capture replay guard could not record a turn for agent=${agentId} (${String(error?.message || error).slice(0, 120)})`);
        }
      };
      // E4.3: rows of an earlier capture of this turn that never settled.
      const staleRowIds = pendingRowIdsOf(agentId, key);
      const markPending = (label, pending) => {
        if (recorded) return;
        try {
          record(agentId, key, pending);
        } catch (error) {
          warn(`plur1bus: capture replay guard could not ${label} a turn for agent=${agentId} (${String(error?.message || error).slice(0, 120)})`);
        }
      };
      const pending = Object.freeze({
        staleRowIds: Object.freeze([...staleRowIds]),
        onRowsPlanned: (ids) => markPending("mark pending", [...new Set([...staleRowIds, ...selectSafeUuids(Array.isArray(ids) ? ids : [], MAX_PENDING_ROW_IDS)])]),
        onRowsKept: () => markPending("unmark pending", null),
      });
      try {
        const result = await fn(recordOnce, pending);
        if (result && result.reason === undefined) recordOnce();
        return result;
      } finally {
        settle(recorded);
        if (inFlight.get(flightKey) === flight) inFlight.delete(flightKey);
      }
    },
  });
}
