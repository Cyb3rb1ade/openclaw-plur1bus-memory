import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";

import { raceAbort } from "../abort.js";
import { securePath } from "../platform.js";
import { validateInput } from "../input-limits.js";
import { safeWarn } from "../safe-logging.js";
import { resolveInside } from "../sql-safety.js";

const MAX_EMBED_TEXTS = 64;
const MAX_EMBED_CHARS = 60_000;
const MAX_EMBED_TOTAL_CHARS = 120_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_FRAME_TIMEOUT_MS = 10_000;
const OWNER_CLAIM_PORT_FIRST = 49_152;
const OWNER_CLAIM_PORT_COUNT = 16_384;
const OPERATIONS = new Set(["query", "passage", "batch"]);
const IPC_ADDRESS_KINDS = new Set(["abstract-socket", "unix-socket", "named-pipe"]);
const FINGERPRINT_ID_RE = /^embedding:v1:sha256:[a-f0-9]{64}$/;
const ACTIVATION_EPOCHS = Symbol.for(
  "@cyb3rb1ade/plur1bus-memory/scoped-embedding-activation-epochs",
);

function activationEpochState(directory) {
  if (!globalThis[ACTIVATION_EPOCHS]) globalThis[ACTIVATION_EPOCHS] = new Map();
  let state = globalThis[ACTIVATION_EPOCHS].get(directory);
  if (!state) {
    state = { epoch: 0, active: null };
    globalThis[ACTIVATION_EPOCHS].set(directory, state);
  }
  return state;
}

function activateOwnerEpoch(directory, token) {
  const state = activationEpochState(directory);
  const epoch = state.epoch + 1;
  state.epoch = epoch;
  state.active = Object.freeze({ epoch, token });
  return epoch;
}

function deactivateOwnerEpoch(directory, epoch, token) {
  const state = activationEpochState(directory);
  if (state.active?.epoch !== epoch || !tokensEqual(state.active.token, token)) return false;
  state.active = null;
  return true;
}

function normalizeRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scoped embedding request must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.some((key) => key !== "operation" && key !== "texts")) {
    throw new Error("scoped embedding request contains unknown fields");
  }
  if (!OPERATIONS.has(value.operation)) throw new Error("scoped embedding operation is invalid");
  if (!Array.isArray(value.texts) || value.texts.length < 1 || value.texts.length > MAX_EMBED_TEXTS) {
    throw new Error(`scoped embedding texts must contain between 1 and ${MAX_EMBED_TEXTS} entries`);
  }
  let total = 0;
  const texts = value.texts.map((text, index) => {
    const checked = validateInput(text, {
      maxLength: MAX_EMBED_CHARS,
      name: `scoped embedding text ${index}`,
      required: true,
    });
    if (!checked.ok || typeof text !== "string") {
      throw new Error(checked.error || `scoped embedding text ${index} must be a string`);
    }
    total += text.length;
    return text;
  });
  if (total > MAX_EMBED_TOTAL_CHARS) {
    throw new Error(`scoped embedding request exceeds ${MAX_EMBED_TOTAL_CHARS} total characters`);
  }
  if (value.operation !== "batch" && texts.length !== 1) {
    throw new Error(`${value.operation} scoped embedding requires exactly one text`);
  }
  return { operation: value.operation, texts };
}

function expectedDimensions(provider) {
  const value = typeof provider?.dimensions === "function"
    ? provider.dimensions()
    : provider?.dimensions;
  const dimensions = Number(value);
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Error("activation-owned embedding provider has no valid dimension");
  }
  return dimensions;
}

function expectedModel(provider) {
  if (typeof provider?.model !== "string" || !provider.model.trim()) {
    throw new Error("activation-owned embedding provider has no valid model identity");
  }
  return provider.model;
}

function expectedFingerprintId(value) {
  if (typeof value !== "string" || !FINGERPRINT_ID_RE.test(value)) {
    throw new Error("activation-owned embedding provider has no valid immutable fingerprint identity");
  }
  return value;
}

