/**
 * scripts/dist/build-plugin-feed.mjs — build the (unsigned) plur1bus.plugin-feed/1 document.
 *
 * node scripts/dist/build-plugin-feed.mjs --channel stable|beta --version <v> --tgz <path> --tarball-url <url>
 *   --installer <path> --installer-url <url> --bootstrap-sh <p> --bootstrap-sh-url <u>
 *   --bootstrap-ps1 <p> --bootstrap-ps1-url <u> --notes-de <md-file> --notes-en <md-file>
 *   [--previous <feed.json> [--allow-older]] [--clawpack-digest <sha256-hex>] [--no-npm] [--security]
 *   [--hermes-lock <json> --hermes-notes-de <md> --hermes-notes-en <md>] --out <json>
 *
 * Reads version, openclaw.compat and engines.node from the tarball's package.json, computes SHA-256 and npm's
 * sha512 integrity, merges into --previous's releases (newest first, versions unique; a version below the previous
 * latest needs --allow-older and then keeps the previous installer and bootstraps), validates against
 * plugin-feed.schema.json and writes atomically. The release workflow runs this (Task 10); the owner signs the
 * result offline with minisign (HM1-R4). Exit 0 on success, 1 with the reason on stderr.
 *
 * `--hermes-lock` (HM2 Task 8) adds a `hosts.hermes` release from scripts/dist/hermes-sidecar.lock.json (the
 * harness release's provider tarball and five sidecar binaries) with its own German and English notes, merged
 * into --previous's Hermes releases the same way. A lock marked `"placeholder": true` or carrying an all-zero hash
 * is refused (ruling F31). Without --hermes-lock, --previous's `hosts.hermes` is carried over unchanged.
 */

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import schema from "./plugin-feed.schema.json" with { type: "json" };

export const FEED_SCHEMA = "plur1bus.plugin-feed/1";
export const PACKAGE_NAME = "@cyb3rb1ade/plur1bus-memory";
export const PLUGIN_ID = "memory-lancedb-namespaced";
export const HERMES_TARGETS = Object.freeze(["linux-x64", "linux-arm64", "darwin-arm64", "win-x64", "win-arm64"]);
export const HERMES_LOCK_SCHEMA = "plur1bus.hermes-sidecar-lock/1";
/** The provider's Python floor; the ceiling is Hermes' own requires-python (HM2-R25). */
export const HERMES_PYTHON = ">=3.11";

// ---------------------------------------------------------------------------
// Validation: a hand-written interpreter for the JSON Schema subset the feed
// schema uses (no Ajv: the plugin has no such dependency), plus the semantic
// rules the schema can only describe.
// ---------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function resolveRef(ref) {
  const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(ref);
  const target = m ? schema.$defs?.[m[1]] : undefined;
  if (target === undefined) throw new Error(`plugin-feed.schema.json: unresolvable $ref ${ref}`);
  return target;
}

function typeMatches(type, value) {
  switch (type) {
    case "object": return isObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    default: throw new Error(`plugin-feed.schema.json: unsupported type ${type}`);
  }
}

