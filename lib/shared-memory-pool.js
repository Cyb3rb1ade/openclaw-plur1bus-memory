import { existsSync, lstatSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { workspacePoolKey, userPoolKey } from "./memory-request-context.js";
import { openDirectoryCapability, pathMatchesDirectoryCapability, stableDirectoryCapabilitiesSupported } from "./directory-capability.js";
import { resolveInside } from "./sql-safety.js";
import { safeWarn } from "./safe-logging.js";

export const SHARED_ROOT_SEGMENT = ".plur1bus-shared";
const KIND_SEGMENTS = Object.freeze({ workspace: "workspaces", user: "users" });

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

/** Descriptor-backed, physically isolated workspace and user memory pool router. */
export class SharedMemoryPool {
  constructor(baseDir, vectorDim, AgentDbPoolClass, logger = null) {
    if (typeof AgentDbPoolClass !== "function") throw new TypeError("SharedMemoryPool requires an AgentDbPool class");
    this.baseDir = assertLexicalAbsolute(baseDir);
    this.vectorDim = vectorDim;
    this.AgentDbPool = AgentDbPoolClass;
    this.logger = logger;
    this.supported = stableDirectoryCapabilitiesSupported();
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
      if (!pathMatchesDirectoryCapability(this.baseDir, this.rootCapability)) throw new Error("shared memory base identity changed");
      return true;
    }
    if (!entryExists(this.baseDir) && !create) return false;
    const ancestor = this._existingBaseAncestor();
    const missing = relative(ancestor, this.baseDir).split(sep).filter(Boolean);
    resolveInside(ancestor, ...missing);
    const capability = openDirectoryCapability(this.baseDir, { create });
    try {
      if (!pathMatchesDirectoryCapability(this.baseDir, capability)) throw new Error("shared memory base identity changed");
      this.rootCapability = capability;
    } catch (error) {
      capability.close();
      throw error;
    }
    return true;
  }

  _ensureSharedRoot({ create }) {
    this._assertOpen();
    if (!this.supported) {
      if (!create) {
        if (!this.warnedUnsupportedRead) {
          this.warnedUnsupportedRead = true;
          safeWarn(this.logger, "shared-memory-pool", new Error("stable directory capabilities unavailable; shared reads are disabled"));
        }
        return false;
      }
      throw new Error("stable directory capabilities are unavailable; explicit shared memory is disabled");
    }
    if (!this._openBase({ create })) return false;
    this._assertOpen();
    const sharedPath = resolveInside(this.baseDir, SHARED_ROOT_SEGMENT);
    if (!this.sharedCapability) {
      let capability;
      try { capability = this.rootCapability.openChild(SHARED_ROOT_SEGMENT, { create }); }
      catch (error) { if (!create && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return false; throw error; }
      try {
        if (!this.rootCapability.childMatches(SHARED_ROOT_SEGMENT, capability)
          || !pathMatchesDirectoryCapability(sharedPath, capability)) throw new Error("shared memory root identity changed");
        this.sharedCapability = capability;
        this.sharedPath = sharedPath;
      } catch (error) {
        capability.close();
        throw error;
      }
    }
    if (!this.rootCapability.childMatches(SHARED_ROOT_SEGMENT, this.sharedCapability)
      || !pathMatchesDirectoryCapability(sharedPath, this.sharedCapability)) {
      throw new Error("shared memory root identity changed");
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
          && pathMatchesDirectoryCapability(keyPath, keyCapability);
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
      || !pathMatchesDirectoryCapability(this.sharedPath, this.sharedCapability)) {
      throw new Error("shared memory root identity changed");
    }
  }

  async _lease(kind, ctx, fn, { readOnly }) {
    this._assertOpen();
    if (typeof fn !== "function") throw new TypeError("shared memory lease requires a callback");
    const key = this._key(kind, ctx);
    const operation = (async () => {
      if (!this._ensureSharedRoot({ create: !readOnly })) return fn(null);
      this._assertOpen();
      if (readOnly && !this._readRouteExists(kind, key)) return fn(null);
      return this._getPool(kind, readOnly).withDb(key, fn);
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
