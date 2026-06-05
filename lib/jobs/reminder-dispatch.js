/**
 * lib/jobs/reminder-dispatch.js
 * Cron-Job: prüft fällige Reminders, schreibt Pending-Queue, optional Delivery.
 */

import { acquireJobLock, releaseJobLock } from "../job-lock.js";
import { checkJobRateLimit, recordJobRun } from "../job-rate-limit.js";
import { listDueReminders, markReminderPending } from "../reminder-store.js";
import { addPendingReminder, clearPendingReminders } from "../reminder-pending.js";
import { sqlString } from "../sql-safety.js";
import { join } from "node:path";

const JOB_KEY = "reminder-dispatch";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function runReminderDispatch(db, agentId, opts = {}) {
  const {
    workspaceDir,
    workspaceKey,
    logger = { info: () => {}, warn: () => {} },
    deliveryMode = "pending_only",
    webhookUrl = null,
    dryRun = false,
    callApi = null, // optional host callback function
  } = opts;

  const timestamp = new Date().toISOString();

  if (!workspaceDir || !workspaceKey) {
    return { timestamp, agentId, skipped: true, reason: "missing_workspace" };
  }

  // Rate limit
  const statePath = join(workspaceDir, "run-state.json");
  const rateLimit = checkJobRateLimit(JOB_KEY, agentId, workspaceKey, DEFAULT_INTERVAL_MS, statePath);
  if (!rateLimit.allowed) {
    return { timestamp, agentId, skipped: true, reason: "rate_limited", remainingMs: rateLimit.remainingMs };
  }

  // Lock
  const lockPath = join(workspaceDir, "locks", `${JOB_KEY}-${agentId}.lock`);
  let lockAcquired = null;
  try {
    lockAcquired = acquireJobLock(lockPath);
  } catch (lockErr) {
    return { timestamp, agentId, skipped: true, reason: "lock_held" };
  }

  try {
    if (db && typeof db.init === "function") {
      await db.init();
    }

    const now = Date.now();
    const due = await listDueReminders(db, agentId, workspaceKey, now);
    const dispatched = [];
    const failed = [];

    for (const r of due) {
      let deliveryOk = false;
      try {
        if (!dryRun) {
          // Mark as pending in DB
          await markReminderPending(db, r.id);
          // Write to pending queue (idempotent)
          await addPendingReminder(workspaceDir, workspaceKey, agentId, r);
        }

        // Optional delivery
        if (deliveryMode === "webhook" && webhookUrl) {
          const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agentId,
              workspaceKey,
              reminder: { id: r.id, text: r.text, remindAt: r.remindAt },
              timestamp: new Date().toISOString(),
            }),
          });
          deliveryOk = resp.ok;
        }

        if (deliveryMode === "host_callback" && callApi) {
          await callApi({ type: "reminder", agentId, reminder: r });
          deliveryOk = true;
        }

        // Update DB status based on delivery outcome
        if (!dryRun && deliveryMode !== "pending_only") {
          if (deliveryOk) {
            await db.table.update({ where: `id = ${sqlString(r.id)}`, values: {
              reminderStatus: "dispatched",
              dispatchedAt: Date.now(),
            }});
          } else {
            await db.table.update({ where: `id = ${sqlString(r.id)}`, values: {
              reminderStatus: "failed",
              lastDispatchAttemptAt: Date.now(),
              nextDispatchAttemptAt: Date.now() + 5 * 60_000,
            }});
          }
        }

        dispatched.push({ id: r.id, text: r.text, remindAt: r.remindAt, deliveryOk });
      } catch (err) {
        failed.push({ id: r.id, error: err.message });
        logger.warn?.(`${JOB_KEY}[${agentId}]: dispatch failed for ${r.id}: ${err.message}`);
        if (!dryRun) {
          await db.table.update({ where: `id = ${sqlString(r.id)}`, values: {
            reminderStatus: "failed",
            lastDispatchAttemptAt: Date.now(),
            nextDispatchAttemptAt: Date.now() + 5 * 60_000,
          }}).catch(() => {});
        }
      }
    }

    if (!dryRun) {
      recordJobRun(JOB_KEY, agentId, workspaceKey, statePath);
    }

    return {
      timestamp,
      agentId,
      skipped: false,
      dispatched: dispatched.length,
      failed: failed.length,
      details: dispatched,
      deliveryMode,
      dryRun,
    };
  } finally {
    if (lockAcquired) releaseJobLock(lockAcquired);
  }
}
