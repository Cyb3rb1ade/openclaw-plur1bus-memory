import { checkRuntimePressure } from "./runtime-pressure-gate.js";
import { makeBoundedQueue } from "./bounded-operation-queue.js";

const DEFAULT_RUNTIME_CONFIG = {
  recallTimeoutMs: 45_000,
  captureTimeoutMs: 60_000,
  // Serialisiert Recall standardmäßig (war 2). Verhindert, dass mehrere teure
  // Recall-Läufe gleichzeitig Store/CPU belasten. Quelle: Performance-Analysis
  // 2026-05-29 §"Runtime-Concurrency senken".
  maxConcurrentRecall: 1,
  maxConcurrentCapturePerAgent: 1,
  backgroundPriority: "low",
  recallCacheTtlMs: 120_000,
  // P7 — bounded queues + runtime pressure gate.
  maxQueueDepthRecall: 20,
  maxQueueDepthCapturePerAgent: 10,
  pressureGateEnabled: true,
  rssWarningBytes: 3 * 1024 * 1024 * 1024, // 3.0 GiB
  rssCriticalBytes: 4.5 * 1024 * 1024 * 1024, // 4.5 GiB
};

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function normalizeRuntimeConfig(config = {}) {
  return {
    recallTimeoutMs: toPositiveInt(config.recallTimeoutMs, DEFAULT_RUNTIME_CONFIG.recallTimeoutMs),
    captureTimeoutMs: toPositiveInt(config.captureTimeoutMs, DEFAULT_RUNTIME_CONFIG.captureTimeoutMs),
    maxConcurrentRecall: toPositiveInt(config.maxConcurrentRecall, DEFAULT_RUNTIME_CONFIG.maxConcurrentRecall),
    maxConcurrentCapturePerAgent: toPositiveInt(config.maxConcurrentCapturePerAgent, DEFAULT_RUNTIME_CONFIG.maxConcurrentCapturePerAgent),
    backgroundPriority: config.backgroundPriority === "normal" ? "normal" : "low",
    recallCacheTtlMs: toPositiveInt(config.recallCacheTtlMs, DEFAULT_RUNTIME_CONFIG.recallCacheTtlMs),
    // P7 additions.
    maxQueueDepthRecall: toPositiveInt(config.maxQueueDepthRecall, DEFAULT_RUNTIME_CONFIG.maxQueueDepthRecall),
    maxQueueDepthCapturePerAgent: toPositiveInt(config.maxQueueDepthCapturePerAgent, DEFAULT_RUNTIME_CONFIG.maxQueueDepthCapturePerAgent),
    pressureGateEnabled: config.pressureGateEnabled === false ? false : true,
    rssWarningBytes: toPositiveInt(config.rssWarningBytes, DEFAULT_RUNTIME_CONFIG.rssWarningBytes),
    rssCriticalBytes: toPositiveInt(config.rssCriticalBytes, DEFAULT_RUNTIME_CONFIG.rssCriticalBytes),
  };
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

export function isBackgroundTurn(event = {}, ctx = {}) {
  const sessionKey = textOf(ctx.sessionKey || event.sessionKey || event.sessionId || event.runId).toLowerCase();
  const origin = textOf(event.origin || event.source || ctx.origin || ctx.source).toLowerCase();
  const prompt = textOf(event.prompt).toLowerCase();
  const kind = textOf(event.kind || event.type || ctx.kind || ctx.type).toLowerCase();
  if (origin === "cron" || origin === "internal") return true;
  if (kind === "cron" || kind === "heartbeat" || kind === "background") return true;
  if (sessionKey.includes(":cron:") || sessionKey.includes(":heartbeat")) return true;
  if (prompt.includes("[cron:") || prompt.includes("heartbeat_ok")) return true;
  return false;
}

function priorityValue(priority) {
  return priority === "high" ? 0 : priority === "normal" ? 1 : 2;
}

function makeTimeout(timeoutMs, onTimeout) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch (_) {}
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  return {
    promise,
    clear() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function isLowPriorityOrBackground(background, priority) {
  return background || priority === "low";
}

function shouldPressureSkip(pressure, background, priority) {
  if (!pressure || pressure.level === "ok") return false;
  // Critical: drop all background and explicitly low-priority work.
  if (pressure.level === "critical" && isLowPriorityOrBackground(background, priority)) return true;
  // Warning: only shed low-priority work; keep normal/high-priority work.
  if (pressure.level === "warning" && priority === "low") return true;
  return false;
}

export function createBackgroundMemoryScheduler({ config = {}, logger = console } = {}) {
  const cfg = normalizeRuntimeConfig(config);
  const recallCache = new Map();
  const captureStates = new Map();
  const stats = {
    recallQueued: 0,
    recallActive: 0,
    recallCompleted: 0,
    recallTimedOut: 0,
    recallFailed: 0,
    recallSkipped: 0,
    captureQueued: 0,
    captureActive: 0,
    captureCompleted: 0,
    captureTimedOut: 0,
    captureFailed: 0,
    captureSkipped: 0,
    lastBackgroundRecallAt: null,
    lastBackgroundCaptureAt: null,
  };

  function currentPressure() {
    if (!cfg.pressureGateEnabled) {
      return { level: "ok", reason: "pressure gate disabled", rssBytes: 0, heapUsedBytes: 0, thresholdBytes: 0 };
    }
    return checkRuntimePressure({ rssWarningBytes: cfg.rssWarningBytes, rssCriticalBytes: cfg.rssCriticalBytes });
  }

  const recallQueue = makeBoundedQueue({
    maxDepth: cfg.maxQueueDepthRecall,
    onEvict: (job, meta) => {
      const durationMs = Date.now() - (job.enqueuedAt || Date.now());
      logger?.warn?.(
        `memory-lancedb-namespaced: recall queue evicted oldest low-priority background job ` +
        `queueDepth=${meta.queueDepth} activeCount=${stats.recallActive} operation=recall ` +
        `durationMs=${durationMs} timeoutMs=${job.timeoutMs || cfg.recallTimeoutMs}`
      );
      job.resolve({
        ok: false,
        skipped: true,
        reason: "queue-depth-evicted",
        queueDepth: meta.queueDepth,
        activeCount: stats.recallActive,
        operation: "recall",
        durationMs,
        timeoutMs: job.timeoutMs || cfg.recallTimeoutMs,
        background: job.background,
      });
    },
  });

  function getCaptureState(key) {
    if (!captureStates.has(key)) {
      captureStates.set(key, {
        queue: makeBoundedQueue({
          maxDepth: cfg.maxQueueDepthCapturePerAgent,
          onEvict: (job, meta) => {
            const durationMs = Date.now() - (job.enqueuedAt || Date.now());
            logger?.warn?.(
              `memory-lancedb-namespaced: capture queue evicted oldest low-priority background job ` +
              `queueDepth=${meta.queueDepth} activeCount=${stats.captureActive} operation=capture ` +
              `durationMs=${durationMs} timeoutMs=${job.timeoutMs || cfg.captureTimeoutMs}`
            );
            job.deferred.resolve({
              ok: false,
              skipped: true,
              reason: "queue-depth-evicted",
              queueDepth: meta.queueDepth,
              activeCount: stats.captureActive,
              operation: "capture",
              durationMs,
              timeoutMs: job.timeoutMs || cfg.captureTimeoutMs,
              background: job.background,
            });
          },
        }),
        active: 0,
      });
    }
    return captureStates.get(key);
  }

  function drainRecall() {
    while (stats.recallActive < cfg.maxConcurrentRecall && recallQueue.length > 0) {
      recallQueue.queue.sort((a, b) => priorityValue(a.priority) - priorityValue(b.priority) || a.seq - b.seq);
      const job = recallQueue.shift();
      if (!job) continue;
      stats.recallActive++;
      Promise.resolve()
        .then(() => job.fn(job.signal))
        .then((value) => {
          stats.recallCompleted++;
          if (job.cacheKey && value !== undefined) {
            recallCache.set(job.cacheKey, { value, expiresAt: Date.now() + cfg.recallCacheTtlMs });
          }
          if (job.background) stats.lastBackgroundRecallAt = new Date().toISOString();
          job.resolve({ ok: true, value, background: job.background });
        })
        .catch((error) => {
          stats.recallFailed++;
          job.resolve({ ok: false, error, background: job.background });
        })
        .finally(() => {
          stats.recallActive--;
          drainRecall();
        });
    }
  }

  function cachedRecall(cacheKey) {
    if (!cacheKey) return null;
    const cached = recallCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      recallCache.delete(cacheKey);
      return null;
    }
    return cached.value;
  }

  function runRecall(meta, fn) {
    const background = Boolean(meta?.background);
    const priority = meta?.priority || (background && cfg.backgroundPriority === "low" ? "low" : "normal");
    const cacheKey = meta?.cacheKey || "";
    const timeoutMs = toPositiveInt(meta?.timeoutMs, cfg.recallTimeoutMs);
    const pressure = currentPressure();

    if (shouldPressureSkip(pressure, background, priority)) {
      stats.recallSkipped++;
      logger?.warn?.(
        `memory-lancedb-namespaced: recall skipped under pressure ` +
        `operation=recall reason=${pressure.reason} pressure=${pressure.level} rss=${pressure.rssBytes}`
      );
      return Promise.resolve({
        ok: false,
        skipped: true,
        reason: pressure.reason,
        pressure,
        background,
      });
    }

    stats.recallQueued++;
    const seq = stats.recallQueued;
    const controller = new AbortController();
    const enqueuedAt = Date.now();
    const queued = new Promise((resolve) => {
      const job = {
        seq,
        priority,
        cacheKey,
        background,
        fn,
        resolve,
        signal: controller.signal,
        timeoutMs,
        enqueuedAt,
      };
      const result = recallQueue.push(job);
      if (!result.accepted) {
        logger?.warn?.(
          `memory-lancedb-namespaced: recall queue full; dropped low-priority background job ` +
          `queueDepth=${recallQueue.length} activeCount=${stats.recallActive} operation=recall ` +
          `durationMs=${Date.now() - enqueuedAt} timeoutMs=${timeoutMs}`
        );
        resolve({
          ok: false,
          skipped: true,
          reason: "queue-full",
          queueDepth: recallQueue.length,
          activeCount: stats.recallActive,
          operation: "recall",
          durationMs: Date.now() - enqueuedAt,
          timeoutMs,
          background,
        });
        return;
      }
      drainRecall();
    });
    const timeout = makeTimeout(timeoutMs, () => {
      stats.recallTimedOut++;
      try { controller.abort(); } catch (_) {}
      logger?.warn?.(`memory-lancedb-namespaced: recall worker timed out after ${timeoutMs}ms${background ? " (background)" : ""}`);
    });
    return Promise.race([queued, timeout.promise]).then((result) => {
      timeout.clear();
      if (result?.timedOut) {
        const value = cachedRecall(cacheKey);
        return value !== null
          ? { ok: true, value, timedOut: true, fromCache: true, background }
          : { ok: false, timedOut: true, background };
      }
      return result;
    });
  }

  function drainCapture(key) {
    const state = getCaptureState(key);
    while (state.active < cfg.maxConcurrentCapturePerAgent && state.queue.length > 0) {
      state.queue.queue.sort((a, b) => priorityValue(a.priority) - priorityValue(b.priority) || a.seq - b.seq);
      const job = state.queue.shift();
      if (!job) continue;
      state.active++;
      stats.captureActive++;
      const controller = new AbortController();
      const timeout = makeTimeout(job.timeoutMs, () => {
        stats.captureTimedOut++;
        try { controller.abort(); } catch (_) {}
        logger?.warn?.(`memory-lancedb-namespaced: capture worker timed out after ${job.timeoutMs}ms for agent=${key}${job.background ? " (background)" : ""}`);
      });
      const fnPromise = Promise.resolve().then(() => job.fn(controller.signal));
      Promise.race([fnPromise, timeout.promise])
        .then(async (result) => {
          timeout.clear();
          // Swallow a late rejection or resolution of the losing fn promise.
          fnPromise.catch(() => {});
          if (result?.timedOut) {
            job.deferred.resolve({ ok: false, timedOut: true, background: job.background });
            return;
          }
          stats.captureCompleted++;
          if (job.background) stats.lastBackgroundCaptureAt = new Date().toISOString();
          job.deferred.resolve({ ok: true, background: job.background });
        })
        .catch((error) => {
          timeout.clear();
          stats.captureFailed++;
          logger?.warn?.(`memory-lancedb-namespaced: capture worker failed for agent=${key}: ${String(error)}`);
          job.deferred.resolve({ ok: false, error: error?.message || String(error), background: job.background });
        })
        .finally(() => {
          state.active--;
          stats.captureActive--;
          // Clean up empty agent state to avoid leaking keys.
          if (state.queue.length === 0 && state.active === 0) {
            captureStates.delete(key);
          }
          drainCapture(key);
        });
    }
  }

  function enqueueCapture(agentId, meta, fn) {
    const key = agentId || "default";
    const background = Boolean(meta?.background);
    const priority = meta?.priority || (background && cfg.backgroundPriority === "low" ? "low" : "normal");
    const timeoutMs = toPositiveInt(meta?.timeoutMs, cfg.captureTimeoutMs);
    const pressure = currentPressure();

    if (shouldPressureSkip(pressure, background, priority)) {
      stats.captureSkipped++;
      logger?.warn?.(
        `memory-lancedb-namespaced: capture skipped under pressure ` +
        `operation=capture reason=${pressure.reason} pressure=${pressure.level} rss=${pressure.rssBytes}`
      );
      return Promise.resolve({
        ok: false,
        skipped: true,
        reason: pressure.reason,
        pressure,
        background,
      });
    }

    stats.captureQueued++;
    const seq = stats.captureQueued;
    const enqueuedAt = Date.now();
    const deferred = makeDeferred();
    const state = getCaptureState(key);
    const job = {
      seq,
      priority,
      background,
      fn,
      timeoutMs,
      key,
      enqueuedAt,
      deferred,
    };
    const result = state.queue.push(job);
    if (!result.accepted) {
      logger?.warn?.(
        `memory-lancedb-namespaced: capture queue full; dropped low-priority background job ` +
        `queueDepth=${state.queue.length} activeCount=${state.active} operation=capture ` +
        `durationMs=${Date.now() - enqueuedAt} timeoutMs=${timeoutMs}`
      );
      deferred.resolve({
        ok: false,
        skipped: true,
        reason: "queue-full",
        queueDepth: state.queue.length,
        activeCount: state.active,
        operation: "capture",
        durationMs: Date.now() - enqueuedAt,
        timeoutMs,
        background,
      });
      return deferred.promise;
    }
    drainCapture(key);
    return deferred.promise;
  }

  function status() {
    const pressure = currentPressure();
    const captureQueuedTotal = [...captureStates.values()].reduce((sum, s) => sum + s.queue.length, 0);
    return {
      config: cfg,
      pressure,
      recall: {
        queued: recallQueue.length,
        active: stats.recallActive,
        completed: stats.recallCompleted,
        timedOut: stats.recallTimedOut,
        failed: stats.recallFailed,
        skipped: stats.recallSkipped,
        cacheSize: recallCache.size,
        lastBackgroundRecallAt: stats.lastBackgroundRecallAt,
      },
      capture: {
        queuedAgents: captureStates.size,
        queuedTotal: captureQueuedTotal,
        active: stats.captureActive,
        completed: stats.captureCompleted,
        timedOut: stats.captureTimedOut,
        failed: stats.captureFailed,
        skipped: stats.captureSkipped,
        lastBackgroundCaptureAt: stats.lastBackgroundCaptureAt,
      },
    };
  }

  return { config: cfg, runRecall, enqueueCapture, status };
}
