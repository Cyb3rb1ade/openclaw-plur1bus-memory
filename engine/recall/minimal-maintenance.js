/**
 * engine/recall/minimal-maintenance.js
 *
 * The auto-recall-off branch of before_prompt_build (was index.js:13329-13420).
 * It still records the Neo hook dispatch, runs throttled GC, and emits the
 * non-droppable time/temporal/reminder blocks plus the maintenance nudges.
 * Host-neutral: everything it needs arrives in the context object.
 */

import { consumePlur1busStartNotice } from "../../lib/setup/feature-profiles.js";
import { formatReminderNudge } from "../../lib/reminder-nudge.js";
import { readPendingReminders, writePendingReminders } from "../../lib/reminder-pending.js";
import { listDueReminders, presentReminder } from "../../lib/reminder-store.js";
import { shouldSkipAutoRecallForInternalTurn } from "../../lib/runtime-scheduler.js";
import { recordActivity, formatTimeContext, getLastActivity } from "../../lib/session-time.js";
import { formatTemporalContinuityContext } from "../../lib/temporal-context.js";

/**
 * @param {object} ctx Engine context.
 * @param {object} ctx.host `HostServices` (types/engine.d.ts).
 * @param {(event: object, hookCtx: object) => {allowed: boolean}} ctx.automaticWorkspacePolicyDecision
 * @param {(args: {workspaceDir: string, schicht15Enabled: boolean, lang: string, tone: string, logger: object}) => {knowledgeNudge: string, conflictNudge: string}} ctx.buildMaintenanceNudges
 *   Declared in `index.js` (a public export, Global Constraint 9) — passed in rather than imported.
 * @param {boolean} ctx.gcEnabled
 * @param {(hookCtx: object, event: object) => object} ctx.getNeoStore
 * @param {boolean} ctx.neoEnabled
 * @param {{withDb: (agentId: string, fn: (db: object) => Promise<any>) => Promise<any>}} ctx.pool
 * @param {(args: {messages: object[]}) => {lang: string, tone: string}} ctx.resolveCommandLocaleRecall
 * @param {boolean} ctx.schicht15Enabled
 * @param {string} ctx.stateDir The OpenClaw state dir (`host.stateDir`).
 * @param {boolean} ctx.temporalContextEnabled
 * @returns {(event: object, hookCtx: object) => Promise<{prependContext: string}|undefined>} Handler.
 */
export function createMinimalMaintenance(ctx) {
  const {
    host,
    automaticWorkspacePolicyDecision,
    buildMaintenanceNudges,
    gcEnabled,
    getNeoStore,
    neoEnabled,
    pool,
    resolveCommandLocaleRecall,
    schicht15Enabled,
    stateDir,
    temporalContextEnabled,
  } = ctx;

  return async function minimalMaintenance(event, hookCtx) {
    const agentId = hookCtx?.agentId;
    if (!automaticWorkspacePolicyDecision(event, hookCtx).allowed) return undefined;
    if (neoEnabled) {
      try {
        const neoStore = getNeoStore(hookCtx, event);
        neoStore.recordHook("before_prompt_build", {
          agentId: hookCtx?.agentId || "default",
          promptLength: event?.prompt?.length || 0,
          autoRecallDisabled: true,
        });
      } catch (neoErr) {
        host.logger.warn(`plur1bus-neo: before_prompt_build dispatch tracking failed: ${String(neoErr)}`);
      }
    }
    // GC: purge expired memories (non-blocking, throttled on hot path)
    if (gcEnabled) {
      pool.withDb(agentId, (db) => db.purgeExpiredThrottled(host.logger)).catch((gcErr) => {
        host.logger.warn(`memory-lancedb-namespaced: GC purge with auto-recall disabled failed: ${String(gcErr)}`);
      });
    }
    // P0-1: Interne/background Turns bekommen keine Nudges (kein Prompt-Overhead).
    if (shouldSkipAutoRecallForInternalTurn(event, hookCtx)) {
      return undefined;
    }
    if (!hookCtx?.workspaceDir) return undefined;
    const pendingStartNotice = consumePlur1busStartNotice(stateDir);
    const startNoticeContext = pendingStartNotice
      ? `<plur1bus-start-notice>\n${pendingStartNotice}\n</plur1bus-start-notice>`
      : "";

    // Knowledge-update + conflict-review nudges (shared, localized helper;
    // conflict-log is read only once). #9 dedup + #11 i18n.
    const { lang, tone } = resolveCommandLocaleRecall({ messages: event?.messages || [] });
    const { knowledgeNudge: nudge, conflictNudge } = buildMaintenanceNudges({
      workspaceDir: hookCtx.workspaceDir,
      schicht15Enabled,
      lang,
      tone,
      logger: host.logger,
    });

    // --- Time Context & Reminder Nudge (auto-recall off) ---
    let timeContext = "";
    let temporalContinuityContext = "";
    let reminderNudge = "";
    try {
      await pool.withDb(agentId, async (db) => {
      // lang/tone bereits oben via resolveCommandLocale aufgelöst.
      const wsKey = hookCtx?.workspaceDir || "default";
      // Capture previous activity before recording the current turn
      const previousUserTurnAt = await getLastActivity(agentId, wsKey, hookCtx?.workspaceDir);
      timeContext = await formatTimeContext(agentId, wsKey, hookCtx?.workspaceDir, lang);
      if (temporalContextEnabled) {
        temporalContinuityContext = await formatTemporalContinuityContext(
          agentId,
          wsKey,
          hookCtx?.workspaceDir,
          { enabled: true, lang, now: Date.now(), previousUserTurnAt }
        );
      }
      await recordActivity(agentId, wsKey, hookCtx?.workspaceDir);
      const dueFromDb = await listDueReminders(db, agentId, wsKey);
      const pendingData = await readPendingReminders(hookCtx?.workspaceDir, wsKey, agentId);
      const dueFromPending = Object.values(pendingData.pending || {});
      const byId = new Map();
      for (const r of [...dueFromDb, ...dueFromPending]) {
        byId.set(r.id || r.reminderKey, r);
      }
      const allDue = [...byId.values()];
      if (allDue.length > 0) {
        reminderNudge = formatReminderNudge(allDue, { lang, tone });
        for (const r of dueFromDb) {
          await presentReminder(db, r.id).catch((err) => {
            host.logger.warn?.(`plur1bus-reminder: present failed for ${r.id}: ${String(err)}`);
          });
        }
        if (dueFromPending.length > 0) {
          for (const r of allDue) {
            delete pendingData.pending[r.id || r.reminderKey];
          }
          await writePendingReminders(hookCtx?.workspaceDir, wsKey, agentId, pendingData);
        }
      }
      });
    } catch (reminderErr) {
      host.logger.warn(`plur1bus-reminder: nudge injection failed (auto-recall off): ${String(reminderErr)}`);
    }
    if (nudge || conflictNudge || startNoticeContext || timeContext || temporalContinuityContext || reminderNudge) {
      return { prependContext: [startNoticeContext, nudge + conflictNudge, timeContext, temporalContinuityContext, reminderNudge].filter(Boolean).join("\n\n") };
    }
  };
}