function validateVectors(vectors, count, dimensions) {
  if (!Array.isArray(vectors) || vectors.length !== count) {
    throw new Error(`scoped embedding vector count mismatch: expected ${count}`);
  }
  return vectors.map((vector, index) => {
    if (
      !Array.isArray(vector)
      || vector.length !== dimensions
      || vector.some((entry) => !Number.isFinite(entry))
    ) {
      throw new Error(`scoped embedding vector ${index} is invalid for ${dimensions} dimensions`);
    }
    return vector.map(Number);
  });
}

function errorPayload(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "plur1bus_scoped_embedding_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function writePrivateToken(tokenPath, token) {
  const temporaryPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${token}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, tokenPath);
    securePath(tokenPath, { mode: 0o600 });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function removeOwnedPath(path, expectedType) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (expectedType === "socket" && !stat.isSocket()) || (expectedType === "file" && !stat.isFile())) {
    throw new Error(`refusing unsafe scoped embedding ${expectedType} path`);
  }
  unlinkSync(path);
}

/** Unlink the token file only while it still holds `token`; a file another
 * owner has since rewritten is theirs and stays. Absent is a no-op. */
function removeOwnTokenFile(tokenPath, token) {
  const stat = lstatIfPresent(tokenPath);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("refusing unsafe scoped embedding file path");
  let current;
  try {
    current = readFileSync(tokenPath, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!token || !tokensEqual(current, token)) return;
  unlinkSync(tokenPath);
}

function existingSocketAcceptsConnections(socketPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const socket = createConnection(socketPath);
    const finish = (error, active) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(active);
    };
    socket.once("connect", () => finish(null, true));
    socket.once("error", (error) => {
      if (error?.code === "ECONNREFUSED" || error?.code === "ENOENT") finish(null, false);
      else finish(error);
    });
    timer = setTimeout(() => finish(null, true), 500);
    timer.unref?.();
  });
}

/** Validate an optional explicit IPC address; `undefined`/`null` selects the legacy private socket.
 * @param {{kind: string, address: string} | undefined | null} value Candidate address.
 * @returns {{kind: string, address: string} | null} Frozen address or null.
 */
function normalizeIpcAddress(value) {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "object"
    || !IPC_ADDRESS_KINDS.has(value.kind)
    || typeof value.address !== "string"
    || !value.address
  ) {
    throw new TypeError("scoped embedding IPC address is invalid");
  }
  return Object.freeze({ kind: value.kind, address: value.address });
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function tokensEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/** Resolve the kernel-owned address used exclusively for owner election.
 * @param {string} directory Canonical private IPC directory.
 * @param {string} [platform] Node platform override used only by unit tests.
 * @returns {string | {host: string, port: number, exclusive: boolean}} Claim listener address.
 */
export function resolveScopedEmbeddingOwnerClaimAddress(directory, platform = process.platform) {
  const digest = createHash("sha256").update(directory).digest("hex").slice(0, 40);
  if (platform === "linux") return `\0plur1bus-embedding-owner-v1-${digest}`;
  // Unix abstract sockets are Linux-only.  A deterministic loopback TCP bind
  // retains kernel-atomic ownership and is released automatically on a crash;
  // unlike a filesystem lock it has no stale path to unlink.
  const port = OWNER_CLAIM_PORT_FIRST
    + (Number.parseInt(digest.slice(0, 4), 16) % OWNER_CLAIM_PORT_COUNT);
  return Object.freeze({ host: "127.0.0.1", port, exclusive: true });
}

