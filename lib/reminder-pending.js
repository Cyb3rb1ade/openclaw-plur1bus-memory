/**
 * lib/reminder-pending.js
 * Atomische Pending-Queue für Reminders pro Workspace+Agent.
 */

import { readFile, writeFile, access, mkdir, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

function safePathSegment(seg) {
  // Sanitize workspaceKey and agentId for filesystem use
  return seg.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function pendingPath(workspaceDir, workspaceKey, agentId) {
  const safeWs = safePathSegment(workspaceKey);
  const safeAgent = safePathSegment(agentId);
  return join(workspaceDir, ".adaptive-learning", "reminders", safeWs, safeAgent, "pending-reminders.json");
}

async function ensureDir(path) {
  const dir = dirname(path);
  try {
    await access(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }
}

export async function readPendingReminders(workspaceDir, workspaceKey, agentId) {
  const path = pendingPath(workspaceDir, workspaceKey, agentId);
  try {
    await access(path);
    const data = await readFile(path, "utf8");
    return JSON.parse(data);
  } catch { return {}; }
}

export async function writePendingReminders(workspaceDir, workspaceKey, agentId, data) {
  const path = pendingPath(workspaceDir, workspaceKey, agentId);
  await ensureDir(path);
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

export async function addPendingReminder(workspaceDir, workspaceKey, agentId, reminder) {
  const data = await readPendingReminders(workspaceDir, workspaceKey, agentId);
  if (!data.pending) data.pending = {};
  // Idempotenz: Überschreibe, nicht dupliziere
  data.pending[reminder.id] = {
    id: reminder.id,
    text: reminder.text,
    remindAt: reminder.remindAt,
    status: "pending",
    createdAt: Date.now(),
  };
  await writePendingReminders(workspaceDir, workspaceKey, agentId, data);
}

export async function removePendingReminder(workspaceDir, workspaceKey, agentId, reminderId) {
  const data = await readPendingReminders(workspaceDir, workspaceKey, agentId);
  if (data.pending) {
    delete data.pending[reminderId];
  }
  await writePendingReminders(workspaceDir, workspaceKey, agentId, data);
}

export async function clearPendingReminders(workspaceDir, workspaceKey, agentId) {
  const path = pendingPath(workspaceDir, workspaceKey, agentId);
  try {
    await access(path);
    await unlink(path);
  } catch { /* ignore */ }
}
