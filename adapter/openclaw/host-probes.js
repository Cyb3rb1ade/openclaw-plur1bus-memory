/**
 * adapter/openclaw/host-probes.js — the five pre-register() functions that
 * take the raw OpenClaw `api` capability surface directly, rather than
 * `HostServices`. They run before `register()` builds `host` (feature-cron
 * native-capability probing, immediate cron safety reconciliation, the
 * deferred feature-cron bootstrap, and reaction-capability auto-detection),
 * so there is no `host` for them to close over.
 *
 * Moved verbatim from index.js (:3184-3194, :3285-3299, :3329-3385,
 * :3398-3511, :4107-4121 at 9fd7bab4); index.js re-exports these names.
 */

import { join } from "node:path";

import { readJsonSafe, writeJsonAtomic } from "../../lib/atomic-file.js";
import { runtimeIfUsable } from "../../lib/runtime-shutdown.js";
import { withTimeout } from "../../lib/with-timeout.js";
import { planUnsafeDirectCronDisables } from "../../lib/setup/feature-cron-plan.js";
import { shouldRunCronBootstrap } from "../../lib/setup/feature-cron-bootstrap.js";
import { PLUGIN_ROOT, PLUGIN_VERSION } from "../../lib/plugin-meta.js";
import { featureCronsMarkerPath, parseFeatureCronBootstrapLastPlanCreateCount, resetFeatureCronsHintCache } from "../../lib/feature-crons-hint.js";

function resolveNeoHooksConfig(api, commandConfig) {
  try {
    const cfg = commandConfig || runtimeIfUsable(api)?.config?.current?.();
    return cfg?.plugins?.entries?.["memory-lancedb-namespaced"]?.hooks || {};
  } catch (error) {
    // An empty object disables every Neo hook. Say so rather than looking
    // like a deliberately empty configuration.
    api?.logger?.warn?.(`memory-lancedb-namespaced: neo hook config unreadable, all neo hooks stay disabled: ${String(error)}`);
    return {};
  }
}

/**
 * Inspect the public OpenClaw capabilities required by model-free feature
 * crons. Missing capabilities are reported explicitly and leave only the
 * affected cron path fail-closed; OpenClaw runtime files are never modified.
 *
 * @param {object} api
 * @returns {boolean}
 */
function inspectCronNativeCapabilities(api) {
  const missing = [
    ["registerGatewayMethod", api?.registerGatewayMethod],
    ["registerCli", api?.registerCli],
  ].filter(([, capability]) => typeof capability !== "function").map(([name]) => name);
  if (missing.length === 0) {
    api.logger?.info?.("plur1bus-feature-crons: native command dispatch ready");
    return true;
  }
  api?.logger?.warn?.(
    `plur1bus-feature-crons: required OpenClaw capability unavailable (${missing.join(", ")}); `
      + "feature-cron setup will remain fail-closed and no host files will be patched",
  );
  return false;
}

/**
 * Use OpenClaw's in-process cron service to close the direct-job execution
 * window before the deferred CLI reconciliation starts.
 *
 * @param {object} api
 * @param {{getCron?: Function}|null} gatewayContext
 * @returns {Promise<{available: boolean, disabled: number, failed: number}>}
 */
async function reconcileUnsafeDirectCronsWithService(api, gatewayContext) {
  let cron;
  try {
    cron = gatewayContext?.getCron?.();
  } catch (error) {
    api.logger?.warn?.(
      `plur1bus-feature-crons: gateway cron service lookup failed (${error?.message || String(error)})`,
    );
    return { available: false, disabled: 0, failed: 0 };
  }
  if (!cron || typeof cron.list !== "function" || typeof cron.update !== "function") {
    api.logger?.warn?.("plur1bus-feature-crons: gateway cron service unavailable for immediate safety reconciliation");
    return { available: false, disabled: 0, failed: 0 };
  }

  let jobs;
  try {
    jobs = await withTimeout(
      Promise.resolve(cron.list({ includeDisabled: true })),
      5_000,
      "feature cron immediate safety list",
    );
  } catch (error) {
    api.logger?.warn?.(
      `plur1bus-feature-crons: immediate cron list failed (${error?.message || String(error)})`,
    );
    return { available: true, disabled: 0, failed: 1 };
  }

  const unsafeJobs = planUnsafeDirectCronDisables(jobs);
  let disabled = 0;
  let failed = 0;
  for (const job of unsafeJobs) {
    try {
      await withTimeout(
        Promise.resolve(cron.update(job.id, {
          enabled: false,
          name: job.safetyName,
        })),
        5_000,
        `feature cron immediate safety update ${job.id}`,
      );
      disabled += 1;
    } catch (error) {
      failed += 1;
      api.logger?.warn?.(
        `plur1bus-feature-crons: immediate safety-disable failed for ${job.id} (${error?.message || String(error)})`,
      );
    }
  }
  if (disabled > 0) {
    api.logger?.warn?.(
      `plur1bus-feature-crons: immediately safety-disabled ${disabled} exact direct job(s)`,
    );
  }
  return { available: true, disabled, failed };
}

/**
 * Deferred, best-effort feature-cron bootstrap for the gateway_start
 * handler registered above. Fail-open end to end: any failure here is
 * logged at debug/warn level and swallowed — it must never affect the
 * gateway or the message flow.
 *
 * Throttled via the same marker file the doctor/status hint reads
 * (see shouldRunCronBootstrap): skipped when a successful run for the current
 * plugin version happened in the last 20h. Host-patch failure forces the
 * safety run regardless of the marker.
 */