function listenServer(server, address) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(address, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeListeningServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function ownerAlreadyActiveError(cause) {
  const error = new Error("scoped embedding IPC owner is already active", { cause });
  error.code = "scoped_embedding_owner_already_active";
  return error;
}

async function runEmbeddingRequest(embeddings, value) {
  const request = normalizeRequest(value);
  let vectors;
  if (request.operation === "query") vectors = [await embeddings.embedQuery(request.texts[0])];
  else if (request.operation === "passage") vectors = [await embeddings.embedPassage(request.texts[0])];
  else vectors = await embeddings.embedBatch(request.texts);
  return {
    vectors: validateVectors(vectors, request.texts.length, expectedDimensions(embeddings)),
  };
}

function encodeResponse(value) {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
    throw new Error("scoped embedding response exceeds the transport limit");
  }
  return encoded;
}

/** Resolve private IPC paths under the configured PLUR1BUS state root.
 * @param {string} stateRoot PLUR1BUS state root.
 * @returns {{directory: string, socketPath: string, tokenPath: string}} Canonical IPC paths.
 */
export function resolveScopedEmbeddingIpcPaths(stateRoot) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("scoped embedding stateRoot is required");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const root = resolveInside(stateRoot);
  const control = resolveInside(root, "control");
  const directory = resolveInside(root, "control", "embedding-ipc");
  const prospectiveSocketPath = resolveInside(root, "control", "embedding-ipc", "owner.sock");
  if (process.platform === "darwin" && Buffer.byteLength(prospectiveSocketPath) > 103) {
    const error = new Error(
      "scoped embedding IPC socket path exceeds the macOS 103-byte limit; configure a shorter state root",
    );
    error.code = "scoped_embedding_socket_path_too_long";
    throw error;
  }
  mkdirSync(control, { recursive: true, mode: 0o700 });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  securePath(directory, { mode: 0o700 });
  // Re-check against the narrower, now-existing IPC directory. A leaf
  // symlink must not redirect token/socket operations elsewhere in stateRoot.
  return Object.freeze({
    directory,
    socketPath: resolveInside(directory, "owner.sock"),
    tokenPath: resolveInside(directory, "owner.token"),
  });
}

/** Create the lifecycle-owned local embedding IPC server.
 *
 * Without `address` the server listens on the private `owner.sock` and elects
 * itself through the kernel-owned claim listener (the OpenClaw path). With an
 * explicit `address` it listens there instead; `claim` defaults to false then,
 * so no claim listener (a loopback TCP port off Linux) is opened; an unclaimed
 * start instead connect-probes the claim address and the legacy `owner.sock`
 * and refuses while a claimed owner of this stateRoot answers in any process.
 * The token always lives at `resolveScopedEmbeddingIpcPaths(stateRoot).tokenPath`
 * and is unlinked on shutdown only while it still holds this server's token.
 * @param {{stateRoot: string, embeddings: object, fingerprintId: string, logger?: object, requestFrameTimeoutMs?: number, address?: {kind: "abstract-socket" | "unix-socket" | "named-pipe", address: string}, claim?: boolean}} options Owner inputs.
 * @returns {{start: () => Promise<void>, shutdown: () => Promise<void>, identity: {model: string, dimensions: number, fingerprintId: string}, tokenPath: string}} Idempotent service resource.
 */
