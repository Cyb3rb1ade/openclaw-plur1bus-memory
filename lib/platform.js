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
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { isSid, parseWhoamiCsv, parseWmiAcl } from "./windows-acl-parse.js";

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
 * win32  — named pipe `\\.\pipe\plur1bus-embedding-<sha256(stateRoot)[0:32]>`.
 * other  — filesystem socket `<stateRoot>/owner.sock` (linux, darwin, BSD).
 *          Abstract sockets are Linux-only and never the default; a caller
 *          that wants one must pass an explicit `abstract-socket` address.
 *
 * @param {string} stateRoot Canonical private state directory.
 * @param {{platform?: string}} [options] Options.
 * @returns {{kind: "abstract-socket"|"unix-socket"|"named-pipe", address: string}} Address.
 */
export function ipcAddress(stateRoot, { platform = process.platform } = {}) {
  if (platform === "win32") {
    const digest = createHash("sha256").update(String(stateRoot)).digest("hex").slice(0, 32);
    return Object.freeze({ kind: "named-pipe", address: `${NAMED_PIPE_PREFIX}plur1bus-embedding-${digest}` });
  }
  // posix.resolve: the unix-socket branch is POSIX-only (identical to
  // resolve() on darwin/BSD/linux; an injected platform no longer borrows the
  // host's flavour).
  return Object.freeze({ kind: "unix-socket", address: posix.resolve(stateRoot, "owner.sock") });
}

/**
 * True when a path must not be followed: a symlink anywhere, and additionally
 * a junction or other reparse point on Windows, where `isSymbolicLink()` is
 * false. Only the last segment is judged (as `lstat` does); a short-name or
 * differently cased ancestor is not a link. A missing path is not unsafe.
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
  // Compare the entry against its own parent's canonical form, not against the
  // spelling the caller used: an ancestor spelled as an 8.3 short name
  // (`C:\Users\RUNNER~1\AppData\Local\Temp`) or in another case also makes
  // realpath differ, and that is not a reparse point at `target`. Only the
  // last segment is judged, as lstat's `isSymbolicLink()` does on POSIX. NTFS
  // names compare case-insensitively.
  try {
    const absolute = resolve(target);
    const parent = dirname(absolute);
    const expected = parent === absolute
      ? realpathSync.native(absolute)
      : join(realpathSync.native(parent), basename(absolute));
    return realpathSync.native(absolute).toLowerCase() !== expected.toLowerCase();
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
  // The requested platform's path flavour (the host's own on a real run).
  const absolute = (platform === "win32" ? win32 : posix).resolve(String(target));
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
 * text is ever parsed as PowerShell. SIDs are read untranslated. The ACL is
 * read through .NET (`Directory.GetAccessControl`, literal path) instead of the
 * `Get-Acl` cmdlet, so no module has to load.
 */
const READ_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sidType = [System.Security.Principal.SecurityIdentifier]",
  "$acl = [System.IO.Directory]::GetAccessControl($env:PLUR1BUS_ACL_PATH)",
  "$aces = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType } })",
  "[pscustomobject]@{ ownerSid = $acl.GetOwner($sidType).Value; userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; aces = $aces } | ConvertTo-Json -Compress -Depth 4",
].join("\n");
const READ_ACL_ENCODED = Buffer.from(READ_ACL_SCRIPT, "utf16le").toString("base64");
const READ_ACL_VBS = join(dirname(fileURLToPath(import.meta.url)), "read-directory-acl.vbs");
const ACL_TIMEOUT_MS = 30_000;

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
 * Environment for the Windows PowerShell 5.1 child. `PSModulePath` is dropped:
 * a parent started from PowerShell 7 passes its module paths on, and 5.1 then
 * fails to load its own modules. Without the variable 5.1 computes its default.
 * Windows environment names are case-insensitive, so every spelling goes.
 *
 * @param {string} target Directory path.
 * @param {Record<string, string|undefined>} [env] Parent environment.
 * @returns {Record<string, string|undefined>} Child environment.
 */
export function aclChildEnv(target, env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "psmodulepath") continue;
    out[key] = value;
  }
  out.PLUR1BUS_ACL_PATH = String(target);
  return out;
}

function aclSpawn(execFile, file, args, options, deadline) {
  return execFile(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    ...options,
    timeout: Math.max(1, deadline - Date.now()),
  });
}

