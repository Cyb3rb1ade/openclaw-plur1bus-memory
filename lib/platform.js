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
 * `secureDirectoryOwnerOnly` / `readDirectoryAcl` — ADR 0001 (verified-path
 *                           shared memory): make a directory owner-only and
 *                           read back its Windows owner and ACEs.
 *
 * Every function takes a `platform` option that defaults to `process.platform`
 * at call time, mirroring `resolveScopedEmbeddingOwnerClaimAddress`
 * (lib/providers/scoped-embedding-ipc.js:207), so unit tests can reach the
 * win32 branches on Linux either by passing the option or by stubbing
 * `process.platform`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, openSync, realpathSync } from "node:fs";
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
 *        read-only bit there. `fd` is ignored on win32 — there is no
 *        `fchmod`-equivalent ACL call, so `icacls` always re-resolves by
 *        `target`'s path instead (a caller with a POSIX-only `fd`-based
 *        race-free path, e.g. `lib/shared-memory-migration.js:216`, falls
 *        back to path resolution there).
 *
 * Never throws for an address that has no filesystem entry; the caller gets
 * `{ applied: false, reason: "not-a-filesystem-path" }` so an embedding owner
 * on a named pipe does not fail to start.
 *
 * @param {string} target Filesystem path.
 * @param {{mode?: number, fd?: number|null, platform?: string,
 *          execFile?: Function, username?: string|null}} [options] Options.
 *          `fd` is POSIX-only; it is not consulted on win32.
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
  try {
    execFile("icacls", [target, "/inheritance:r", "/grant:r", `${who}:(F)`], { stdio: "ignore" });
  } catch (error) {
    if (error.code === "ENOENT") return { applied: false, reason: "acl-tool-unavailable" };
    throw error;
  }
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

/**
 * The `O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` flag set for opening a
 * directory without following a link (POSIX). Shared with
 * lib/verified-path-directory.js. Fails closed: when `O_DIRECTORY` or
 * `O_NOFOLLOW` is missing, the open would silently follow links, so this
 * throws (`code: "ENOSYS"`) instead of degrading to 0.
 *
 * @param {Record<string, number|undefined>} [fsConstants] `fs.constants` (injectable for tests).
 * @returns {number} Open flags.
 */
export function noFollowDirectoryFlags(fsConstants = constants) {
  if (!fsConstants.O_DIRECTORY || !fsConstants.O_NOFOLLOW) {
    const error = new Error("O_DIRECTORY and O_NOFOLLOW are unavailable; refusing to open directories that could be links");
    error.code = "ENOSYS";
    throw error;
  }
  return (fsConstants.O_RDONLY ?? 0) | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | (fsConstants.O_CLOEXEC ?? 0);
}

/**
 * Restrict a directory to the current user, inheritably (ADR 0001 step 4).
 *
 * POSIX: `fchmod 0o700` through an `O_DIRECTORY|O_NOFOLLOW` descriptor, so a
 *        symlink at `target` is refused (`ELOOP`) instead of followed.
 * win32: `icacls <target> /inheritance:r /grant:r <user>:(OI)(CI)(F)` — drops
 *        the inherited ACEs and grants the current user full control that is
 *        inherited by children. The path is an argv element, never a shell
 *        string.
 *
 * Same result shape as `securePath`.
 *
 * @param {string} target Directory path.
 * @param {{platform?: string, execFile?: Function, username?: string|null}} [options] Options.
 * @returns {{applied: boolean, reason?: string, mechanism?: "chmod"|"acl"}} Outcome.
 */
