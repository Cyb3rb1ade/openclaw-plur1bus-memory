/**
 * scripts/dist/render-bootstraps.mjs — render install-plugin.sh and install-plugin.ps1 (HM1 Task 7, HM1-R3).
 *
 * node scripts/dist/render-bootstraps.mjs --pubkey-stable <line> --pubkey-beta <line> [--out-dir dist-installer]
 * node scripts/dist/render-bootstraps.mjs --test-key [--out-dir <dir>]
 * ... [--installer <plur1bus-plugin-installer.mjs>]   also render the keys into the installer bundle, in place
 *
 * Fills the templates scripts/dist/install-plugin.{sh,ps1}.in at their placeholders:
 *   @@PUBKEY_STABLE@@, @@PUBKEY_BETA@@  the channel minisign public keys (the second line of a .pub file)
 *   @@MINISIGN_JS@@                     scripts/dist/minisign.mjs, verbatim: as a quoted here-document in the
 *                                       .sh, base64 of the same bytes in the .ps1 (which must stay ASCII-only)
 *   @@RENDER_NOTE@@                     one header line saying how the file was rendered
 * Without both keys it refuses (exit 1) unless --test-key is given; a --test-key build says TEST ONLY in its
 * header and verifies a feed only with PLUR1BUS_PLUGIN_PUBKEY under PLUR1BUS_PLUGIN_INSTALLER_TEST=1.
 * --installer renders the same keys into the bundle's @@PLUR1BUS_PLUGIN_PUBKEY_STABLE@@ / _BETA@@ (HM1-R-F1), so the
 * released bundle verifies `--feed <url>` itself; a --test-key render leaves both keys empty (the bundle then refuses
 * every feed it has to verify itself) and marks the bundle with the TEST ONLY line below its first line.
 * Prints each file's path and SHA-256 on stdout; errors go to stderr.
 */

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parsePublicKey } from "./minisign.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
export const DEFAULT_OUT_DIR = join(ROOT, "dist-installer");
const HEREDOC = "PLUR1BUS_MINISIGN_JS";
const PLACEHOLDER = /@@(PUBKEY_STABLE|PUBKEY_BETA|MINISIGN_JS|RENDER_NOTE)@@/g;

const INSTALLER_PLACEHOLDER = /@@PLUR1BUS_PLUGIN_PUBKEY_(STABLE|BETA)@@/g;
export const INSTALLER_TEST_MARKER = "// TEST ONLY: installer bundle rendered with --test-key and no release keys; it verifies no feed itself.";
const INSTALLER_RELEASE_MARKER = "// Channel public keys rendered by scripts/dist/render-bootstraps.mjs; do not edit.";
const RELEASE_NOTE = "Rendered by scripts/dist/render-bootstraps.mjs with the stable and beta channel keys; do not edit.";
const TEST_NOTE = "TEST ONLY: rendered with --test-key and no release keys; verifies a feed only with PLUR1BUS_PLUGIN_PUBKEY under PLUR1BUS_PLUGIN_INSTALLER_TEST=1.";

function checkKey(name, line) {
  try {
    parsePublicKey(line);
  } catch (err) {
    throw new Error(`--${name}: ${err.message}`);
  }
}

function fill(template, values, name) {
  const out = template.replace(PLACEHOLDER, (_, key) => values[key]);
  for (const key of ["PUBKEY_STABLE", "PUBKEY_BETA", "MINISIGN_JS", "RENDER_NOTE"]) {
    if (!template.includes(`@@${key}@@`)) throw new Error(`${name}: template lacks @@${key}@@`);
  }
  return out;
}

/**
 * @param {{ pubkeyStable?: string, pubkeyBeta?: string, testKey?: boolean, minisignSource?: string, shTemplate?: string, ps1Template?: string }} o
 * @returns {{ sh: string, ps1: string }}
 */
