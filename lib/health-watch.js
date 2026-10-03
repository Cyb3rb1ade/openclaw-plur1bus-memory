// Health watch: two signal sources the Memory Health scan cannot see.
//
// 1. LLM router failures, counted in-process. The router logs one redacted
//    line per failed dispatch; until 7.18.0 nothing counted them, so a feature
//    failing every run for days (Bernhardine's dream narrative, 30.09.2026)
//    only showed up when someone read the gateway log.
// 2. A fixed set of OpenClaw gateway log signals that stand for lost replies
//    or a wedged gateway (agent-db cleanup failure, ingress adoption stalls,
//    turns that completed without a reply payload, critical memory pressure).
//
// Both are aggregate-only: the dashboard gets counts, categories and
// timestamps — never a log line, a path or an error message.

import { open, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { safeDebug } from "./safe-logging.js";
import { resolveInside } from "./sql-safety.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DEFAULT_LOG_DIR = "/tmp/openclaw";
const DEFAULT_MAX_BYTES_PER_FILE = 8 * 1024 * 1024;
const DATE_RE = /"date":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)"/;

/**
 * Gateway log signals. `failedWithinMs` turns a recent hit into a hard failure
 * (the agent-db wedge stops every agent until restart); everything else only
 * degrades the badge.
 */
export const GATEWAY_LOG_SIGNALS = Object.freeze([
  Object.freeze({
    id: "agent-db-cleanup",
    label: "Agent database cleanup failed",
    match: (line) => line.includes("Agent database cleanup failed"),
    failedWithinMs: 15 * 60 * 1000,
  }),
  Object.freeze({
    id: "ingress-stall",
    label: "Channel ingress adoption stalled",
    match: (line) => line.includes("claim→adoption stalled") || line.includes("claim->adoption stalled"),
  }),
  Object.freeze({
    id: "reply-dropped",
    label: "Turn completed without a reply payload",
    match: (line) => line.includes("no queued reply payloads") && line.includes("cause=completed"),
  }),
  Object.freeze({
    id: "memory-critical",
    label: "Gateway memory pressure critical",
    // reason=rss_growth also fires as critical while a freshly started gateway
    // warms up (>1 GiB growth from a low start); only the absolute threshold
    // is a real signal.
    match: (line) => line.includes("memory pressure: level=critical") && line.includes("reason=rss_threshold"),
  }),
]);

function safeLabel(value) {
  return typeof value === "string" && SAFE_LABEL_RE.test(value) ? value : null;
}

