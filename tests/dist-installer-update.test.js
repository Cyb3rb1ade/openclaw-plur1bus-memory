// tests/dist-installer-update.test.js — installer update with store snapshot, automatic
// rollback and resume (HM1 Task 6, D89, Review Focus 5). Only the sandbox's openclaw/node
// shims; never a real OpenClaw, store outside the sandbox, or crontab.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as lancedb from "@lancedb/lancedb";

import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readState, writeState } from "../scripts/dist/installer/state.mjs";
import { listSnapshots } from "../lib/snapshot/store-snapshot.js";
import { createInstallerSandbox, makeTestFeed, mutatingCalls, runSandboxInstaller, sink, treeDigest, walkTree } from "./helpers/installer-sandbox.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = pathToFileURL(join(REPO, "scripts", "dist", "installer", "main.mjs")).href;
const ID = "memory-lancedb-namespaced";
const C = `plugins.entries.${ID}.config`;
const SLOT = "plugins.slots.memory";
const PKG = "@cyb3rb1ade/plur1bus-memory";

const NOTES = {
  "7.17.0": { de: "DE-HINWEIS 7.17.0: Selbsttest", en: "EN-NOTE 7.17.0: selftest" },
  "7.16.12": { de: "DE-HINWEIS 7.16.12: Korrekturen", en: "EN-NOTE 7.16.12: fixes" },
  "7.16.11": { de: "DE-HINWEIS 7.16.11: alt", en: "EN-NOTE 7.16.11: old" },
};
const feed3 = (o = {}) => makeTestFeed({ versions: ["7.17.0", "7.16.12", "7.16.11"], notes: NOTES, ...o });

const run = runSandboxInstaller;

const mutating = mutatingCalls;

/** A tracked install of `version` with a real (tiny) LanceDB store at the default baseDbPath (R-S7). */
async function trackedSandbox({ version = "7.16.11", source = "clawhub", stateSource, scenario = {}, feed = feed3() } = {}) {
  const sb = createInstallerSandbox({ feed, scenario: { installed: true, installedSource: source === "clawhub" ? "clawhub" : "npm", installedVersion: version, ...scenario } });
  const baseDbPath = join(sb.home, ".openclaw", "memory", "lancedb-namespaced");
  mkdirSync(baseDbPath, { recursive: true });
  const db = await lancedb.connect(join(baseDbPath, "main"));
  const table = await db.createTable("memories", [
    { id: "m-1", text: "TEST ONLY one", vector: [1, 0] },
    { id: "m-2", text: "TEST ONLY two", vector: [0, 1] },
  ]);
  await table.add([{ id: "m-3", text: "TEST ONLY three", vector: [1, 1] }]);
  writeState(sb.stateDir, { previousSlot: null, installedVersion: version, source: stateSource ?? source });
  sb.setScenario({ mutateStore: baseDbPath });
  return { sb, baseDbPath };
}

const walk = walkTree;

/** Anything a killed or half-finished run could leave behind (a restore's `.pre-restore-*` copy is kept on purpose, HM1-R-F2). */
function strays(...roots) {
  return roots.flatMap((r) => walk(r)).filter((p) => /\.tmp-\d+$|\.restore-\d+$|\.staging-/.test(p));
}

/** The `.pre-restore-*` copies beside the store. */
function preRestores(baseDbPath) {
  return readdirSync(dirname(baseDbPath)).filter((n) => n.startsWith(`${basename(baseDbPath)}.pre-restore-`)).map((n) => join(dirname(baseDbPath), n));
}

