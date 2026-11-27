/**
 * lib/verified-path-directory.js — verified-path directories (ADR 0001,
 * Option B) for platforms without descriptor aliases (darwin, win32).
 *
 * `DirectoryCapability` (lib/directory-capability.js) hands LanceDB a
 * `/proc/self/fd/<n>/…` path that the kernel resolves through a held
 * descriptor. macOS and Windows have no such path form, so this module routes
 * by the canonical path instead and makes that safe by policy and by a pinned
 * identity:
 *
 * 1. The requested path is canonicalised once (`realpathSync.native` of its
 *    nearest existing ancestor plus the missing segments) and walked from the
 *    filesystem root one segment at a time with `lstat` (bigint). A symlink,
 *    junction or reparse point (`isUnsafeLink`) is refused with `ELOOP`, a
 *    non-directory with `ENOTDIR`.
 * 2. POSIX: every walked directory is owned by root or the current uid and is
 *    not group/other-writable unless the sticky bit is set; otherwise
 *    `reason: "unsafe-root"`. Windows checks reparse points only.
 * 3. Every held directory keeps its `{dev, ino}`. POSIX also holds an
 *    `O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` anchor descriptor so the inode
 *    cannot be freed and recycled for a look-alike. `assertOpen()` re-checks
 *    `lstat(path)` (and `fstat(anchor)` on POSIX) against the stored identity
 *    and throws `EIDENTITY` on any difference.
 *
 * Every error names the display path only — never identity numbers, SIDs or
 * the raw fs message. Anything unexpected fails closed.
 *
 * The object is duck-type-compatible with `DirectoryCapability`
 * (`assertOpen`, `openChild`, `childMatches`, `close`, `path`, `identity`,
 * `displayPath`).
 */

import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import { validateSegment } from "./directory-capability.js";
import { isUnsafeLink, noFollowDirectoryFlags, readDirectoryAcl } from "./platform.js";

const WIN32_ALLOWED_SIDS = new Set(["S-1-5-18", "S-1-5-32-544"]);

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function failure(message, displayPath, { code, reason } = {}) {
  const error = new Error(`${message}: ${displayPath}`);
  if (code) error.code = code;
  if (reason) error.reason = reason;
  return error;
}

/** Re-throw an fs error as a display-path-only error that keeps its code. */
function fsFailure(error, displayPath) {
  const code = typeof error?.code === "string" ? error.code : "EIO";
  return failure(`verified-path directory unavailable (${code})`, displayPath, { code });
}

function unsafeRoot(message, displayPath) {
  return failure(message, displayPath, { reason: "unsafe-root" });
}

function toBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  return null;
}

/** POSIX ancestor policy: owner root or `uid`, and not group/other-writable unless sticky. */
function assertPosixAncestor(stat, uid, displayPath) {
  const owner = toBigInt(stat.uid);
  const mode = toBigInt(stat.mode);
  const self = toBigInt(uid);
  if (owner === null || mode === null || self === null) {
    throw unsafeRoot("verified-path directory ownership cannot be established", displayPath);
  }
  if (owner !== 0n && owner !== self) {
    throw unsafeRoot("verified-path directory has a foreign owner", displayPath);
  }
  if ((mode & 0o022n) !== 0n && (mode & 0o1000n) === 0n) {
    throw unsafeRoot("verified-path directory is writable by other users", displayPath);
  }
}

/**
 * Check one lstat result: not a link, a directory, and (POSIX) the ancestor
 * policy. `path` is the real location, `displayPath` what errors name.
 */
function assertSegment(path, stat, displayPath, { platform, uid }) {
  if (isUnsafeLink(path, { platform, stat })) {
    throw failure("verified-path directory segment is a link", displayPath, { code: "ELOOP" });
  }
  if (typeof stat?.isDirectory !== "function" || !stat.isDirectory()) {
    throw failure("verified-path directory segment is not a directory", displayPath, { code: "ENOTDIR" });
  }
  if (platform !== "win32") assertPosixAncestor(stat, uid, displayPath);
}

function lstatEntry(lstat, path, displayPath) {
  try {
    return lstat(path, { bigint: true });
  } catch (error) {
    throw fsFailure(error, displayPath);
  }
}

/**
 * Open (and optionally create) one directory entry, verify it and pin it.
 * `path` must already be canonical up to its parent, which the caller holds.
 */
