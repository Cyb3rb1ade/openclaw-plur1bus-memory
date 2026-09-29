// tests/dist-installer-bundle.test.js — the one-file installer bundle (HM1-R20).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createInstallerSandbox } from "./helpers/installer-sandbox.js";
import { generateTestKeyPair } from "./helpers/minisign-sign.js";
import { INSTALLER_TEST_MARKER, renderInstallerKeys } from "../scripts/dist/render-bootstraps.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let bundle;
let buildOut;

describe("plugin installer bundle", () => {
  before(() => {
    const dir = makeTempDir("plur1bus-installer-bundle-");
    bundle = join(dir, "plur1bus-plugin-installer.mjs");
    const r = spawnSync(process.execPath, [join(root, "scripts", "dist", "build-installer.mjs"), "--out", bundle], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    buildOut = r.stdout;
  });

  it("the bundle imports only node: builtins", () => {
    const text = readFileSync(bundle, "utf8");
    const specifiers = [
      ...text.matchAll(/\bimport\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g),
      ...text.matchAll(/\bexport\s+[^"'`;]*?\s+from\s+["']([^"']+)["']/g),
      ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    assert.ok(specifiers.length > 0, "the bundle imports node builtins");
    assert.deepEqual(specifiers.filter((s) => !s.startsWith("node:")), []);
    assert.doesNotMatch(text, /\bimport\(\s*[^"'\s)]/, "no computed dynamic import");
    assert.match(buildOut, /sha256 [0-9a-f]{64}/);
  });

  it("the bundle runs --help on the current Node", () => {
    const r = spawnSync(process.execPath, [bundle, "--help"], { encoding: "utf8", env: { PATH: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage: .*plur1bus-plugin-installer/);
    assert.match(r.stdout, /--accept-nc-licence/);
    const bad = spawnSync(process.execPath, [bundle, "--no-such-flag"], { encoding: "utf8", env: { PATH: "" } });
    assert.equal(bad.status, 1, bad.stderr);
  });

  it("the bundle performs a dry run against the sandbox shims", () => {
    const sb = createInstallerSandbox();
    const env = { ...sb.env, PLUR1BUS_PLUGIN_TEST_FREE_BYTES: String(64 * 1024 ** 3) };
    const r = spawnSync(process.execPath, [bundle, "--feed-file", sb.feedFile, "--dry-run", "--json"], { encoding: "utf8", env });
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.schema, "plur1bus.plugin-installer/1");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(doc.findings, []);
    assert.ok(doc.steps.some((s) => s.id === "install" && s.status === "planned"));
    assert.ok(sb.openclawCalls().some((a) => a[0] === "--version"));
    assert.ok(!sb.openclawCalls().some((a) => a[1] === "install" || a[1] === "set"));
  });

  // HM1-R-F1: the release renders the channel keys into the bundle, so `--feed <url>` works on the bundle alone.
  function signedFeedSandbox(key) {
    const sb = createInstallerSandbox();
    const feedPath = join(sb.root, "stable.json");
    const bytes = Buffer.from(JSON.stringify(sb.feed, null, 2));
    writeFileSync(feedPath, bytes);
    writeFileSync(`${feedPath}.minisig`, key.sign(bytes));
    return { sb, feedUrl: pathToFileURL(feedPath).href };
  }
  function renderedCopy(o) {
    const dir = makeTempDir("plur1bus-installer-rendered-");
    const out = join(dir, "plur1bus-plugin-installer.mjs");
    copyFileSync(bundle, out);
    writeFileSync(out, renderInstallerKeys(readFileSync(out, "utf8"), o));
    return out;
  }
  function runFeed(file, sb, feedUrl) {
    const env = { ...sb.env, PLUR1BUS_PLUGIN_TEST_FREE_BYTES: String(64 * 1024 ** 3) };
    delete env.PLUR1BUS_PLUGIN_PUBKEY;
    return spawnSync(process.execPath, [file, "--feed", feedUrl, "--dry-run", "--json"], { encoding: "utf8", env });
  }

  it("a bundle rendered with the channel keys verifies --feed itself", () => {
    const stable = generateTestKeyPair();
    const beta = generateTestKeyPair();
    const file = renderedCopy({ pubkeyStable: stable.publicKeyLine, pubkeyBeta: beta.publicKeyLine });
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /@@PLUR1BUS_PLUGIN_PUBKEY_/);
    assert.ok(!text.includes("rendered with --test-key"));
    assert.ok(text.includes(stable.publicKeyLine) && text.includes(beta.publicKeyLine));
    const { sb, feedUrl } = signedFeedSandbox(stable);
    const r = runFeed(file, sb, feedUrl);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).findings, []);
    // the beta key does not verify the stable feed
    const other = signedFeedSandbox(beta);
    const bad = runFeed(file, other.sb, other.feedUrl);
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr + bad.stdout, /feed signature check failed/);
  });

  it("an unrendered or TEST ONLY bundle refuses a feed it has to verify itself", () => {
    const key = generateTestKeyPair();
    const test = renderedCopy({ testKey: true });
    assert.ok(readFileSync(test, "utf8").split("\n")[1] === INSTALLER_TEST_MARKER);
    for (const file of [bundle, test]) {
      const { sb, feedUrl } = signedFeedSandbox(key);
      const r = runFeed(file, sb, feedUrl);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr + r.stdout, /carries no feed public key/);
    }
    assert.throws(() => renderInstallerKeys(readFileSync(test, "utf8"), { testKey: true }), /occurs 0 times/);
    assert.throws(() => renderInstallerKeys(readFileSync(bundle, "utf8"), {}), /required/);
  });
});
