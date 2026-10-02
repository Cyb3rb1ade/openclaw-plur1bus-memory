#!/usr/bin/env node
/**
 * tests/helpers/sign-feed-for-ci.mjs — a TEST ONLY signed plugin feed over local files (HM1 Task 8).
 *
 * node tests/helpers/sign-feed-for-ci.mjs --artefacts <dir> --out-dir <dir> [--tgz <extra.tgz>]... [--channel stable]
 *   [--github-env <file>] [--hermes-lock <lock.json> | --no-hermes]
 *
 * HM2 Task 11: the feed also carries `hosts.hermes`, built from scripts/dist/hermes-sidecar.lock.json (or
 * --hermes-lock) with build-plugin-feed.mjs exactly as the release does. Its provider and sidecar URLs stay the
 * harness release's https URLs (the installer verifies them by SHA-256). A lock still marked `"placeholder": true`
 * is accepted here only (TEST ONLY feed): until the harness release P4 fills it, the Hermes legs fail at the first
 * download, which is why they are continue-on-error (HM2-R19).
 *
 * <artefacts> is the plugin-dist `pack` artefact: pack.json ({ version, ciVersion, tgz, ciTgz }), the tarballs it
 * names, plur1bus-plugin-installer.mjs, install-plugin.sh and install-plugin.ps1. Every tarball (the pack's two plus
 * any --tgz, e.g. the newest GitHub Release for the nightly upgrade leg) becomes one release, built oldest first
 * with scripts/dist/build-plugin-feed.mjs exactly as the release workflow does, then every URL is replaced by the
 * file:// URL of the local file. The feed is signed with an ephemeral minisign key (tests/helpers/minisign-sign.js,
 * never written to disk, untrusted comment "TEST ONLY"); `<out-dir>/{channel}.json`, `.minisig` and `pubkey.txt`
 * are written. file:// feeds and PLUR1BUS_PLUGIN_PUBKEY are honoured only with PLUR1BUS_PLUGIN_INSTALLER_TEST=1.
 *
 * Runs on each install leg (file:// URLs are absolute paths of that runner), not once in `pack`: the key and the
 * paths exist only there. --github-env appends PLUR1BUS_PLUGIN_PUBKEY and PLUR1BUS_PLUGIN_FEED lines.
 * Prints { feedUrl, publicKey, versions } as one JSON line; exit 0, or 1 with the reason on stderr.
 */

import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { buildFeed, compareVersions, readPackageJsonFromTgz, validateFeed, writeFileAtomic } from "../../scripts/dist/build-plugin-feed.mjs";
import { verifyMinisign } from "../../scripts/dist/minisign.mjs";
import { generateTestKeyPair } from "./minisign-sign.js";

const PLACEHOLDER = "https://ci.invalid/TEST-ONLY/";
const NOTES = { de: "TEST ONLY: CI-Feed des plugin-dist-Workflows.\n", en: "TEST ONLY: feed of the plugin-dist workflow.\n" };
export const DEFAULT_HERMES_LOCK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "dist", "hermes-sidecar.lock.json");

/**
 * @param {{ artefacts: string, outDir: string, extraTgz?: string[], channel?: string, hermesLock?: string|null }} o
 *   `hermesLock`: the lock for hosts.hermes (default scripts/dist/hermes-sidecar.lock.json); null = no hosts.hermes
 * @returns {Promise<{ feedFile: string, feedUrl: string, publicKey: string, versions: string[] }>}
 */