export function renderBootstraps(o = {}) {
  const testKey = Boolean(o.testKey);
  const stable = (o.pubkeyStable ?? "").trim();
  const beta = (o.pubkeyBeta ?? "").trim();
  if (!testKey && (!stable || !beta)) {
    throw new Error("--pubkey-stable and --pubkey-beta are required (or --test-key for a TEST ONLY build)");
  }
  if (stable) checkKey("pubkey-stable", stable);
  if (beta) checkKey("pubkey-beta", beta);

  const src = o.minisignSource ?? readFileSync(join(HERE, "minisign.mjs"), "utf8");
  if (src.split("\n").some((l) => l.trim() === HEREDOC)) throw new Error(`minisign.mjs contains the here-document delimiter ${HEREDOC}`);
  const shTemplate = o.shTemplate ?? readFileSync(join(HERE, "install-plugin.sh.in"), "utf8");
  const ps1Template = o.ps1Template ?? readFileSync(join(HERE, "install-plugin.ps1.in"), "utf8");
  const note = testKey ? TEST_NOTE : RELEASE_NOTE;

  const sh = fill(shTemplate, { PUBKEY_STABLE: stable, PUBKEY_BETA: beta, MINISIGN_JS: src.replace(/\n$/, ""), RENDER_NOTE: note }, "install-plugin.sh.in");
  const ps1 = fill(ps1Template, { PUBKEY_STABLE: stable, PUBKEY_BETA: beta, MINISIGN_JS: Buffer.from(src, "utf8").toString("base64"), RENDER_NOTE: note }, "install-plugin.ps1.in");
  const bad = Buffer.from(ps1, "utf8").findIndex((b) => b >= 0x80);
  if (bad !== -1) throw new Error(`install-plugin.ps1 must be ASCII-only (Windows PowerShell 5.1 reads BOM-less scripts as ANSI); non-ASCII byte at offset ${bad}`);
  return { sh, ps1 };
}

/**
 * Render the channel keys into the installer bundle text (HM1-R-F1). Each placeholder must occur exactly once.
 * @param {string} text
 * @param {{ pubkeyStable?: string, pubkeyBeta?: string, testKey?: boolean }} o
 */
export function renderInstallerKeys(text, o = {}) {
  const testKey = Boolean(o.testKey);
  const stable = (o.pubkeyStable ?? "").trim();
  const beta = (o.pubkeyBeta ?? "").trim();
  if (!testKey && (!stable || !beta)) {
    throw new Error("--pubkey-stable and --pubkey-beta are required (or --test-key for a TEST ONLY build)");
  }
  if (stable) checkKey("pubkey-stable", stable);
  if (beta) checkKey("pubkey-beta", beta);
  for (const key of ["STABLE", "BETA"]) {
    const n = text.split(`@@PLUR1BUS_PLUGIN_PUBKEY_${key}@@`).length - 1;
    if (n !== 1) throw new Error(`installer bundle: @@PLUR1BUS_PLUGIN_PUBKEY_${key}@@ occurs ${n} times (expected once; already rendered?)`);
  }
  if (text.includes(INSTALLER_TEST_MARKER)) throw new Error("installer bundle already carries the TEST ONLY marker");
  const values = { STABLE: stable, BETA: beta };
  const filled = text.replace(INSTALLER_PLACEHOLDER, (_, key) => values[key]);
  const nl = filled.indexOf("\n");
  const marker = testKey ? INSTALLER_TEST_MARKER : INSTALLER_RELEASE_MARKER;
  return nl === -1 ? `${filled}\n${marker}\n` : `${filled.slice(0, nl + 1)}${marker}\n${filled.slice(nl + 1)}`;
}

/** <file>.tmp-<pid> -> fsync -> rename (global constraint "atomic writes"). */
function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** @returns {Array<{ file: string, sha256: string }>} */
export function writeBootstraps({ outDir = DEFAULT_OUT_DIR, ...o } = {}) {
  const { sh, ps1 } = renderBootstraps(o);
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const [name, text, mode] of [["install-plugin.sh", sh, 0o755], ["install-plugin.ps1", ps1, 0o644]]) {
    const file = join(dir, name);
    writeAtomic(file, text, mode);
    out.push({ file, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
  }
  if (o.installer) {
    const file = resolve(o.installer);
    const text = renderInstallerKeys(readFileSync(file, "utf8"), o);
    writeAtomic(file, text, 0o644);
    out.push({ file, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
  }
  return out;
}

if (import.meta.filename && process.argv[1] === import.meta.filename) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "pubkey-stable": { type: "string" },
        "pubkey-beta": { type: "string" },
        "out-dir": { type: "string" },
        "test-key": { type: "boolean", default: false },
        installer: { type: "string" },
      },
      strict: true,
    });
    const written = writeBootstraps({
      outDir: values["out-dir"] ?? DEFAULT_OUT_DIR,
      pubkeyStable: values["pubkey-stable"],
      pubkeyBeta: values["pubkey-beta"],
      testKey: values["test-key"],
      installer: values.installer,
    });
    for (const w of written) process.stdout.write(`${w.file}\nsha256 ${w.sha256}\n`);
  } catch (err) {
    process.stderr.write(`render-bootstraps: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
