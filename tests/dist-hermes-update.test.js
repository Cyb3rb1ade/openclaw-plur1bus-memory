// tests/dist-hermes-update.test.js — `install-plugin --host hermes --update` (HM2 Task 9): notes first, Now/Later/Skip,
// provider-only and sidecar updates with the store snapshot (F18), the home's manifest/config saved byte for byte, the
// recorded use class (F3), rollback (binary, setup with it, files, store per HM1-R-F2, provider, binding), install over an
// older install (F17), and every kill point with resume and --rollback. Shims and temp homes only (hermes-sandbox.js).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readHermesState } from "../scripts/dist/installer/hermes/state.mjs";
import { createHermesSandbox, runHermesInstaller, sha256File } from "./helpers/hermes-sandbox.js";
import { sink, treeDigest, walkTree } from "./helpers/installer-sandbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "scripts", "dist", "installer", "main.mjs");
const run = runHermesInstaller;
const POSIX_KILL = process.platform === "win32" && "POSIX kill of the installer process";
const strays = (sb) => [...walkTree(sb.home), ...walkTree(sb.root)].filter((p) => /plur1bus\.tmp-\d+$|\.plur1bus-prev-\d+$|\.tmp-\d+$|\.prev-\d+$|host-update-home[\\/]\d+$/.test(p));
const providerVersion = (sb) => JSON.parse(readFileSync(join(sb.hermesHome, "plugins", "plur1bus", "MANIFEST.json"), "utf8")).version;
const bindingVersion = (sb) => JSON.parse(readFileSync(join(sb.hermesHome, "plur1bus.json"), "utf8")).version;
const storeDir = (sb) => join(sb.plur1busHome, "state", "lancedb");
const mutatingPlur1bus = (sb, from = 0) => sb.plur1busCalls().slice(from).filter((a) => a[0] !== "--version").map((a) => a.slice(3).join(" ")).filter((c) => !/^(agent list|config get|service status)/.test(c));

function runChild(sb, argv, { killAt } = {}) {
  const code = `import { runInstaller } from ${JSON.stringify(MAIN)};\nprocess.exitCode = await runInstaller(process.argv.slice(1));\n`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", "--host", "hermes", "--feed-file", sb.feedFile, ...argv], {
    env: { ...sb.env, PLUR1BUS_PLUGIN_TEST_FREE_BYTES: String(64 * 1024 ** 3), PLUR1BUS_SANDBOX_ALLOW_KILL_PARENT: "1", ...(killAt ? { PLUR1BUS_PLUGIN_TEST_KILL_AT: killAt } : {}) },
    encoding: "utf8",
    timeout: 120_000,
  });
}

/** An installed 0.1.0 with a store and a recorded use class; returns the digests a rollback must restore. */
async function installed(opts = {}) {
  const sb = createHermesSandbox(opts);
  const r = await run(sb, []);
  assert.equal(r.code, EXIT.OK, r.out);
  mkdirSync(storeDir(sb), { recursive: true });
  writeFileSync(join(storeDir(sb), "memories.lance"), "TEST ONLY store\n");
  const cfg = join(sb.plur1busHome, "config.json");
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(cfg, "utf8")), embedding: { useClass: "commercial" } }, null, 2));
  return sb;
}

function snapshotOf(sb) {
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  return {
    hermes: treeDigest(sb.hermesHome),
    manifest: read(join(sb.plur1busHome, "manifest.json")),
    config: read(join(sb.plur1busHome, "config.json")),
    store: treeDigest(storeDir(sb)),
    bin: sha256File(sb.sidecarBin),
  };
}

function assertRolledBack(sb, before) {
  const now = snapshotOf(sb);
  assert.equal(now.manifest, before.manifest, "manifest.json byte for byte");
  assert.equal(now.config, before.config, "config.json byte for byte");
  assert.equal(now.store, before.store, "the store");
  assert.equal(now.bin, before.bin, "the previous binary");
  assert.equal(now.hermes, before.hermes, "the Hermes home (provider dir, binding, state)");
  assert.deepEqual(strays(sb), []);
}

