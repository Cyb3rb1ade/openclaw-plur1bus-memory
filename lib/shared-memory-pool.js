import { lstatSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { workspacePoolKey, userPoolKey } from "./memory-request-context.js";
import { openDirectoryCapability, pathMatchesDirectoryCapability, stableDirectoryCapabilitiesSupported } from "./directory-capability.js";
import { readDirectoryAcl, secureDirectoryOwnerOnly } from "./platform.js";
import { assertOwnerOnlyDirectory, openVerifiedPathDirectory } from "./verified-path-directory.js";
import { resolveInside } from "./sql-safety.js";
import { safeWarn } from "./safe-logging.js";

export const SHARED_ROOT_SEGMENT = ".plur1bus-shared";
const KIND_SEGMENTS = Object.freeze({ workspace: "workspaces", user: "users" });

export const SHARED_MEMORY_UNSUPPORTED = "SHARED_MEMORY_UNSUPPORTED";

/**
 * Matches the write-path `_ensureSharedRoot` throw's message (below) — the
 * single shared regex tests assert against instead of each hand-rolling
 * their own copy of the wording (E4 Task 6, fix round 1).
 */
export const SHARED_MEMORY_UNSUPPORTED_MESSAGE_RE = /shared memory is not supported on this platform/;

/**
 * @param {string} [reason="platform"] Why shared memory is unsupported (matches `support().reason`).
 * @returns {Error} "shared memory is not supported on this platform" with `.code === SHARED_MEMORY_UNSUPPORTED` and `.reason`.
 */
export function sharedMemoryUnsupportedError(reason = "platform") {
  const err = new Error("shared memory is not supported on this platform");
  err.code = SHARED_MEMORY_UNSUPPORTED;
  err.reason = reason;
  return err;
}

function entryExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function assertLexicalAbsolute(path) {
  if (typeof path !== "string" || !path) throw new TypeError("shared memory baseDir must be a non-empty string");
  return resolve(path);
}

const SHARED_MEMORY_MODES = Object.freeze(["fd-capability", "verified-path", "unavailable"]);

/**
 * The routing mode a `SharedMemoryPool` picks when none is forced (ADR 0001):
 * `fd-capability` wherever descriptor aliases work (Linux), `verified-path` on
 * darwin and win32, `unavailable` elsewhere.
 * @param {string} [platform] Platform to decide for (default `process.platform`).
 * @returns {"fd-capability"|"verified-path"|"unavailable"} Mode.
 */
export function defaultSharedMemoryMode(platform = process.platform) {
  if (stableDirectoryCapabilitiesSupported()) return "fd-capability";
  return platform === "darwin" || platform === "win32" ? "verified-path" : "unavailable";
}

/**
 * Map a verified-path failure to its `support().reason` taint. Fail-closed:
 * an error without a reason (e.g. `ENOSYS` for missing O_NOFOLLOW) is an
 * unsafe root; a pinned identity that moved is `identity-changed`.
 */
function taintReasonOf(error) {
  return error?.reason ?? (error?.code === "EIDENTITY" ? "identity-changed" : "unsafe-root");
}

/** The pool's own identity-mismatch error; `code: "EIDENTITY"` maps to the `identity-changed` taint. */
function identityChanged(which) {
  const error = new Error(`shared memory ${which} identity changed`);
  error.code = "EIDENTITY";
  return error;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * ADR 0001 step 3: the shared base belongs to the current user. POSIX: owner
 * = uid and not group/other-writable. win32: owner SID = current user SID.
 * Errors carry `reason` (`unsafe-root` or `acl-tool-unavailable`) and name
 * only `path`.
 */
function assertBaseOwnedByUser(path, { platform = process.platform, uid = process.getuid?.(), readAcl = readDirectoryAcl } = {}) {
  const refuse = (message, reason = "unsafe-root") => Object.assign(new Error(`${message}: ${path}`), { reason });
  if (platform === "win32") {
    let acl;
    try { acl = readAcl(path); } catch (error) {
      if (error?.reason === "acl-tool-unavailable") throw refuse("shared memory base ACL cannot be read", "acl-tool-unavailable");
      throw refuse("shared memory base ownership cannot be verified");
    }
    if (typeof acl?.userSid !== "string" || typeof acl?.ownerSid !== "string"
      || acl.ownerSid.toUpperCase() !== acl.userSid.toUpperCase()) {
      throw refuse("shared memory base has a foreign owner");
    }
    return;
  }
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch { throw refuse("shared memory base is missing or unreadable"); }
  if (!Number.isInteger(uid) || stat.uid !== BigInt(uid)) throw refuse("shared memory base has a foreign owner");
  if ((stat.mode & 0o022n) !== 0n) throw refuse("shared memory base is writable by other users");
}

/**
 * Descriptor-backed (Linux) or verified-path (darwin, win32; ADR 0001),
 * physically isolated workspace and user memory pool router.
 */
export class SharedMemoryPool {
  /**
   * @param {string} baseDir Shared base directory.
   * @param {number} vectorDim Vector dimension.
   * @param {Function} AgentDbPoolClass AgentDbPool (or a subclass).
   * @param {object} [logger] Optional logger.
   * @param {{mode?: "fd-capability"|"verified-path"|"unavailable"}} [options] `mode` forces the routing mode (tests); default {@link defaultSharedMemoryMode}.
   */
  constructor(baseDir, vectorDim, AgentDbPoolClass, logger = null, { mode = defaultSharedMemoryMode() } = {}) {
    if (typeof AgentDbPoolClass !== "function") throw new TypeError("SharedMemoryPool requires an AgentDbPool class");
    if (!SHARED_MEMORY_MODES.includes(mode)) throw new TypeError("SharedMemoryPool mode must be fd-capability, verified-path or unavailable");
    this.baseDir = assertLexicalAbsolute(baseDir);
    this.vectorDim = vectorDim;
    this.AgentDbPool = AgentDbPoolClass;
    this.logger = logger;
    this.mode = mode;
    this.supported = mode !== "unavailable";
    // Verified-path only: why the pool stopped trusting its root (a
    // `support().reason`); set once, cleared only by a restart.
    this.taint = null;
    this.ownerChecked = false;
    this.baseOwnerChecked = false;
    this.rootCapability = null;
    this.sharedCapability = null;
    this.sharedPath = null;
    this.workspaceWritePool = null;
    this.userWritePool = null;
    this.workspaceReadPool = null;
    this.userReadPool = null;
    this.activeOperations = new Set();
    this.shutdownPromise = null;
    this.isShutdown = false;
    this.warnedUnsupportedRead = false;
  }

  _assertOpen() { if (this.isShutdown) throw new Error("shared memory pool is shutdown"); }

  /**
   * Read-only, no filesystem access: {@link SharedMemorySupport} (1.8.0,
   * types/engine.d.ts) for `Engine.status().sharedMemory`. Linux's only mode
   * is `fd-capability`; darwin and win32 use `verified-path` (ADR 0001),
   * which answers `supported: false` with the taint's reason
   * (`unsafe-root`, `acl-tool-unavailable`, `identity-changed`) once a check
   * failed. `unavailable` always means reason `platform`.
   * @returns {{supported: boolean, mode: string, reason?: string}}
   */
  support() {
    if (!this.supported) return { supported: false, mode: "unavailable", reason: "platform" };
    return this.taint
      ? { supported: false, mode: this.mode, reason: this.taint }
      : { supported: true, mode: this.mode };
  }

  _verified() { return this.mode === "verified-path"; }

  _openDirectory(path, options) {
    return this._verified() ? openVerifiedPathDirectory(path, options) : openDirectoryCapability(path, options);
  }

  /**
   * Whether `path`, opened afresh, is still `capability`'s directory. fd mode:
   * `pathMatchesDirectoryCapability`; verified-path: the pinned identity of a
   * freshly walked `VerifiedPathDirectory`.
   */
  _pathMatches(path, capability) {
    if (!this._verified()) return pathMatchesDirectoryCapability(path, capability);
    let current;
    try {
      current = openVerifiedPathDirectory(path);
      return sameIdentity(current.identity, capability.identity);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") return false;
      if (error?.reason === "unsafe-root") return false;
      throw error;
    } finally {
      current?.close();
    }
  }

  /** Verified-path: record the first failure as the pool's taint and log it (log-safe). */
  _taint(error, reason = taintReasonOf(error)) {
    if (!this.taint) {
      this.taint = reason;
      safeWarn(this.logger, "shared-memory-pool", new Error(`verified-path shared memory disabled until restart (${reason})`));
    }
  }

  _key(kind, ctx) {
    const value = kind === "workspace" ? ctx?.workspaceIdentity : ctx?.userPrincipal;
    if (!value) throw new Error(kind === "workspace"
      ? "shared pool requires a bound workspace"
      : "shared pool requires an authenticated user principal");
    return kind === "workspace" ? workspacePoolKey(value) : userPoolKey(value);
  }

  _existingBaseAncestor() {
    let current = this.baseDir;
    while (!entryExists(current)) {
      const parent = dirname(current);
      if (parent === current) throw new Error("shared memory base has no existing ancestor");
      current = parent;
    }
    return current;
  }

  _openBase({ create }) {
    if (this.rootCapability) {
      if (!this._pathMatches(this.baseDir, this.rootCapability)) throw identityChanged("base");
      return true;
    }
    if (!entryExists(this.baseDir) && !create) return false;
    const ancestor = this._existingBaseAncestor();
    const missing = relative(ancestor, this.baseDir).split(sep).filter(Boolean);
    resolveInside(ancestor, ...missing);
    const capability = this._openDirectory(this.baseDir, { create });
    try {
      if (!this._pathMatches(this.baseDir, capability)) throw identityChanged("base");
      this.rootCapability = capability;
    } catch (error) {
      capability.close();
      throw error;
    }
    return true;
  }

  /**
   * Verified-path, first write lease only (ADR 0001 step 4): a root this
   * pool just created is restricted to the current user; then the root must
   * be owner-only. A pre-existing looser root is refused (`unsafe-root`),
   * never silently tightened. The base (step 3) is checked earlier, before
   * the root is created (`_openSharedRoot`).
   */
  _assertOwnerPolicy(createdRoot) {
    if (this.ownerChecked) return;
    if (createdRoot) {
      const secured = secureDirectoryOwnerOnly(this.sharedCapability.path);
      if (!secured.applied) {
        throw Object.assign(new Error(`shared memory root cannot be restricted: ${this.sharedCapability.path}`), { reason: secured.reason === "acl-tool-unavailable" ? "acl-tool-unavailable" : "unsafe-root" });
      }
    }
    assertOwnerOnlyDirectory(this.sharedCapability.path);
    this.ownerChecked = true;
  }

  _ensureSharedRoot({ create }) {
    this._assertOpen();
    if (!this.supported || this.taint) {
      if (!create) {
        if (!this.warnedUnsupportedRead) {
          this.warnedUnsupportedRead = true;
          safeWarn(this.logger, "shared-memory-pool", new Error(this.taint
            ? `verified-path shared memory is disabled (${this.taint}); shared reads are disabled`
            : "stable directory capabilities unavailable; shared reads are disabled"));
        }
        return false;
      }
      throw sharedMemoryUnsupportedError(this.taint ?? "platform");
    }
    if (!this._verified()) return this._openSharedRoot({ create });
    try {
      return this._openSharedRoot({ create });
    } catch (error) {
      if (!this.isShutdown) this._taint(error);
      throw error;
    }
  }

  _openSharedRoot({ create }) {
    if (!this._openBase({ create })) return false;
    this._assertOpen();
    const sharedPath = resolveInside(this.baseDir, SHARED_ROOT_SEGMENT);
    // ADR 0001 step 3, before anything is created under the base: a base
    // that passed the ancestor walk only because it is sticky (e.g. a 1777
    // directory) must not receive a `.plur1bus-shared`.
    if (this._verified() && create && !this.baseOwnerChecked) {
      assertBaseOwnedByUser(this.rootCapability.path);
      this.baseOwnerChecked = true;
    }
    if (!this.sharedCapability) {
      const createdRoot = this._verified() && create && !entryExists(resolveInside(this.rootCapability.path, SHARED_ROOT_SEGMENT));
      let capability;
      try { capability = this.rootCapability.openChild(SHARED_ROOT_SEGMENT, { create }); }
      catch (error) { if (!create && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return false; throw error; }
      try {
        if (!this.rootCapability.childMatches(SHARED_ROOT_SEGMENT, capability)
          || !this._pathMatches(sharedPath, capability)) throw identityChanged("root");
        this.sharedCapability = capability;
        this.sharedPath = sharedPath;
      } catch (error) {
        capability.close();
        throw error;
      }
      if (createdRoot) this._assertOwnerPolicy(true);
    }
    if (this._verified() && create) this._assertOwnerPolicy(false);
    if (!this.rootCapability.childMatches(SHARED_ROOT_SEGMENT, this.sharedCapability)
      || !this._pathMatches(sharedPath, this.sharedCapability)) {
      throw identityChanged("root");
    }
    return true;
  }

  _slot(kind, readOnly) { return `${kind}${readOnly ? "Read" : "Write"}Pool`; }

  _getPool(kind, readOnly) {
    const slot = this._slot(kind, readOnly);
    if (this[slot]) return this[slot];
    const segment = KIND_SEGMENTS[kind];
    const basePath = resolveInside(this.sharedPath, segment);
    this[slot] = new this.AgentDbPool(basePath, this.vectorDim, this.logger, {
      readOnly,
      secureRouting: true,
      parentDirectoryCapability: this.sharedCapability,
      baseSegment: segment,
      pathGuard: () => this.assertSharedRoot(),
    });
    return this[slot];
  }

  _readRouteExists(kind, key) {
    this.assertSharedRoot();
    const segment = KIND_SEGMENTS[kind];
    const kindPath = resolveInside(this.sharedPath, segment);
    let kindCapability;
    try {
      kindCapability = this.sharedCapability.openChild(segment);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
      throw error;
    }
    try {
      const keyPath = resolveInside(kindPath, key);
      let keyCapability;
      try {
        keyCapability = kindCapability.openChild(key);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
        throw error;
      }
      try {
        return kindCapability.childMatches(key, keyCapability)
          && this._pathMatches(keyPath, keyCapability);
      } finally {
        keyCapability.close();
      }
    } finally {
      kindCapability.close();
    }
  }

  assertSharedRoot() {
    this._assertOpen();
    if (!this.sharedPath || !this.sharedCapability || !this.rootCapability
      || !this.rootCapability.childMatches(SHARED_ROOT_SEGMENT, this.sharedCapability)
      || !this._pathMatches(this.sharedPath, this.sharedCapability)) {
      throw identityChanged("root");
    }
  }

  _assertRootAfterLease() {
    if (this.isShutdown) return;
    try {
      this.assertSharedRoot();
    } catch (error) {
      this._taint(error, "identity-changed");
      throw error;
    }
  }

  async _lease(kind, ctx, fn, { readOnly }) {
    this._assertOpen();
    if (typeof fn !== "function") throw new TypeError("shared memory lease requires a callback");
    const key = this._key(kind, ctx);
    const operation = (async () => {
      if (!this._ensureSharedRoot({ create: !readOnly })) return fn(null);
      if (!this._verified()) {
        this._assertOpen();
        if (readOnly && !this._readRouteExists(kind, key)) return fn(null);
        return this._getPool(kind, readOnly).withDb(key, fn);
      }
      try {
        this._assertOpen();
        if (readOnly && !this._readRouteExists(kind, key)) return fn(null);
        return await this._getPool(kind, readOnly).withDb(key, fn);
      } finally {
        // ADR 0001 step 5: the root is re-verified after every lease; a
        // mismatch taints the pool until restart (this caller sees the
        // storage error, later shares see `unsupported`).
        this._assertRootAfterLease();
      }
    })();
    this.activeOperations.add(operation);
    try { return await operation; } finally { this.activeOperations.delete(operation); }
  }

  withWorkspaceDb(ctx, fn) { return this._lease("workspace", ctx, fn, { readOnly: false }); }
  withUserDb(ctx, fn) { return this._lease("user", ctx, fn, { readOnly: false }); }
  withWorkspaceReadDb(ctx, fn) {
    this._assertOpen();
    return ctx?.workspaceIdentity ? this._lease("workspace", ctx, fn, { readOnly: true }) : fn(null);
  }
  withUserReadDb(ctx, fn) {
    this._assertOpen();
    return ctx?.userPrincipal ? this._lease("user", ctx, fn, { readOnly: true }) : fn(null);
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.isShutdown = true;
    this.shutdownPromise = (async () => {
      await Promise.allSettled([...this.activeOperations]);
      const results = await Promise.allSettled([
        this.workspaceWritePool, this.userWritePool, this.workspaceReadPool, this.userReadPool,
      ].filter(Boolean).map((pool) => pool.shutdown()));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      try { this.sharedCapability?.close(); } catch (error) { errors.push(error); } finally { this.sharedCapability = null; }
      try { this.rootCapability?.close(); } catch (error) { errors.push(error); } finally { this.rootCapability = null; }
      if (errors.length) throw new AggregateError(errors, "shared memory pool shutdown failed");
    })();
    return this.shutdownPromise;
  }
}
