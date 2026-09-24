/**
 * adapter/openclaw/register-gateway.js — PR-03i.
 *
 * The OpenClaw gateway lifecycle this module owns: a lone `gateway_start`
 * (the Neo worker warm-up, was index.js:5299-5307, no matching `gateway_stop`)
 * plus two `gateway_start`/`gateway_stop` pairs (the Obsidian bridge, was
 * index.js:7023-7032, and the Neo maintenance service, was
 * index.js:10319-10341), and the shutdown owner plus its four
 * after-lifecycle service registrations (was index.js:13453-13491). A third
 * `gateway_start`/`gateway_stop` pair — the control-health probe — moved with
 * the command surface into `register-commands.js` instead, since it lives
 * inside the same `registerGatewayMethod` block that builds the control-UI
 * projection callback.
 *
 * Each range keeps its own function and its own call site in `register()`.
 * The extraction plan sketched one `registerGatewayLifecycle(ctx)` for every
 * `gateway_start`/`gateway_stop` registration, but the chat-command surface
 * registers its control-health `gateway_start`/`gateway_stop` pair between
 * the Obsidian bridge pair and the Neo service pair, so folding them into one
 * call would reorder the host's handler lists — an observable change M1a
 * does not make.
 *
 * Two budgets are load-bearing and must not drift:
 *   - `gateway_stop` is registered with `timeoutMs: 30_000`. The host default
 *     is 5 000 ms, under which in-flight LanceDB writes are lost
 *     (lib/runtime-shutdown.js:308, host-contract §a.1).
 *   - the Neo worker warm-up takes `timeoutMs: 5_000` because it only arms an
 *     unref'd timer; the work itself happens 20 s later, outside any turn.
 *
 * `registerGatewayShutdownServices` must stay the last statement of
 * `register()`: lifecycle ownership is registered after every hook and
 * capability registration, and the four `…AfterLifecycle` calls must follow
 * `registerGatewayShutdown` in this exact order because they take its return
 * value as `lifecycleRegistered`.
 */

import { registerScopedEmbeddingIpcServiceAfterLifecycle } from "../../lib/providers/scoped-embedding-ipc.js";
import {
  registerGatewayShutdown,
  registerLocalModelOwnershipServiceAfterLifecycle,
  registerModelPreparationServiceAfterLifecycle,
  registerReembeddingRecoveryServiceAfterLifecycle,
} from "../../lib/runtime-shutdown.js";

// 7.12.24: Der erste agent_end nach einem Gateway-Neustart brauchte 8–18 s
// bis "worker captured" (sonst 0,4–1 s). Den Worker-Thread deshalb kurz
// nach dem Start anwerfen, ausserhalb jedes Turns.
const NEO_WORKER_WARMUP_DELAY_MS = 20_000;

/**
 * Arm the Neo worker thread shortly after the gateway comes up.
 *
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerNeoWorkerWarmUp(ctx) {
  const { api, host, neoWorkerRuntime } = ctx;

  if (neoWorkerRuntime && typeof api.on === "function") {
    api.on("gateway_start", () => {
      const timer = setTimeout(() => {
        const ok = neoWorkerRuntime.warmUp();
        host.logger.info(`plur1bus-neo: worker warm-up ${ok ? "done" : "skipped"}`);
      }, NEO_WORKER_WARMUP_DELAY_MS);
      timer?.unref?.();
    }, { timeoutMs: 5_000 });
  }
}

/**
 * Register the Obsidian bridge as a host service, or as a gateway hook pair
 * on a host without `registerService`.
 *
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerObsidianBridgeLifecycle(ctx) {
  const { api, bridgeService, host, obsidianBridgeCfg } = ctx;

  if (obsidianBridgeCfg.watch === true) {
    if (typeof api.registerService === "function") {
      api.registerService(bridgeService);
    } else if (typeof api.on === "function") {
      api.on("gateway_start", () => bridgeService.start(), { timeoutMs: 30_000 });
      api.on("gateway_stop", () => bridgeService.stop(), { timeoutMs: 30_000 });
    }
  } else {
    host.logger.info(`plur1bus-obsidian-bridge: configured (watch=false, dryRun=${obsidianBridgeCfg.dryRun !== false})`);
  }
}

/**
 * Register the Neo maintenance service start/stop pair.
 *
 * @param {object} ctx Registration context: the engine context plus `api`.
 * @returns {void}
 */
export function registerNeoServiceLifecycle(ctx) {
  const { api, host, neoEnabled, neoRoot, neoWorkerRuntime } = ctx;

  if (neoEnabled) {
    const startNeoService = () => {
      host.logger.info(`plur1bus-neo: service ready (state: ${neoRoot}, mode: augment)`);
    };
    const stopNeoService = async () => {
      try {
        await neoWorkerRuntime?.close?.();
      } catch (err) {
        host.logger.warn?.(`plur1bus-neo: worker shutdown failed: ${String(err)}`);
      }
      host.logger.info("plur1bus-neo: service stopped");
    };
    if (typeof api.on === "function") {
      api.on("gateway_start", startNeoService, { timeoutMs: 30_000 });
      api.on("gateway_stop", stopNeoService, { timeoutMs: 30_000 });
    } else if (typeof api.registerService === "function") {
      api.registerService({
        id: "plur1bus-neo-maintenance",
        start: startNeoService,
        stop: stopNeoService,
      });
    }
  }
}

/**
 * Register lifecycle ownership and the four services that depend on it.
 * Must be the last statement of `register()`.
 *
 * @param {object} ctx Registration context: `api`, the engine's `closeResources`,
 *   and the five members the after-lifecycle services read.
 * @returns {void}
 */
export function registerGatewayShutdownServices(ctx) {
  const {
    api,
    closeResources,
    coordinatesLocalModelGeneration,
    embeddings,
    modelPreparationCoordinator,
    reembeddingSwitchRecovery,
    scopedEmbeddingServer,
  } = ctx;

  // The engine owns the closer (engine/lifecycle/close-resources.js,
  // built in createEngine() over the same resources this call used to list);
  // Engine.close() and the host's cleanup share its one promise.
  const gatewayShutdownRegistered = registerGatewayShutdown(api, { closeResources });
  registerLocalModelOwnershipServiceAfterLifecycle(api, {
    enabled: coordinatesLocalModelGeneration
      && typeof embeddings?.activateSharedModelOwner === "function",
    lifecycleRegistered: gatewayShutdownRegistered,
    embeddings,
  });
  registerScopedEmbeddingIpcServiceAfterLifecycle({
    api,
    server: scopedEmbeddingServer,
    enabled: Boolean(scopedEmbeddingServer),
    lifecycleRegistered: gatewayShutdownRegistered,
  });
  registerModelPreparationServiceAfterLifecycle(api, {
    lifecycleRegistered: gatewayShutdownRegistered,
    coordinator: modelPreparationCoordinator,
  });
  registerReembeddingRecoveryServiceAfterLifecycle(api, {
    lifecycleRegistered: gatewayShutdownRegistered,
    recovery: reembeddingSwitchRecovery,
  });
}
