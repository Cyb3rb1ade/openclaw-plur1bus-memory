/**
 * engine/providers/embedding-service.js — EmbeddingService.probe() (E3 Task 3)
 * real, exercising the provider; serve() (E3 Task 4) runs the scoped embedding
 * IPC server on an explicit address as the in-process owner.
 *
 * probe() answers whether the configured embedding provider is actually
 * loaded and producing usable vectors, without ever throwing on a provider
 * failure (the result says `ok: false`) and without leaking the provider's
 * raw error message into anything a client could see — that goes to
 * `logger.warn` only (global-constraints: typed failures carry fixed,
 * log-safe messages; raw exceptions never do).
 */
import { randomUUID } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";

import { raceAbort } from "../../lib/abort.js";
import { createScopedEmbeddingIpcServer, resolveScopedEmbeddingIpcPaths } from "../../lib/providers/scoped-embedding-ipc.js";
import { memoryOpError } from "../memory-ops/errors.js";

/** Fixed prefix of every probe text; the per-engine nonce and an incrementing
 * attempt counter keep it from ever hitting a persisted embedding cache. */
export const PROBE_TEXT_PREFIX = "plur1bus embedding probe";

/**
 * @param {object} deps
 * @param {() => object} deps.getEmbeddings Returns the current provider (has `embedQuery`).
 * @param {() => object} deps.getIdentity Returns an EmbeddingIdentity (types/engine.d.ts).
 * @param {{ warn(message: string): void }} deps.logger
 * @param {() => number} [deps.clock]
 * @param {string} [deps.nonce] Per-engine nonce distinguishing probe texts from real content.
 * @returns {{ probe(opts?: { signal?: AbortSignal, refresh?: boolean }): Promise<object>, lastResult(): object | null, lastAttempt(): object | null, pending(): boolean }}
 *   Every result is an EmbeddingProbeResult (types/engine.d.ts).
 *   - `probe()`: see types/engine.d.ts. `refresh: true` always gets a provider call that starts after the call
 *     in flight (if any) settles; refreshes queued behind the same in-flight call share that one new call.
 *     Callers should pass a `signal` (or timeout) — a hung provider otherwise never answers.
 *   - `lastResult()`: the most recent **successful** probe (`ok: true`), or null — what E4 reads for
 *     "the model has been ready"; a later failure does not clear it.
 *   - `lastAttempt()`: the most recent **completed** provider probe, successful or failed (never an
 *     `"aborted"` answer — an abort only ends one caller's wait, the provider call still completes), or null.
 */
export function createEmbeddingProbe({ getEmbeddings, getIdentity, logger, clock = Date.now, nonce = randomUUID() }) {
  let attempt = 0;
  /** @type {{ promise: Promise<object>, started: boolean } | null} The newest provider call, running or queued. */
  let inFlight = null;
  /** @type {object | null} EmbeddingProbeResult (types/engine.d.ts) of the last successful probe. */
  let memoized = null;
  /** @type {object | null} EmbeddingProbeResult of the last completed probe, ok or failed. */
  let lastCompleted = null;

  function runProbe() {
    const t0 = clock();
    const identity = getIdentity();
    const text = `${PROBE_TEXT_PREFIX} ${nonce}:${attempt++}`;
    const failed = (error) => {
      const result = { ok: false, error, cached: false, identity, durationMs: clock() - t0, checkedAt: clock() };
      lastCompleted = result;
      return result;
    };
    return (async () => {
      let vector;
      try {
        vector = await getEmbeddings().embedQuery(text);
      } catch (error) {
        logger.warn(`embedding.probe: provider failed: ${error?.message ?? error}`);
        return failed("provider-failed");
      }
      if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) return failed("invalid-vector");
      let allFinite = true;
      for (let i = 0; i < vector.length; i += 1) {
        if (!Number.isFinite(vector[i])) { allFinite = false; break; }
      }
      if (!allFinite) return failed("invalid-vector");
      if (vector.length !== identity.dimensions) return failed("dimension-mismatch");
      const result = { ok: true, cached: false, identity, durationMs: clock() - t0, checkedAt: clock() };
      memoized = result;
      lastCompleted = result;
      return result;
    })();
  }

  /** Start a provider call now, or queue it behind `after` (the call currently in flight). */
  function launch(after) {
    const entry = { promise: null, started: false };
    const run = () => {
      entry.started = true;
      return runProbe();
    };
    entry.promise = (after ? after.then(run, run) : run()).finally(() => {
      if (inFlight === entry) inFlight = null;
    });
    inFlight = entry;
    return entry;
  }

  async function probe(opts = {}) {
    const refresh = opts.refresh === true;
    if (!refresh && memoized) return { ...memoized, cached: true };
    const callerStart = clock();
    let entry = inFlight;
    if (!entry) entry = launch(null);
    // A running call began before this refresh was asked for: queue a new one
    // behind it. A call that is itself still queued has not started yet, so it
    // already is "a new provider call" for this caller too.
    else if (refresh && entry.started) entry = launch(entry.promise);
    try {
      return await raceAbort(entry.promise, opts.signal);
    } catch {
      const identity = getIdentity();
      return { ok: false, error: "aborted", cached: false, identity, durationMs: clock() - callerStart, checkedAt: clock() };
    }
  }

  return {
    probe,
    /** Last successful probe, or null (E4 model readiness; not wired to Engine.status() here). */
    lastResult: () => memoized,
    /** Last completed probe, ok or failed (never an abort), or null. */
    lastAttempt: () => lastCompleted,
    /** true while a provider call is running or queued (E4 model readiness). */
    pending: () => inFlight !== null,
  };
}

