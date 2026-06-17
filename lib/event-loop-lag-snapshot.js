/**
 * lib/event-loop-lag-snapshot.js — cheap event-loop lag snapshot.
 *
 * Uses perf_hooks.monitorEventLoopDelay for a passive histogram. No heavy
 * sampling; snapshot() only reads the current histogram state.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

const DEFAULT_RESOLUTION_MS = 10;

function nsToMs(ns) {
  return typeof ns === "number" && Number.isFinite(ns) ? ns / 1e6 : undefined;
}

export function createEventLoopLagSnapshot({ enabled = true, resolutionMs = DEFAULT_RESOLUTION_MS } = {}) {
  let histogram = null;

  if (enabled && typeof monitorEventLoopDelay === "function") {
    try {
      histogram = monitorEventLoopDelay({
        resolution: Number.isFinite(resolutionMs) && resolutionMs > 0 ? resolutionMs : DEFAULT_RESOLUTION_MS,
      });
      histogram.enable();
    } catch (err) {
      histogram = null;
    }
  }

  return {
    enable() {
      if (!histogram) return;
      try { histogram.enable(); } catch (_) { /* ignore */ }
    },

    disable() {
      if (!histogram) return;
      try { histogram.disable(); } catch (_) { /* ignore */ }
    },

    snapshot() {
      if (!histogram) return { available: false };
      try {
        const meanMs = nsToMs(histogram.mean);
        const maxMs = nsToMs(histogram.max);
        const p99Ms = nsToMs(histogram.percentile(99));
        const count = typeof histogram.count === "number" ? histogram.count : undefined;
        if (meanMs === undefined && maxMs === undefined && count === undefined) {
          return { available: false };
        }
        return {
          available: true,
          meanMs: meanMs ?? 0,
          maxMs: maxMs ?? 0,
          p99Ms: p99Ms ?? 0,
          count,
        };
      } catch (_) {
        return { available: false };
      }
    },
  };
}