function openSegment(path, displayPath, { create, platform, uid, lstat }) {
  let stat;
  try {
    stat = lstat(path, { bigint: true });
  } catch (error) {
    if (!create || error?.code !== "ENOENT") throw fsFailure(error, displayPath);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (mkdirError) {
      // EEXIST: something appeared between the ENOENT and the mkdir — possibly
      // a planted link. It is re-lstat'ed and refused by the same checks.
      if (mkdirError?.code !== "EEXIST") throw fsFailure(mkdirError, displayPath);
    }
    stat = lstatEntry(lstat, path, displayPath);
  }
  assertSegment(path, stat, displayPath, { platform, uid });
  const identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
  let anchorFd = null;
  if (platform !== "win32") {
    try {
      anchorFd = openSync(path, noFollowDirectoryFlags());
    } catch (error) {
      throw fsFailure(error, displayPath);
    }
    try {
      if (!sameIdentity(fstatSync(anchorFd, { bigint: true }), identity)) {
        throw failure("verified-path directory identity changed", displayPath, { code: "EIDENTITY" });
      }
    } catch (error) {
      closeSync(anchorFd);
      if (error?.code === "EIDENTITY") throw error;
      throw fsFailure(error, displayPath);
    }
  }
  return new VerifiedPathDirectory(path, identity, anchorFd, { platform, uid, lstat, displayPath });
}

/** A path-routed directory whose identity is pinned and re-verified before use. */
export class VerifiedPathDirectory {
  /**
   * Internal: use `openVerifiedPathDirectory` or `openChild`.
   * @param {string} path Canonical real path.
   * @param {{dev: bigint, ino: bigint}} identity Pinned identity.
   * @param {number|null} anchorFd POSIX anchor descriptor, null on win32.
   * @param {{platform?: string, uid?: number, lstat?: Function, displayPath?: string}} [opts] Options.
   */
  constructor(path, identity, anchorFd, opts = {}) {
    const { platform = process.platform, uid = process.getuid?.(), lstat = lstatSync, displayPath = path } = opts;
    this.path = path;
    this.identity = Object.isFrozen(identity) ? identity : Object.freeze({ dev: identity.dev, ino: identity.ino });
    this.anchorFd = anchorFd ?? null;
    this.displayPath = displayPath;
    this.closed = false;
    this._platform = platform;
    this._uid = uid;
    this._lstat = lstat;
  }

  /** Throw unless still open and (POSIX) the anchor still denotes the pinned inode. */
  _assertHeld() {
    if (this.closed) throw failure("verified-path directory is closed", this.displayPath);
    if (this.anchorFd === null) return;
    let anchor;
    try {
      anchor = fstatSync(this.anchorFd, { bigint: true });
    } catch {
      throw failure("verified-path directory identity changed", this.displayPath, { code: "EIDENTITY" });
    }
    if (!sameIdentity(anchor, this.identity)) {
      throw failure("verified-path directory identity changed", this.displayPath, { code: "EIDENTITY" });
    }
  }

  /** Assert that `path` still names the pinned, non-link directory. */
  assertOpen() {
    this._assertHeld();
    let current;
    try {
      current = this._lstat(this.path, { bigint: true });
    } catch {
      throw failure("verified-path directory identity changed", this.displayPath, { code: "EIDENTITY" });
    }
    if (
      !sameIdentity(current, this.identity)
      || isUnsafeLink(this.path, { platform: this._platform, stat: current })
      || typeof current?.isDirectory !== "function"
      || !current.isDirectory()
    ) {
      throw failure("verified-path directory identity changed", this.displayPath, { code: "EIDENTITY" });
    }
  }

  /** Open one verified child directory, optionally creating it `0o700`. */
  openChild(name, { create = false } = {}) {
    this.assertOpen();
    const segment = validateSegment(name);
    const childPath = join(this.path, segment);
    const child = openSegment(childPath, resolve(this.displayPath, segment), {
      create,
      platform: this._platform,
      uid: this._uid,
      lstat: this._lstat,
    });
    // Re-check the parent after the child is pinned: a parent swapped while
    // the child was lstat'ed and opened must not leave a pinned child that was
    // reached through the swapped chain.
    try {
      this.assertOpen();
    } catch (error) {
      child.close();
      throw error;
    }
    return child;
  }

  /** Return whether `name` still resolves to `childDirectory`'s pinned identity. */
  childMatches(name, childDirectory) {
    this.assertOpen();
    if (!(childDirectory instanceof VerifiedPathDirectory)) {
      throw new TypeError("childMatches expects a VerifiedPathDirectory");
    }
    // Not assertOpen(): a swapped child path must answer false, not throw.
    childDirectory._assertHeld();
    let current;
    try {
      current = this.openChild(name);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") return false;
      // The name now resolves to something that fails the ancestor policy:
      // that is not the held child either.
      if (error?.reason === "unsafe-root") return false;
      throw error;
    }
    try {
      return sameIdentity(current.identity, childDirectory.identity);
    } finally {
      current.close();
    }
  }

  /** Release the anchor descriptor. Safe to call repeatedly. */
  close() {
    if (this.closed) return;
    this.closed = true;
    const fd = this.anchorFd;
    this.anchorFd = null;
    if (fd !== null) closeSync(fd);
  }
}

