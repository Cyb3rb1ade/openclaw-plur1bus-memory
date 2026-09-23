/**
 * lib/platform.js — the four platform decisions, in one place.
 *
 * `securePath`            — host-contract §f.9: chmod is not a permission on
 *                           Windows, so a token or state file written 0o600
 *                           stays world-readable there.
 * `ipcAddress`            — the embedding owner's transport per platform.
 * `isUnsafeLink`          — host-contract §f.15: `isSymbolicLink()` is false
 *                           for a Windows junction or reparse point.
 * `canonicalIdentityPath` — ADR-002 §"Principal and turn-origin contract":
 *                           `C:\Users\X` and `c:\users\x` must hash alike.
 *
 * Every function takes a `platform` option that defaults to `process.platform`
 * at call time, mirroring `resolveScopedEmbeddingOwnerClaimAddress`
 * (lib/providers/scoped-embedding-ipc.js:207), so unit tests can reach the
 * win32 branches on Linux either by passing the option or by stubbing
 * `process.platform`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, fchmodSync, lstatSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";

const NAMED_PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * A value `securePath` and `isUnsafeLink` can actually act on. Named pipes and
 * Linux abstract sockets have no filesystem entry.
 * @param {unknown} target Candidate path.
 * @returns {boolean} True when the value is a real filesystem path.
 */
export function isFilesystemPath(target) {
  if (typeof target !== "string" || target.length === 0) return false;
  if (target.startsWith(NAMED_PIPE_PREFIX)) return false;
  if (target.startsWith("\0")) return false;
  return true;
}

/**
 * Restrict a path to the current user.
 *
 * POSIX: `chmod` (on `fd` when one is supplied, which is race-free).
 * win32: a per-user SID ACL via `icacls`, because `chmod` only toggles the
 *        read-only bit there.
 *
 * Never throws for an address that has no filesystem entry; the caller gets
 * `{ applied: false, reason: "not-a-filesystem-path" }` so an embedding owner
 * on a named pipe does not fail to start.
 *
 * @param {string} target Filesystem path.
 * @param {{mode?: number, fd?: number|null, platform?: string,
 *          execFile?: Function, username?: string|null}} [options] Options.
 * @returns {{applied: boolean, reason?: string, mechanism?: "chmod"|"acl"}} Outcome.
 */
export function securePath(target, {
  mode = 0o600,
  fd = null,
  platform = process.platform,
  execFile = execFileSync,
  username = null,
} = {}) {
  if (!isFilesystemPath(target)) return { applied: false, reason: "not-a-filesystem-path" };
  if (platform !== "win32") {
    if (fd !== null && fd !== undefined) fchmodSync(fd, mode);
    else chmodSync(target, mode);
    return { applied: true, mechanism: "chmod" };
  }
  const who = username || userInfo().username;
  execFile("icacls", [target, "/inheritance:r", "/grant:r", `${who}:(F)`], { stdio: "ignore" });
  return { applied: true, mechanism: "acl" };
}

/**
 * The embedding-owner IPC address for a state root.
 *
 * linux  — abstract socket, no filesystem entry, released on process death.
 * win32  — named pipe `\\.\pipe\plur1bus-embedding-<sha256(stateRoot)[0:32]>`.
 * other  — filesystem socket under the state root (darwin, BSD).
 *
 * @param {string} stateRoot Canonical private state directory.
 * @param {{platform?: string}} [options] Options.
 * @returns {{kind: "abstract-socket"|"unix-socket"|"named-pipe", address: string}} Address.
 */
export function ipcAddress(stateRoot, { platform = process.platform } = {}) {
  const digest = createHash("sha256").update(String(stateRoot)).digest("hex").slice(0, 32);
  if (platform === "linux") {
    return Object.freeze({ kind: "abstract-socket", address: `\0plur1bus-embedding-${digest}` });
  }
  if (platform === "win32") {
    return Object.freeze({ kind: "named-pipe", address: `${NAMED_PIPE_PREFIX}plur1bus-embedding-${digest}` });
  }
  return Object.freeze({ kind: "unix-socket", address: resolve(stateRoot, "owner.sock") });
}

/**
 * True when a path must not be followed: a symlink anywhere, and additionally
 * a junction or other reparse point on Windows, where `isSymbolicLink()` is
 * false. A missing path is not unsafe.
 *
 * @param {string} target Path to inspect.
 * @param {{platform?: string, stat?: import("node:fs").Stats|null}} [options] Options.
 * @returns {boolean} True when the path is a link the caller must refuse.
 */
export function isUnsafeLink(target, { platform = process.platform, stat = null } = {}) {
  if (!isFilesystemPath(target)) return false;
  let entry = stat;
  if (!entry) {
    try {
      entry = lstatSync(target);
    } catch {
      return false;
    }
  }
  if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) return true;
  if (platform !== "win32") return false;
  try {
    return realpathSync.native(target) !== resolve(target);
  } catch {
    return false;
  }
}

/**
 * The stable identity form of a path, used before hashing a workspace
 * principal. On Windows the filesystem is case-insensitive and accepts both
 * separators, so `C:/Users/X` and `c:\users\x` must produce one string.
 *
 * @param {string} target Path to canonicalise.
 * @param {{platform?: string}} [options] Options.
 * @returns {string} Canonical identity path.
 */
export function canonicalIdentityPath(target, { platform = process.platform } = {}) {
  const absolute = resolve(String(target));
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    resolved = absolute;
  }
  if (platform !== "win32") return resolved;
  return resolved.replace(/\//g, "\\").toLowerCase();
}
