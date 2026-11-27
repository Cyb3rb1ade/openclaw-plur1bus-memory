/**
 * adapter/openclaw/register-cron.js — PR-03i.
 *
 * The two feature-cron registrations: the unsafe direct-cron turn guard on
 * `before_agent_reply` (was index.js:4544-4553) and the deferred feature-cron
 * bootstrap on `gateway_start` (was index.js:7046-7082).
 *
 * Both keep their own function and their own call site in `register()`. The
 * guard is registered before the chat-command surface installs its own
 * `before_agent_reply` handler, and the bootstrap keeps its `gateway_start`
 * slot between the Obsidian bridge pair and the Neo service pair; merging the
 * two into a single call would reorder the host's handler lists.
 *
 * `guardUnsafeDirectCronTurn`, `reconcileUnsafeDirectCronsWithService` and
 * `runDeferredFeatureCronBootstrap` stay top-level functions of `index.js`
 * (they are named exports 46 test files import, and the latter two take the
 * host handle as their own first parameter), so they arrive through `ctx`
 * rather than as imports.
 */

import { ensureEpistemicCutoff } from "../../lib/epistemic-cutoff.js";

/**
 * Register the turn guard that blocks unsafe direct feature-cron dispatch
 * while the host has no native cron capability.
 *
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerUnsafeDirectCronGuard(ctx) {
  const { api, cronDirectDispatchReady, guardUnsafeDirectCronTurn } = ctx;

  if (!cronDirectDispatchReady && typeof api.on === "function") {
    api.on(
      "before_agent_reply",
      (event, context) => guardUnsafeDirectCronTurn(
        event,
        context,
        { hostReady: cronDirectDispatchReady },
      ),
    );
  }
}

/**
 * Register the deferred feature-cron bootstrap on gateway_start.
 *
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerDeferredFeatureCronBootstrap(ctx) {
  const {
    api,
    baseDbPath,
    cfg,
    cronDirectDispatchReady,
    host,
    reconcileUnsafeDirectCronsWithService,
    runDeferredFeatureCronBootstrap,
  } = ctx;

  // Feature-cron bootstrap, deferred (installer/ClawHub channel): the
  // documented install path rsyncs the plugin and never runs npm, so the
  // postinstall hook (`npm install` → scripts/setup-feature-crons.mjs)
  // never fires there. This handler covers that gap for every install
  // channel — npm install, rsync/git-clone install, and ClawHub — without
  // depending on any of them running npm at all. See getFeatureCronsSetupHint
  // in index.js and shouldRunCronBootstrap/featureCronsHintFromMarker in
  // lib/setup/feature-cron-bootstrap.js for the pure throttle/hint logic.
  if (
    typeof api.on === "function"
    && (cfg.featureCronSetup?.auto !== false || !cronDirectDispatchReady)
  ) {
    api.on(
      "gateway_start",
      async (_event, gatewayContext) => {
        const cutoff = ensureEpistemicCutoff(baseDbPath);
        if (!cutoff.ok) host.logger.warn(`memory-lancedb-namespaced: epistemic cutoff unavailable (${cutoff.reason})`);
        if (!cronDirectDispatchReady) {
          await reconcileUnsafeDirectCronsWithService(api, gatewayContext);
        }
        // The in-process service closes the immediate safety window first.
        // CLI reconciliation remains deferred and retried so it can restore
        // only safely marked jobs after the native capability becomes ready.
        const timer = setTimeout(() => {
          runDeferredFeatureCronBootstrap(api, {
            cfg,
            baseDbPath,
            force: !cronDirectDispatchReady,
          }).catch((err) => {
            host.logger.debug(`plur1bus-feature-crons: deferred bootstrap failed: ${err?.message || err}`);
          });
        }, cronDirectDispatchReady ? 90_000 : 0);
        timer?.unref?.();
      },
      { timeoutMs: cronDirectDispatchReady ? 5_000 : 30_000 },
    );
  }
}