export function createScopedEmbeddingIpcServer({
  stateRoot,
  embeddings,
  fingerprintId,
  logger = null,
  requestFrameTimeoutMs = DEFAULT_REQUEST_FRAME_TIMEOUT_MS,
  address = undefined,
  claim = address === undefined,
} = {}) {
  if (!embeddings) throw new Error("activation-owned embedding provider is required");
  if (!Number.isSafeInteger(requestFrameTimeoutMs) || requestFrameTimeoutMs < 1 || requestFrameTimeoutMs > 60_000) {
    throw new Error("scoped embedding request frame timeout must be between 1 and 60000 milliseconds");
  }
  if (typeof claim !== "boolean") throw new TypeError("scoped embedding IPC claim must be a boolean");
  // `null` is not "no address": the legacy owner.sock is reached only by omitting it.
  if (address === null) throw new TypeError("scoped embedding IPC address is invalid");
  const explicitAddress = normalizeIpcAddress(address);
  const paths = resolveScopedEmbeddingIpcPaths(stateRoot);
  const listenTarget = explicitAddress ? explicitAddress.address : paths.socketPath;
  // Only a filesystem Unix socket has a path to probe, chmod and unlink.
  const socketPath = !explicitAddress || explicitAddress.kind === "unix-socket" ? listenTarget : null;
  const ownerIdentity = Object.freeze({
    model: expectedModel(embeddings),
    dimensions: expectedDimensions(embeddings),
    fingerprintId: expectedFingerprintId(fingerprintId),
  });
  let server = null;
  let claimServer = null;
  let token = null;
  let startPromise = null;
  let shutdownPromise = null;
  let ownsPaths = false;
  let listening = false;
  let ownerEpoch = null;
  const sockets = new Set();

  const processSocket = async (socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    const line = await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", fail);
        socket.off("end", onEnd);
        if (timer) clearTimeout(timer);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const fail = (error) => finish(error);
      const onEnd = () => fail(new Error("scoped embedding request ended before a complete frame"));
      const onData = (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
          fail(new Error("scoped embedding request exceeds the transport limit"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const trailing = buffer.slice(newline + 1).trim();
        if (trailing) {
          fail(new Error("scoped embedding connection accepts exactly one request"));
          return;
        }
        finish(null, buffer.slice(0, newline));
      };
      socket.on("data", onData);
      socket.once("error", fail);
      socket.once("end", onEnd);
      timer = setTimeout(() => {
        const error = new Error("scoped embedding request frame timed out");
        error.code = "scoped_embedding_request_timeout";
        fail(error);
      }, requestFrameTimeoutMs);
      timer.unref?.();
    });
    const envelope = JSON.parse(line);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new Error("scoped embedding envelope is invalid");
    }
    const envelopeKeys = Object.keys(envelope).sort();
    if (
      envelopeKeys.length !== 5
      || !["dimensions", "fingerprintId", "model", "request", "token"].every((key, index) => envelopeKeys[index] === key)
    ) {
      throw new Error("scoped embedding envelope contains unknown or missing fields");
    }
    if (!tokensEqual(String(envelope.token || ""), token || "")) {
      const error = new Error("scoped embedding authentication failed");
      error.code = "scoped_embedding_auth_failed";
      throw error;
    }
    if (envelope.model !== ownerIdentity.model || envelope.dimensions !== ownerIdentity.dimensions) {
      const error = new Error("scoped embedding model identity does not match the activation-owned provider");
      error.code = "scoped_embedding_identity_mismatch";
      throw error;
    }
    if (envelope.fingerprintId !== ownerIdentity.fingerprintId) {
      const error = new Error("scoped embedding fingerprint does not match the activation-owned provider");
      error.code = "scoped_embedding_fingerprint_mismatch";
      throw error;
    }
    return await runEmbeddingRequest(embeddings, envelope.request);
  };

  const start = () => {
    if (startPromise) return startPromise;
    if (shutdownPromise) throw new Error("scoped embedding IPC server is shut down");
    startPromise = (async () => {
      if (claim) {
        claimServer = createServer((socket) => socket.destroy());
        try {
          await listenServer(claimServer, resolveScopedEmbeddingOwnerClaimAddress(paths.directory));
        } catch (error) {
          if (error?.code === "EADDRINUSE") throw ownerAlreadyActiveError(error);
          throw error;
        }
        claimServer.on("error", (error) => safeWarn(logger, "scoped-embedding-ipc.claim", error));
      }
      // Unclaimed, the claim listener is not ours to open (ADR-001 C1), but a
      // claimed owner of this stateRoot in any process holds it (and its
      // owner.sock): connect-probe both — connecting opens no listener — and
      // refuse rather than overwrite that owner's token.
      if (!claim && (
        await existingSocketAcceptsConnections(resolveScopedEmbeddingOwnerClaimAddress(paths.directory))
        || (lstatIfPresent(paths.socketPath)?.isSocket() && await existingSocketAcceptsConnections(paths.socketPath))
      )) {
        throw ownerAlreadyActiveError();
      }
      // An explicit address is checked with lstat so a dangling symlink is
      // refused as unsafe; the legacy private path keeps its existsSync check.
      const stat = !socketPath
        ? null
        : explicitAddress
          ? lstatIfPresent(socketPath)
          : existsSync(socketPath) ? lstatSync(socketPath) : null;
      if (stat) {
        if (stat.isSymbolicLink() || !stat.isSocket()) {
          throw new Error("refusing unsafe scoped embedding socket path");
        }
        if (await existingSocketAcceptsConnections(socketPath)) {
          throw ownerAlreadyActiveError();
        }
        removeOwnedPath(socketPath, "socket");
      }
      const issueToken = () => {
        removeOwnedPath(paths.tokenPath, "file");
        token = randomBytes(32).toString("hex");
        writePrivateToken(paths.tokenPath, token);
        ownsPaths = true;
      };
      // With the claim listener held, nobody else can own the token, so it is
      // issued before listening (the OpenClaw order). Without it, the listen
      // itself is the exclusion: a live owner on the address must keep its
      // token, so the token is issued only after this server holds the address.
      if (claim) issueToken();
      server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        processSocket(socket)
          .then((result) => socket.end(encodeResponse({ ok: true, ...result })))
          .catch((error) => {
            try {
              socket.end(encodeResponse({ ok: false, error: errorPayload(error) }));
            } catch (writeError) {
              safeWarn(logger, "scoped-embedding-ipc.response", writeError);
              socket.destroy();
            }
          });
      });
      try {
        await listenServer(server, listenTarget);
      } catch (error) {
        if (!claim && error?.code === "EADDRINUSE") throw ownerAlreadyActiveError(error);
        throw error;
      }
      listening = true;
      // Unclaimed, nothing else elects a single owner per stateRoot, yet the
      // token file and activation epoch are per stateRoot. Refuse while another
      // owner in this process holds them (checked synchronously with issueToken
      // and activateOwnerEpoch below, so no start can interleave).
      if (!claim && activationEpochState(paths.directory).active) throw ownerAlreadyActiveError();
      if (socketPath) securePath(socketPath, { mode: 0o600 });
      if (!claim) issueToken();
      server.on("error", (error) => safeWarn(logger, "scoped-embedding-ipc.server", error));
      ownerEpoch = activateOwnerEpoch(paths.directory, token);
    })().catch(async (error) => {
      for (const socket of sockets) socket.destroy();
      try { await closeListeningServer(server); } catch (cleanupError) { error.serverCleanupError = cleanupError; }
      // Unclaimed: a socket file this server never bound belongs to someone else.
      if (socketPath && (claim ? ownsPaths : listening)) {
        try { removeOwnedPath(socketPath, "socket"); } catch (cleanupError) { error.socketCleanupError = cleanupError; }
      }
      if (ownsPaths) {
        try { removeOwnTokenFile(paths.tokenPath, token); } catch (cleanupError) { error.tokenCleanupError = cleanupError; }
      }
      server = null;
      listening = false;
      if (ownerEpoch !== null && token) deactivateOwnerEpoch(paths.directory, ownerEpoch, token);
      ownerEpoch = null;
      token = null;
      ownsPaths = false;
      try { await closeListeningServer(claimServer); } catch (cleanupError) { error.claimCleanupError = cleanupError; }
      claimServer = null;
      throw error;
    });
    return startPromise;
  };

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try { await startPromise; } catch (error) { safeWarn(logger, "scoped-embedding-ipc.start-cleanup", error); }
      if (ownerEpoch !== null && token) deactivateOwnerEpoch(paths.directory, ownerEpoch, token);
      ownerEpoch = null;
      if (server) {
        const current = server;
        const closed = closeListeningServer(current);
        for (const socket of sockets) socket.destroy();
        await closed;
      }
      if (ownsPaths) {
        if (socketPath) removeOwnedPath(socketPath, "socket");
        removeOwnTokenFile(paths.tokenPath, token);
      }
      server = null;
      listening = false;
      token = null;
      ownsPaths = false;
      await closeListeningServer(claimServer);
      claimServer = null;
    })();
    return shutdownPromise;
  };

  return Object.freeze({ start, shutdown, identity: ownerIdentity, tokenPath: paths.tokenPath });
}

