/**
 * scripts/dist/installer/hermes/binding.mjs — one Hermes home bound to one PLUR1BUS agent.
 *
 * The same rules as the harness provider's hosts/hermes/plur1bus/binding.py (HM2-R8 as amended by
 * HM2-R8a, ruling F11), checked against the shared vectors (tests/fixtures/hermes/binding-vectors.json,
 * a byte copy of the harness file):
 *   * agent ids key on realpath(HERMES_HOME): the default root is `hermes-default`,
 *     `<default root>/profiles/<p>` is `hermes-<fold(p)>`, any other home `hermes-home-<sha256(realpath)[:8]>`;
 *   * fold = `hermes-` + ASCII A-Z lower-cased, every other code point outside [a-z0-9_-] → `-`, 64 chars;
 *   * Windows compares homes with full Unicode case folding (Python casefold); the hash is over the exact UTF-8 string.
 * Files: `$HERMES_HOME/plur1bus.json` (`plur1bus.hermes-binding/1`, 0600) and
 * `<plur1bus home>/hosts/hermes-bindings.json` (`plur1bus.hermes-bindings/1`, `{agentId: hermesHome}`).
 * Registry readers ignore unknown keys (ruling F12). Writes are atomic; the registry's
 * read-modify-write is serialised against other installer runs and the provider's `hermes plur1bus bind` by the
 * shared O_EXCL lock file `hosts/.hermes-bindings.lock` (withRegistryLock).
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

import { sleepSync, writeFileAtomic } from "../fsutil.mjs";

export const BINDING_SCHEMA = "plur1bus.hermes-binding/1";
export const BINDING_FILE = "plur1bus.json";
export const REGISTRY_SCHEMA = "plur1bus.hermes-bindings/1";
export const INSTALLED_BY = "plur1bus-plugin-installer";
export const DEFAULT_RECALL_HARD_MS = 600;
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_ID_MAX = 64;
const PREFIX = "hermes-";

export class BindingConflict extends Error {
  constructor(agentId, otherHome, home) {
    super(`agent ${agentId} is already bound to the Hermes home ${otherHome}${home ? ` (this home: ${home})` : ""}`);
    this.agentId = agentId;
    this.otherHome = otherHome;
    this.home = home ?? null;
  }
}

const pathFor = (platform) => (platform === "win32" ? win32 : posix);

export function foldProfile(profile) {
  let out = "";
  for (const ch of String(profile)) {
    const c = ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
    out += /^[a-z0-9_-]$/.test(c) ? c : "-";
  }
  return (PREFIX + out).slice(0, AGENT_ID_MAX);
}

export function homeHash8(realHome) {
  return createHash("sha256").update(Buffer.from(realHome, "utf8")).digest("hex").slice(0, 8);
}

/**
 * Full Unicode case folding as Python's `str.casefold()` compares (binding.py `_same_path`): per code point
 * lower → upper → lower, so ß/ẞ fold to `ss`, every sigma (final ς too) to `σ`, ligatures expand, and İ becomes
 * `i̇` (never plain `i`). The one exception is U+0131 (dotless ı), which casefold keeps. Checked against
 * CPython's casefold for every code point both Unicode versions assign (the remaining differences are
 * characters newer than CPython's Unicode database). Cherokee folds to one case on both sides.
 */
export function foldCase(text) {
  let out = "";
  for (const ch of String(text)) out += ch === "\u0131" ? ch : ch.toLowerCase().toUpperCase().toLowerCase();
  return out;
}

/** Python's `ntpath.normcase(..).casefold()` on win32 (`/` → `\`, full case folding), exact match elsewhere. */
export function samePath(a, b, platform) {
  if (platform === "win32") return foldCase(a.replaceAll("/", "\\")) === foldCase(b.replaceAll("/", "\\"));
  return a === b;
}

/** The agent id for an already resolved home and default root (pure; the shared vectors test this). */
export function classifyHome(realHome, realRoot, platform = process.platform) {
  const P = pathFor(platform);
  if (samePath(realHome, realRoot, platform)) return foldProfile("default");
  const parent = P.dirname(realHome);
  const name = P.basename(realHome);
  const parentName = P.basename(parent);
  const isProfiles = platform === "win32" ? parentName.toLowerCase() === "profiles" : parentName === "profiles";
  if (name && isProfiles && samePath(P.dirname(parent), realRoot, platform)) return foldProfile(name);
  return `${PREFIX}home-${homeHash8(realHome)}`;
}