function check(node, value, path, errors) {
  const where = path || "(root)";
  if (node === true || node === undefined) return;
  if (node === false) {
    errors.push(`${where}: reserved and not allowed in ${FEED_SCHEMA}`);
    return;
  }
  if (node.$ref) {
    check(resolveRef(node.$ref), value, path, errors);
    return;
  }
  if ("const" in node && value !== node.const) {
    errors.push(`${where}: must be ${JSON.stringify(node.const)}`);
    return;
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${where}: must be one of ${node.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    return;
  }
  if (node.type && !typeMatches(node.type, value)) {
    errors.push(`${where}: must be of type ${node.type}`);
    return;
  }
  if (typeof value === "string") {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${where}: must not be empty`);
    if (node.pattern && !new RegExp(node.pattern, "u").test(value)) errors.push(`${where}: does not match ${node.pattern}`);
  }
  if (isObject(value)) {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path ? `${path}.` : ""}${key}: required`);
    }
    const props = node.properties ?? {};
    for (const [key, sub] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key in props) check(props[key], sub, childPath, errors);
      else if (node.additionalProperties === false) errors.push(`${childPath}: unknown property`);
    }
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${where}: needs at least ${node.minItems} item(s)`);
    if (node.items !== undefined) value.forEach((item, i) => check(node.items, item, `${path}.${i}`, errors));
  }
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * Compare two semver versions (build metadata not allowed).
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 */
export function compareVersions(a, b) {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) throw new Error(`not a semver version: ${ma ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  if (!ma[4] || !mb[4]) return (ma[4] ? -1 : 0) - (mb[4] ? -1 : 0);
  const pa = ma[4].split(".");
  const pb = mb[4].split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Every URL-carrying field of a structurally valid feed, as [path, url]. */
function feedUrls(feed) {
  return [
    ["installer.url", feed.installer.url],
    ["bootstrap.sh.url", feed.bootstrap.sh.url],
    ["bootstrap.ps1.url", feed.bootstrap.ps1.url],
    ...feed.hosts.openclaw.releases.map((r, i) => [`hosts.openclaw.releases.${i}.tarball.url`, r.tarball.url]),
    ...(feed.hosts.hermes?.releases ?? []).flatMap((r, i) => [
      [`hosts.hermes.releases.${i}.provider.url`, r.provider.url],
      ...HERMES_TARGETS.map((t) => [`hosts.hermes.releases.${i}.sidecar.binary.${t}.url`, r.sidecar.binary[t].url]),
    ]),
  ];
}

/** Sorted newest first, versions unique, latest = releases[0] (shared by both hosts). */
function checkReleaseList(host, list, errors) {
  const seen = new Set();
  list.releases.forEach((rel, i) => {
    const p = `hosts.${host}.releases.${i}`;
    if (seen.has(rel.version)) errors.push(`${p}.version: duplicate version ${rel.version}`);
    seen.add(rel.version);
    if (i > 0 && compareVersions(list.releases[i - 1].version, rel.version) <= 0) {
      errors.push(`${p}.version: releases must be sorted newest first`);
    }
  });
  if (list.latest !== list.releases[0].version) errors.push(`hosts.${host}.latest: must equal the newest release ${list.releases[0].version}`);
}

/**
 * Validate a feed against plugin-feed.schema.json and the feed's semantic rules.
 * Production callers use the default: every URL must be https://. Only tests pass allowFile: true.
 * @param {unknown} feed
 * @param {{ allowFile?: boolean }} [options]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateFeed(feed, { allowFile = false } = {}) {
  const errors = [];
  check(schema, feed, "", errors);
  if (errors.length === 0) {
    for (const [p, url] of feedUrls(feed)) {
      if (!url.startsWith("https://") && !(allowFile && url.startsWith("file://"))) {
        errors.push(`${p}: must be an https:// URL`);
      }
    }
    const oc = feed.hosts.openclaw;
    checkReleaseList("openclaw", oc, errors);
    oc.releases.forEach((rel, i) => {
      const p = `hosts.openclaw.releases.${i}`;
      if (rel.clawhub !== `clawhub:${PACKAGE_NAME}@${rel.version}`) errors.push(`${p}.clawhub: must be clawhub:${PACKAGE_NAME}@${rel.version}`);
      if (rel.npm !== undefined && rel.npm !== `npm:${PACKAGE_NAME}@${rel.version}`) errors.push(`${p}.npm: must be npm:${PACKAGE_NAME}@${rel.version}`);
    });
    const hermes = feed.hosts.hermes;
    if (hermes) {
      checkReleaseList("hermes", hermes, errors);
      hermes.releases.forEach((rel, i) => {
        if (compareVersions(rel.minHermesVersion, rel.testedHermesVersion) > 0) {
          errors.push(`hosts.hermes.releases.${i}.minHermesVersion: ${rel.minHermesVersion} is above testedHermesVersion ${rel.testedHermesVersion}`);
        }
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Tarball reading (npm pack output: gzip'd ustar, entries under package/).
// ---------------------------------------------------------------------------

function tarString(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function tarSize(buf, start) {
  if (buf[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + 12; i++) n = n * 256 + buf[i];
    return n;
  }
  const text = tarString(buf, start, 12).trim();
  return text ? parseInt(text, 8) : 0;
}

/**
 * Read `package/package.json` from an npm-pack tarball.
 * @param {Buffer} tgz
 * @returns {Record<string, any>}
 */
export function readPackageJsonFromTgz(tgz) {
  const tar = gunzipSync(tgz);
  let offset = 0;
  let longName = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = tarSize(tar, offset + 124);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "L") {
      longName = tarString(data, 0, data.length);
      continue;
    }
    const prefix = tarString(tar, dataStart - 512 + 345, 155);
    const shortName = tarString(tar, dataStart - 512, 100);
    const name = longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    longName = null;
    if ((type === "0" || type === "\0") && name.replace(/^\.\//, "") === "package/package.json") {
      return JSON.parse(data.toString("utf8"));
    }
  }
  throw new Error("tarball has no package/package.json");
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const integrity = (buf) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;

function readInput(path, what) {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`cannot read ${what} ${path}: ${err.code ?? err.message}`);
  }
}

