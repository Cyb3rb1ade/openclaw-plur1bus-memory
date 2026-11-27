/**
 * lib/post-turn-queue.js — post-turn LLM work, queued for the
 * `post-turn-refine` feature cron.
 *
 * Under OpenClaw 2026.9.7 every plugin LLM call made after a turn (episode
 * extraction, light-dream insights and narrative) inherits the finished turn's
 * caller identity and is refused with "agent tool caller authority is no
 * longer active" (openclaw/openclaw#162941). The same calls succeed from a
 * cron. The agent_end hook therefore only enqueues the work; the cron runs it.
 *
 * One file per entry (`<enqueuedAtMs>-<uuid>.json`, mode 0600) under
 * `<baseDbPath>/.post-turn-queue/<agentId>/`. Enqueueing is a single atomic
 * write, so plugin instances never race on a shared file; the cron drains
 * FIFO behind a job lock. Entries hold the new turns' text, like the turn
 * journal does, and are deleted once processed.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireJobLock, releaseJobLock, JOB_LOCK_HARD_CEILING_FACTOR } from "./job-lock.js";
import { securePath } from "./platform.js";
import { safeWarn } from "./safe-logging.js";
import { resolveInside, safeAgentId } from "./sql-safety.js";

export const POST_TURN_QUEUE_DIR = ".post-turn-queue";
export const POST_TURN_QUEUE_CAP = 200;
export const POST_TURN_MAX_ATTEMPTS = 3;
const ENTRY_FILE = /^\d{13}-[0-9a-f-]{36}\.json$/;
const DRAIN_LOCK = ".drain.lock";
const DRAIN_LOCK_STALE_MS = 15 * 60 * 1000;

function queueDir(baseDbPath, agentId) {
  const root = join(baseDbPath, POST_TURN_QUEUE_DIR);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = resolveInside(root, safeAgentId(agentId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function listEntryFiles(dir) {
  return readdirSync(dir).filter((name) => ENTRY_FILE.test(name)).sort();
}

function writeEntryFile(path, entry) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  securePath(tmp, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Enqueue one turn batch. Drops the oldest entries beyond the cap.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {object} payload serializable work description
 * @param {{logger?: object, now?: number}} [opts]
 * @returns {{id: string, file: string, dropped: number}}
 */
export function enqueuePostTurnWork(baseDbPath, agentId, payload, opts = {}) {
  const dir = queueDir(baseDbPath, agentId);
  const id = randomUUID();
  const enqueuedAt = Number.isFinite(opts.now) ? opts.now : Date.now();
  const file = `${String(enqueuedAt).padStart(13, "0")}-${id}.json`;
  writeEntryFile(join(dir, file), { ...payload, id, agentId, enqueuedAt, attempts: 0 });
  const files = listEntryFiles(dir);
  let dropped = 0;
  for (const name of files.slice(0, Math.max(0, files.length - POST_TURN_QUEUE_CAP))) {
    try {
      unlinkSync(join(dir, name));
      dropped += 1;
    } catch (err) {
      safeWarn(opts.logger, "post-turn-queue", err, { op: "cap-drop" });
    }
  }
  if (dropped > 0) safeWarn(opts.logger, "post-turn-queue", "queue cap reached, oldest entries dropped", { agentId, dropped });
  return { id, file, dropped };
}

/**
 * Number of queued entries for one agent.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @returns {number}
 */
export function countPostTurnWork(baseDbPath, agentId) {
  try {
    const root = join(baseDbPath, POST_TURN_QUEUE_DIR);
    if (!existsSync(root)) return 0;
    const dir = resolveInside(root, safeAgentId(agentId));
    return existsSync(dir) ? listEntryFiles(dir).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Drain one agent's queue FIFO. `process(entry)` resolves true when the entry
 * is done. A false result or a throw stops the drain (later entries depend on
 * the episode state the earlier ones leave); after POST_TURN_MAX_ATTEMPTS the
 * entry is dropped with a warning so one bad batch cannot block the queue.
 *
 * @param {string} baseDbPath
 * @param {string} agentId
 * @param {(entry: object) => Promise<boolean>} process
 * @param {{maxEntries?: number, budgetMs?: number, logger?: object, now?: () => number}} [opts]
 * @returns {Promise<{processed: number, failed: number, dropped: number, remaining: number, locked?: boolean, deadlineHit?: boolean}>}
 */
export async function drainPostTurnWork(baseDbPath, agentId, process, opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const dir = queueDir(baseDbPath, agentId);
  const lockPath = join(dir, DRAIN_LOCK);
  try {
    acquireJobLock(lockPath, { staleMs: DRAIN_LOCK_STALE_MS, hardCeilingMs: DRAIN_LOCK_STALE_MS * JOB_LOCK_HARD_CEILING_FACTOR });
  } catch {
    return { processed: 0, failed: 0, dropped: 0, remaining: listEntryFiles(dir).length, locked: true };
  }
  const result = { processed: 0, failed: 0, dropped: 0, remaining: 0, deadlineHit: false };
  const startedAt = now();
  const maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : 10;
  const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : 300_000;
  try {
    for (const name of listEntryFiles(dir)) {
      if (result.processed >= maxEntries) break;
      if (now() - startedAt > budgetMs) {
        result.deadlineHit = true;
        break;
      }
      const path = join(dir, name);
      let entry;
      try {
        entry = JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        safeWarn(opts.logger, "post-turn-queue", err, { op: "parse", agentId });
        unlinkSync(path);
        result.dropped += 1;
        continue;
      }
      let ok = false;
      try {
        ok = (await process(entry)) === true;
      } catch (err) {
        safeWarn(opts.logger, "post-turn-queue", err, { op: "process", agentId });
      }
      if (ok) {
        unlinkSync(path);
        result.processed += 1;
        continue;
      }
      result.failed += 1;
      const attempts = (Number(entry.attempts) || 0) + 1;
      if (attempts >= POST_TURN_MAX_ATTEMPTS) {
        safeWarn(opts.logger, "post-turn-queue", "entry dropped after repeated failures", { agentId, attempts });
        unlinkSync(path);
        result.dropped += 1;
        continue;
      }
      writeEntryFile(path, { ...entry, attempts });
      break;
    }
  } finally {
    releaseJobLock(lockPath);
  }
  result.remaining = listEntryFiles(dir).length;
  return result;
}