async function runDeferredFeatureCronBootstrap(api, {
  cfg,
  baseDbPath,
  spawnImpl,
  force = false,
  safetyRetryDelaysMs = [0, 1_000, 5_000, 30_000, 120_000, 600_000],
  waitImpl,
} = {}) {
  const markerPath = featureCronsMarkerPath(baseDbPath);
  let marker = null;
  try {
    marker = readJsonSafe(markerPath, null);
  } catch (_e) {
    marker = null;
  }

  if (!force && !shouldRunCronBootstrap(marker, { pluginVersion: PLUGIN_VERSION })) {
    api.logger?.debug?.("plur1bus-feature-crons: deferred bootstrap skipped (recent run recorded)");
    return { ok: true, safetyPending: false, attempts: 0 };
  }

  const scriptPath = join(PLUGIN_ROOT, "scripts", "setup-feature-crons.mjs");
  const retrySchedule = force && Array.isArray(safetyRetryDelaysMs) && safetyRetryDelaysMs.length > 0
    ? safetyRetryDelaysMs
    : [0];
  const waitForRetry = waitImpl || ((delayMs) => new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, delayMs);
    timer?.unref?.();
  }));

  for (let attemptIndex = 0; attemptIndex < retrySchedule.length; attemptIndex += 1) {
    const delayMs = retrySchedule[attemptIndex];
    if (attemptIndex > 0 && delayMs > 0) await waitForRetry(delayMs);

    let stdout = "";
    let ok = false;
    try {
      let child;
      if (spawnImpl) {
        child = spawnImpl(process.execPath, [scriptPath, "--json"], {
          cwd: PLUGIN_ROOT,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        const { spawn } = await import("node:child_process");
        child = spawn(process.execPath, [scriptPath, "--json"], {
          cwd: PLUGIN_ROOT,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      ok = await new Promise((resolvePromise) => {
        child.stdout?.on("data", (chunk) => { stdout += chunk; });
        child.stderr?.resume();
        child.on("error", () => resolvePromise(false));
        child.on("close", (code) => resolvePromise(code === 0));
      });
    } catch (err) {
      api.logger?.debug?.(`plur1bus-feature-crons: deferred bootstrap spawn failed: ${err?.message || err}`);
    }

    let parsedResult = null;
    try {
      parsedResult = stdout.trim() ? JSON.parse(stdout.trim()) : null;
    } catch {
      parsedResult = null;
    }

    if (ok) {
      const lastPlanCreateCount = parseFeatureCronBootstrapLastPlanCreateCount(stdout);
      try {
        writeJsonAtomic(
          markerPath,
          {
            pluginVersion: PLUGIN_VERSION,
            lastRunAt: new Date().toISOString(),
            ...(lastPlanCreateCount !== undefined ? { lastPlanCreateCount } : {}),
          },
          { pretty: true },
        );
      } catch (err) {
        api.logger?.debug?.(`plur1bus-feature-crons: marker write failed: ${err?.message || err}`);
      }
      resetFeatureCronsHintCache();
      api.logger?.info?.(
        `plur1bus-feature-crons: deferred bootstrap ran (ok=${ok}${lastPlanCreateCount !== undefined ? `, planCreateCount=${lastPlanCreateCount}` : ""})`,
      );
    } else {
      api.logger?.info?.("plur1bus-feature-crons: deferred bootstrap attempt failed");
    }

    const failedSafetyRecovery = Array.isArray(parsedResult?.results)
      && parsedResult.results.some(
        (result) => result?.action === "safety-recovery" && result?.ok === false,
      );
    const safetyPending = force && (
      !ok
      || !parsedResult
      || parsedResult.skipped === true
      || failedSafetyRecovery
    );
    if (!safetyPending) {
      return { ok, safetyPending: false, attempts: attemptIndex + 1 };
    }
    if (attemptIndex + 1 < retrySchedule.length) {
      api.logger?.warn?.(
        `plur1bus-feature-crons: safety reconciliation pending; retry ${attemptIndex + 2}/${retrySchedule.length}`,
      );
    }
  }
  api.logger?.warn?.("plur1bus-feature-crons: safety reconciliation still pending after bounded retries");
  return { ok: false, safetyPending: true, attempts: retrySchedule.length };
}

// Reaction-nudge capability detection (Humanization F6): computed at most once
// per process, cached across handler invocations.
let _reactionsCapability = null;
function makeReactionsCapabilityChecker(api) {
  return async function detectReactionsCapabilityCached() {
    if (_reactionsCapability !== null) return _reactionsCapability;
    try {
      const { detectReactionsCapability } = await import("../../lib/reaction-directive.js");
      const runtimeConfig = typeof runtimeIfUsable(api)?.config?.current === "function"
        ? runtimeIfUsable(api).config.current()
        : (runtimeIfUsable(api)?.config && typeof runtimeIfUsable(api).config === "object" ? runtimeIfUsable(api).config : null);
      _reactionsCapability = detectReactionsCapability(runtimeConfig);
    } catch (_) { _reactionsCapability = false; }
    try { api.logger?.info?.(`plur1bus: reaction capability auto-detect → ${_reactionsCapability}`); } catch (_) { /* non-blocking */ }
    return _reactionsCapability;
  };
}

export {
  resolveNeoHooksConfig,
  inspectCronNativeCapabilities,
  reconcileUnsafeDirectCronsWithService,
  runDeferredFeatureCronBootstrap,
  makeReactionsCapabilityChecker,
};