/**
 * Build the feed document (not written).
 * @param {{ channel: string, version: string, tgz: string, tarballUrl: string, installer: string, installerUrl: string,
 *   bootstrapSh: string, bootstrapShUrl: string, bootstrapPs1: string, bootstrapPs1Url: string,
 *   notesDe: string, notesEn: string, previous?: string, allowOlder?: boolean, clawpackDigest?: string, npm?: boolean,
 *   security?: boolean, now?: Date, hermesLock?: string, hermesNotesDe?: string, hermesNotesEn?: string, allowPlaceholderLock?: boolean }} opts
 * @returns {Record<string, any>} a feed that passed validateFeed
 */
export function buildFeed(opts) {
  const tgz = readInput(opts.tgz, "tarball");
  let pkg;
  try {
    pkg = readPackageJsonFromTgz(tgz);
  } catch (err) {
    throw new Error(`cannot read package.json from ${opts.tgz}: ${err.message}`);
  }
  if (pkg.name !== PACKAGE_NAME) throw new Error(`tarball package is ${pkg.name}, expected ${PACKAGE_NAME}`);
  if (pkg.version !== opts.version) throw new Error(`--version ${opts.version} does not match the tarball's version ${pkg.version}`);
  const compat = pkg.openclaw?.compat;
  if (!isObject(compat)) throw new Error("tarball package.json has no openclaw.compat");
  if (typeof pkg.engines?.node !== "string") throw new Error("tarball package.json has no engines.node");

  let previous = null;
  if (opts.previous) {
    try {
      previous = JSON.parse(readInput(opts.previous, "previous feed").toString("utf8"));
    } catch (err) {
      throw new Error(err instanceof SyntaxError ? `previous feed ${opts.previous} is not JSON` : err.message);
    }
    const res = validateFeed(previous);
    if (!res.ok) throw new Error(`previous feed ${opts.previous} is invalid:\n  ${res.errors.join("\n  ")}`);
    if (previous.channel !== opts.channel) throw new Error(`previous feed is channel ${previous.channel}, not ${opts.channel}`);
    if (previous.hosts.openclaw.releases.some((r) => r.version === opts.version)) {
      throw new Error(`version ${opts.version} is already in the previous feed`);
    }
  }
  // An older hotfix is added as a release entry only: the newest installer and bootstraps stay.
  const older = previous !== null && compareVersions(opts.version, previous.hosts.openclaw.latest) < 0;
  if (older && !opts.allowOlder) {
    throw new Error(`version ${opts.version} is below the previous feed's latest ${previous.hosts.openclaw.latest}; pass --allow-older to add it as an older release`);
  }
  if (!older) {
    const missing = ARTEFACT_FLAGS.filter(([flag, key]) => !opts[key]).map(([flag]) => `--${flag}`);
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  }

  const release = {
    version: pkg.version,
    pluginId: PLUGIN_ID,
    clawhub: `clawhub:${PACKAGE_NAME}@${pkg.version}`,
    ...(opts.npm === false ? {} : { npm: `npm:${PACKAGE_NAME}@${pkg.version}` }),
    tarball: { url: opts.tarballUrl, sha256: sha256(tgz), integrity: integrity(tgz) },
    ...(opts.clawpackDigest ? { clawpackDigest: opts.clawpackDigest } : {}),
    compat: { pluginApi: compat.pluginApi, minGatewayVersion: compat.minGatewayVersion },
    node: pkg.engines.node,
    security: opts.security === true,
    notes: {
      de: readInput(opts.notesDe, "German notes").toString("utf8"),
      en: readInput(opts.notesEn, "English notes").toString("utf8"),
    },
  };
  const releases = [release, ...(previous?.hosts.openclaw.releases ?? [])].sort((a, b) => compareVersions(b.version, a.version));
  const hermes = buildHermesHost(opts, previous);

  const feed = {
    schema: FEED_SCHEMA,
    channel: opts.channel,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    installer: older
      ? { ...previous.installer }
      : { version: pkg.version, url: opts.installerUrl, sha256: sha256(readInput(opts.installer, "installer")) },
    bootstrap: older
      ? { sh: { ...previous.bootstrap.sh }, ps1: { ...previous.bootstrap.ps1 } }
      : {
        sh: { url: opts.bootstrapShUrl, sha256: sha256(readInput(opts.bootstrapSh, "bootstrap")) },
        ps1: { url: opts.bootstrapPs1Url, sha256: sha256(readInput(opts.bootstrapPs1, "bootstrap")) },
      },
    hosts: {
      openclaw: {
        windowsNativeBeta: previous ? previous.hosts.openclaw.windowsNativeBeta : true,
        latest: releases[0].version,
        releases,
      },
      ...(hermes ? { hermes } : {}),
    },
  };
  const res = validateFeed(feed);
  if (!res.ok) throw new Error(`built feed is invalid:\n  ${res.errors.join("\n  ")}`);
  return feed;
}