const IPC_ADDRESS_KINDS = new Set(["unix-socket", "abstract-socket", "named-pipe"]);
const ABSTRACT_SOCKET_NAME = /^\0[\x21-\x7e]{1,107}$/;
const NAMED_PIPE_NAME = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,200}$/;

const invalidInput = (message) => memoryOpError("invalid-input", message);
const detailOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Validate a caller-supplied IpcAddress (types/engine.d.ts) for `platform`.
 * @param {unknown} address Candidate address.
 * @param {{ platform?: string }} [options]
 * @returns {{ kind: string, address: string }} Frozen copy.
 * @throws MemoryOpError "invalid-input" with a fixed message.
 */
export function validateIpcAddress(address, { platform = process.platform } = {}) {
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    throw invalidInput("address must be an IpcAddress or null");
  }
  const keys = Object.keys(address).sort();
  if (keys.length !== 2 || keys[0] !== "address" || keys[1] !== "kind"
    || typeof address.kind !== "string" || typeof address.address !== "string") {
    throw invalidInput("address must be an IpcAddress or null");
  }
  const { kind, address: value } = address;
  if (!IPC_ADDRESS_KINDS.has(kind)) throw invalidInput("unsupported IPC address kind");
  if (kind === "unix-socket") {
    if (platform === "win32") throw invalidInput("unix sockets are not used on Windows; use a named pipe");
    if (!posix.isAbsolute(value)) throw invalidInput("socket path must be absolute");
    if (Buffer.byteLength(value) > (platform === "darwin" ? 103 : 107)) {
      throw invalidInput("socket path exceeds the platform limit");
    }
    if (value.includes("\0")) throw invalidInput("invalid socket path");
  } else if (kind === "abstract-socket") {
    if (platform !== "linux") throw invalidInput("abstract sockets are Linux-only");
    if (!ABSTRACT_SOCKET_NAME.test(value)) throw invalidInput("invalid abstract socket name");
  } else {
    if (platform !== "win32") throw invalidInput("named pipes are Windows-only");
    if (!NAMED_PIPE_NAME.test(value)) throw invalidInput("invalid named pipe name");
  }
  return Object.freeze({ kind, address: value });
}

/**
 * The parent directory of a unix-socket path must exist, be a real directory
 * (not a link) and, on POSIX, grant nothing to group or others — checked
 * before anything listens or any token is written.
 * @param {string} socketPath Absolute socket path (already validated).
 * @param {{ platform?: string, isUnsafeLink?: (path: string) => boolean }} [options]
 * @throws MemoryOpError "invalid-input" with a fixed message.
 */
export function assertPrivateSocketDirectory(socketPath, { platform = process.platform, isUnsafeLink } = {}) {
  const directory = dirname(socketPath);
  let entry;
  try {
    entry = lstatSync(directory);
  } catch {
    throw invalidInput("socket directory does not exist");
  }
  if (entry.isSymbolicLink() || (typeof isUnsafeLink === "function" && isUnsafeLink(directory))) {
    throw invalidInput("socket directory must not be a link");
  }
  let stat;
  try {
    stat = statSync(directory);
  } catch {
    throw invalidInput("socket directory does not exist");
  }
  if (!stat.isDirectory()) throw invalidInput("socket directory is not a directory");
  if (platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw invalidInput("socket directory must be private (0700)");
  }
}

/** What serve(null) answers: nothing is served (in-process). */
const NOT_SERVING = Object.freeze({ address: null, tokenPath: null, identity: null, dispose() {} });

