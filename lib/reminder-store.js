/**
 * lib/reminder-store.js
 * CRUD für Reminders als vollwertige LanceDB-Memories.
 * Nutzt zentrale Memory-Defaults via db.store(), nicht direktes table.add().
 */

import { randomUUID, createHash } from "node:crypto";
import { safeUuid, safeTimestamp, sqlString } from "./sql-safety.js";

const TERMINAL_REMINDER_STATUSES = new Set(["acknowledged", "cancelled"]);

function buildReminderKey(agentId, workspaceKey, text, remindAt) {
  return createHash("sha256")
    .update(`${workspaceKey}:${agentId}:${text}:${remindAt}`)
    .digest("hex")
    .slice(0, 32);
}

function isActiveReminder(row) {
  if (!row) return false;
  if (["archived", "deleted", "superseded"].includes(row.status)) return false;
  return !TERMINAL_REMINDER_STATUSES.has(row.reminderStatus || "scheduled");
}

/**
 * Speichert einen Reminder mit vollständigen v6-Defaults.
 * Gibt einen bestehenden aktiven Reminder mit gleichem reminderKey zurück.
 */
export async function saveReminder(db, opts) {
  const { text, remindAt, agentId, workspaceKey, source = "user", embeddings, initialStatus = "scheduled" } = opts;

  const id = safeUuid(randomUUID());
  const safeRemindAt = safeTimestamp(Number(remindAt));
  const reminderKey = buildReminderKey(agentId, workspaceKey, text, safeRemindAt);

  const existing = await db.table
    .query()
    .where(`memoryKind = 'reminder' AND storedBy = ${sqlString(agentId)} AND workspaceKey = ${sqlString(workspaceKey)} AND reminderKey = ${sqlString(reminderKey)}`)
    .limit(20)
    .toArray();
  const activeExisting = existing
    .filter(isActiveReminder)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
  if (activeExisting) return activeExisting;

  // Embedding für vector search
  let vector = null;
  if (embeddings?.embedQuery) {
    vector = await embeddings.embedQuery(text);
  }

  const raw = {
    id,
    text,
    memoryKind: "reminder",
    category: "reminder",
    reminderStatus: initialStatus,
    remindAt: safeRemindAt,
    remindedAt: 0,
    dispatchedAt: 0,
    acknowledgedAt: 0,
    cancelledAt: 0,
    reminderKey,
    dispatchCount: 0,
    lastDispatchAttemptAt: 0,
    nextDispatchAttemptAt: 0,
    createdAt: Date.now(),
    sourceTimestamp: Date.now(),
    storedBy: agentId,
    workspaceKey,
    importance: 0.9,
    memoryClass: "working",
    confirmed: true,
    status: "active",
    versionNumber: 1,
    memoryStrength: 1.0,
    halfLifeDays: 30,
    retrievalCount: 0,
    replayCount: 0,
    emotionalValence: "",
    emotionalIntensity: 0,
    emotionalDominant: "neutral",
    vector,
  };

  // Store via centralized path (same as normal memories)
  await db.store(raw);
  return raw;
}

/**
 * Listet fällige Reminders für einen Agenten in einem Workspace.
 * Failed Reminders werden erst nach nextDispatchAttemptAt erneut gelistet.
 */
export async function listDueReminders(db, agentId, workspaceKey, now = Date.now()) {
  const safeNow = safeTimestamp(now);
  const results = await db.table
    .query()
    .where(`memoryKind = 'reminder' AND storedBy = ${sqlString(agentId)} AND workspaceKey = ${sqlString(workspaceKey)} AND remindAt <= ${safeNow} AND remindAt > 0 AND (reminderStatus IN ('scheduled', 'due') OR (reminderStatus = 'failed' AND nextDispatchAttemptAt > 0 AND nextDispatchAttemptAt <= ${safeNow}))`)
    .limit(50)
    .toArray();
  return results;
}

/**
 * Listet alle Reminders eines Agenten (für Admin/Debug).
 */
export async function listReminders(db, agentId, workspaceKey) {
  return db.table
    .query()
    .where(`memoryKind = 'reminder' AND storedBy = ${sqlString(agentId)} AND workspaceKey = ${sqlString(workspaceKey)}`)
    .limit(200)
    .toArray();
}

/**
 * Present: markiert als "im Prompt gezeigt" — NICHT erledigt.
 * Der Reminder bleibt aktiv bis explizite Bestätigung (acknowledged).
 */
export async function presentReminder(db, id) {
  const safeId = safeUuid(id);
  await db.table.update({ where: `id = ${sqlString(safeId)}`, values: {
    reminderStatus: "presented",
    remindedAt: Date.now(),
  }});
}

/**
 * Acknowledge: markiert als explizit erledigt (nur bei User/Agent-Bestätigung).
 * z.B. /plur1bus reminder done <id> oder Agent erkennt "erledigt".
 */
export async function acknowledgeReminder(db, id) {
  const safeId = safeUuid(id);
  await db.table.update({ where: `id = ${sqlString(safeId)}`, values: {
    reminderStatus: "acknowledged",
    acknowledgedAt: Date.now(),
  }});
}

/**
 * Cancel: markiert als abgebrochen.
 */
export async function cancelReminder(db, id) {
  const safeId = safeUuid(id);
  await db.table.update({ where: `id = ${sqlString(safeId)}`, values: {
    reminderStatus: "cancelled",
    cancelledAt: Date.now(),
  }});
}

/**
 * Mark as pending (wird vom Dispatch-Job aufgerufen).
 */
/**
 * Mark as pending (wird vom Dispatch-Job aufgerufen).
 * HINWEIS: dispatchCount-Update ist nicht atomisch bei concurrent dispatchern.
 * Für MVP akzeptabel; bei hoher Parallelität sollte DB-seitiges increment genutzt werden.
 */
export async function markReminderPending(db, id) {
  const safeId = safeUuid(id);
  const rows = await db.table.query().where(`id = ${sqlString(safeId)}`).limit(1).toArray();
  const current = rows[0];
  await db.table.update({ where: `id = ${sqlString(safeId)}`, values: {
    reminderStatus: "pending",
    dispatchedAt: Date.now(),
    dispatchCount: (current?.dispatchCount || 0) + 1,
  }});
}