/** `realpathSync.native` of the nearest existing ancestor plus the missing segments. */
function canonicalise(absolutePath) {
  const missing = [];
  let existing = absolutePath;
  for (;;) {
    try {
      const real = realpathSync.native(existing);
      return missing.length ? join(real, ...missing) : real;
    } catch (error) {
      const parent = dirname(existing);
      if (error?.code !== "ENOENT" || parent === existing) throw fsFailure(error, absolutePath);
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

/**
 * Open (or create) an absolute directory as a `VerifiedPathDirectory`:
 * canonicalise once, walk from the root with `lstat`, apply the ancestor
 * policy to every segment and return the held leaf.
 *
 * @param {string} path Absolute path.
 * @param {{create?: boolean, platform?: string, uid?: number, lstat?: Function}} [options] Options.
 * @returns {VerifiedPathDirectory} Held leaf directory.
 */
export function openVerifiedPathDirectory(path, {
  create = false,
  platform = process.platform,
  uid = process.getuid?.(),
  lstat = lstatSync,
} = {}) {
  if (typeof path !== "string" || !path || path.includes("\0") || !isAbsolute(path)) {
    throw new TypeError("verified-path directory path must be absolute");
  }
  const requested = resolve(path);
  if (platform !== "win32") {
    // Fail closed before touching the filesystem when links cannot be refused.
    noFollowDirectoryFlags();
    if (toBigInt(uid) === null) {
      throw unsafeRoot("verified-path directory ownership cannot be established", requested);
    }
  }
  const canonical = canonicalise(requested);
  const { root } = parse(canonical);
  const segments = canonical.slice(root.length).split(sep).filter(Boolean);
  const options = { create, platform, uid, lstat };
  let current = openSegment(root, canonical, options);
  try {
    let currentPath = root;
    for (const segment of segments) {
      current.assertOpen();
      currentPath = join(currentPath, segment);
      const next = openSegment(currentPath, canonical, options);
      // Re-check the parent after the child is pinned (closes the window in
      // which an ancestor is swapped between its check and the child's open).
      try {
        current.assertOpen();
      } catch (error) {
        next.close();
        throw error;
      }
      current.close();
      current = next;
    }
    current.displayPath = canonical;
    return current;
  } catch (error) {
    current.close();
    throw error;
  }
}

/**
 * Throw unless `path` is a directory owned by the current user and private
 * to it (ADR 0001 step 4). POSIX: owner = `uid` and `(mode & 0o077) === 0`.
 * win32: owner SID = current user SID and every Allow ACE is for the user,
 * SYSTEM (`S-1-5-18`) or Administrators (`S-1-5-32-544`); Deny ACEs are fine.
 * Errors carry `reason: "unsafe-root"`, or `"acl-tool-unavailable"` when the
 * ACL cannot be read, and name only `path`.
 *
 * @param {string} path Directory path.
 * @param {{platform?: string, uid?: number, readAcl?: Function}} [options] Options.
 */
export function assertOwnerOnlyDirectory(path, {
  platform = process.platform,
  uid = process.getuid?.(),
  readAcl = readDirectoryAcl,
} = {}) {
  const displayPath = String(path);
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    throw unsafeRoot("owner-only directory is missing or unreadable", displayPath);
  }
  if (isUnsafeLink(path, { platform, stat }) || !stat.isDirectory()) {
    throw unsafeRoot("owner-only directory is not a plain directory", displayPath);
  }
  if (platform !== "win32") {
    const self = toBigInt(uid);
    if (self === null) throw unsafeRoot("owner-only directory ownership cannot be established", displayPath);
    if (toBigInt(stat.uid) !== self) throw unsafeRoot("owner-only directory has a foreign owner", displayPath);
    if ((toBigInt(stat.mode) & 0o077n) !== 0n) {
      throw unsafeRoot("owner-only directory is accessible to other users", displayPath);
    }
    return;
  }
  let acl;
  try {
    acl = readAcl(path);
  } catch (error) {
    if (error?.reason === "acl-tool-unavailable") {
      throw failure("owner-only directory ACL cannot be read", displayPath, { reason: "acl-tool-unavailable" });
    }
    throw unsafeRoot("owner-only directory ACL cannot be verified", displayPath);
  }
  const userSid = typeof acl?.userSid === "string" ? acl.userSid.toUpperCase() : null;
  const ownerSid = typeof acl?.ownerSid === "string" ? acl.ownerSid.toUpperCase() : null;
  if (!userSid || ownerSid !== userSid) {
    throw unsafeRoot("owner-only directory has a foreign owner", displayPath);
  }
  if (!Array.isArray(acl.aces)) throw unsafeRoot("owner-only directory ACL cannot be verified", displayPath);
  for (const ace of acl.aces) {
    if (ace?.type === "Deny") continue;
    const sid = typeof ace?.sid === "string" ? ace.sid.toUpperCase() : null;
    if (ace?.type !== "Allow" || !sid || (sid !== userSid && !WIN32_ALLOWED_SIDS.has(sid))) {
      throw unsafeRoot("owner-only directory grants access to other principals", displayPath);
    }
  }
}
