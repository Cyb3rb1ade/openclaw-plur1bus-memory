import { Worker } from "node:worker_threads";

function makeWorkerError(error) {
  if (error instanceof Error) return error;
  const err = new Error(error?.message || String(error || "Neo worker failed"));
  err.name = error?.name || "Error";
  if (error?.stack) err.stack = error.stack;
  if (error?.code) err.code = error.code;
  return err;
}

function safeWarn(logger, message) {
  try {
    logger?.warn?.(message);
  } catch (_) {
    // Logging must never make Neo worker failure handling worse.
  }
}

function cloneJobOptions(jobOptions = {}) {
  const { logger: _logger, signal: _signal, ...rest } = jobOptions || {};
  return rest;
}

/**
 * Creates a long-lived Worker Thread runtime for Neo agent_end capture/drain jobs.
 *
 * @param {object} options Runtime options.
 * @param {object} [options.logger] Optional host logger; never sent to the worker.
 * @returns {{runNeoAgentEnd: Function, close: Function}} Neo worker runtime.
 */
export function createNeoWorkerRuntime(options = {}) {
  const logger = options.logger;
  const maxQueue = Math.max(0, Number.isFinite(options.maxQueue) ? Number(options.maxQueue) : 100);
  const maxPending = Math.max(1, Number.isFinite(options.maxPending) ? Number(options.maxPending) : maxQueue + 1);
  const maxJobAgeMs = Math.max(1, Number.isFinite(options.maxJobAgeMs) ? Number(options.maxJobAgeMs) : 60_000);
  const pending = new Map();
  const queued = [];
  let worker = null;
  let activeJob = null;
  let nextId = 1;
  let closed = false;

  const cleanupJob = (job) => {
    if (job?.signal && job?.abortHandler) {
      job.signal.removeEventListener?.("abort", job.abortHandler);
    }
    if (job?.deadlineTimer) clearTimeout(job.deadlineTimer);
  };

  const rejectQueued = (error) => {
    const err = makeWorkerError(error);
    while (queued.length > 0) {
      const job = queued.shift();
      cleanupJob(job);
      job.reject(err);
    }
  };

  const finishActiveJob = (job, error, value) => {
    if (activeJob === job) activeJob = null;
    pending.delete(job.id);
    cleanupJob(job);
    if (error) job.reject(makeWorkerError(error));
    else job.resolve(value);
    queueMicrotask(processNext);
  };

  const resetWorker = (currentWorker, error) => {
    if (worker !== currentWorker) return;
    worker = null;
    if (error && activeJob) finishActiveJob(activeJob, error);
  };

  const terminateWorker = async (reason) => {
    const currentWorker = worker;
    const job = activeJob;
    worker = null;
    if (job) finishActiveJob(job, reason);
    if (currentWorker) {
      try {
        await currentWorker.terminate();
      } catch (error) {
        safeWarn(logger, `plur1bus-neo: worker termination failed: ${error?.message || String(error)}`);
      }
    }
  };

  const ensureWorker = () => {
    if (closed) throw new Error("Neo worker runtime is closed");
    if (worker) return worker;

    const currentWorker = new Worker(new URL("./neo-worker-runner.js", import.meta.url));
    worker = currentWorker;

    currentWorker.on("message", (message = {}) => {
      const entry = pending.get(message.id);
      if (!entry) {
        safeWarn(logger, `plur1bus-neo: received unknown worker response id=${message.id}`);
        return;
      }
      pending.delete(message.id);
      if (message.ok) {
        entry.resolve(message.result);
      } else {
        entry.reject(makeWorkerError(message.error));
      }
    });

    currentWorker.once("error", (error) => {
      safeWarn(logger, `plur1bus-neo: worker error: ${error?.message || String(error)}`);
      resetWorker(currentWorker, error);
    });

    currentWorker.once("exit", (code) => {
      if (worker !== currentWorker) return;
      const error = new Error(`Neo worker exited with code ${code}`);
      safeWarn(logger, `plur1bus-neo: ${error.message}`);
      resetWorker(currentWorker, error);
    });

    return currentWorker;
  };

  const postActiveJob = (job) => {
    let currentWorker;
    try {
      currentWorker = ensureWorker();
    } catch (error) {
      finishActiveJob(job, error);
      return;
    }

    pending.set(job.id, {
      resolve: (value) => finishActiveJob(job, null, value),
      reject: (error) => finishActiveJob(job, error),
    });
    try {
      job.deadlineTimer = setTimeout(() => {
        if (activeJob === job) void terminateWorker(Object.assign(new Error("Neo worker job deadline exceeded"), { code: "NEO_WORKER_DEADLINE" }));
      }, Math.max(1, job.deadlineAt - Date.now()));
      job.deadlineTimer.unref?.();
      currentWorker.postMessage({
        id: job.id,
        type: "neoAgentEnd",
        event: job.event || {},
        ctx: job.ctx || {},
        jobOptions: cloneJobOptions(job.jobOptions),
      });
    } catch (error) {
      pending.delete(job.id);
      finishActiveJob(job, error);
    }
  };

  function processNext() {
    if (closed || activeJob || queued.length === 0) return;
    const job = queued.shift();
    if (Date.now() >= job.deadlineAt) {
      cleanupJob(job);
      job.reject(Object.assign(new Error("Neo worker job expired before execution"), { code: "NEO_WORKER_DEADLINE" }));
      queueMicrotask(processNext);
      return;
    }
    if (job.signal?.aborted) {
      cleanupJob(job);
      job.reject(new Error("Neo worker job aborted"));
      queueMicrotask(processNext);
      return;
    }
    activeJob = job;
    postActiveJob(job);
  }

  return {
    runNeoAgentEnd(event, ctx, jobOptions = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("Neo worker runtime is closed"));
          return;
        }
        if (queued.length + (activeJob ? 1 : 0) >= maxPending || queued.length >= maxQueue) {
          reject(Object.assign(new Error("Neo worker queue backpressure"), { code: "NEO_WORKER_BACKPRESSURE" }));
          return;
        }
        const signal = jobOptions?.signal;
        let abortHandler = null;
        const cleanup = () => {
          if (signal && abortHandler) signal.removeEventListener?.("abort", abortHandler);
        };
        const resolveAndCleanup = (value) => {
          cleanup();
          resolve(value);
        };
        const rejectAndCleanup = (error) => {
          cleanup();
          reject(error);
        };
        if (signal?.aborted) {
          rejectAndCleanup(new Error("Neo worker job aborted"));
          return;
        }
        const job = {
          id,
          event,
          ctx,
          jobOptions,
          signal,
          resolve: resolveAndCleanup,
          reject: rejectAndCleanup,
          abortHandler: null,
          deadlineAt: Date.now() + Math.max(1, Number.isFinite(jobOptions.maxJobAgeMs) ? Number(jobOptions.maxJobAgeMs) : maxJobAgeMs),
        };
        if (signal) {
          abortHandler = () => {
            const queuedIndex = queued.indexOf(job);
            if (queuedIndex >= 0) {
              queued.splice(queuedIndex, 1);
              rejectAndCleanup(new Error("Neo worker job aborted"));
              return;
            }
            if (activeJob === job) {
              void terminateWorker(new Error("Neo worker terminated after job abort"));
            }
          };
          job.abortHandler = abortHandler;
          signal.addEventListener?.("abort", abortHandler, { once: true });
        }
        queued.push(job);
        processNext();
      });
    },

    async close() {
      closed = true;
      rejectQueued(new Error("Neo worker runtime is closed"));
      await terminateWorker(new Error("Neo worker runtime is closed"));
    },
  };
}