/** realpath of `p`, or of its deepest existing ancestor plus the missing tail (a profile not created yet). */
export function realish(p, platform = process.platform) {
  const P = pathFor(platform);
  const tail = [];
  let cur = P.resolve(p);
  for (;;) {
    try {
      return P.join(realpathSync.native(cur), ...tail);
    } catch {
      const parent = P.dirname(cur);
      if (parent === cur) return P.resolve(p);
      tail.unshift(P.basename(cur));
      cur = parent;
    }
  }
}

/**
 * The agent id for a Hermes home (HM2-R8a). `profile` (Hermes' agent_identity) is informational: the path decides.
 * @param {{ hermesHome: string, defaultRoot: string, profile?: string|null, platform?: string }} a
 */
export function agentIdFor({ hermesHome, defaultRoot, profile = null, platform = process.platform }) {
  void profile;
  return classifyHome(realish(hermesHome, platform), realish(defaultRoot, platform), platform);
}

export function bindingPath(hermesHome) {
  return join(hermesHome, BINDING_FILE);
}

/** The binding document ({} fields per plur1bus.hermes-binding/1). */
export function makeBinding({ home, bin, agentId, version, recallHardMs = DEFAULT_RECALL_HARD_MS, capture = true }) {
  if (!AGENT_ID_RE.test(agentId)) throw new Error(`invalid agent id ${JSON.stringify(agentId)}`);
  return { schema: BINDING_SCHEMA, version: version ?? null, installedBy: INSTALLED_BY, home, bin: bin ?? null, agentId, recallHardMs, capture };
}

/** Write `$HERMES_HOME/plur1bus.json` atomically, mode 0600. */
export function writeBinding(hermesHome, b) {
  if (b?.schema !== BINDING_SCHEMA || !AGENT_ID_RE.test(b.agentId) || typeof b.home !== "string") throw new Error("refusing to write an invalid binding");
  writeFileAtomic(bindingPath(hermesHome), `${JSON.stringify(b, null, 2)}\n`);
}

/**
 * The binding of `hermesHome`: null without a file, { invalid: reason } for a bad one. Unknown keys are ignored.
 * @returns {null | { invalid: string } | { home: string, agentId: string, bin: string|null, version: string|null, installedBy: string|null, text: string }}
 */