/** Run the installer in a child process (so the shim can kill it like Ctrl-C/OOM would). */
function runChild(sb, argv) {
  const code = `import { runInstaller } from ${JSON.stringify(MAIN)};\nprocess.exitCode = await runInstaller(process.argv.slice(1));\n`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", "--feed-file", sb.feedFile, ...argv], {
    env: { ...sb.env, PLUR1BUS_PLUGIN_TEST_FREE_BYTES: String(64 * 1024 ** 3), PLUR1BUS_SANDBOX_ALLOW_KILL_PARENT: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
}

describe("plugin installer: update", () => {
  it("update snapshots, updates, verifies and records the new version", async () => {
    const { sb, baseDbPath } = await trackedSandbox();
    const before = treeDigest(baseDbPath);
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(mutating(sb.openclawCalls()), [["plugins", "install", `clawhub:${PKG}@7.17.0`, "--force", "--accept-capabilities"]]);
    assert.ok(!sb.openclawCalls().some((a) => a[1] === "update"), "plugins update rejects clawhub:/npm: locators (R-S4)");
    const snaps = (await listSnapshots({ stateDir: sb.stateDir })).filter((s) => s.kind === "snapshot");
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].label, "pre-7.17.0");
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.mode, "update");
    const byId = Object.fromEntries(doc.steps.map((s) => [s.id, s]));
    for (const id of ["snapshot", "update", "verify.loaded", "verify.integrity", "verify.selftest"]) assert.equal(byId[id]?.status, "ok", `${id}: ${JSON.stringify(byId[id])}`);
    // the snapshot step comes before the change
    assert.ok(doc.steps.findIndex((s) => s.id === "snapshot") < doc.steps.findIndex((s) => s.id === "update"));
    const st = readState(sb.stateDir);
    assert.equal(st.installedVersion, "7.17.0");
    assert.equal(st.source, "clawhub");
    assert.equal(st.inProgress, undefined);
    assert.equal(sb.shimState().version, "7.17.0");
    // the new plugin wrote into the store; nothing else touched it
    assert.notEqual(treeDigest(baseDbPath), before);
    assert.deepEqual(strays(sb.root, sb.home), []);

    // equal version → up-to-date, nothing changes
    const calls = sb.openclawCalls().length;
    const again = await run(sb, ["--update", "--json"]);
    assert.equal(again.code, EXIT.OK, again.out);
    assert.match(again.out, /up-to-date/);
    assert.deepEqual(mutating(sb.openclawCalls().slice(calls)), []);
  });

  it("an update of a tarball install downloads and verifies both tarballs and keeps old npm generations", async () => {
    const bytes = { "7.17.0": Buffer.from("TEST ONLY 7.17.0"), "7.16.11": Buffer.from("TEST ONLY 7.16.11") };
    const url = (v) => `https://example.invalid/TEST-ONLY/cyb3rb1ade-plur1bus-memory-${v}.tgz`;
    const tarballs = Object.fromEntries(Object.entries(bytes).map(([v, b]) => [v, { url: url(v), sha256: createHash("sha256").update(b).digest("hex") }]));
    const { sb } = await trackedSandbox({ source: "npm", stateSource: "tarball", feed: feed3({ clawpackDigest: null, tarballs }) });
    const oldGen = join(sb.stateDir, "npm", "projects", "cyb3rb1ade-plur1bus-memory-1ff39c963c__openclaw-generation__g-0000000000000000");
    mkdirSync(oldGen, { recursive: true });
    writeFileSync(join(oldGen, "blob"), Buffer.alloc(4096));
    const fetched = [];
    const fetchImpl = async (u) => {
      fetched.push(String(u));
      const b = Object.entries(bytes).find(([v]) => String(u) === url(v))?.[1];
      if (!b) return { ok: false, status: 404 };
      return { ok: true, status: 200, headers: new Headers({ "content-length": String(b.length) }), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
    };
    const r = await run(sb, ["--update", "--yes", "--json"], { fetchImpl });
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(fetched.sort(), [url("7.16.11"), url("7.17.0")].sort(), "target and rollback tarball are fetched before any change");
    const inst = mutating(sb.openclawCalls());
    assert.equal(inst.length, 1, JSON.stringify(inst));
    const artefacts = join(sb.stateDir, "plur1bus-installer", "artefacts");
    assert.equal(inst[0][2], `npm-pack:${join(artefacts, "7.17.0.tgz")}`);
    assert.deepEqual(inst[0].slice(3), ["--force", "--accept-capabilities"]);
    assert.deepEqual(readdirSync(artefacts).sort(), ["7.16.11.tgz", "7.17.0.tgz"], "the current and the previous tarball are kept (T8-b)");
    assert.equal(readState(sb.stateDir).source, "tarball");
    assert.ok(existsSync(join(oldGen, "blob")), "old npm generation folders are never deleted (R-S4)");
    assert.match(r.stderr, /old npm generation/i);
    assert.deepEqual(strays(sb.root, sb.home), []);
    assert.deepEqual(readdirSync(join(sb.stateDir, "memory")).filter((n) => n.startsWith(".plur1bus-installer-work")), []);
  });

  it("release notes are printed before anything changes and Skip changes nothing", async () => {
    const { sb, baseDbPath } = await trackedSandbox();
    const stateBytes = readFileSync(join(sb.stateDir, "memory", ".plur1bus-installer.json"));
    const before = treeDigest(baseDbPath);
    let seenAtPrompt = null;
    const stderr = sink();
    const prompt = async (q) => {
      seenAtPrompt = { text: stderr.text, question: q, mutations: mutating(sb.openclawCalls()).length };
      return "s";
    };
    const r = await run(sb, ["--update", "--lang", "de"], { isTTY: true, prompt, stderr });
    assert.equal(r.code, EXIT.OK, stderr.text);
    assert.ok(seenAtPrompt, "the choice was asked");
    assert.match(seenAtPrompt.question, /Now.*Later.*Skip/i);
    assert.equal(seenAtPrompt.mutations, 0);
    assert.match(seenAtPrompt.text, /DE-HINWEIS 7\.17\.0/);
    assert.match(seenAtPrompt.text, /DE-HINWEIS 7\.16\.12/);
    assert.doesNotMatch(seenAtPrompt.text, /DE-HINWEIS 7\.16\.11/, "the installed version's notes are not shown");
    assert.doesNotMatch(seenAtPrompt.text, /EN-NOTE/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.deepEqual(await listSnapshots({ stateDir: sb.stateDir }), []);
    assert.deepEqual(readFileSync(join(sb.stateDir, "memory", ".plur1bus-installer.json")), stateBytes);
    assert.equal(treeDigest(baseDbPath), before);

    // --lang defaults from LANG, fallback en; Later also changes nothing
    const e2 = sink();
    const r2 = await run(sb, ["--update"], { isTTY: true, prompt: async () => "later", stderr: e2, env: { ...sb.env, LANG: "de_DE.UTF-8" } });
    assert.equal(r2.code, EXIT.OK, e2.text);
    assert.match(e2.text, /DE-HINWEIS 7\.17\.0/);
    const e3 = sink();
    await run(sb, ["--update"], { isTTY: true, prompt: async () => "l", stderr: e3, env: { ...sb.env, LANG: "fr_FR.UTF-8" } });
    assert.match(e3.text, /EN-NOTE 7\.17\.0/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
  });

  it("a failed verify restores the previous version and the snapshot and exits 1", async () => {
    const { sb, baseDbPath } = await trackedSandbox({ scenario: { failVersions: ["7.17.0"] } });
    const before = treeDigest(baseDbPath);
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.deepEqual(mutating(sb.openclawCalls()), [
      ["plugins", "install", `clawhub:${PKG}@7.17.0`, "--force", "--accept-capabilities"],
      ["plugins", "install", `clawhub:${PKG}@7.16.11`, "--force", "--accept-capabilities"],
    ]);
    assert.equal(sb.shimState().version, "7.16.11");
    assert.equal(treeDigest(baseDbPath), before, "store digest equal to before");
    assert.deepEqual(strays(sb.root, sb.home), []);
    const st = readState(sb.stateDir);
    assert.equal(st.installedVersion, "7.16.11");
    assert.equal(st.inProgress, undefined);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.steps.find((s) => s.id === "rollback")?.status, "ok");
    // HM1-R-F2: the new version wrote into the store, so it differed and was restored; the replaced store is kept and named
    assert.equal(doc.steps.find((s) => s.id === "restore.compare")?.status, "info");
    assert.match(doc.steps.find((s) => s.id === "restore.compare").detail, /written-by-7\.\d+\.\d+\.txt is new since the snapshot/);
    assert.equal(doc.steps.find((s) => s.id === "restore")?.status, "ok");
    const pre = preRestores(baseDbPath);
    assert.equal(pre.length, 1, "the .pre-restore-* copy is kept after the rolled-back verify passed");
    assert.ok(existsSync(join(pre[0], "written-by-7.17.0.txt")), "it holds what was written after the snapshot");
    assert.equal(doc.preRestorePath, pre[0]);
    assert.ok(r.stderr.includes(pre[0]) && /--uninstall --purge/.test(r.stderr), "the report names the copy and how it goes");
    assert.match(doc.steps.find((s) => s.id === "rollback").detail, /store restored from plur1bus-/);
    assert.equal(doc.steps.find((s) => s.id === "verify.loaded")?.status, "failed");
    // the snapshot stays for manual recovery
    assert.equal((await listSnapshots({ stateDir: sb.stateDir })).filter((s) => s.kind === "snapshot").length, 1);
  });

  it("PLUR1BUS_SELFTEST_FORCE_FAIL=1 (test flag only) fails the update's verify, not the rollback's (Task 8 CI seam)", async () => {
    const { sb, baseDbPath } = await trackedSandbox();
    const before = treeDigest(baseDbPath);
    const r = await run({ ...sb, env: { ...sb.env, PLUR1BUS_SELFTEST_FORCE_FAIL: "1" } }, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    const doc = JSON.parse(r.stdout);
    const byId = Object.fromEntries(doc.steps.map((s) => [s.id, s]));
    assert.equal(byId["verify.selftest"].status, "failed");
    assert.match(byId["verify.selftest"].detail, /PLUR1BUS_SELFTEST_FORCE_FAIL/);
    assert.equal(byId["rollback.verify.selftest"].status, "ok", "the rollback verify is never forced");
    assert.equal(byId.rollback.status, "ok");
    assert.equal(sb.shimState().version, "7.16.11");
    assert.equal(treeDigest(baseDbPath), before);
    assert.ok(sb.openclawCalls().filter((a) => a[0] === "plur1bus").length >= 2, "the real selftest still runs under the seam");
  });

  it("PLUR1BUS_SELFTEST_FORCE_FAIL is ignored without PLUR1BUS_PLUGIN_INSTALLER_TEST=1", async () => {
    const { sb } = await trackedSandbox();
    const env = { ...sb.env, PLUR1BUS_SELFTEST_FORCE_FAIL: "1" };
    delete env.PLUR1BUS_PLUGIN_INSTALLER_TEST;
    const r = await run({ ...sb, env }, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(sb.shimState().version, "7.17.0");
  });

  it("after a rolled-back update, --update --offline <tgz> succeeds from the kept artefact (T8-b)", async () => {
    const dir = makeTempDir("plur1bus-offline-t8b-");
    const files = {};
    const tarballs = {};
    for (const v of ["7.16.11", "7.17.0"]) {
      files[v] = join(dir, `TEST ONLY ${v}.tgz`);
      writeFileSync(files[v], `TEST ONLY tarball ${v}`);
      tarballs[v] = { url: `https://example.invalid/TEST-ONLY/${v}.tgz`, sha256: createHash("sha256").update(readFileSync(files[v])).digest("hex") };
    }
    const sb = createInstallerSandbox({ feed: feed3({ clawpackDigest: null, tarballs }) });
    assert.equal((await run(sb, ["--offline", files["7.16.11"], "--version", "7.16.11", "--non-interactive"])).code, EXIT.OK);
    const artefacts = join(sb.stateDir, "plur1bus-installer", "artefacts");

    const failed = await run({ ...sb, env: { ...sb.env, PLUR1BUS_SELFTEST_FORCE_FAIL: "1" } }, ["--update", "--offline", files["7.17.0"], "--yes", "--json"]);
    assert.equal(failed.code, EXIT.FAILED, failed.out);
    assert.equal(sb.shimState().version, "7.16.11");
    assert.equal(sb.shimState().sourcePath, join(artefacts, "7.16.11.tgz"), "the rolled-back install record points at the kept artefact");
    assert.ok(existsSync(join(artefacts, "7.16.11.tgz")));

    // the tarball the person installed from is gone; the kept copy is enough
    rmSync(files["7.16.11"]);
    const r = await run(sb, ["--update", "--offline", files["7.17.0"], "--yes", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(sb.shimState().version, "7.17.0");
    assert.match(JSON.parse(r.stdout).steps.find((x) => x.id === "rollback-source").detail, /artefacts/);
  });

  it("artefact retention keeps exactly the current and the previous tarball (T8-b)", async () => {
    const dir = makeTempDir("plur1bus-retention-t8b-");
    const files = {};
    const tarballs = {};
    for (const v of ["7.16.11", "7.16.12", "7.17.0"]) {
      files[v] = join(dir, `${v}.tgz`);
      writeFileSync(files[v], `TEST ONLY tarball ${v}`);
      tarballs[v] = { url: `https://example.invalid/TEST-ONLY/${v}.tgz`, sha256: createHash("sha256").update(readFileSync(files[v])).digest("hex") };
    }
    const sb = createInstallerSandbox({ feed: feed3({ clawpackDigest: null, tarballs }) });
    const artefacts = join(sb.stateDir, "plur1bus-installer", "artefacts");
    assert.equal((await run(sb, ["--offline", files["7.16.11"], "--version", "7.16.11", "--non-interactive"])).code, EXIT.OK);
    assert.deepEqual(readdirSync(artefacts), ["7.16.11.tgz"]);
    assert.equal((await run(sb, ["--update", "--offline", files["7.16.12"], "--version", "7.16.12", "--yes"])).code, EXIT.OK);
    assert.deepEqual(readdirSync(artefacts).sort(), ["7.16.11.tgz", "7.16.12.tgz"]);
    assert.equal((await run(sb, ["--update", "--offline", files["7.17.0"], "--yes"])).code, EXIT.OK);
    assert.deepEqual(readdirSync(artefacts).sort(), ["7.16.12.tgz", "7.17.0.tgz"]);
    assert.deepEqual(Object.keys(readState(sb.stateDir).artefacts).sort(), ["7.16.12", "7.17.0"]);
    if (process.platform !== "win32") {
      for (const n of readdirSync(artefacts)) assert.equal(statSync(join(artefacts, n)).mode & 0o777, 0o600, n);
    }
    // uninstall removes the installer's kept tarballs with its state
    assert.equal((await run(sb, ["--uninstall"])).code, EXIT.OK);
    assert.equal(existsSync(artefacts), false);
  });

  it("a failed rollback exits 4 and prints the manual steps", async () => {
    const { sb, baseDbPath } = await trackedSandbox({ scenario: { failVersions: ["7.17.0", "7.16.11"] } });
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.ROLLBACK_FAILED, r.out);
    assert.match(r.stderr, new RegExp(`openclaw plugins install clawhub:${PKG.replace("/", "\\/")}@7\\.16\\.11 --force --accept-capabilities`));
    const snap = (await listSnapshots({ stateDir: sb.stateDir })).find((s) => s.kind === "snapshot");
    assert.ok(r.stderr.includes(snap.id), "the manual steps name the snapshot");
    const doc = JSON.parse(r.stdout);
    assert.ok(Array.isArray(doc.manualSteps) && doc.manualSteps.length > 0);
    const pre = walk(dirname(baseDbPath)).filter((p) => p.includes(".pre-restore-"));
    assert.ok(pre.length > 0, "the pre-restore copy is kept when the rolled-back verify fails");
    assert.equal(readState(sb.stateDir).inProgress?.step, "rollback-failed");
  });

  it("no TTY and no --yes exits 2", async () => {
    const { sb, baseDbPath } = await trackedSandbox();
    const before = treeDigest(baseDbPath);
    const r = await run(sb, ["--update"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.stderr, /EN-NOTE 7\.17\.0/);
    assert.match(r.stderr, /--yes/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.deepEqual(await listSnapshots({ stateDir: sb.stateDir }), []);
    assert.equal(treeDigest(baseDbPath), before);
    // a tracked install found by a plain install run takes the same path
    const r2 = await run(sb, []);
    assert.equal(r2.code, EXIT.NEEDS_CHOICE, r2.out);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
  });

  it("an existing embedding choice is never changed by an update", async () => {
    const config = { [SLOT]: ID, [`${C}.embedding.provider`]: "openai", [`${C}.embedding.model`]: "text-embedding-3-small", [`plugins.entries.${ID}.hooks.allowConversationAccess`]: "false" };
    const { sb } = await trackedSandbox({ scenario: { config } });
    const r = await run(sb, ["--update", "--yes", "--accept-nc-licence"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(sb.openclawCalls().filter((a) => a[0] === "config" && a[1] === "set"), []);
    assert.deepEqual(sb.shimState().config, config);
    assert.ok(!r.stderr.includes("allowConversationAccess true"), "a person's false is not questioned");
  });

  it("a killed update is completed or rolled back by the next run", { skip: process.platform === "win32" && "POSIX kill of the parent process" }, async () => {
    // A: killed while OpenClaw installs (after the snapshot) → the next run completes the update
    const a = await trackedSandbox({ scenario: { killParentOnInstall: true } });
    const k = runChild(a.sb, ["--update", "--yes"]);
    assert.equal(k.signal, "SIGKILL", `${k.status} ${k.stderr}`);
    const mid = readState(a.sb.stateDir);
    assert.equal(mid.inProgress?.op, "update");
    assert.equal(mid.inProgress?.step, "update");
    assert.ok(mid.inProgress?.snapshotId, "the snapshot was taken before the change");
    a.sb.setScenario({ killParentOnInstall: false });
    const r = await run(a.sb, []);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.match(r.stderr, /interrupted update to 7\.17\.0 at step update/);
    const st = readState(a.sb.stateDir);
    assert.equal(st.installedVersion, "7.17.0");
    assert.equal(st.inProgress, undefined);
    assert.equal(a.sb.shimState().version, "7.17.0");
    assert.deepEqual(strays(a.sb.root, a.sb.home), []);

    // B: the same interruption, then --rollback → previous version and the snapshot's store
    const b = await trackedSandbox({ scenario: { killParentOnInstall: true } });
    const before = treeDigest(b.baseDbPath);
    const k2 = runChild(b.sb, ["--update", "--yes"]);
    assert.equal(k2.signal, "SIGKILL", `${k2.status} ${k2.stderr}`);
    assert.notEqual(treeDigest(b.baseDbPath), before, "the new version wrote into the store before the kill");
    b.sb.setScenario({ killParentOnInstall: false });
    const r2 = await run(b.sb, ["--rollback", "--json"]);
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.match(r2.stderr, /interrupted update to 7\.17\.0 at step update/);
    assert.equal(JSON.parse(r2.stdout).steps.find((s) => s.id === "rollback")?.status, "ok");
    assert.equal(b.sb.shimState().version, "7.16.11");
    assert.equal(treeDigest(b.baseDbPath), before);
    assert.equal(readState(b.sb.stateDir).inProgress, undefined);
    assert.deepEqual(strays(b.sb.root, b.sb.home), []);
    assert.equal(preRestores(b.baseDbPath).length, 1, "the store the killed run left is kept at .pre-restore-*");

    // --rollback with nothing interrupted changes nothing
    const n = b.sb.openclawCalls().length;
    const r3 = await run(b.sb, ["--rollback"]);
    assert.equal(r3.code, EXIT.FAILED, r3.out);
    assert.match(r3.stderr, /nothing to roll back/);
    assert.deepEqual(mutating(b.sb.openclawCalls().slice(n)), []);
  });

  it("an interrupted fresh install is rolled back and installed again by the next run", async () => {
    const sb = createInstallerSandbox({ scenario: { installed: true, config: { [SLOT]: "memory-lancedb-stock" } } });
    writeState(sb.stateDir, { previousSlot: "memory-lancedb-stock", installedVersion: null, source: "clawhub", inProgress: { op: "install", step: "config", snapshotId: null, previousVersion: null } });
    const r = await run(sb, []);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.match(r.stderr, /interrupted install .*at step config/);
    const calls = mutating(sb.openclawCalls()).map((a) => a.slice(0, 3).join(" "));
    assert.equal(calls[0], `plugins uninstall ${ID}`);
    assert.ok(calls.includes(`plugins install clawhub:${PKG}@7.16.11`), JSON.stringify(calls));
    const st = readState(sb.stateDir);
    assert.equal(st.installedVersion, "7.16.11");
    assert.equal(st.previousSlot, "memory-lancedb-stock");
    assert.equal(st.inProgress, undefined);
  });

  it("downloads are capped and a malformed free-space test seam is refused", async () => {
    const huge = { ok: true, status: 200, headers: new Headers({ "content-length": String(300 * 1024 * 1024) }), arrayBuffer: async () => { throw new Error("must not read the body"); } };
    const { sb } = await trackedSandbox({ source: "npm", stateSource: "tarball", feed: feed3({ clawpackDigest: null }) });
    const r = await run(sb, ["--update", "--yes"], { fetchImpl: async () => huge });
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.match(r.stderr, /200 MB limit/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.deepEqual(await listSnapshots({ stateDir: sb.stateDir }), []);
    assert.equal(readState(sb.stateDir).inProgress, undefined);

    const r2 = await run(sb, ["--update", "--yes"], { env: { ...sb.env, PLUR1BUS_PLUGIN_TEST_FREE_BYTES: "lots" } });
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.match(r2.stderr, /PLUR1BUS_PLUGIN_TEST_FREE_BYTES/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
  });

  it("a store restore never runs under a running Gateway: non-interactive exits 4, --rollback finishes later (T6-e)", async () => {
    const { sb, baseDbPath } = await trackedSandbox({ scenario: { failVersions: ["7.17.0"], gatewayRunning: true } });
    const before = treeDigest(baseDbPath);
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.ROLLBACK_FAILED, r.out);
    assert.match(r.stderr, /stop the Gateway/i);
    assert.match(r.stderr, /--rollback/);
    assert.equal(sb.shimState().version, "7.16.11", "the plugin reinstall part of the rollback still ran");
    assert.notEqual(treeDigest(baseDbPath), before, "the store was not restored under the running Gateway");
    assert.deepEqual(walk(dirname(baseDbPath)).filter((p) => p.includes(".pre-restore-")), []);
    assert.match(JSON.parse(r.stdout).steps.find((s) => s.id === "restore.compare").detail, /new since the snapshot/, "it differed, so a restore was due");
    assert.equal(readState(sb.stateDir).inProgress?.step, "rollback-failed");
    assert.ok(sb.openclawCalls().some((a) => a.join(" ") === "gateway status --json"));

    sb.setScenario({ gatewayRunning: false });
    const r2 = await run(sb, ["--rollback"]);
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.equal(treeDigest(baseDbPath), before);
    assert.equal(readState(sb.stateDir).inProgress, undefined);
    assert.deepEqual(strays(sb.root, sb.home), []);
    assert.equal(preRestores(baseDbPath).length, 1);
  });

  it("an untouched store is not restored, so a running Gateway neither blocks nor prompts the rollback (HM1-R-F2)", async () => {
    const { sb, baseDbPath } = await trackedSandbox({ scenario: { failVersions: ["7.17.0"], gatewayRunning: true } });
    sb.setScenario({ mutateStore: null }); // plugins install --force does not write to the store
    const before = treeDigest(baseDbPath);
    const snapDir = join(sb.stateDir, "memory", ".snapshots");
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    const doc = JSON.parse(r.stdout);
    const restore = doc.steps.find((s) => s.id === "restore");
    assert.equal(restore?.status, "skipped");
    assert.match(restore.detail, /untouched since snapshot plur1bus-.*nothing to restore/);
    assert.equal(doc.steps.find((s) => s.id === "rollback")?.status, "ok");
    assert.match(doc.steps.find((s) => s.id === "rollback").detail, /store untouched since plur1bus-.* \(not restored\)/);
    assert.equal(doc.manualSteps, undefined);
    assert.equal(sb.shimState().version, "7.16.11");
    assert.equal(treeDigest(baseDbPath), before);
    assert.deepEqual(preRestores(baseDbPath), []);
    assert.equal(readState(sb.stateDir).inProgress, undefined);
    assert.equal(readdirSync(snapDir).filter((n) => n.startsWith("plur1bus-")).length, 1, "the snapshot stays");

    // on a TTY: no Gateway prompt either
    const t = await trackedSandbox({ scenario: { failVersions: ["7.17.0"], gatewayRunning: true } });
    t.sb.setScenario({ mutateStore: null });
    const asked = [];
    const r2 = await run(t.sb, ["--update", "--yes"], { isTTY: true, prompt: async (q) => (asked.push(q), "") });
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.deepEqual(asked.filter((q) => /Gateway/.test(q)), []);
  });

  it("a store restore on a TTY waits until the person stopped the Gateway (T6-e)", async () => {
    const { sb, baseDbPath } = await trackedSandbox({ scenario: { failVersions: ["7.17.0"], gatewayRunning: true } });
    const before = treeDigest(baseDbPath);
    const asked = [];
    const prompt = async (q) => {
      asked.push(q);
      if (asked.length === 2) sb.setScenario({ gatewayRunning: false });
      return "";
    };
    const r = await run(sb, ["--update", "--yes"], { isTTY: true, prompt });
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.equal(asked.length, 2, "asked again while the Gateway still ran");
    assert.match(asked[0], /Gateway/);
    assert.equal(treeDigest(baseDbPath), before);
    assert.equal(readState(sb.stateDir).inProgress, undefined);
  });

  it("--dry-run never resumes an interrupted run (T6-d)", async () => {
    const { sb, baseDbPath } = await trackedSandbox();
    writeState(sb.stateDir, {
      previousSlot: null, installedVersion: "7.16.11", source: "clawhub",
      inProgress: { op: "update", step: "update", snapshotId: null, previousVersion: "7.16.11", targetVersion: "7.17.0", source: "clawhub",
        previous: { version: "7.16.11", source: "clawhub", npmIntegrity: null, clawpackSha256: null, sourcePath: null },
        rollback: { locator: `clawhub:${PKG}@7.16.11`, opts: { force: true, acceptCapabilities: true }, file: null, sha256: null } },
    });
    const stateFile = join(sb.stateDir, "memory", ".plur1bus-installer.json");
    const bytes = readFileSync(stateFile);
    const before = treeDigest(baseDbPath);
    for (const argv of [["--dry-run", "--json"], ["--update", "--dry-run"], ["--rollback", "--dry-run"]]) {
      const r = await run(sb, argv);
      assert.equal(r.code, EXIT.OK, r.out);
      assert.match(r.stderr, /interrupted update to 7\.17\.0 at step update/);
      assert.match(r.stderr, /--rollback/);
    }
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.deepEqual(readFileSync(stateFile), bytes);
    assert.equal(treeDigest(baseDbPath), before);
  });

  it("--update --dry-run prints the plan without --yes, without a TTY and without changes", async () => {
    const { sb, baseDbPath } = await trackedSandbox();
    const before = treeDigest(baseDbPath);
    for (const argv of [["--update", "--dry-run"], ["--dry-run"]]) {
      const r = await run(sb, argv, { isTTY: false });
      assert.equal(r.code, EXIT.OK, r.out);
      assert.match(r.stderr, /EN-NOTE 7\.17\.0/);
      assert.match(r.stderr, /\[plan\] snapshot/);
      assert.match(r.stderr, /\[plan\] update: openclaw plugins install/);
      assert.doesNotMatch(r.stderr, /needs a choice/);
    }
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.equal(treeDigest(baseDbPath), before);
    assert.equal(readState(sb.stateDir).inProgress, undefined);
  });

  it("a successful update names an unset allowConversationAccess and never sets it (T6-b)", async () => {
    const { sb } = await trackedSandbox();
    const r = await run(sb, ["--update", "--yes"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.ok(r.stderr.includes(`openclaw config set plugins.entries.${ID}.hooks.allowConversationAccess true`), r.stderr);
    assert.deepEqual(sb.openclawCalls().filter((a) => a[0] === "config" && a[1] === "set"), []);
  });

  it("a rollback whose previous install record carries no digests exits 1, not 4", async () => {
    const { sb, baseDbPath } = await trackedSandbox({ scenario: { failVersions: ["7.17.0"], recordDigestsMissingFor: ["7.16.11"] } });
    const before = treeDigest(baseDbPath);
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.doesNotMatch(r.out, /TypeError|unexpected error/);
    assert.equal(JSON.parse(r.stdout).steps.find((s) => s.id === "rollback")?.status, "ok");
    assert.equal(treeDigest(baseDbPath), before);
  });

  it("--update without any install exits 1 and a legacy deploy exits 2 naming --adopt-legacy", async () => {
    const sb = createInstallerSandbox();
    const r = await run(sb, ["--update"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.match(r.stderr, /not installed/);
    const lg = createInstallerSandbox({ scenario: { legacy: true } });
    mkdirSync(join(lg.stateDir, "extensions", ID), { recursive: true });
    const r2 = await run(lg, ["--update"]);
    assert.equal(r2.code, EXIT.NEEDS_CHOICE, r2.out);
    assert.match(r2.stderr, /legacy-deploy.*--adopt-legacy/);
    assert.deepEqual(mutating(lg.openclawCalls()), []);
  });
});
