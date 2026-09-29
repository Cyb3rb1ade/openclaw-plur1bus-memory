// tests/dist-ci-helpers.test.js — the helpers of .github/workflows/plugin-dist.yml (HM1 Task 8)
// and a static check of the workflow itself. Local only: temp dirs, the repo's own
// @lancedb/lancedb and engine, ephemeral TEST ONLY keys; never a real OpenClaw.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { parse as parseYaml } from "yaml";

import { assertDisposable } from "./helpers/assert-disposable.mjs";
import { digestIds, storeDigest } from "./helpers/store-digest.mjs";
import { assertStoreInsideStateDir, seedStore } from "./helpers/seed-store.mjs";
import { signFeedForCi } from "./helpers/sign-feed-for-ci.mjs";
import { validateFeed } from "../scripts/dist/build-plugin-feed.mjs";
import { verifyMinisign } from "../scripts/dist/minisign.mjs";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createInstallerSandbox } from "./helpers/installer-sandbox.js";
import { buildInstaller } from "../scripts/dist/build-installer.mjs";
import { renderBootstraps } from "../scripts/dist/render-bootstraps.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPERS = join(REPO, "tests", "helpers");
const WORKFLOW = join(REPO, ".github", "workflows", "plugin-dist.yml");

/** npm pack of a minimal package carrying the fields the feed builder reads; returns the file name. */
function packTiny(dir, v) {
  const d = join(dir, `pkg-${v}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "@cyb3rb1ade/plur1bus-memory", version: v, type: "module", main: "./index.js", license: "MIT", openclaw: { extensions: ["./index.js"], compat: { pluginApi: ">=2026.8.1", minGatewayVersion: "2026.8.1" } }, engines: { node: ">=24.16.0 <25 || >=26.1.0" } }));
  writeFileSync(join(d, "index.js"), "export default {};\n");
  const npmCli = [join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")].find((p) => existsSync(p));
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", dir], { cwd: d, encoding: "utf8" })
    : spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], { cwd: d, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout)[0].filename;
}

/** A pack artefact like plugin-dist's `pack` job makes: two tarballs, pack.json, installer bundle, TEST ONLY bootstraps. */
async function packArtefact(dir, { version = "7.16.11", real = false } = {}) {
  const ciVersion = `${version}-ci.0`;
  const ciTgz = packTiny(dir, ciVersion);
  const tgz = packTiny(dir, version);
  if (real) {
    await buildInstaller({ out: join(dir, "plur1bus-plugin-installer.mjs") });
    const { sh, ps1 } = renderBootstraps({ testKey: true });
    writeFileSync(join(dir, "install-plugin.sh"), sh, { mode: 0o755 });
    writeFileSync(join(dir, "install-plugin.ps1"), ps1);
  } else {
    writeFileSync(join(dir, "plur1bus-plugin-installer.mjs"), "// TEST ONLY installer\n");
    writeFileSync(join(dir, "install-plugin.sh"), "#!/bin/sh\n# TEST ONLY\n");
    writeFileSync(join(dir, "install-plugin.ps1"), "# TEST ONLY\n");
  }
  const integrity = (f) => `sha512-${createHash("sha512").update(readFileSync(join(dir, f))).digest("base64")}`;
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ version, ciVersion, tgz, ciTgz }));
  return { version, ciVersion, tgz, ciTgz, integrity: { [version]: integrity(tgz), [ciVersion]: integrity(ciTgz) } };
}

describe("plugin-dist CI helpers", () => {
  it("assert-disposable refuses a state dir outside RUNNER_TEMP or os.tmpdir()", () => {
    const runnerTemp = makeTempDir("runner-temp-");
    const inside = { RUNNER_TEMP: runnerTemp, OPENCLAW_HOME: join(runnerTemp, "oc-home"), OPENCLAW_STATE_DIR: join(runnerTemp, "oc-state") };
    assert.equal(assertDisposable({ env: inside }).ok, true);

    const outside = { ...inside, OPENCLAW_STATE_DIR: join(REPO, "not-temp", ".openclaw") };
    const r = assertDisposable({ env: outside });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /OPENCLAW_STATE_DIR/);

    // without RUNNER_TEMP the root is os.tmpdir(); an unset variable is refused too
    assert.equal(assertDisposable({ env: { OPENCLAW_HOME: join(tmpdir(), "a"), OPENCLAW_STATE_DIR: join(tmpdir(), "b") } }).ok, true);
    assert.equal(assertDisposable({ env: { OPENCLAW_HOME: join(tmpdir(), "a") } }).ok, false);
    // a sibling that merely shares the prefix is outside
    assert.equal(assertDisposable({ env: { ...inside, OPENCLAW_HOME: `${runnerTemp}-evil` } }).ok, false);
    // the temp root itself is not a disposable instance
    assert.equal(assertDisposable({ env: { ...inside, OPENCLAW_STATE_DIR: runnerTemp } }).ok, false);
    // extra variables (HOME for the POSIX legs)
    assert.equal(assertDisposable({ env: { ...inside, HOME: "/home/someone" }, vars: ["HOME"] }).ok, false);

    const cli = spawnSync(process.execPath, [join(HELPERS, "assert-disposable.mjs")], { env: { ...process.env, ...outside }, encoding: "utf8" });
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stderr, /not disposable/);
    const ok = spawnSync(process.execPath, [join(HELPERS, "assert-disposable.mjs")], { env: { ...process.env, ...inside }, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
  });

  it("store-digest is stable across row order", async () => {
    assert.deepEqual(digestIds(["main/b", "main/a", "ops/c"]), digestIds(["ops/c", "main/a", "main/b"]));
    assert.notEqual(digestIds(["main/a"]).sha256, digestIds(["main/a", "main/b"]).sha256);

    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `m-${i}`, text: `TEST ONLY ${i}`, vector: [i, 1] }));
    const a = makeTempDir("digest-a-");
    const b = makeTempDir("digest-b-");
    const ta = await (await lancedb.connect(join(a, "main"))).createTable("memories", rows);
    const tb = await (await lancedb.connect(join(b, "main"))).createTable("memories", [...rows].reverse().slice(0, 3));
    await tb.add([...rows].reverse().slice(3));
    ta.close();
    tb.close();
    const da = await storeDigest({ baseDbPath: a });
    const db = await storeDigest({ baseDbPath: b });
    assert.equal(da.rows, 7);
    assert.equal(da.sha256, db.sha256);
    assert.deepEqual(da.tables, ["main"]);

    const cli = spawnSync(process.execPath, [join(HELPERS, "store-digest.mjs"), "--base-db-path", a], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).sha256, da.sha256);
  });

  it("seed-store refuses a baseDbPath outside the given state dir", async () => {
    const stateDir = makeTempDir("seed-state-");
    const outside = join(makeTempDir("seed-outside-"), "store");
    assert.throws(() => assertStoreInsideStateDir(stateDir, outside), /outside the state dir/);
    assert.throws(() => assertStoreInsideStateDir(stateDir, stateDir), /outside the state dir/);
    assert.throws(() => assertStoreInsideStateDir(stateDir, `${stateDir}-x/store`), /outside the state dir/);
    assert.doesNotThrow(() => assertStoreInsideStateDir(stateDir, join(stateDir, "memory", "lancedb-namespaced")));
    await assert.rejects(seedStore({ stateDir, baseDbPath: outside, pluginDir: REPO, count: 1 }), /outside the state dir/);
    assert.equal(existsSync(outside), false, "nothing written outside");

    const cli = spawnSync(process.execPath, [join(HELPERS, "seed-store.mjs"), "--state-dir", stateDir, "--base-db-path", outside, "--plugin-dir", REPO], { encoding: "utf8" });
    assert.equal(cli.status, 2, cli.stderr);
    assert.equal(existsSync(outside), false);
  });

  it("seed-store writes synthetic memories through the plugin's own MemoryDB and store-digest counts them", async () => {
    const stateDir = makeTempDir("seed-real-");
    const baseDbPath = join(stateDir, "memory", "lancedb-namespaced");
    const seeded = await seedStore({ stateDir, baseDbPath, pluginDir: REPO, count: 12 });
    assert.equal(seeded.rows, 12);
    const d = await storeDigest({ baseDbPath, pluginDir: REPO });
    assert.equal(d.rows, 12);
    assert.equal(d.sha256, digestIds(Array.from({ length: 12 }, (_, i) => `ci-seed/ci-seed-${String(i).padStart(3, "0")}`)).sha256);
    await assert.rejects(seedStore({ stateDir, baseDbPath, pluginDir: REPO, count: 1 }), /already has/);
  });

  it("sign-feed-for-ci builds and signs a file:// feed with both releases, newest first", async () => {
    const dir = makeTempDir("sign-feed-");
    const { tgz: name, ciTgz: ciName } = await packArtefact(dir);
    const out = join(dir, "feed");
    const r = await signFeedForCi({ artefacts: dir, outDir: out });
    const feedBytes = readFileSync(join(out, "stable.json"));
    const feed = JSON.parse(feedBytes.toString("utf8"));
    assert.deepEqual(feed.hosts.openclaw.releases.map((x) => x.version), ["7.16.11", "7.16.11-ci.0"]);
    assert.equal(feed.hosts.openclaw.latest, "7.16.11");
    assert.equal(feed.installer.url, pathToFileURL(join(dir, "plur1bus-plugin-installer.mjs")).href);
    assert.equal(feed.hosts.openclaw.releases[1].tarball.url, pathToFileURL(join(dir, ciName)).href);
    assert.equal(validateFeed(feed).ok, false, "file:// URLs are refused without allowFile");
    assert.equal(validateFeed(feed, { allowFile: true }).ok, true);
    const sig = readFileSync(join(out, "stable.json.minisig"), "utf8");
    assert.match(sig, /TEST ONLY/);
    assert.equal(verifyMinisign({ message: feedBytes, signatureText: sig, publicKey: r.publicKey }).ok, true);
    assert.equal(r.feedUrl, pathToFileURL(join(out, "stable.json")).href);
    assert.equal(readFileSync(join(out, "pubkey.txt"), "utf8").trim(), r.publicKey);

    const genv = join(dir, "github-env");
    const cli = spawnSync(process.execPath, [join(HELPERS, "sign-feed-for-ci.mjs"), "--artefacts", dir, "--out-dir", join(dir, "feed2"), "--github-env", genv], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const lines = readFileSync(genv, "utf8");
    assert.match(lines, /^PLUR1BUS_PLUGIN_PUBKEY=RW[A-Za-z0-9+/=]+$/m);
    assert.match(lines, /^PLUR1BUS_PLUGIN_FEED=file:\/\/.+stable\.json$/m);
  });
  it("local dry run: the installer leg (install-plugin.sh, signed file:// feed, bundle) against the sandbox shims", { skip: process.platform === "win32" && "POSIX sh bootstrap and a symlinked plugin dir" }, async () => {
    const dir = makeTempDir("dist-dry-run-");
    const a = await packArtefact(dir, { real: true });
    const sb = createInstallerSandbox({ scenario: { recordNpmIntegrityByVersion: a.integrity } });
    // the shim's install record points here (fixture inspect-installed.json); a real MemoryDB lives in this repo
    const installPath = join(sb.stateDir, "npm", "projects", "cyb3rb1ade-plur1bus-memory-1ff39c963c", "node_modules", "@cyb3rb1ade", "plur1bus-memory");
    mkdirSync(dirname(installPath), { recursive: true });
    symlinkSync(REPO, installPath, "dir");
    const feedDir = join(dir, "feed");
    await signFeedForCi({ artefacts: dir, outDir: feedDir });
    const summaryFile = join(dir, "summary.md");
    // the bootstrap needs a real node on PATH (the sandbox's `node` is a logging shim); openclaw stays the shim
    const realBin = join(dir, "real-bin");
    mkdirSync(realBin);
    symlinkSync(process.execPath, join(realBin, "node"));
    const env = { ...sb.env, PATH: `${realBin}:${sb.env.PATH}`, RUNNER_TEMP: sb.root };
    const r = spawnSync(process.execPath, [join(HELPERS, "ci-plugin-dist.mjs"), "installer", "--artefacts", dir, "--feed-dir", feedDir, "--bootstrap", "sh"], {
      env: { ...env, GITHUB_STEP_SUMMARY: summaryFile },
      encoding: "utf8",
      timeout: 600_000,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-6000));
    const packs = sb.openclawCalls().filter((c) => c[0] === "plugins" && c[1] === "install").map((c) => /memory-([0-9][^/]*)\.tgz$/.exec(c[2])?.[1]);
    assert.deepEqual(packs, [a.ciVersion, a.version, a.ciVersion, a.version], "fresh -ci.0, forced failing update, rollback, update");
    assert.match(r.stdout, /FACT bootstrap\.jsonByteIdentical\.sh: \{"same":true/);
    const md = readFileSync(summaryFile, "utf8");
    for (const want of [/store before \| 50 rows/, /forced failing update \| exit 1, rollback ok, digest equal/, /update 7\.16\.11-ci\.0 → 7\.16\.11 \| exit 0 \(feed tarball\), digest equal, snapshots 1 → 2/, /uninstall \| exit 0, store kept/]) assert.match(md, want);
    assert.equal((await storeDigest({ baseDbPath: join(sb.stateDir, "memory", "lancedb-namespaced") })).rows, 50);

    // the driver refuses an instance outside the temp root before calling anything
    const before = sb.openclawCalls().length;
    const bad = spawnSync(process.execPath, [join(HELPERS, "ci-plugin-dist.mjs"), "installer", "--artefacts", dir, "--feed-dir", feedDir, "--bootstrap", "sh"], {
      env: { ...env, RUNNER_TEMP: join(sb.root, "elsewhere") },
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a disposable OpenClaw instance/);
    assert.equal(sb.openclawCalls().length, before);
  });
});

describe("plugin-dist workflow", () => {
  const wf = parseYaml(readFileSync(WORKFLOW, "utf8"));

  it("plugin-dist.yml parses and every uses: is pinned to a 40-hex SHA", () => {
    const uses = [];
    const walk = (node) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "uses") uses.push(v);
          walk(v);
        }
      }
    };
    walk(wf.jobs);
    assert.ok(uses.length >= 5, `found ${uses.length} uses:`);
    for (const u of uses) assert.match(u, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/, u);
    const text = readFileSync(WORKFLOW, "utf8");
    for (const line of text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l))) assert.match(line, /@[0-9a-f]{40} # v\d/, `pinned with a version comment: ${line.trim()}`);
  });

  it("plugin-dist.yml has the triggers, permissions and the ten-leg install matrix of the brief", () => {
    assert.deepEqual(wf.permissions, { contents: "read" });
    assert.deepEqual(wf.on.push.tags, ["v*"]);
    assert.equal(wf.on.schedule[0].cron, "17 3 * * *");
    assert.ok("workflow_dispatch" in wf.on);
    for (const p of ["scripts/dist/**", "lib/selftest/**", "lib/snapshot/**", ".github/workflows/plugin-dist.yml", "package*.json", "openclaw.plugin.json"]) {
      assert.ok(wf.on.pull_request.paths.includes(p), p);
    }
    assert.equal(wf.on.workflow_call.outputs.artifact.value, "${{ jobs.pack.outputs.artifact }}");
    assert.equal(wf.jobs.pack["runs-on"], "ubuntu-24.04");
    const m = wf.jobs.install.strategy;
    assert.equal(m["fail-fast"], false);
    assert.deepEqual(m.matrix.runner, ["ubuntu-24.04", "ubuntu-24.04-arm", "macos-15", "windows-2025", "windows-11-arm"]);
    assert.deepEqual(m.matrix.openclaw, ["min", "latest"]);
    assert.equal(wf.jobs.install["continue-on-error"], undefined, "the ten install legs are required");
    assert.deepEqual(wf.jobs.install.needs, "pack");
    assert.equal(wf.jobs.wsl["runs-on"], "windows-2025");
    assert.equal(wf.jobs.wsl["continue-on-error"], true);
    assert.equal(wf.jobs["upgrade-from-release"]["continue-on-error"], true);
    assert.match(wf.jobs["upgrade-from-release"].if, /schedule/);
    const text = readFileSync(WORKFLOW, "utf8");
    assert.match(text, /Vampire\/setup-wsl@[0-9a-f]{40} # v\d/);
    assert.ok(!/secrets\./.test(text), "the workflow uses no secrets");
    // every install leg asserts disposability right after installing OpenClaw
    const steps = wf.jobs.install.steps.map((s) => s.name ?? s.uses ?? "");
    const installIdx = steps.findIndex((n) => /Install OpenClaw \(POSIX/.test(n));
    const assertIdx = steps.findIndex((n) => /assert-disposable/i.test(n));
    assert.ok(installIdx >= 0 && assertIdx > installIdx, steps.join(" | "));
    assert.ok(steps.slice(installIdx + 1, assertIdx).every((n) => /Install OpenClaw/.test(n)), "assert-disposable is the first step after the OpenClaw install");
  });
});
