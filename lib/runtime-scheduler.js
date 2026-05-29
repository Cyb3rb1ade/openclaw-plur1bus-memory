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

export function createBackgroundMemoryScheduler({ config = {}, logger = console } = {}) {
  const cfg = normalizeRuntimeConfig(config);
  const recallQueue = [];
  const captureQueues = new Map();
  const recallCache = new Map();
  const stats = {
    recallQueued: 0,
    recallActive: 0,
    recallCompleted: 0,
    recallTimedOut: 0,
    recallFailed: 0,
    captureQueued: 0,
    captureActive: 0,
    captureCompleted: 0,
    captureTimedOut: 0,
    captureFailed: 0,
    lastBackgroundRecallAt: null,
    lastBackgroundCaptureAt: null,
  };

  function drainRecall() {
    while (stats.recallActive < cfg.maxConcurrentRecall && recallQueue.length > 0) {
      recallQueue.sort((a, b) => priorityValue(a.priority) - priorityValue(b.priority) || a.seq - b.seq);
      const job = recallQueue.shift();
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
    stats.recallQueued++;
    const seq = stats.recallQueued;
    // AbortController, damit ein Timeout die laufende Arbeit tatsächlich
    // signalisiert (fn erhält signal) statt sie unbemerkt weiterlaufen zu lassen.
    const controller = new AbortController();
    const queued = new Promise((resolve) => {
      recallQueue.push({ seq, priority, cacheKey, background, fn, resolve, signal: controller.signal });
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

  function enqueueCapture(agentId, meta, fn) {
    const key = agentId || "default";
    const background = Boolean(meta?.background);
    const timeoutMs = toPositiveInt(meta?.timeoutMs, cfg.captureTimeoutMs);
    stats.captureQueued++;
    const prev = captureQueues.get(key) || Promise.resolve();
    const next = prev.then(async () => {
      stats.captureActive++;
      const controller = new AbortController();
      const timeout = makeTimeout(timeoutMs, () => {
        stats.captureTimedOut++;
        try { controller.abort(); } catch (_) {}
        logger?.warn?.(`memory-lancedb-namespaced: capture worker timed out after ${timeoutMs}ms for agent=${key}${background ? " (background)" : ""}`);
      });
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => fn(controller.signal)),
          timeout.promise.then((value) => {
            if (value?.timedOut) return value;
            return value;
          }),
        ]);
        timeout.clear();
        if (result?.timedOut) return;
        stats.captureCompleted++;
        if (background) stats.lastBackgroundCaptureAt = new Date().toISOString();
      } catch (error) {
        timeout.clear();
        stats.captureFailed++;
        logger?.warn?.(`memory-lancedb-namespaced: capture worker failed for agent=${key}: ${String(error)}`);
      } finally {
        stats.captureActive--;
      }
    }).catch(() => {});
    captureQueues.set(key, next);
    next.finally(() => {
      if (captureQueues.get(key) === next) captureQueues.delete(key);
    });
    return next;
  }

  function status() {
    return {
      config: cfg,
      recall: {
        queued: recallQueue.length,
        active: stats.recallActive,
        completed: stats.recallCompleted,
        timedOut: stats.recallTimedOut,
        failed: stats.recallFailed,
        cacheSize: recallCache.size,
        lastBackgroundRecallAt: stats.lastBackgroundRecallAt,
      },
      capture: {
        queuedAgents: captureQueues.size,
        active: stats.captureActive,
        completed: stats.captureCompleted,
        timedOut: stats.captureTimedOut,
        failed: stats.captureFailed,
        lastBackgroundCaptureAt: stats.lastBackgroundCaptureAt,
      },
    };
  }

  return { config: cfg, runRecall, enqueueCapture, status };
}
