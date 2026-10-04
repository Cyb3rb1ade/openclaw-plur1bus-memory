/**
 * lib/review-workspace-status.js — what the agent's workspace last wrote, for
 * the evening review.
 *
 * Until 7.18.11 the evening review only audited memory quality. Whether the
 * daily note, the dream diary, the REM report or KNOWLEDGE.md were actually
 * written was invisible. This module reads file names and mtimes, plus the
 * count and age of the KNOWLEDGE.md queue (no memory content), and leaves out
 * anything the workspace does not have, so installations without dreaming or
 * daily notes get no extra lines.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import { safeDebug } from "./safe-logging.js";
import { resolveInside } from "./sql-safety.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_NOTE = /^(\d{4}-\d{2}-\d{2})(?:-\d{4})?\.md$/;
// REM runs weekly; one missed week is the warning threshold. The same week
// applies to KNOWLEDGE.md while memories wait for it.
const REM_STALE_DAYS = 8;
const KNOWLEDGE_STALE_DAYS = 8;
// The REM run writes its report and the dream diary entry together.
const DIARY_REM_SLACK_MS = 6 * 60 * 60 * 1000;

function localDate(date, timeZone) {
  const parts = { year: "", month: "", day: "" };
  try {
    for (const part of new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(timeZone ? { timeZone } : {}) }).formatToParts(date)) {
      if (part.type in parts) parts[part.type] = part.value;
    }
  } catch {
    return date.toISOString().slice(0, 10);
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function daysBetween(fromIsoDate, toIsoDate) {
  return Math.round((Date.parse(`${toIsoDate}T00:00:00Z`) - Date.parse(`${fromIsoDate}T00:00:00Z`)) / DAY_MS);
}

function insideOrNull(workspaceDir, ...parts) {
  try {
    const path = resolveInside(workspaceDir, ...parts);
    return existsSync(path) ? path : null;
  } catch (err) {
    safeDebug(null, "review-workspace-status:path", err, { parts: parts.join("/") });
    return null;
  }
}

function fileMtime(workspaceDir, ...parts) {
  const path = insideOrNull(workspaceDir, ...parts);
  if (!path) return null;
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.mtime : null;
  } catch (err) {
    safeDebug(null, "review-workspace-status:stat", err);
    return null;
  }
}

function newestEntry(workspaceDir, parts, accept = () => true) {
  const dir = insideOrNull(workspaceDir, ...parts);
  if (!dir) return null;
  let newest = null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !accept(entry.name)) continue;
      const mtime = fileMtime(dir, entry.name);
      if (mtime && (!newest || mtime > newest.mtime)) newest = { name: entry.name, mtime };
    }
  } catch (err) {
    safeDebug(null, "review-workspace-status:readdir", err);
    return null;
  }
  return newest;
}

function dailyNoteStatus(workspaceDir, today) {
  const dir = insideOrNull(workspaceDir, "memory");
  if (!dir) return null;
  let latest = null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const match = entry.isFile() ? DAILY_NOTE.exec(entry.name) : null;
      if (!match) continue;
      const mtime = fileMtime(dir, entry.name);
      if (!mtime) continue;
      if (!latest || match[1] > latest.date || (match[1] === latest.date && mtime > latest.mtime)) {
        latest = { date: match[1], mtime };
      }
    }
  } catch (err) {
    safeDebug(null, "review-workspace-status:daily", err);
    return null;
  }
  if (!latest) return null;
  const ageDays = daysBetween(latest.date, today);
  // The note for a day is written late that evening, so at review time
  // yesterday's note is the newest one that can exist.
  return { ...latest, ageDays, ok: ageDays <= 1 };
}

// Count and age of the memories waiting for KNOWLEDGE.md (Schicht 1.5).
function knowledgePendingStatus(workspaceDir) {
  const path = insideOrNull(workspaceDir, ".adaptive-learning", "knowledge-pending.json");
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const items = Array.isArray(raw?.pending) ? raw.pending : [];
    const times = items.map((item) => Date.parse(item?.queuedAt)).filter(Number.isFinite);
    return { count: items.length, oldest: times.length > 0 ? new Date(Math.min(...times)) : null };
  } catch (err) {
    safeDebug(null, "review-workspace-status:knowledge-pending", err);
    return null;
  }
}

/**
 * Collect the workspace write status shown in the evening review.
 *
 * @param {string} workspaceDir
 * @param {{now?: Date, timeZone?: string}} [opts]
 * @returns {{dailyNote?: object, lightDream?: object, remDream?: object, dreamDiary?: object, memoryFile?: object, knowledge?: object} | null}
 */
export function collectReviewWorkspaceStatus(workspaceDir, opts = {}) {
  if (typeof workspaceDir !== "string" || !workspaceDir || !existsSync(workspaceDir)) return null;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const today = localDate(now, opts.timeZone);
  const status = {};

  const dailyNote = dailyNoteStatus(workspaceDir, today);
  if (dailyNote) status.dailyNote = dailyNote;

  const light = newestEntry(workspaceDir, ["memory", "dream-diary", "light"], (name) => name.endsWith(".md"));
  if (light) status.lightDream = { mtime: light.mtime };

  const rem = newestEntry(workspaceDir, ["memory", "dream-diary", "rem"], (name) => name.endsWith(".md"));
  if (rem) {
    const ageDays = daysBetween(localDate(rem.mtime, opts.timeZone), today);
    status.remDream = { mtime: rem.mtime, week: /^(\d{4}-W\d{2})/.exec(rem.name)?.[1] || "", ageDays, ok: ageDays <= REM_STALE_DAYS };
  }

  for (const [key, parts] of [["dreamDiary", ["DREAMS.md"]], ["memoryFile", ["MEMORY.md"]], ["knowledge", ["memory", "KNOWLEDGE.md"]]]) {
    const mtime = fileMtime(workspaceDir, ...parts);
    if (mtime) status[key] = { mtime, ageDays: daysBetween(localDate(mtime, opts.timeZone), today) };
  }

  // The diary gets its automatic entry with each REM run; a REM report
  // without a matching diary write means the diary step failed.
  if (status.dreamDiary && status.remDream) {
    status.dreamDiary.withRem = true;
    status.dreamDiary.ok = status.dreamDiary.mtime.getTime() >= status.remDream.mtime.getTime() - DIARY_REM_SLACK_MS;
  }

  const pending = knowledgePendingStatus(workspaceDir);
  if (pending && status.knowledge) {
    status.knowledge.pending = pending.count;
    status.knowledge.pendingSince = pending.oldest;
    status.knowledge.ok = pending.count === 0 || status.knowledge.ageDays <= KNOWLEDGE_STALE_DAYS;
  }

  return Object.keys(status).length > 0 ? status : null;
}