export function secureDirectoryOwnerOnly(target, {
  platform = process.platform,
  execFile = execFileSync,
  username = null,
} = {}) {
  if (!isFilesystemPath(target)) return { applied: false, reason: "not-a-filesystem-path" };
  if (platform !== "win32") {
    const fd = openSync(target, noFollowDirectoryFlags());
    try {
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
    return { applied: true, mechanism: "chmod" };
  }
  const who = username || userInfo().username;
  try {
    execFile("icacls", [target, "/inheritance:r", "/grant:r", `${who}:(OI)(CI)(F)`], { stdio: "ignore", windowsHide: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { applied: false, reason: "acl-tool-unavailable" };
    throw error;
  }
  return { applied: true, mechanism: "acl" };
}

/**
 * The PowerShell program behind `readDirectoryAcl`. It is a constant: the
 * path arrives only through `$env:PLUR1BUS_ACL_PATH`, so no caller-supplied
 * text is ever parsed as PowerShell. SIDs are read untranslated.
 */
const READ_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sidType = [System.Security.Principal.SecurityIdentifier]",
  "$acl = Get-Acl -LiteralPath $env:PLUR1BUS_ACL_PATH",
  "$aces = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType } })",
  "[pscustomobject]@{ ownerSid = $acl.GetOwner($sidType).Value; userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; aces = $aces } | ConvertTo-Json -Compress -Depth 4",
].join("\n");
const READ_ACL_ENCODED = Buffer.from(READ_ACL_SCRIPT, "utf16le").toString("base64");
const SID_PATTERN = /^S-1-\d+(-\d+)*$/;

function aclReadError(target, message, code) {
  const error = new Error(`${message}: ${target}`);
  error.reason = "acl-tool-unavailable";
  if (code) error.code = code;
  return error;
}

/**
 * Windows PowerShell 5.1 `ConvertTo-Json` quirks: an ETS-wrapped array can
 * serialise as `{"value":[…],"Count":n}`, and a one-element array as the
 * bare object. Both are unwrapped to a plain array; anything else is null.
 */
function normalizeAceList(aces) {
  if (Array.isArray(aces)) return aces;
  if (!aces || typeof aces !== "object") return null;
  if (Array.isArray(aces.value) && Number.isInteger(aces.Count) && aces.Count === aces.value.length) return aces.value;
  return [aces];
}

function parseAcl(target, output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output ?? "").replace(/^\uFEFF/, "").trim());
  } catch {
    throw aclReadError(target, "directory ACL read returned malformed output");
  }
  const isSid = (value) => typeof value === "string" && SID_PATTERN.test(value);
  const rawAces = normalizeAceList(parsed?.aces);
  if (!parsed || !isSid(parsed.ownerSid) || !isSid(parsed.userSid) || !rawAces) {
    throw aclReadError(target, "directory ACL read returned malformed output");
  }
  const aces = rawAces.map((ace) => {
    if (!ace || !isSid(ace.sid) || (ace.type !== "Allow" && ace.type !== "Deny")) {
      throw aclReadError(target, "directory ACL read returned malformed output");
    }
    return { sid: ace.sid, type: ace.type };
  });
  return { ownerSid: parsed.ownerSid, userSid: parsed.userSid, aces };
}

/**
 * Read a directory's owner SID, the current user's SID and its access ACEs
 * (win32 only; ADR 0001 step 4).
 *
 * Runs `powershell.exe -NoProfile -NonInteractive -EncodedCommand <constant>`
 * with the path in the environment variable `PLUR1BUS_ACL_PATH`; the path is
 * never part of the argv or the script. Any failure — the tool missing
 * (`ENOENT`), a non-zero exit, a timeout or output that is not the expected
 * JSON — throws an Error with `reason: "acl-tool-unavailable"` whose message
 * names only `target`.
 *
 * @param {string} target Directory path.
 * @param {{execFile?: Function}} [options] Options.
 * @returns {{ownerSid: string, userSid: string, aces: Array<{sid: string, type: "Allow"|"Deny"}>}} ACL.
 */
export function readDirectoryAcl(target, { execFile = execFileSync } = {}) {
  let output;
  try {
    output = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", READ_ACL_ENCODED],
      {
        env: { ...process.env, PLUR1BUS_ACL_PATH: String(target) },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 30_000,
      },
    );
  } catch (error) {
    if (error?.code === "ENOENT") throw aclReadError(target, "directory ACL tool is unavailable", "ENOENT");
    throw aclReadError(target, "directory ACL read failed");
  }
  return parseAcl(target, output);
}