export async function signFeedForCi({ artefacts, outDir, extraTgz = [], channel = "stable", hermesLock = DEFAULT_HERMES_LOCK }) {
  const dir = resolve(artefacts);
  const pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
  const byVersion = new Map();
  for (const file of [join(dir, pack.ciTgz), join(dir, pack.tgz), ...extraTgz.map((t) => resolve(t))]) {
    const version = readPackageJsonFromTgz(readFileSync(file)).version;
    if (byVersion.has(version)) {
      if (byVersion.get(version).file !== file) process.stderr.write(`sign-feed-for-ci: ${file} is version ${version}, already in the feed from ${byVersion.get(version).file}; skipped\n`);
      continue;
    }
    byVersion.set(version, { file, version });
  }
  const tarballs = [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version));
  for (const [key, want] of [["tgz", pack.version], ["ciTgz", pack.ciVersion]]) {
    const got = tarballs.find((t) => t.file === join(dir, pack[key]))?.version;
    if (got !== want) throw new Error(`pack.json ${key} ${pack[key]} is version ${got}, pack.json says ${want}`);
  }
  const files = {
    installer: join(dir, "plur1bus-plugin-installer.mjs"),
    sh: join(dir, "install-plugin.sh"),
    ps1: join(dir, "install-plugin.ps1"),
  };
  const urlOf = new Map(Object.values(files).map((f) => [PLACEHOLDER + basename(f), pathToFileURL(f).href]));
  const work = mkdtempSync(join(tmpdir(), "plur1bus-ci-feed-"));
  try {
    writeFileSync(join(work, "notes.de.md"), NOTES.de);
    writeFileSync(join(work, "notes.en.md"), NOTES.en);
    let previous;
    let feed;
    for (const [i, t] of tarballs.entries()) {
      const placeholder = `${PLACEHOLDER}${i}/${basename(t.file)}`;
      urlOf.set(placeholder, pathToFileURL(t.file).href);
      feed = buildFeed({
        channel,
        version: t.version,
        tgz: t.file,
        tarballUrl: placeholder,
        installer: files.installer,
        installerUrl: PLACEHOLDER + basename(files.installer),
        bootstrapSh: files.sh,
        bootstrapShUrl: PLACEHOLDER + basename(files.sh),
        bootstrapPs1: files.ps1,
        bootstrapPs1Url: PLACEHOLDER + basename(files.ps1),
        notesDe: join(work, "notes.de.md"),
        notesEn: join(work, "notes.en.md"),
        previous,
        // hosts.hermes once, with the newest plugin release (later builds carry it over from --previous)
        ...(hermesLock && i === tarballs.length - 1 ? {
          hermesLock: resolve(hermesLock),
          hermesNotesDe: join(work, "notes.de.md"),
          hermesNotesEn: join(work, "notes.en.md"),
          allowPlaceholderLock: JSON.parse(readFileSync(resolve(hermesLock), "utf8")).placeholder === true,
        } : {}),
      });
      previous = join(work, `feed-${i}.json`);
      writeFileSync(previous, JSON.stringify(feed));
    }
    const local = (url) => {
      const u = urlOf.get(url);
      if (!u) throw new Error(`no local file for ${url}`);
      return u;
    };
    feed.installer.url = local(feed.installer.url);
    feed.bootstrap.sh.url = local(feed.bootstrap.sh.url);
    feed.bootstrap.ps1.url = local(feed.bootstrap.ps1.url);
    for (const r of feed.hosts.openclaw.releases) r.tarball.url = local(r.tarball.url);
    const valid = validateFeed(feed, { allowFile: true });
    if (!valid.ok) throw new Error(`CI feed is invalid:\n  ${valid.errors.join("\n  ")}`);

    const out = resolve(outDir);
    const feedFile = join(out, `${channel}.json`);
    const text = `${JSON.stringify(feed, null, 2)}\n`;
    await writeFileAtomic(feedFile, text);
    const key = generateTestKeyPair();
    const sig = key.sign(Buffer.from(text, "utf8"), { trustedComment: `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${channel}.json (TEST ONLY, plugin-dist CI)` });
    await writeFileAtomic(`${feedFile}.minisig`, sig);
    await writeFileAtomic(join(out, "pubkey.txt"), `${key.publicKeyLine}\n`);
    const check = verifyMinisign({ message: readFileSync(feedFile), signatureText: sig, publicKey: key.publicKeyLine });
    if (!check.ok) throw new Error(`self-check of the CI feed signature failed: ${check.reason}`);
    return { feedFile, feedUrl: pathToFileURL(feedFile).href, publicKey: key.publicKeyLine, versions: feed.hosts.openclaw.releases.map((r) => r.version), hermes: feed.hosts.hermes?.latest ?? null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.filename && resolve(process.argv[1] ?? "") === import.meta.filename) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        artefacts: { type: "string" },
        "out-dir": { type: "string" },
        tgz: { type: "string", multiple: true },
        channel: { type: "string", default: "stable" },
        "github-env": { type: "string" },
        "hermes-lock": { type: "string" },
        "no-hermes": { type: "boolean", default: false },
      },
    });
    if (!values.artefacts || !values["out-dir"]) throw new Error("--artefacts and --out-dir are required");
    const r = await signFeedForCi({ artefacts: values.artefacts, outDir: values["out-dir"], extraTgz: values.tgz ?? [], channel: values.channel, hermesLock: values["no-hermes"] ? null : (values["hermes-lock"] ?? DEFAULT_HERMES_LOCK) });
    if (values["github-env"]) appendFileSync(values["github-env"], `PLUR1BUS_PLUGIN_PUBKEY=${r.publicKey}\nPLUR1BUS_PLUGIN_FEED=${r.feedUrl}\n`);
    process.stdout.write(`${JSON.stringify({ feedUrl: r.feedUrl, publicKey: r.publicKey, versions: r.versions, hermes: r.hermes })}\n`);
  } catch (err) {
    process.stderr.write(`sign-feed-for-ci: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