function requestUnavailableError(cause) {
  const error = new Error("activation-owned embedding IPC capability is unavailable", { cause });
  error.code = "scoped_embedding_ipc_unavailable";
  return error;
}

function ownerChangedError() {
  const error = new Error("activation-owned embedding owner changed; discard the stale scoped provider");
  error.code = "scoped_embedding_owner_changed";
  return error;
}

function readIpcToken(paths) {
  let token;
  try {
    token = readFileSync(paths.tokenPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid scoped embedding token");
  } catch (error) {
    throw requestUnavailableError(error);
  }
  return token;
}

function requestIpc(target, token, identity, request) {
  const frame = `${JSON.stringify({ token, ...identity, request })}\n`;
  if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES) {
    return Promise.reject(new Error("scoped embedding request exceeds the transport limit"));
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(target);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(requestUnavailableError(new Error("response timeout"))), RESPONSE_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("scoped embedding response exceeds the transport limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response?.ok) {
          const error = new Error(response?.error?.message || "activation-owned embedding request failed");
          error.code = response?.error?.code || "plur1bus_scoped_embedding_error";
          finish(error);
          return;
        }
        finish(null, response);
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(requestUnavailableError(error)));
    socket.once("end", () => {
      if (!settled) finish(requestUnavailableError(new Error("response ended before a complete frame")));
    });
  });
}

