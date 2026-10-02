// tests/dist-hermes-feed.test.js — hosts.hermes in the signed plugin feed (HM2 Task 8): schema, semantic rules, the
// builder's --hermes-lock/--hermes-notes-* flags and the checked-in placeholder lock (ruling F31).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFeed, HERMES_TARGETS, main, readHermesLock, validateFeed } from "../scripts/dist/build-plugin-feed.mjs";
import { hasPlaceholderHash } from "../scripts/dist/installer/hermes/install.mjs";
import { makeHermesFeed } from "./helpers/hermes-sandbox.js";
import { makeTarGz } from "./helpers/ustar.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "scripts", "dist", "plugin-feed.schema.json"), "utf8"));
const LOCK = join(root, "scripts", "dist", "hermes-sidecar.lock.json");
const hex = (n) => createHash("sha256").update(String(n)).digest("hex");
const clone = (v) => structuredClone(v);

const art = (name, n) => ({ url: `https://github.com/Cyb3rb1ade/PLUR1BUS-Harness/releases/download/v0.1.0/${name}`, sha256: hex(n) });
const validFeed = () => makeHermesFeed({ provider: art("plur1bus-hermes-provider-0.1.0.tar.gz", "p"), binary: art("plur1bus-linux-x64", "b") });

/** Inputs for buildFeed: an npm-pack-shaped tgz, installer, bootstraps, notes, a filled lock. */
function inputs(dir, { version = "7.18.0", lock = {} } = {}) {
  const pkg = { name: "@cyb3rb1ade/plur1bus-memory", version, openclaw: { compat: { pluginApi: ">=2026.8.1", minGatewayVersion: "2026.8.1" } }, engines: { node: ">=24.16.0 <25 || >=26.1.0" } };
  const tgz = join(dir, `plugin-${version}.tgz`);
  writeFileSync(tgz, makeTarGz([{ name: "package/package.json", data: JSON.stringify(pkg) }]));
  for (const f of ["installer.mjs", "install-plugin.sh", "install-plugin.ps1"]) writeFileSync(join(dir, f), `TEST ONLY ${f}`);
  writeFileSync(join(dir, "de.md"), "Plugin DE");
  writeFileSync(join(dir, "en.md"), "Plugin EN");
  writeFileSync(join(dir, "hermes-de.md"), "Hermes-Hostmodus DE");
  writeFileSync(join(dir, "hermes-en.md"), "Hermes host mode EN");
  const lockDoc = {
    schema: "plur1bus.hermes-sidecar-lock/1",
    placeholder: false,
    harnessTag: "v0.1.0",
    version: "0.1.0",
    nodeVersion: "24.21.0",
    provider: art("plur1bus-hermes-provider-0.1.0.tar.gz", "p"),
    binary: Object.fromEntries(HERMES_TARGETS.map((t) => [t, art(`plur1bus-${t}`, t)])),
    minHermesVersion: "0.21.4",
    testedHermesVersion: "0.21.5",
    ...lock,
  };
  const lockFile = join(dir, "lock.json");
  writeFileSync(lockFile, JSON.stringify(lockDoc));
  const base = "https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory/releases/download/v" + version;
  return {
    channel: "stable", version, tgz, tarballUrl: `${base}/p.tgz`,
    installer: join(dir, "installer.mjs"), installerUrl: `${base}/installer.mjs`,
    bootstrapSh: join(dir, "install-plugin.sh"), bootstrapShUrl: `${base}/install-plugin.sh`,
    bootstrapPs1: join(dir, "install-plugin.ps1"), bootstrapPs1Url: `${base}/install-plugin.ps1`,
    notesDe: join(dir, "de.md"), notesEn: join(dir, "en.md"),
    hermesLock: lockFile, hermesNotesDe: join(dir, "hermes-de.md"), hermesNotesEn: join(dir, "hermes-en.md"),
  };
}

