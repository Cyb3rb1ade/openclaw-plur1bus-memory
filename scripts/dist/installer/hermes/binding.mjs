/**
 * scripts/dist/installer/hermes/binding.mjs — one Hermes home bound to one PLUR1BUS agent.
 *
 * The same rules as the harness provider's hosts/hermes/plur1bus/binding.py (HM2-R8 as amended by
 * HM2-R8a, ruling F11), checked against the shared vectors (tests/fixtures/hermes/binding-vectors.json,
 * a byte copy of the harness file):
 *   * agent ids key on realpath(HERMES_HOME): the default root is `hermes-default`,
 *     `<default root>/profiles/<p>` is `hermes-<fold(p)>`, any other home `hermes-home-<sha256(realpath)[:8]>`;
 *   * fold = `hermes-` + ASCII A-Z lower-cased, every other code point outside [a-z0-9_-] → `-`, 64 chars;
 *   * Windows compares homes case-insensitively; the hash is over the exact UTF-8 string.
 * Files: `$HERMES_HOME/plur1bus.json` (`plur1bus.hermes-binding/1`, 0600) and
 * `<plur1bus home>/hosts/hermes-bindings.json` (`plur1bus.hermes-bindings/1`, `{agentId: hermesHome}`).
 * Registry readers ignore unknown keys (ruling F12). Writes are atomic; the registry's
 * read-modify-write is serialised against other installer runs by an exclusive lock file.
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";

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

/** Python's ntpath.normcase + casefold, close enough for paths: `/` → `\`, lower case. */
export function samePath(a, b, platform) {
  if (platform === "win32") return a.replaceAll("/", "\\").toLowerCase() === b.replaceAll("/", "\\").toLowerCase();
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

function withRegistryLock(plur1busHome, fn) {
  const lock = join(plur1busHome, "hosts", ".hermes-bindings.installer.lock");
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 10_000;
  let fd;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o600);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      // a lock left by a killed run: stale after 60 s
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { force: true });
      } catch {
        // gone meanwhile
      }
      if (Date.now() > deadline) throw new Error(`the bindings registry is locked (${lock})`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
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
  return withRegistryLock(plur1busHome, () => {
    const bindings = readRegistry(plur1busHome);
    const updated = registryAdd(bindings, agentId, real, platform);
    if (agentId in bindings) return { added: false, home: real };
    writeRegistry(plur1busHome, updated);
    return { added: true, home: real };
  });
}

/** Remove agentId from the registry when it is bound to hermesHome (rollback of registerBinding). */
export function unregisterBinding(plur1busHome, agentId, hermesHome, platform = process.platform) {
  const real = realish(resolve(hermesHome), platform);
  return withRegistryLock(plur1busHome, () => {
    const bindings = readRegistry(plur1busHome);
    if (!(agentId in bindings) || !samePath(bindings[agentId], real, platform)) return false;
    delete bindings[agentId];
    writeRegistry(plur1busHome, bindings);
    return true;
  });
}