/**
 * Fast path may take `target` as one argv element (no shell) only when it is
 * an absolute path with no NUL, quote or leading `-`. That is a recorded
 * deviation from the PowerShell fallback, which still passes the path only
 * through `PLUR1BUS_ACL_PATH`. The WMI script is a constant and also reads
 * that environment variable, never argv.
 */
function canUseAclFastPath(target) {
  if (typeof target !== "string" || target.length === 0) return false;
  if (target.includes("\0") || target.includes('"')) return false;
  if (target.trimStart().startsWith("-")) return false;
  return win32.isAbsolute(target);
}

/**
 * Absolute `System32` path for a built-in tool. `SystemRoot` must be an
 * absolute win32 path with no quote or NUL; otherwise `C:\Windows`.
 * @param {string} exe File name, e.g. `cscript.exe`.
 * @param {NodeJS.ProcessEnv} [env] Environment.
 * @returns {string} Win32 path.
 */
function windowsSystem32(exe, env = process.env) {
  const root = env.SystemRoot;
  const base = typeof root === "string"
    && win32.isAbsolute(root)
    && !root.includes("\0")
    && !root.includes('"')
    ? root
    : "C:\\Windows";
  return win32.join(base, "System32", exe);
}

/** Built-in Windows PowerShell 5.1. Not resolved through `PATH`. */
function windowsPowerShell(env = process.env) {
  return windowsSystem32(win32.join("WindowsPowerShell", "v1.0", "powershell.exe"), env);
}

function readDirectoryAclFast(target, execFile, deadline) {
  const wmiOut = aclSpawn(execFile, windowsSystem32("cscript.exe"), ["//Nologo", READ_ACL_VBS], {
    env: aclChildEnv(target),
  }, deadline);
  const parsed = parseWmiAcl(wmiOut);
  const who = aclSpawn(execFile, windowsSystem32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {}, deadline);
  return { ownerSid: parsed.ownerSid, userSid: parseWhoamiCsv(who), aces: parsed.aces };
}

/**
 * Read a directory's owner SID, the current user's SID and its access ACEs
 * (win32 only; ADR 0001 step 4).
 *
 * Fast path: `%SystemRoot%\System32\cscript.exe` runs a constant WMI script
 * (path in `PLUR1BUS_ACL_PATH`) plus `%SystemRoot%\System32\whoami.exe /user
 * /fo csv /nh`. Both print SIDs, not display names. PowerShell 5.1 remains the
 * fallback when a fast-path spawn fails or its stdout does not parse (a
 * `cscript` deprecation banner must not fail `/share` closed). An observed
 * NULL DACL (`DACL=NULL`) fails closed with no fallback. PowerShell 5.1 is
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. Any failure of both — the tool
 * missing (`ENOENT`), a non-zero exit, a timeout or output that is not the
 * expected shape — throws an Error with `reason: "acl-tool-unavailable"` whose
 * message names only `target`. The 30 s cap is the outer bound for the whole
 * read.
 *
 * @param {string} target Directory path.
 * @param {{execFile?: Function, timeoutMs?: number}} [options] Options.
 *          `timeoutMs` defaults to 30 s; production callers omit it. Tests that
 *          force the PowerShell 5.1 path on windows-11-arm may raise it: a
 *          cold 5.1 start there is 15-45 s, which is the reason for the fast
 *          path, not a change to the product cap.
 * @returns {{ownerSid: string, userSid: string, aces: Array<{sid: string, type: "Allow"|"Deny"}>}} ACL.
 */
export function readDirectoryAcl(target, { execFile = execFileSync, timeoutMs = ACL_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  if (canUseAclFastPath(target)) {
    try {
      return readDirectoryAclFast(target, execFile, deadline);
    } catch (error) {
      // NULL DACL is a real observation (everyone full access): fail closed.
      // Other parse failures and spawn failures use PowerShell 5.1.
      if (error?.code === "ACL_NULL_DACL") {
        throw aclReadError(target, "directory ACL has a null DACL");
      }
    }
  }
  let output;
  try {
    output = aclSpawn(
      execFile,
      windowsPowerShell(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", READ_ACL_ENCODED],
      { env: aclChildEnv(target) },
      deadline,
    );
  } catch (error) {
    if (error?.code === "ENOENT") throw aclReadError(target, "directory ACL tool is unavailable", "ENOENT");
    throw aclReadError(target, "directory ACL read failed");
  }
  return parseAcl(target, output);
}