/** Embedding provider used by request-scoped OpenClaw plugin registries.
 * `address` selects an explicit server address; the token is always read from
 * `resolveScopedEmbeddingIpcPaths(stateRoot).tokenPath`.
 * @param {{stateRoot: string, model: string, dimensions: number, fingerprintId: string, address?: {kind: string, address: string}}} cfg Scoped provider configuration.
 */
export class IpcScopedEmbeddingProvider {
  constructor(cfg = {}) {
    this.id = "local-transformers";
    this.model = cfg.model;
    this.dim = Number(cfg.dimensions);
    this.fingerprintId = expectedFingerprintId(cfg.fingerprintId);
    // Like the server: `null` is not "no address"; the legacy owner.sock is reached only by omitting it.
    if (cfg.address === null) throw new TypeError("scoped embedding IPC address is invalid");
    this.address = normalizeIpcAddress(cfg.address);
    this.paths = resolveScopedEmbeddingIpcPaths(cfg.stateRoot);
    this._closed = false;
    this._ownerToken = null;
    this._expectedOwnerEpoch = null;
    this._ownerBindingError = null;
    if (!this.model || !Number.isSafeInteger(this.dim) || this.dim < 1) {
      throw new Error("scoped embedding model and positive dimensions are required");
    }
    try {
      this._ownerToken = readIpcToken(this.paths);
    } catch (error) {
      this._ownerBindingError = error;
      this._expectedOwnerEpoch = activationEpochState(this.paths.directory).epoch + 1;
    }
  }

  dimensions() {
    return this.dim;
  }

  async _request(operation, texts) {
    if (this._closed) throw new Error("scoped embedding provider is shut down");
    const request = normalizeRequest({ operation, texts });
    if (!this._ownerToken) {
      const active = activationEpochState(this.paths.directory).active;
      if (!active) {
        throw this._ownerBindingError || requestUnavailableError(new Error("owner was absent at construction"));
      }
      if (active.epoch !== this._expectedOwnerEpoch) throw ownerChangedError();
      this._ownerToken = active.token;
      this._expectedOwnerEpoch = null;
      this._ownerBindingError = null;
    }
    const token = readIpcToken(this.paths);
    if (!tokensEqual(this._ownerToken, token)) throw ownerChangedError();
    const response = await requestIpc(this.address ? this.address.address : this.paths.socketPath, token, {
      model: this.model,
      dimensions: this.dim,
      fingerprintId: this.fingerprintId,
    }, request);
    return validateVectors(response?.vectors, request.texts.length, this.dim);
  }