export function readBinding(hermesHome) {
  let text;
  try {
    text = readFileSync(bindingPath(hermesHome), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    return { invalid: `unreadable (${err?.code ?? err})` };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { invalid: "not valid JSON", text };
  }
  if (!doc || typeof doc !== "object" || doc.schema !== BINDING_SCHEMA || typeof doc.home !== "string" || !AGENT_ID_RE.test(String(doc.agentId))) {
    return { invalid: `not a ${BINDING_SCHEMA} document`, text };
  }
  return {
    home: doc.home,
    agentId: doc.agentId,
    bin: typeof doc.bin === "string" ? doc.bin : null,
    version: typeof doc.version === "string" ? doc.version : null,
    installedBy: typeof doc.installedBy === "string" ? doc.installedBy : null,
    text,
  };
}

export function removeBinding(hermesHome) {
  rmSync(bindingPath(hermesHome), { force: true });
}

export function registryPath(plur1busHome) {
  return join(plur1busHome, "hosts", "hermes-bindings.json");
}

/** `{agentId: hermesHome}` from the registry ({} without one). Throws for an unreadable or foreign document. */
export function readRegistry(plur1busHome) {
  let text;
  try {
    text = readFileSync(registryPath(plur1busHome), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw new Error(`${registryPath(plur1busHome)}: unreadable (${err?.code ?? err})`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${registryPath(plur1busHome)}: not valid JSON`);
  }
  if (!doc || typeof doc !== "object" || doc.schema !== REGISTRY_SCHEMA || !doc.bindings || typeof doc.bindings !== "object") {
    throw new Error(`${registryPath(plur1busHome)}: not a ${REGISTRY_SCHEMA} document`);
  }
  const out = {};
  for (const [k, v] of Object.entries(doc.bindings)) if (typeof v === "string") out[k] = v;
  return out;
}

/** `bindings` plus agentId → realHome (pure); the same pair is unchanged, an id held by another home throws BindingConflict. */
export function registryAdd(bindings, agentId, realHome, platform = process.platform) {
  const other = bindings[agentId];
  if (other !== undefined && !samePath(other, realHome, platform)) throw new BindingConflict(agentId, other, realHome);
  return other === undefined ? { ...bindings, [agentId]: realHome } : { ...bindings };
}

/** Hermes homes other than `hermesHome` in the registry (ruling F4: purge refuses while any is bound). */
export function otherBoundHomes(plur1busHome, hermesHome, platform = process.platform) {
  const real = realish(hermesHome, platform);
  return Object.entries(readRegistry(plur1busHome)).filter(([, h]) => !samePath(h, real, platform)).map(([agentId, home]) => ({ agentId, home }));
}

/** True when agentId is already registered for hermesHome, false when free; throws BindingConflict otherwise. Writes nothing. */
export function checkBinding(plur1busHome, agentId, hermesHome, platform = process.platform) {
  const bindings = readRegistry(plur1busHome);
  registryAdd(bindings, agentId, realish(hermesHome, platform), platform);
  return agentId in bindings;
}

/**
 * The registry lock shared with the Python provider (hosts/hermes/plur1bus/_filelock.py `ExclusiveLockFile`, used
 * by binding.py `register_binding`; harness cab7783, c0e2575); both sides implement exactly this protocol:
 *   * path `<plur1bus home>/hosts/.hermes-bindings.lock` (`hosts/` created 0700), created O_CREAT|O_EXCL, mode 0600;
 *     the content `<pid> <hostname> <ms> <nonce>\n` (nonce: 128-bit hex) is written and the fd closed before the
 *     critical section; Windows: EPERM/EACCES on create (a name pending deletion) is "busy", like EEXIST;
 *   * stale: mtime older than 60 s, or a pid of this host that no longer runs on a lock at least 1 s old
 *     (`process.kill(pid, 0)` → ESRCH; libuv probes Windows processes the way Python's OpenProcess check does);
 *   * breaking a stale lock, at most one rename per poll round: rename it to `<lock>.break-<random>`, re-stat and
 *     re-read the moved file; when dev/ino and content are the ones judged stale, unlink it and retry the create at
 *     once; otherwise a live lock was moved: put it back with link() (never overwrites; EEXIST means a new holder
 *     exists) and unlink the break file. A break that removed nothing (rename failed, the file vanished, or it was
 *     put back) sleeps 25 ms and checks the deadline: no spinning;
 *   * release: rename to `<lock>.rel-<my nonce>`; on Windows EPERM/EACCES/EBUSY (a reader without
 *     FILE_SHARE_DELETE) is retried, backoff 10 ms doubling to 100 ms, for at most 2 s, then the lock is left to the
 *     stale rules. Only ENOENT means gone; then, when a `<lock>.break-*` / `.rel-*` file holds my nonce (a waiter
 *     moved my live lock aside and is putting it back), wait for the put-back (poll 5 ms, the same 2 s) and release
 *     it, so no live-pid lock with an abandoned nonce stays behind. The moved file is unlinked only when it holds my
 *     nonce, else put back as above (a stolen lock is never deleted; an unreadable one is left to the sweep);
 *   * the holder calls assertHeld() just before writing the registry: lock-lost unless its nonce is in the lock,
 *     waiting out a pending put-back the same way;
 *   * moved files are unlinked with a 0.5 s Windows sharing retry, else left to the sweep; `*.break-*` / `*.rel-*`
 *     leftovers older than 60 s are removed; 25 ms poll, 10 s deadline.
 */
export const REGISTRY_LOCK_FILE = ".hermes-bindings.lock";
const LOCK_STALE_MS = 60_000;
const LOCK_DEADLINE_MS = 10_000;
const LOCK_POLL_MS = 25;
const RELEASE_RETRY_MS = 2_000;
const SETTLE_POLL_MS = 5;

export class RegistryLockTimeout extends Error {
  constructor(lock) {
    super(`the bindings registry is locked (${lock})`);
    this.code = "LOCK_TIMEOUT";
  }
}

export class RegistryLockLost extends Error {
  constructor(lock) {
    super(`lock-lost: the bindings registry lock ${lock} is no longer ours; the registry was not written`);
    this.code = "LOCK_LOST";
  }
}

const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

const statId = (p) => {
  try {
    const st = statSync(p, { bigint: true });
    return { dev: st.dev, ino: st.ino, mtimeMs: Number(st.mtimeMs) };
  } catch {
    return null;
  }
};

/** The lock text holds `nonce` as its fourth field (Python `_holds`). */
const holds = (text, nonce) => String(text ?? "").trim().split(/\s+/)[3] === nonce;

const SHARING_CODES = ["EPERM", "EACCES", "EBUSY"];

/**
 * Run `op` (a rename or unlink): true when it succeeded, false when the source is gone (ENOENT). On win32 a sharing
 * error (EPERM/EACCES/EBUSY) is retried for `budgetMs` (backoff 10 ms doubling to 100 ms) and then re-thrown; every
 * other error propagates (Python `_retry_sharing`).
 */
function retrySharing(op, budgetMs, platform) {
  const deadline = Date.now() + budgetMs;
  let delay = 10;
  for (;;) {
    try {
      op();
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      if (platform !== "win32" || !SHARING_CODES.includes(err?.code) || Date.now() >= deadline) throw err;
      sleepSync(delay);
      delay = Math.min(delay * 2, 100);
    }
  }
}

function judgedStale(text, st) {
  const age = Date.now() - st.mtimeMs;
  if (age > LOCK_STALE_MS) return true;
  const [pid, host] = String(text ?? "").trim().split(/\s+/);
  if (!/^\d+$/.test(pid ?? "") || host !== hostname() || age < 1000) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH"; // EPERM (another user's process) and an out-of-range pid count as alive
  }
}

/** Remove a moved-aside file; a Windows sharing error is retried for 0.5 s and then left to the sweep. */
function unlinkMoved(p, platform) {
  try {
    retrySharing(() => rmSync(p), 500, platform);
  } catch (err) {
    if (platform !== "win32") throw err;
  }
}

/** Put a moved live lock back without overwriting a newer one, then drop the moved name. */
function putBack(moved, lock, platform) {
  try {
    linkSync(moved, lock);
  } catch {
    // EEXIST: a new holder exists, so the moved one is not needed back
  }
  unlinkMoved(moved, platform);
}

/** A `<lock>.break-*` / `<lock>.rel-*` file holds `nonce`: our live lock was moved aside and is being put back. */
function movedAside(lock, nonce) {
  const dir = dirname(lock);
  const base = basename(lock);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => (n.startsWith(`${base}.break-`) || n.startsWith(`${base}.rel-`)) && holds(readText(join(dir, n)), nonce));
}

/**
 * True when the lock holds `nonce`. When it does not but a moved-aside file does, wait up to `budgetMs` (poll 5 ms)
 * for the put-back; the put-back links before it unlinks, so once no moved file holds the nonce one more read of the
 * lock decides (Python `_settle`).
 */
function settle(lock, nonce, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (holds(readText(lock), nonce)) return true;
    if (!movedAside(lock, nonce)) return holds(readText(lock), nonce);
    if (Date.now() >= deadline) return false;
    sleepSync(SETTLE_POLL_MS);
  }
}

/** Move the lock judged stale aside and remove it; true only when that stale file was removed (Python `_break`). */
function breakStale(lock, st, text, platform) {
  const moved = `${lock}.break-${randomBytes(16).toString("hex")}`;
  try {
    renameSync(lock, moved);
  } catch {
    return false; // gone, or (Windows) busy: the wait loop sleeps and the next round decides
  }
  const st2 = statId(moved);
  if (!st2) return false; // swept meanwhile; it was old
  if (st2.dev === st.dev && st2.ino === st.ino && readText(moved) === text) {
    unlinkMoved(moved, platform);
    return true;
  }
  putBack(moved, lock, platform); // a live lock taken after our check: return it
  return false;
}

function sweepLockLeftovers(lock, platform) {
  const dir = dirname(lock);
  const base = `${basename(lock)}.`;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(base) || !/^(break|rel)-[0-9a-f]+$/.test(n.slice(base.length))) continue;
    const st = statId(join(dir, n));
    if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      try {
        unlinkMoved(join(dir, n), platform);
      } catch {
        // gone meanwhile
      }
    }
  }
}

/**
 * TEST ONLY (both PLUR1BUS_PLUGIN_INSTALLER_TEST=1 and PLUR1BUS_LOCK_TEST_PAUSE_DIR=<dir> set): the first time this
 * process judges a lock stale it writes <dir>/judged and waits (at most 20 s) for <dir>/go before breaking it, so a
 * test can let another process break that lock and take its own in between: the double-break race made
 * deterministic (tests/dist-hermes-install.test.js). Without both variables it does nothing.
 */
function testPauseAfterJudge() {
  const dir = process.env.PLUR1BUS_LOCK_TEST_PAUSE_DIR;
  if (process.env.PLUR1BUS_PLUGIN_INSTALLER_TEST !== "1" || !dir || existsSync(join(dir, "judged"))) return;
  writeFileSync(join(dir, "judged"), "1");
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(dir, "go")) && Date.now() < deadline) sleepSync(5);
}

/** Release our hold (Python `_release`); never throws. */
function releaseLock(lock, nonce, platform) {
  const moved = `${lock}.rel-${nonce}`;
  const deadline = Date.now() + RELEASE_RETRY_MS;
  for (;;) {
    let renamed;
    try {
      renamed = retrySharing(() => renameSync(lock, moved), Math.max(0, deadline - Date.now()), platform);
    } catch {
      return; // still busy after the retries, or e.g. a read-only directory: the stale rules apply to it
    }
    if (renamed) break;
    // gone: either our lock was broken (nothing of ours to remove), or a waiter moved it aside and is putting it
    // back; then wait for the put-back and release it, so it is not left behind
    if (!settle(lock, nonce, Math.max(0, deadline - Date.now())) || Date.now() >= deadline) return;
  }
  const text = readText(moved);
  try {
    if (holds(text, nonce)) unlinkMoved(moved, platform);
    else if (text !== null) putBack(moved, lock, platform); // our lock was broken meanwhile: never release someone else's
  } catch {
    // left to the sweep
  }
}

/**
 * Run `fn({ assertHeld })` under the registry lock; `assertHeld()` throws RegistryLockLost unless the lock still holds
 * this run's nonce (call it right before writing). An async `fn` holds the lock until its promise settles.
 */
export function withRegistryLock(plur1busHome, fn, { platform = process.platform } = {}) {
  const lock = join(plur1busHome, "hosts", REGISTRY_LOCK_FILE);
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  sweepLockLeftovers(lock, platform);
  const nonce = randomBytes(16).toString("hex");
  const token = `${process.pid} ${hostname()} ${Date.now()} ${nonce}\n`;
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (;;) {
    let fd = null;
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (err) {
      const busy = err?.code === "EEXIST" || (platform === "win32" && (err?.code === "EPERM" || err?.code === "EACCES"));
      if (!busy) throw err;
    }
    if (fd !== null) {
      try {
        writeSync(fd, token);
      } catch (err) {
        closeSync(fd);
        releaseLock(lock, nonce, platform);
        throw err;
      }
      closeSync(fd);
      break;
    }
    const st = statId(lock);
    const text = st ? readText(lock) : null;
    if (st && text !== null && judgedStale(text, st)) {
      testPauseAfterJudge();
      if (breakStale(lock, st, text, platform)) continue; // retry the create at once
    }
    if (Date.now() >= deadline) throw new RegistryLockTimeout(lock);
    sleepSync(LOCK_POLL_MS);
  }
  const assertHeld = () => {
    if (!settle(lock, nonce, RELEASE_RETRY_MS)) throw new RegistryLockLost(lock);
  };
  const release = () => releaseLock(lock, nonce, platform);
  let result;
  try {
    result = fn({ assertHeld });
  } catch (err) {
    release();
    throw err;
  }
  if (result && typeof result.then === "function") return result.finally(release);
  release();
  return result;
}

function writeRegistry(plur1busHome, bindings) {
  const sorted = Object.fromEntries(Object.entries(bindings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileAtomic(registryPath(plur1busHome), `${JSON.stringify({ schema: REGISTRY_SCHEMA, bindings: sorted }, null, 2)}\n`);
}

/**
 * Record agentId → realpath(hermesHome). Re-registering the same pair is a no-op; a conflict throws BindingConflict.
 * @returns {{ added: boolean, home: string }}
 */
export function registerBinding(plur1busHome, agentId, hermesHome, platform = process.platform) {
  const real = realish(resolve(hermesHome), platform);
  return withRegistryLock(plur1busHome, ({ assertHeld }) => {
    const bindings = readRegistry(plur1busHome);
    const updated = registryAdd(bindings, agentId, real, platform);
    if (agentId in bindings) return { added: false, home: real };
    assertHeld();
    writeRegistry(plur1busHome, updated);
    return { added: true, home: real };
  });
}

/** Remove agentId from the registry when it is bound to hermesHome (rollback of registerBinding). */
export function unregisterBinding(plur1busHome, agentId, hermesHome, platform = process.platform) {
  return withRegistryLock(plur1busHome, ({ assertHeld }) => unregisterLocked(plur1busHome, agentId, hermesHome, platform, assertHeld));
}

/** unregisterBinding for a caller that already holds the registry lock. */
export function unregisterLocked(plur1busHome, agentId, hermesHome, platform, assertHeld) {
  const real = realish(resolve(hermesHome), platform);
  const bindings = readRegistry(plur1busHome);
  if (!(agentId in bindings) || !samePath(bindings[agentId], real, platform)) return false;
  delete bindings[agentId];
  assertHeld();
  writeRegistry(plur1busHome, bindings);
  return true;
}