/**
 * Read and check a hermes-sidecar.lock.json (HM2 Task 7 seed shape).
 * @param {string} path
 * @param {{ allowPlaceholder?: boolean }} [o] only tests pass allowPlaceholder
 */
export function readHermesLock(path, { allowPlaceholder = false } = {}) {
  let lock;
  try {
    lock = JSON.parse(readInput(path, "Hermes sidecar lock").toString("utf8"));
  } catch (err) {
    throw new Error(err instanceof SyntaxError ? `Hermes sidecar lock ${path} is not JSON` : err.message);
  }
  if (!isObject(lock) || lock.schema !== HERMES_LOCK_SCHEMA) throw new Error(`${path} is not a ${HERMES_LOCK_SCHEMA} document`);
  const missing = HERMES_TARGETS.filter((t) => !isObject(lock.binary?.[t]));
  if (missing.length) throw new Error(`${path} has no sidecar binary for ${missing.join(", ")}`);
  if (!isObject(lock.provider)) throw new Error(`${path} has no provider`);
  const semver = /^\d+\.\d+\.\d+$/;
  // F33: the harness release's Node pin travels with the lock (T10 compares it with node-pins.json)
  if (!semver.test(String(lock.nodeVersion ?? ""))) throw new Error(`${path} records no nodeVersion (the harness release's Node pin)`);
  if (!semver.test(String(lock.version ?? "")) || lock.harnessTag !== `v${lock.version}`) throw new Error(`${path}: harnessTag ${JSON.stringify(lock.harnessTag)} does not name version ${lock.version}`);
  const zero = /^0{64}$/;
  if (!allowPlaceholder && (lock.placeholder === true || zero.test(lock.provider.sha256) || HERMES_TARGETS.some((t) => zero.test(lock.binary[t].sha256)))) {
    throw new Error(`${path} is a placeholder (placeholder: true or an all-zero hash); fill it from the harness release's lock seed first`);
  }
  return lock;
}