function nowFrom(now) {
  const value = typeof now === "function" ? now() : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

/**
 * In-memory, bounded record of failed LLM router dispatches.
 * @param {{ windowMs?: number, maxEntries?: number, now?: () => number }} [options]
 * @returns {{ record: (failure: object) => void, snapshot: () => Array<object> }}
 */
export function createLlmFailureRecorder({ windowMs = DAY_MS, maxEntries = 500, now } = {}) {
  const entries = [];
  const prune = (at) => {
    const cutoff = at - windowMs;
    while (entries.length && entries[0].at < cutoff) entries.shift();
    while (entries.length > maxEntries) entries.shift();
  };
  return Object.freeze({
    record(failure = {}) {
      const at = nowFrom(now);
      entries.push({
        at,
        feature: safeLabel(failure.feature) || "unknown",
        agentId: safeLabel(failure.agentId),
        hint: safeLabel(failure.hint) || "unknown",
        errorClass: safeLabel(failure.errorClass),
      });
      prune(at);
    },
    snapshot() {
      prune(nowFrom(now));
      const groups = new Map();
      for (const entry of entries) {
        const key = `${entry.feature}\u0000${entry.agentId || ""}\u0000${entry.hint}`;
        const group = groups.get(key) || {
          feature: entry.feature, agentId: entry.agentId, hint: entry.hint,
          errorClass: entry.errorClass, count: 0, lastAt: 0,
        };
        group.count += 1;
        if (entry.at >= group.lastAt) {
          group.lastAt = entry.at;
          group.errorClass = entry.errorClass;
        }
        groups.set(key, group);
      }
      return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
    },
  });
}

function localDateStamp(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Directory and file names to scan. OpenClaw rolls `openclaw-YYYY-MM-DD.log`
 * by local date; a configured non-rolling `logging.file` is read as is.
 * @param {{ gatewayLogDir?: string, loggingFile?: string, nowMs: number }} options
 * @returns {{ dir: string, files: string[] }}
 */
export function resolveGatewayLogFiles({ gatewayLogDir, loggingFile, nowMs }) {
  const rollingNames = [localDateStamp(nowMs - DAY_MS), localDateStamp(nowMs)]
    .map((stamp) => `openclaw-${stamp}.log`);
  if (typeof gatewayLogDir === "string" && gatewayLogDir.trim()) {
    return { dir: gatewayLogDir.trim(), files: rollingNames };
  }
  if (typeof loggingFile === "string" && loggingFile.trim()) {
    const file = loggingFile.trim();
    if (!/\d{4}-\d{2}-\d{2}/.test(basename(file))) return { dir: dirname(file), files: [basename(file)] };
    return { dir: dirname(file), files: rollingNames };
  }
  return { dir: DEFAULT_LOG_DIR, files: rollingNames };
}

async function readTail(path, maxBytes) {
  const info = await stat(path);
  const length = Math.min(info.size, maxBytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    // A cut-off first line cannot be parsed; drop it unless we read the file whole.
    return length < info.size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/**
 * Count gateway log signals inside the window, reading only the tail of
 * today's and yesterday's log.
 * @param {{ dir: string, files: string[], nowMs?: number, windowMs?: number, maxBytesPerFile?: number, logger?: object }} options
 * @returns {Promise<{ readable: boolean, signals: Array<{ id: string, count: number, lastAt: number|null }> }>}
 */
export async function scanGatewayLog({
  dir,
  files,
  nowMs = Date.now(),
  windowMs = DAY_MS,
  maxBytesPerFile = DEFAULT_MAX_BYTES_PER_FILE,
  logger,
} = {}) {
  const counts = new Map(GATEWAY_LOG_SIGNALS.map((signal) => [signal.id, { id: signal.id, count: 0, lastAt: null }]));
  const cutoff = nowMs - windowMs;
  // One event writes several lines (lane error, cron receipt, retry notice).
  // Lines of the same signal within the same second count once.
  const seen = new Set();
  let readable = false;
  for (const name of Array.isArray(files) ? files : []) {
    let text;
    try {
      text = await readTail(resolveInside(dir, name), maxBytesPerFile);
      readable = true;
    } catch (err) {
      if (err?.code !== "ENOENT") safeDebug(logger, "health-watch", err, { component: "gateway-log" });
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const signal = GATEWAY_LOG_SIGNALS.find((candidate) => candidate.match(line));
      if (!signal) continue;
      const stamp = DATE_RE.exec(line);
      const at = stamp ? Date.parse(stamp[1]) : NaN;
      if (!Number.isFinite(at) || at < cutoff || at > nowMs + 60_000) continue;
      const eventKey = `${signal.id}:${Math.floor(at / 1000)}`;
      if (seen.has(eventKey)) continue;
      seen.add(eventKey);
      const entry = counts.get(signal.id);
      entry.count += 1;
      entry.lastAt = entry.lastAt === null ? at : Math.max(entry.lastAt, at);
    }
  }
  return { readable, signals: [...counts.values()] };
}

/**
 * Cache the log scan so opening the dashboard repeatedly reads the log at most
 * once per TTL. There is no timer: the scan only runs when someone looks.
 * @param {{ ttlMs?: number, scan: () => Promise<object>, now?: () => number }} options
 * @returns {{ snapshot: () => Promise<object|null> }}
 */
export function createGatewayLogWatch({ ttlMs = 60_000, scan, now } = {}) {
  let cached = null;
  let cachedAt = 0;
  let inflight = null;
  return Object.freeze({
    async snapshot() {
      const at = nowFrom(now);
      if (cached && at - cachedAt < ttlMs) return cached;
      if (!inflight) {
        inflight = Promise.resolve()
          .then(() => scan())
          .then((result) => {
            cached = result;
            cachedAt = nowFrom(now);
            return result;
          })
          .finally(() => { inflight = null; });
      }
      return inflight;
    },
  });
}

const STATE_RANK = Object.freeze({ ready: 0, unavailable: 1, degraded: 2, failed: 3 });

function worst(states) {
  return states.reduce((acc, state) => (STATE_RANK[state] > STATE_RANK[acc] ? state : acc), "ready");
}

/**
 * Dashboard projection: badge state plus the aggregate rows, nothing else.
 * @param {{ llmFailures?: Array<object>, logScan?: object|null, nowMs?: number }} input
 * @returns {object}
 */
export function projectHealthWatch({ llmFailures = [], logScan = null, nowMs = Date.now() } = {}) {
  const llm = (Array.isArray(llmFailures) ? llmFailures : [])
    .filter((row) => row && Number.isSafeInteger(row.count) && row.count > 0)
    .slice(0, 20)
    .map((row) => ({
      feature: safeLabel(row.feature) || "unknown",
      agentId: safeLabel(row.agentId),
      hint: safeLabel(row.hint) || "unknown",
      errorClass: safeLabel(row.errorClass),
      count: row.count,
      lastAt: Number.isFinite(row.lastAt) ? row.lastAt : null,
    }));
  // Timeouts happen under load; a feature that fails the same way three times
  // a day is broken, not busy.
  const llmState = llm.some((row) => row.count >= 3 && row.hint !== "timeout" && row.hint !== "aborted")
    ? "degraded" : "ready";

  const readable = logScan?.readable === true;
  const byId = new Map((Array.isArray(logScan?.signals) ? logScan.signals : []).map((entry) => [entry?.id, entry]));
  const gateway = GATEWAY_LOG_SIGNALS.map((signal) => {
    const entry = byId.get(signal.id) || {};
    const count = Number.isSafeInteger(entry.count) && entry.count >= 0 ? entry.count : 0;
    const lastAt = Number.isFinite(entry.lastAt) ? entry.lastAt : null;
    let state = count > 0 ? "degraded" : "ready";
    if (count > 0 && signal.failedWithinMs && lastAt !== null && nowMs - lastAt <= signal.failedWithinMs) state = "failed";
    return { id: signal.id, label: signal.label, count, lastAt, state: readable ? state : "unavailable" };
  });
  const gatewayState = readable ? worst(gateway.map((row) => row.state)) : "unavailable";

  return {
    status: worst([llmState, gatewayState]),
    windowHours: 24,
    llm: { state: llmState, failures: llm },
    gateway: { state: gatewayState, readable, attempted: logScan !== null && typeof logScan === "object", signals: gateway },
  };
}