describe("hermes installer: update", () => {
  it("update shows notes first and Skip changes nothing", async () => {
    const sb = await installed();
    await sb.addRelease({ version: "0.2.0" });
    const before = snapshotOf(sb);
    const n = sb.log().length;
    const stderr = sink();
    const asked = [];
    const r = await run(sb, ["--update"], {
      isTTY: true,
      stderr,
      prompt: async (q) => {
        asked.push({ q, before: stderr.text });
        return "s";
      },
    });
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(asked.length, 1);
    assert.match(asked[0].before, /TEST ONLY 0\.2\.0 EN/, "the notes are printed before the question");
    assert.match(asked[0].before, /0\.1\.0 → 0\.2\.0/);
    assert.match(stderr.text, /skipped 0\.2\.0; nothing was changed/);
    assert.deepEqual(mutatingPlur1bus(sb, sb.plur1busCalls().length), []);
    assert.deepEqual(sb.log().slice(n).filter((e) => e.bin === "hermes" && e.argv[0] === "config" && e.argv[1] !== "get"), []);
    assertRolledBack(sb, before);
    // Later changes nothing either; --lang de picks the German notes
    const later = await run(sb, ["--update", "--lang", "de"], { isTTY: true, prompt: async () => "" });
    assert.equal(later.code, EXIT.OK);
    assert.match(later.out, /TEST ONLY 0\.2\.0 DE/);
    assert.match(later.out, /later/);
    assertRolledBack(sb, before);
  });

  it("no TTY and no --yes exits 2", async () => {
    const sb = await installed();
    await sb.addRelease({ version: "0.2.0" });
    const before = snapshotOf(sb);
    const r = await run(sb, ["--update"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /--update --yes/);
    assertRolledBack(sb, before);
    // up to date → exit 0
    const up = createHermesSandbox();
    assert.equal((await run(up, [])).code, EXIT.OK);
    const u = await run(up, ["--update", "--json"]);
    assert.equal(u.code, EXIT.OK, u.out);
    assert.match(u.out, /up-to-date/);
    // nothing installed → exit 1
    const none = await run(createHermesSandbox(), ["--update", "--yes"]);
    assert.equal(none.code, EXIT.FAILED);
    assert.match(none.out, /not installed/);
  });

  it("a provider-only update swaps the provider and keeps the sidecar", async () => {
    const sb = await installed();
    await sb.addRelease({ version: "0.1.1", sidecarVersion: "0.1.0" });
    const bin = sha256File(sb.sidecarBin);
    const n = sb.plur1busCalls().length;
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(providerVersion(sb), "0.1.1");
    assert.equal(bindingVersion(sb), "0.1.1");
    assert.equal(readHermesState(sb.hermesHome).installedVersion, "0.1.1");
    assert.equal(readHermesState(sb.hermesHome).inProgress, undefined);
    assert.equal(sha256File(sb.sidecarBin), bin, "the sidecar binary is untouched");
    assert.deepEqual(mutatingPlur1bus(sb, n), [], "no daemon stop, no setup");
    assert.equal(existsSync(join(sb.plur1busHome, "backups", "host-update")), false, "no snapshot for a provider-only update");
    assert.deepEqual(strays(sb), []);
    assert.equal(sb.provider(), "plur1bus");
  });

  it("a sidecar update stops the daemon, snapshots, installs and verifies (F18, F3)", async () => {
    const sb = await installed();
    const { binArtefact } = await sb.addRelease({ version: "0.2.0" });
    const n = sb.plur1busCalls().length;
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    const calls = mutatingPlur1bus(sb, n);
    assert.equal(calls[0], "daemon stop");
    assert.deepEqual(calls.slice(1), ["setup --profile host --non-interactive --use-class commercial --no-service"], "the recorded use class is passed (F3)");
    const snaps = readdirSync(join(sb.plur1busHome, "backups", "host-update")).filter((x) => x.startsWith("plur1bus-"));
    assert.equal(snaps.length, 1, "one store snapshot under <home>/backups/host-update (F18)");
    assert.match(readFileSync(join(sb.plur1busHome, "backups", "host-update", snaps[0], "snapshot.json"), "utf8"), /pre-0\.2\.0/);
    assert.equal(sha256File(sb.sidecarBin), sha256File(binArtefact));
    assert.equal(JSON.parse(readFileSync(join(sb.plur1busHome, "manifest.json"), "utf8")).binary.version, "0.2.0");
    assert.equal(providerVersion(sb), "0.2.0");
    assert.equal(readHermesState(sb.hermesHome).installedVersion, "0.2.0");
    assert.deepEqual(strays(sb), []);
    const doc = JSON.parse(r.stdout);
    for (const id of ["snapshot", "home-backup", "sidecar", "setup", "provider", "binding", "verify.selftest"]) assert.equal(doc.steps.find((x) => x.id === id)?.status, "ok", id);
  });

  it("a failed verify restores provider, binary and the store", async () => {
    const sb = await installed();
    await sb.addRelease({ version: "0.2.0" });
    const before = snapshotOf(sb);
    sb.setScenario({ selftestFail: true, setupMigratesStoreFrom: "0.2.0" });
    const n = sb.plur1busCalls().length;
    const r = await run(sb, ["--update", "--yes", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.steps.find((x) => x.id === "rollback").status, "ok", r.out);
    assert.equal(doc.steps.find((x) => x.id === "restore").status, "ok", "the store changed, so it is restored (HM1-R-F2)");
    assert.ok(doc.preRestorePath && existsSync(doc.preRestorePath), "the replaced store is kept and named");
    assert.match(r.out, /Nothing deletes it except/);
    // the previous binary ran setup again before the files were put back
    const calls = mutatingPlur1bus(sb, n);
    assert.deepEqual(calls.filter((c) => c.startsWith("setup")).length, 2, calls.join("\n"));
    assert.ok(calls.includes("daemon start"));
    assertRolledBack(sb, before);
    assert.equal(providerVersion(sb), "0.1.0");
    assert.equal(bindingVersion(sb), "0.1.0");
    assert.equal(readHermesState(sb.hermesHome).inProgress, undefined);
    // an unchanged store is not restored
    const quiet = await installed();
    await quiet.addRelease({ version: "0.2.0" });
    quiet.setScenario({ selftestFail: true });
    const q = await run(quiet, ["--update", "--yes", "--json"]);
    assert.equal(q.code, EXIT.FAILED);
    assert.equal(JSON.parse(q.stdout).steps.find((x) => x.id === "restore").status, "skipped");
  });

  it("installing over an older plur1bus install becomes the update (F17)", async () => {
    const sb = await installed();
    await sb.addRelease({ version: "0.2.0" });
    const r = await run(sb, ["--yes", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(JSON.parse(r.stdout).mode, "update");
    assert.equal(providerVersion(sb), "0.2.0");
  });

  // F19 for the update: every step and kill point, then a resumed run or --rollback
  const KILL_POINTS = [
    { point: "update.daemon-stopped", step: "stop" },
    { point: "update.home-saved", step: "home" },
    { point: "update.snapshotted", step: "snapshot" },
    { point: "sidecar.planned", step: "sidecar" },
    { point: "sidecar.moved-aside", step: "sidecar" },
    { point: "setup", how: "shim", step: "setup" },
    { point: "provider.staged", step: "provider" },
    { point: "provider.moved-aside", step: "provider" },
    { point: "binding.before", step: "binding" },
  ];
  async function killedUpdate({ point, how = "seam" }) {
    const sb = await installed();
    await sb.addRelease({ version: "0.2.0" });
    sb.setScenario({ setupMigratesStoreFrom: "0.2.0" });
    const before = snapshotOf(sb);
    if (how === "shim") sb.setScenario({ killOn: point });
    const k = runChild(sb, ["--update", "--yes"], how === "seam" ? { killAt: point } : {});
    assert.notEqual(k.status, 0, `${point}: not killed\n${k.stdout}${k.stderr}`);
    if (how === "shim") sb.setScenario({ killOn: null });
    return { sb, before };
  }
  for (const kp of KILL_POINTS) {
    it(`update killed at ${kp.point}: the next run finishes it`, { skip: POSIX_KILL }, async () => {
      const { sb } = await killedUpdate(kp);
      assert.equal(readHermesState(sb.hermesHome).inProgress.op, "update");
      assert.equal(readHermesState(sb.hermesHome).inProgress.step, kp.step);
      const r = await run(sb, ["--json"]);
      assert.equal(r.code, EXIT.OK, r.out);
      assert.match(r.out, new RegExp(`interrupted update at step ${kp.step}; finishing it`));
      assert.equal(providerVersion(sb), "0.2.0");
      assert.equal(JSON.parse(readFileSync(join(sb.plur1busHome, "manifest.json"), "utf8")).binary.version, "0.2.0");
      assert.equal(readHermesState(sb.hermesHome).installedVersion, "0.2.0");
      assert.equal(readHermesState(sb.hermesHome).inProgress, undefined);
      assert.deepEqual(strays(sb), []);
    });
    it(`update killed at ${kp.point}: --rollback restores the previous version`, { skip: POSIX_KILL }, async () => {
      const { sb, before } = await killedUpdate(kp);
      const r = await run(sb, ["--rollback", "--json"]);
      assert.equal(r.code, EXIT.FAILED, r.out);
      assert.equal(JSON.parse(r.stdout).steps.find((x) => x.id === "rollback").status, "ok", r.out);
      assertRolledBack(sb, before);
    });
  }

  it("an interrupted update is not continued by --uninstall", { skip: POSIX_KILL }, async () => {
    const { sb } = await killedUpdate({ point: "update.snapshotted" });
    const r = await run(sb, ["--uninstall"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /interrupted update/);
  });
});

describe("hermes installer: update (T9 review)", () => {
  it("a rollback killed midway resumes as a rollback, not as the update (review 4)", { skip: POSIX_KILL }, async () => {
    for (const next of [[], ["--rollback"]]) {
      const sb = await installed();
      await sb.addRelease({ version: "0.2.0" });
      const before = snapshotOf(sb);
      sb.setScenario({ selftestFail: true, setupMigratesStoreFrom: "0.2.0" });
      const k = runChild(sb, ["--update", "--yes"], { killAt: "update.rollback-binary" });
      assert.notEqual(k.status, 0, k.stdout + k.stderr);
      assert.equal(readHermesState(sb.hermesHome).inProgress.step, "rollback");
      sb.setScenario({ selftestFail: false });
      const r = await run(sb, next);
      assert.equal(r.code, EXIT.FAILED, r.out);
      assert.match(r.out, /interrupted update at step rollback; rolling it back/);
      assert.ok(!r.out.includes("finishing it"), "not re-applied as the update");
      assertRolledBack(sb, before);
      assert.equal(providerVersion(sb), "0.1.0");
    }
  });

  it("an unknown use class passes no --use-class at all (review 5, F3)", async () => {
    const sb = await installed();
    const cfg = join(sb.plur1busHome, "config.json");
    const c = JSON.parse(readFileSync(cfg, "utf8"));
    delete c.embedding;
    writeFileSync(cfg, JSON.stringify(c, null, 2));
    const sf = join(sb.hermesHome, ".plur1bus-installer.json");
    const st = JSON.parse(readFileSync(sf, "utf8"));
    delete st.useClass;
    writeFileSync(sf, JSON.stringify(st));
    await sb.addRelease({ version: "0.2.0" });
    const n = sb.plur1busCalls().length;
    assert.equal((await run(sb, ["--update", "--yes"])).code, EXIT.OK);
    assert.deepEqual(mutatingPlur1bus(sb, n).filter((x) => x.startsWith("setup")), ["setup --profile host --non-interactive --no-service"]);
  });

  it("rollback restarts the sidecar only when it ran before, through its service when registered (review 6)", async () => {
    const stopped = await installed();
    await stopped.addRelease({ version: "0.2.0" });
    stopped.setScenario({ selftestFail: true, daemonRunning: false });
    const n = stopped.plur1busCalls().length;
    const r = await run(stopped, ["--update", "--yes"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.ok(!mutatingPlur1bus(stopped, n).includes("daemon start"), "not started: it was not running before");
    assert.match(r.out, /stays stopped, as it was before the update/);
    const svc = await installed();
    await svc.addRelease({ version: "0.2.0" });
    svc.setScenario({ selftestFail: true, serviceRegistered: true });
    const m = svc.plur1busCalls().length;
    const r2 = await run(svc, ["--update", "--yes"]);
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.ok(mutatingPlur1bus(svc, m).includes("daemon start"));
    assert.match(r2.out, /started through its service/);
  });

  it("the other bound Hermes homes are named before the question and in the .pre-restore note (review 7)", async () => {
    const sb = await installed();
    const work = join(sb.hermesRoot, "profiles", "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "config.yaml"), "memory:\n  memory_enabled: true\n");
    assert.equal((await run(sb, ["--hermes-profile", "work"])).code, EXIT.OK);
    await sb.addRelease({ version: "0.2.0" });
    const stderr = sink();
    let seen = "";
    await run(sb, ["--update"], { isTTY: true, stderr, prompt: async () => ((seen = stderr.text), "s") });
    assert.match(seen, /also affects the other Hermes homes bound to .*hermes-work/);
    sb.setScenario({ selftestFail: true, setupMigratesStoreFrom: "0.2.0" });
    const r = await run(sb, ["--update", "--yes"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.match(r.out, /including what hermes-work .* captured meanwhile\) is kept at/);
  });
});