/** hosts.hermes from --hermes-lock (merged into --previous's), --previous's unchanged, or null. */
function buildHermesHost(opts, previous) {
  const prev = previous?.hosts.hermes ?? null;
  if (!opts.hermesLock) return prev ? structuredClone(prev) : null;
  if (!opts.hermesNotesDe || !opts.hermesNotesEn) throw new Error("--hermes-lock needs --hermes-notes-de and --hermes-notes-en");
  const lock = readHermesLock(opts.hermesLock, { allowPlaceholder: opts.allowPlaceholderLock === true });
  if (prev?.releases.some((r) => r.version === lock.version)) throw new Error(`Hermes release ${lock.version} is already in the previous feed`);
  const release = {
    version: lock.version,
    provider: { url: lock.provider.url, sha256: lock.provider.sha256 },
    sidecar: { version: lock.version, binary: Object.fromEntries(HERMES_TARGETS.map((t) => [t, { url: lock.binary[t].url, sha256: lock.binary[t].sha256 }])) },
    minHermesVersion: lock.minHermesVersion,
    testedHermesVersion: lock.testedHermesVersion ?? lock.minHermesVersion,
    python: lock.python ?? HERMES_PYTHON,
    security: opts.security === true,
    notes: {
      de: readInput(opts.hermesNotesDe, "German Hermes notes").toString("utf8"),
      en: readInput(opts.hermesNotesEn, "English Hermes notes").toString("utf8"),
    },
  };
  const releases = [release, ...(prev?.releases ?? [])].sort((a, b) => compareVersions(b.version, a.version));
  return { windowsNativeBeta: prev ? prev.windowsNativeBeta : true, latest: releases[0].version, releases };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rename with the Windows retry the global constraints require (Defender, spec B.5). */
async function renameWithRetry(from, to) {
  const deadline = Date.now() + 10_000;
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const retryable = process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(err.code);
      if (!retryable || Date.now() + delay > deadline) throw err;
      await sleep(delay);
    }
  }
}

/**
 * Write `text` to `path` atomically: <path>.tmp-<pid> → fsync → rename.
 * @param {string} path
 * @param {string} text
 */
export async function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    await renameWithRetry(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const REQUIRED_FLAGS = ["channel", "version", "tgz", "tarball-url", "notes-de", "notes-en", "out"];
/** Artefact flags: required unless --allow-older adds a version below the previous latest (then ignored). */
const ARTEFACT_FLAGS = [
  ["installer", "installer"], ["installer-url", "installerUrl"], ["bootstrap-sh", "bootstrapSh"],
  ["bootstrap-sh-url", "bootstrapShUrl"], ["bootstrap-ps1", "bootstrapPs1"], ["bootstrap-ps1-url", "bootstrapPs1Url"],
];

/**
 * CLI entry.
 * @param {string[]} argv arguments after the script path
 * @returns {Promise<0 | 1>}
 */
export async function main(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        ...Object.fromEntries([...REQUIRED_FLAGS, ...ARTEFACT_FLAGS.map(([f]) => f)].map((f) => [f, { type: "string" }])),
        previous: { type: "string" },
        "allow-older": { type: "boolean" },
        "clawpack-digest": { type: "string" },
        "no-npm": { type: "boolean" },
        security: { type: "boolean" },
        "hermes-lock": { type: "string" },
        "hermes-notes-de": { type: "string" },
        "hermes-notes-en": { type: "string" },
      },
    });
    const missing = REQUIRED_FLAGS.filter((f) => !values[f]);
    if (missing.length) throw new Error(`missing ${missing.map((f) => `--${f}`).join(", ")}`);
    if (values["allow-older"] && !values.previous) throw new Error("--allow-older needs --previous");
    const feed = buildFeed({
      channel: values.channel,
      version: values.version,
      tgz: values.tgz,
      tarballUrl: values["tarball-url"],
      installer: values.installer,
      installerUrl: values["installer-url"],
      bootstrapSh: values["bootstrap-sh"],
      bootstrapShUrl: values["bootstrap-sh-url"],
      bootstrapPs1: values["bootstrap-ps1"],
      bootstrapPs1Url: values["bootstrap-ps1-url"],
      notesDe: values["notes-de"],
      notesEn: values["notes-en"],
      previous: values.previous,
      allowOlder: values["allow-older"] === true,
      clawpackDigest: values["clawpack-digest"],
      npm: !values["no-npm"],
      security: values.security === true,
      hermesLock: values["hermes-lock"],
      hermesNotesDe: values["hermes-notes-de"],
      hermesNotesEn: values["hermes-notes-en"],
    });
    const out = resolve(values.out);
    await writeFileAtomic(out, `${JSON.stringify(feed, null, 2)}\n`);
    process.stderr.write(`build-plugin-feed: wrote ${out} (${feed.channel}, latest ${feed.hosts.openclaw.latest}, ${feed.hosts.openclaw.releases.length} release(s)${feed.hosts.hermes ? `; hermes ${feed.hosts.hermes.latest}` : ""})\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`build-plugin-feed: ${err.message}\n`);
    return 1;
  }
}

if (import.meta.filename && process.argv[1] === import.meta.filename) {
  process.exitCode = await main(process.argv.slice(2));
}
