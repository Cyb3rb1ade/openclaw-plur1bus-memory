/**
 * lib/jobs/reminder-dispatch.js
 * Cron-Job: prüft fällige Reminders, schreibt Pending-Queue, optional Delivery.
 */

import { acquireJobLock, releaseJobLock, JOB_LOCK_HARD_CEILING_FACTOR } from "../job-lock.js";
import { checkJobRateLimit, recordJobRun } from "../job-rate-limit.js";
import { listDueReminders, markReminderPending } from "../reminder-store.js";
import { addPendingReminder, clearPendingReminders } from "../reminder-pending.js";
import { sqlString } from "../sql-safety.js";
import { fetchWithTimeout } from "../fetch-with-timeout.js";
import { join } from "node:path";
import { describeError } from "../log-redact.js";

const JOB_KEY = "reminder-dispatch";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_LOCK_STALE_MS = 2 * 60 * 1000; // reminder dispatch should recover quickly
const DEFAULT_RETRY_DELAY_MS = 5 * 60_000;
// Delivery attempts (counted by markReminderPending in dispatchCount) after
// which a failing reminder is parked: status `failed`, no nextDispatchAttemptAt,
// so listDueReminders never selects it again.
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 5;

export async function runReminderDispatch(db, agentId, opts = {}) {
  const {
    workspaceDir,
    workspaceKey,
    logger = { info: () => {}, warn: () => {} },
    deliveryMode = "pending_only",
    webhookUrl = null,
    dryRun = false,
    callApi = null, // optional host callback function
    lockStaleMs = DEFAULT_LOCK_STALE_MS,
    maxDispatchAttempts = DEFAULT_MAX_DISPATCH_ATTEMPTS,
  } = opts;
  const attemptCap = Number.isFinite(Number(maxDispatchAttempts)) && Number(maxDispatchAttempts) >= 1
    ? Math.floor(Number(maxDispatchAttempts))
    : DEFAULT_MAX_DISPATCH_ATTEMPTS;

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
    lockAcquired = acquireJobLock(lockPath, { staleMs: lockStaleMs, hardCeilingMs: lockStaleMs * JOB_LOCK_HARD_CEILING_FACTOR });
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

    const markDispatched = (id) => db.table.update({ where: `id = ${sqlString(id)}`, values: {
      reminderStatus: "dispatched",
      dispatchedAt: Date.now(),
    }});
    for (const r of due) {
      let deliveryOk = false;
      // markReminderPending (below) counts this attempt in dispatchCount.
      const attempt = (Number(r.dispatchCount) || 0) + 1;
      const markFailed = () => db.table.update({ where: `id = ${sqlString(r.id)}`, values: {
        reminderStatus: "failed",
        lastDispatchAttemptAt: Date.now(),
        // Past the cap no retry is scheduled: listDueReminders only re-selects
        // `failed` rows with nextDispatchAttemptAt > 0.
        nextDispatchAttemptAt: attempt >= attemptCap ? 0 : Date.now() + DEFAULT_RETRY_DELAY_MS,
      }});
      try {
        if (!dryRun) {
          // Mark as pending in DB
          await markReminderPending(db, r.id);
          // Write to pending queue (idempotent)
          await addPendingReminder(workspaceDir, workspaceKey, agentId, r);
        }

        // Optional delivery
        if (deliveryMode === "webhook" && webhookUrl) {
          const resp = await fetchWithTimeout(webhookUrl, {
            method: "POST",
            // The id is stable across legitimate retries of the same reminder,
            // so a receiver can drop a duplicate.
            headers: { "Content-Type": "application/json", "Idempotency-Key": String(r.id) },
            body: JSON.stringify({
              agentId,
              workspaceKey,
              reminder: { id: r.id, text: r.text, remindAt: r.remindAt },
              timestamp: new Date().toISOString(),
            }),
          }, 10_000);
          deliveryOk = resp.ok;
        }

        if (deliveryMode === "host_callback" && callApi) {
          await callApi({ type: "reminder", agentId, reminder: r });
          deliveryOk = true;
        }

        // Update DB status based on delivery outcome. Once delivered, a failing
        // status write must not fall through to the catch below: that would mark
        // the row `failed` with a retry time and send the same reminder again.
        if (!dryRun && deliveryMode !== "pending_only") {
          if (deliveryOk) {
            try {
              await markDispatched(r.id);
            } catch (statusErr) {
              logger.warn?.(`${JOB_KEY}[${agentId}]: delivered ${r.id} but the status write failed: ${describeError(statusErr)}`);
              // One more try; if it fails too, the row stays `pending`, which
              // listDueReminders never selects, so there is no second delivery.
              await markDispatched(r.id).catch(() => {});
            }
          } else {
            await markFailed();
          }
        }

        dispatched.push({ id: r.id, text: r.text, remindAt: r.remindAt, deliveryOk });
      } catch (err) {
        failed.push({ id: r.id, error: err.message });
        logger.warn?.(`${JOB_KEY}[${agentId}]: dispatch failed for ${r.id}: ${describeError(err)}`);
        if (!dryRun) {
          await markFailed().catch((statusErr) => {
            logger.warn?.(`${JOB_KEY}[${agentId}]: failed to mark ${r.id} as failed: ${statusErr.message}`);
          });
        }
      }
    }

    if (!dryRun) {
      await recordJobRun(JOB_KEY, agentId, workspaceKey, statePath);
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