describe("feed: hosts.hermes", () => {
  it("the schema no longer forbids hosts.hermes", () => {
    const h = schema.properties.hosts.properties.hermes;
    assert.equal(typeof h, "object");
    assert.equal(h.additionalProperties, false);
    assert.deepEqual(schema.$defs.hermesRelease.properties.sidecar.properties.binary.required, HERMES_TARGETS);
    assert.deepEqual(validateFeed(validFeed(), { allowFile: false }), { ok: true, errors: [] });

    const bad = (mutate, pattern) => {
      const f = validFeed();
      mutate(f.hosts.hermes);
      const r = validateFeed(f);
      assert.equal(r.ok, false, `${pattern} should fail`);
      assert.ok(r.errors.some((e) => pattern.test(e)), r.errors.join("\n"));
    };
    bad((h2) => { h2.latest = "0.0.9"; }, /hosts\.hermes\.latest/);
    bad((h2) => { h2.releases.push({ ...clone(h2.releases[0]), version: "0.2.0" }); }, /sorted newest first/);
    bad((h2) => { h2.releases.push(clone(h2.releases[0])); }, /duplicate version/);
    bad((h2) => { h2.releases[0].minHermesVersion = "0.22.0"; }, /above testedHermesVersion/);
    bad((h2) => { h2.releases[0].provider.url = "http://example.invalid/x"; }, /provider\.url/);
    bad((h2) => { h2.releases[0].sidecar.binary["linux-x64"].url = "file:///tmp/x"; }, /binary\.linux-x64\.url: must be an https:\/\/ URL/);
    bad((h2) => { h2.releases[0].extra = true; }, /unknown property/);
    bad((h2) => { delete h2.releases[0].python; }, /python: required/);
    bad((h2) => { delete h2.windowsNativeBeta; }, /windowsNativeBeta: required/);
  });

  it("rejects a Hermes release missing a target", () => {
    const f = validFeed();
    delete f.hosts.hermes.releases[0].sidecar.binary["win-arm64"];
    const r = validateFeed(f);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("binary.win-arm64: required")), r.errors.join("\n"));
    const g = validFeed();
    g.hosts.hermes.releases[0].sidecar.binary["darwin-x64"] = art("x", "x");
    assert.ok(validateFeed(g).errors.some((e) => e.includes("darwin-x64: unknown property")));

    const dir = makeTempDir("hermes-feed-");
    const opts = inputs(dir);
    const lock = JSON.parse(readFileSync(opts.hermesLock, "utf8"));
    delete lock.binary["linux-arm64"];
    writeFileSync(opts.hermesLock, JSON.stringify(lock));
    assert.throws(() => buildFeed(opts), /no sidecar binary for linux-arm64/);
  });

  it("builds hosts.hermes from the lock file and notes", async () => {
    const dir = makeTempDir("hermes-feed-");
    const opts = inputs(dir);
    const feed = buildFeed(opts);
    assert.deepEqual(validateFeed(feed), { ok: true, errors: [] });
    assert.equal(feed.hosts.openclaw.latest, "7.18.0");
    const h = feed.hosts.hermes;
    assert.equal(h.windowsNativeBeta, true);
    assert.equal(h.latest, "0.1.0");
    assert.equal(h.releases.length, 1);
    const [rel] = h.releases;
    const lock = JSON.parse(readFileSync(opts.hermesLock, "utf8"));
    assert.deepEqual(rel.provider, lock.provider);
    assert.equal(rel.sidecar.version, "0.1.0");
    assert.deepEqual(rel.sidecar.binary, lock.binary);
    assert.equal(rel.minHermesVersion, "0.21.4");
    assert.equal(rel.testedHermesVersion, "0.21.5");
    assert.equal(rel.python, ">=3.11");
    assert.equal(rel.security, false);
    assert.deepEqual(rel.notes, { de: "Hermes-Hostmodus DE", en: "Hermes host mode EN" });

    // merged into --previous: a newer Hermes release goes first; without --hermes-lock the previous one is kept
    const prevFile = join(dir, "prev.json");
    writeFileSync(prevFile, JSON.stringify(feed));
    const dir2 = makeTempDir("hermes-feed-");
    const next = buildFeed({ ...inputs(dir2, { version: "7.18.1", lock: { version: "0.2.0", harnessTag: "v0.2.0" } }), previous: prevFile });
    assert.deepEqual(next.hosts.hermes.releases.map((r) => r.version), ["0.2.0", "0.1.0"]);
    assert.equal(next.hosts.hermes.latest, "0.2.0");
    const carried = buildFeed({ ...inputs(makeTempDir("hermes-feed-"), { version: "7.18.2" }), hermesLock: undefined, previous: prevFile });
    assert.deepEqual(carried.hosts.hermes, feed.hosts.hermes);
    // I3(a): a later plugin release over the unchanged lock keeps the published Hermes release as it is (no notes read)
    const same = buildFeed({ ...inputs(makeTempDir("hermes-feed-"), { version: "7.18.3" }), hermesNotesDe: undefined, hermesNotesEn: undefined, previous: prevFile });
    assert.deepEqual(same.hosts.hermes, feed.hosts.hermes);
    assert.deepEqual(validateFeed(same), { ok: true, errors: [] });
    // the same version with another hash is a re-tag and refused
    const baseLock = JSON.parse(readFileSync(opts.hermesLock, "utf8"));
    assert.throws(
      () => buildFeed({ ...inputs(makeTempDir("hermes-feed-"), { version: "7.18.4", lock: { provider: { ...baseLock.provider, sha256: "a".repeat(64) } } }), previous: prevFile }),
      /Hermes release 0\.1\.0 is already in the previous feed with other hashes \(provider\)/,
    );
    assert.throws(
      () => buildFeed({ ...inputs(makeTempDir("hermes-feed-"), { version: "7.18.4", lock: { binary: { ...baseLock.binary, "win-x64": { ...baseLock.binary["win-x64"], sha256: "b".repeat(64) } } } }), previous: prevFile }),
      /with other hashes \(win-x64\)/,
    );
    assert.throws(() => buildFeed({ ...opts, hermesNotesEn: undefined }), /--hermes-notes-de and --hermes-notes-en/);

    // the CLI flags
    const out = join(dir, "out", "stable.json");
    const code = await main([
      "--channel", "stable", "--version", "7.18.0", "--tgz", opts.tgz, "--tarball-url", opts.tarballUrl,
      "--installer", opts.installer, "--installer-url", opts.installerUrl, "--bootstrap-sh", opts.bootstrapSh, "--bootstrap-sh-url", opts.bootstrapShUrl,
      "--bootstrap-ps1", opts.bootstrapPs1, "--bootstrap-ps1-url", opts.bootstrapPs1Url, "--notes-de", opts.notesDe, "--notes-en", opts.notesEn,
      "--hermes-lock", opts.hermesLock, "--hermes-notes-de", opts.hermesNotesDe, "--hermes-notes-en", opts.hermesNotesEn, "--out", out,
    ]);
    assert.equal(code, 0);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).hosts.hermes.latest, "0.1.0");
  });

  it("refuses a placeholder lock; the checked-in lock is one (F31)", () => {
    const checkedIn = JSON.parse(readFileSync(LOCK, "utf8"));
    assert.equal(checkedIn.placeholder, true);
    assert.equal(checkedIn.schema, "plur1bus.hermes-sidecar-lock/1");
    assert.deepEqual(Object.keys(checkedIn.binary).sort(), [...HERMES_TARGETS].sort());
    assert.equal(checkedIn.minHermesVersion, "0.21.4");
    for (const t of HERMES_TARGETS) assert.match(checkedIn.binary[t].url, /^https:\/\/github\.com\/Cyb3rb1ade\/PLUR1BUS-Harness\/releases\/download\/v0\.1\.0\/plur1bus-/);
    assert.throws(() => readHermesLock(LOCK), /placeholder/);
    assert.equal(readHermesLock(LOCK, { allowPlaceholder: true }).version, "0.1.0");

    const dir = makeTempDir("hermes-feed-");
    const zero = inputs(dir, { lock: { binary: Object.fromEntries(HERMES_TARGETS.map((t) => [t, { url: `https://example.invalid/${t}`, sha256: "0".repeat(64) }])) } });
    assert.throws(() => buildFeed(zero), /placeholder/);
    assert.equal(existsSync(join(dir, "out.json")), false);
    // the installer refuses a placeholder hash outside the test seams, too (F31)
    assert.equal(hasPlaceholderHash({ provider: { sha256: "a".repeat(64) }, sidecar: { binary: { "linux-x64": { sha256: "0".repeat(64) } } } }), true);
    assert.equal(hasPlaceholderHash({ provider: { sha256: "a".repeat(64) }, sidecar: { binary: { "linux-x64": { sha256: "b".repeat(64) } } } }), false);
  });

  it("the lock records the harness release's Node pin and tag (F33)", () => {
    const checkedIn = JSON.parse(readFileSync(LOCK, "utf8"));
    assert.match(checkedIn.nodeVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(checkedIn.harnessTag, `v${checkedIn.version}`);
    // T10 adds scripts/dist/node-pins.json; from then on the bootstrap pin must equal the sidecar's Node
    const pins = join(dirname(LOCK), "node-pins.json");
    if (existsSync(pins)) assert.equal(JSON.parse(readFileSync(pins, "utf8")).version, checkedIn.nodeVersion);
    assert.throws(() => buildFeed(inputs(makeTempDir("hermes-feed-"), { lock: { nodeVersion: undefined } })), /nodeVersion/);
    assert.throws(() => buildFeed(inputs(makeTempDir("hermes-feed-"), { lock: { harnessTag: "v9.9.9" } })), /harnessTag/);
  });
});