  async embedBatch(texts) {
    return await this._request("batch", texts);
  }

  async embedQuery(text) {
    return (await this._request("query", [text]))[0];
  }

  async embedPassage(text) {
    return (await this._request("passage", [text]))[0];
  }

  async embed(text) {
    return await this.embedPassage(text);
  }

  async shutdown() {
    this._closed = true;
  }
}

/** Long-lived discovery facade that binds each pure embedding operation to the current owner epoch.
 * @param {{stateRoot: string, model: string, dimensions: number, fingerprintId: string, address?: {kind: string, address: string}}} cfg Scoped provider configuration; `address` is passed to each client.
 */
export class ReloadSafeIpcScopedEmbeddingProvider {
  constructor(cfg = {}) {
    this.id = "local-transformers";
    this.model = cfg.model;
    this.dim = Number(cfg.dimensions);
    this.fingerprintId = expectedFingerprintId(cfg.fingerprintId);
    if (cfg.address === null) throw new TypeError("scoped embedding IPC address is invalid");
    this._clientConfig = Object.freeze({
      stateRoot: cfg.stateRoot,
      model: this.model,
      dimensions: this.dim,
      fingerprintId: this.fingerprintId,
      address: normalizeIpcAddress(cfg.address) ?? undefined,
    });
    this._closed = false;
    this._active = new Set();
    if (!this.model || !Number.isSafeInteger(this.dim) || this.dim < 1) {
      throw new Error("scoped embedding model and positive dimensions are required");
    }
  }

  dimensions() {
    return this.dim;
  }

  async _dispatch(method, args) {
    if (this._closed) throw new Error("scoped embedding provider is shut down");
    let release;
    const settled = new Promise((resolve) => { release = resolve; });
    this._active.add(settled);
    let client = null;
    try {
      client = new IpcScopedEmbeddingProvider(this._clientConfig);
      return await client[method](...args);
    } finally {
      try {
        await client?.shutdown();
      } finally {
        this._active.delete(settled);
        release();
      }
    }
  }

  async embedBatch(texts, options = {}) {
    return await raceAbort(this._dispatch("embedBatch", [texts]), options.signal, "embedding aborted");
  }

  async embedQuery(text, options = {}) {
    return await raceAbort(this._dispatch("embedQuery", [text]), options.signal, "embedding aborted");
  }

  async embedPassage(text, options = {}) {
    return await raceAbort(this._dispatch("embedPassage", [text]), options.signal, "embedding aborted");
  }

  async embed(text, options = {}) {
    return await this.embedPassage(text, options);
  }

  async shutdown() {
    this._closed = true;
    await Promise.all([...this._active]);
  }
}

/** Register private IPC only after the full OpenClaw registry owns shutdown.
 * @param {{api: object, server: object, enabled: boolean, lifecycleRegistered: boolean}} options Service inputs.
 * @returns {boolean} Whether the activation-owned service was registered.
 */
export function registerScopedEmbeddingIpcServiceAfterLifecycle({
  api,
  server,
  enabled,
  lifecycleRegistered,
} = {}) {
  if (!enabled) return false;
  if (!lifecycleRegistered || typeof api?.registerService !== "function") {
    api?.logger?.warn?.(
      "memory-lancedb-namespaced: scoped embedding IPC disabled because OpenClaw lifecycle services are unavailable",
    );
    return false;
  }
  api.registerService({
    id: "plur1bus-scoped-embedding-owner",
    start: () => server.start(),
    stop: () => server.shutdown(),
  });
  return true;
}