/**
 * The engine's EmbeddingService.serve() state machine: at most one scoped
 * embedding IPC server (no claim listener), every call serialized through one
 * promise chain so start, stop, dispose and shutdown never interleave.
 *
 * @param {object} deps
 * @param {string} deps.stateRoot The engine's baseDbPath; the token lives under it.
 * @param {() => object} deps.getEmbeddings The engine's current provider.
 * @param {string} deps.fingerprintId Active embedding fingerprint id.
 * @param {() => { kind: string, address: string }} deps.defaultAddress Platform default IpcAddress.
 * @param {boolean} deps.hostOwned The OpenClaw lifecycle server owns this stateRoot's IPC.
 * @param {() => boolean} deps.isClient The engine's provider is itself an IPC client.
 * @param {() => boolean} deps.isClosed The engine is closing or closed.
 * @param {(path: string) => boolean} [deps.isUnsafeLink]
 * @param {{ warn(message: string): void }} deps.logger
 * @param {Function} [deps.createServer]
 * @param {string} [deps.platform]
 * @returns {{ serve(address?: object | null): Promise<object>, current(): object | null, shutdown(): Promise<void> }}
 *   Results are EmbeddingServeResult (types/engine.d.ts).
 */
export function createEmbeddingServing({
  stateRoot,
  getEmbeddings,
  fingerprintId,
  defaultAddress,
  hostOwned,
  isClient,
  isClosed,
  isUnsafeLink,
  logger,
  createServer = createScopedEmbeddingIpcServer,
  platform = process.platform,
}) {
  let chain = Promise.resolve();
  /** @type {{ server: object, result: object } | null} */
  let active = null;
  let shutdownPromise = null;
  const closed = () => shutdownPromise !== null || isClosed();

  const enqueue = (task) => {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  };

  const stopActive = async () => {
    const current = active;
    active = null;
    if (current) await current.server.shutdown();
  };

  const startFailed = (error) => {
    logger.warn(`embedding.serve: start failed: ${detailOf(error)}`);
    return memoryOpError("storage", "embedding IPC server failed to start");
  };

  async function serveNow(address) {
    if (closed()) throw memoryOpError("storage", "engine is closed");
    if (address === null) {
      try {
        await stopActive();
      } catch (error) {
        logger.warn(`embedding.serve: stop failed: ${detailOf(error)}`);
        throw memoryOpError("storage", "embedding IPC server failed to stop");
      }
      return NOT_SERVING;
    }
    if (hostOwned) throw memoryOpError("conflict", "embedding IPC is owned by the host lifecycle");
    if (isClient()) throw memoryOpError("conflict", "this engine is an embedding IPC client, not the owner");

    let candidate = address;
    if (candidate === undefined) {
      try { candidate = defaultAddress(); } catch (error) { throw startFailed(error); }
    }
    const requested = validateIpcAddress(candidate, { platform });
    if (requested.kind === "unix-socket") {
      // Creates and secures the private IPC directory first, so the darwin
      // default (<stateRoot>/control/embedding-ipc/owner.sock) passes.
      try { resolveScopedEmbeddingIpcPaths(stateRoot); } catch (error) { throw startFailed(error); }
      assertPrivateSocketDirectory(requested.address, { platform, isUnsafeLink });
    }

    if (active) {
      const served = active.result.address;
      if (served.kind === requested.kind && served.address === requested.address) return active.result;
      throw memoryOpError("conflict", "embedding IPC is already served on another address");
    }

    let server;
    try {
      server = createServer({ stateRoot, embeddings: getEmbeddings(), fingerprintId, logger, address: requested, claim: false });
      await server.start();
    } catch (error) {
      if (error?.code === "scoped_embedding_owner_already_active") {
        throw memoryOpError("conflict", "embedding IPC address is in use");
      }
      throw startFailed(error);
    }

    const result = Object.freeze({
      address: requested,
      tokenPath: server.tokenPath,
      identity: server.identity,
      dispose() {
        if (active?.result !== result) return undefined;
        enqueue(async () => {
          if (active?.result === result) await stopActive();
        }).catch((error) => logger.warn(`embedding.serve: stop failed: ${detailOf(error)}`));
        return undefined;
      },
    });
    active = { server, result };
    return result;
  }

  return {
    async serve(address) {
      if (closed()) throw memoryOpError("storage", "engine is closed");
      return enqueue(() => serveNow(address));
    },
    current: () => active?.result ?? null,
    /** Waits for queued serve calls, stops the served server; idempotent. */
    shutdown() {
      if (!shutdownPromise) shutdownPromise = enqueue(stopActive);
      return shutdownPromise;
    },
  };
}
