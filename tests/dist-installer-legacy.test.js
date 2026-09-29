// tests/dist-installer-legacy.test.js — adoption of a legacy rsync deploy (HM1 Task 6,
// ruling HM1-R9, Review Focus 1). Only the sandbox's openclaw/node/crontab shims; the
// crontab is only ever listed through the shim, never edited.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { detectLegacyDeploy } from "../scripts/dist/installer/legacy.mjs";
import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readState } from "../scripts/dist/installer/state.mjs";
import { listSnapshots } from "../lib/snapshot/store-snapshot.js";
import { createInstallerSandbox, makeTestFeed, mutatingCalls, runSandboxInstaller, treeDigest, walkTree } from "./helpers/installer-sandbox.js";

const ID = "memory-lancedb-namespaced";
const SLOT = "plugins.slots.memory";
const PKG = "@cyb3rb1ade/plur1bus-memory";
const CRON_MARKER = "TEST-ONLY-CRON-MARKER-7f3a";
const posixOnly = { skip: process.platform === "win32" && "crontab is POSIX-only" };

const run = runSandboxInstaller;

const mutating = mutatingCalls;

const walk = walkTree;

/** The owner's VPS shape: rsync deploy, release copy, stock plugin, a store; untracked by OpenClaw. */
function legacySandbox(scenario = {}, { feed } = {}) {
  const sb = createInstallerSandbox({ ...(feed ? { feed } : {}), scenario: { legacy: true, config: { [SLOT]: ID }, ...scenario } });
  const legacyDir = join(sb.stateDir, "extensions", ID);
  mkdirSync(join(legacyDir, "lib"), { recursive: true });
  writeFileSync(join(legacyDir, "index.js"), "// TEST ONLY legacy deploy\n");
  writeFileSync(join(legacyDir, "lib", "x.js"), "export const x = 1;\n");
  const stock = join(sb.stateDir, "extensions", "memory-lancedb-stock");
  mkdirSync(stock, { recursive: true });
  writeFileSync(join(stock, "index.js"), "// TEST ONLY stock\n");
  const release = join(sb.stateDir, "plur1bus-release");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "index.js"), "// TEST ONLY release copy\n");
  const baseDbPath = join(sb.home, ".openclaw", "memory", "lancedb-namespaced");
  mkdirSync(join(baseDbPath, "main"), { recursive: true });
  writeFileSync(join(baseDbPath, "main", "TEST-ONLY.lance"), "TEST ONLY rows\n");
  sb.setScenario({ mutateStore: baseDbPath });
  return { sb, legacyDir, stock, release, baseDbPath };
}

const backups = (sb) => readdirSync(join(sb.stateDir, "extensions")).filter((n) => n.startsWith(".plur1bus-legacy-"));

describe("plugin installer: legacy adoption", () => {
  it("legacy deploy with the protect guard refuses adoption and changes nothing", async (t) => {
    // (a) the guard script under <state>/scripts/
    const a = legacySandbox();
    mkdirSync(join(a.sb.stateDir, "scripts"), { recursive: true });
    writeFileSync(join(a.sb.stateDir, "scripts", "protect-plur1bus-deploy.sh"), "#!/bin/sh\n# TEST ONLY guard\n");
    const before = treeDigest(a.sb.stateDir);
    const r = await run(a.sb, ["--adopt-legacy", "--json"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.match(r.out, /legacy-deploy-guard/);
    assert.match(r.stderr, /crontab -e/);
    assert.match(r.stderr, /--adopt-legacy/);
    assert.ok(!a.sb.openclawCalls().some((c) => c[1] === "install"), JSON.stringify(a.sb.openclawCalls()));
    assert.deepEqual(mutating(a.sb.openclawCalls()), []);
    assert.equal(treeDigest(a.sb.stateDir), before, "nothing under the state dir changed (legacy dir, no snapshot, no state file)");
    assert.equal(readState(a.sb.stateDir), null);
    assert.equal(JSON.parse(r.stdout).guard?.source, "file");

    // (b) only a crontab line
    if (process.platform === "win32") return t.skip("crontab is POSIX-only");
    const b = legacySandbox();
    b.sb.setCrontab(`# m h dom mon dow command\n*/15 * * * * /home/sandbox/.openclaw/scripts/protect-plur1bus-deploy.sh --quiet ${CRON_MARKER}\n`);
    const before2 = treeDigest(b.sb.stateDir);
    const r2 = await run(b.sb, ["--adopt-legacy", "--json"]);
    assert.equal(r2.code, EXIT.INCOMPATIBLE, r2.out);
    assert.match(r2.out, /legacy-deploy-guard/);
    assert.equal(JSON.parse(r2.stdout).guard?.source, "crontab");
    assert.ok(!b.sb.openclawCalls().some((c) => c[1] === "install"));
    assert.equal(treeDigest(b.sb.stateDir), before2);
    assert.deepEqual(b.sb.log().filter((e) => e.bin === "crontab").map((e) => e.argv), [["-l"]], "the crontab is only listed, never edited");
  });

  it("detectLegacyDeploy follows HM1-R9", () => {
    const st = "/s";
    const dir = "/s/extensions/memory-lancedb-namespaced";
    const guard = "/s/scripts/protect-plur1bus-deploy.sh";
    const untrackedJson = { plugin: { rootDir: dir } };
    const tracked = { plugin: { rootDir: dir }, install: { version: "7.16.11" } };
    assert.deepEqual(detectLegacyDeploy({ stateDir: st, inspectJson: untrackedJson, exists: (p) => p === dir, crontab: null }), { untracked: true, guard: false });
    assert.deepEqual(detectLegacyDeploy({ stateDir: st, inspectJson: tracked, exists: (p) => p === dir, crontab: null }), { untracked: false, guard: false });
    assert.deepEqual(detectLegacyDeploy({ stateDir: st, inspectJson: null, exists: () => false, crontab: null }), { untracked: false, guard: false });
    assert.deepEqual(detectLegacyDeploy({ stateDir: st, inspectJson: null, exists: (p) => p === dir || p === guard, crontab: "" }), { untracked: true, guard: true, guardSource: "file" });
    assert.deepEqual(detectLegacyDeploy({ stateDir: st, inspectJson: untrackedJson, exists: (p) => p === dir, crontab: "*/15 * * * * protect-plur1bus-deploy.sh\n" }), { untracked: true, guard: true, guardSource: "crontab" });
    assert.deepEqual(detectLegacyDeploy({ stateDir: st, inspectJson: untrackedJson, exists: (p) => p === dir, crontab: "# protect-plur1bus-deploy disabled\n" }), { untracked: true, guard: false }, "a commented-out line is not a guard");
  });

  it("adoption keeps the legacy dir and the store and rolls back on a failed verify", async () => {
    // success: legacy dir kept (renamed), tracked install, slot and conversation access set
    const ok = legacySandbox();
    const legacyBefore = treeDigest(ok.legacyDir);
    const r = await run(ok.sb, ["--adopt-legacy", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(existsSync(ok.legacyDir), false);
    const kept = backups(ok.sb);
    assert.equal(kept.length, 1);
    assert.equal(treeDigest(join(ok.sb.stateDir, "extensions", kept[0])), legacyBefore);
    const m = mutating(ok.sb.openclawCalls());
    assert.deepEqual(m[0], ["plugins", "install", `clawhub:${PKG}@7.16.11`, "--force", "--accept-capabilities"]);
    assert.ok(m.some((c) => c.join(" ") === `config set plugins.entries.${ID}.hooks.allowConversationAccess true`));
    assert.ok(m.some((c) => c.join(" ") === `config set ${SLOT} ${ID}`));
    assert.ok(!m.some((c) => /embedding|modelPreparation/.test(c[2] ?? "")), "adoption never changes the embedding choice");
    assert.equal((await listSnapshots({ stateDir: ok.sb.stateDir })).filter((s) => s.kind === "snapshot").length, 1);
    const st = readState(ok.sb.stateDir);
    assert.equal(st.installedVersion, "7.16.11");
    assert.equal(st.inProgress, undefined);
    assert.equal(st.previousSlot, null, "the legacy deploy's own slot is not a slot to restore on uninstall");
    assert.equal(JSON.parse(r.stdout).mode, "adopt-legacy");

    // failure: the legacy dir is renamed back, the store restored
    const bad = legacySandbox({ failVersions: ["7.16.11"] });
    const legacy2 = treeDigest(bad.legacyDir);
    const store2 = treeDigest(bad.baseDbPath);
    const r2 = await run(bad.sb, ["--adopt-legacy", "--json"]);
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.ok(existsSync(bad.legacyDir));
    assert.equal(treeDigest(bad.legacyDir), legacy2);
    assert.deepEqual(backups(bad.sb), []);
    assert.equal(treeDigest(bad.baseDbPath), store2, "store digest equal");
    // HM1-R-F2: nothing wrote into the store, so it was compared, found untouched and not restored
    assert.equal(JSON.parse(r2.stdout).steps.find((s) => s.id === "restore")?.status, "skipped");
    assert.deepEqual(walk(bad.sb.home).filter((p) => p.includes(".pre-restore-")), []);
    const calls = mutating(bad.sb.openclawCalls()).map((c) => c.join(" "));
    assert.ok(calls.includes(`plugins uninstall ${ID} --force`), JSON.stringify(calls));
    assert.equal(bad.sb.shimState().installed, false);
    assert.equal(bad.sb.shimState().config[SLOT], ID, "the legacy deploy is selected again");
    assert.equal(readState(bad.sb.stateDir)?.inProgress, undefined);
    assert.equal(JSON.parse(r2.stdout).steps.find((s) => s.id === "rollback")?.status, "ok");
  });

  it("a failed adoption restores a store the new version wrote into and keeps the replaced store (HM1-R-F2)", async () => {
    const { sb, legacyDir, baseDbPath } = legacySandbox({ failVersions: ["7.17.0"] }, { feed: makeTestFeed({ version: "7.17.0" }) });
    const store = treeDigest(baseDbPath);
    const legacy = treeDigest(legacyDir);
    const r = await run(sb, ["--adopt-legacy", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    const doc = JSON.parse(r.stdout);
    assert.match(doc.steps.find((s) => s.id === "restore.compare")?.detail ?? "", /written-by-7\.17\.0\.txt is new since the snapshot/);
    assert.equal(doc.steps.find((s) => s.id === "restore")?.status, "ok");
    assert.equal(doc.steps.find((s) => s.id === "rollback")?.status, "ok");
    assert.equal(treeDigest(baseDbPath), store);
    assert.equal(treeDigest(legacyDir), legacy);
    const pre = readdirSync(dirname(baseDbPath)).filter((n) => n.startsWith("lancedb-namespaced.pre-restore-")).map((n) => join(dirname(baseDbPath), n));
    assert.equal(pre.length, 1, "the replaced store is kept at .pre-restore-*");
    assert.ok(existsSync(join(pre[0], "written-by-7.17.0.txt")));
    assert.equal(doc.preRestorePath, pre[0]);
  });

  it("an adoption whose install fails with nothing installed puts the legacy dir back without restoring the store", async () => {
    const { sb, legacyDir, baseDbPath } = legacySandbox({ installExitVersions: ["7.16.11"] });
    const legacy = treeDigest(legacyDir);
    // the Gateway keeps writing through the legacy plugin while the adoption runs
    writeFileSync(join(baseDbPath, "main", "live-write.lance"), "TEST ONLY live\n");
    const r = await run(sb, ["--adopt-legacy", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.equal(treeDigest(legacyDir), legacy);
    assert.deepEqual(backups(sb), []);
    assert.ok(existsSync(join(baseDbPath, "main", "live-write.lance")));
    assert.ok(!sb.openclawCalls().some((c) => c[1] === "uninstall"));
    assert.equal(JSON.parse(r.stdout).steps.find((s) => s.id === "restore"), undefined);
    assert.equal(readState(sb.stateDir)?.inProgress, undefined);
  });

  it("a legacy backup name that already exists gets a unique suffix", async () => {
    const { sb, legacyDir } = legacySandbox();
    const legacy = treeDigest(legacyDir);
    const fixed = Date.UTC(2026, 8, 29, 1, 2, 3);
    const taken = join(sb.stateDir, "extensions", ".plur1bus-legacy-20260929T010203Z");
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "keep.txt"), "TEST ONLY earlier backup\n");
    const r = await run(sb, ["--adopt-legacy"], { now: () => fixed });
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(backups(sb).sort(), [".plur1bus-legacy-20260929T010203Z", ".plur1bus-legacy-20260929T010203Z-2"]);
    assert.deepEqual(readdirSync(taken), ["keep.txt"]);
    assert.equal(treeDigest(join(sb.stateDir, "extensions", ".plur1bus-legacy-20260929T010203Z-2")), legacy);
  });

  it("adoption leaves memory-lancedb-stock and plur1bus-release untouched", async () => {
    const { sb, stock, release } = legacySandbox();
    const s = treeDigest(stock);
    const rel = treeDigest(release);
    const r = await run(sb, ["--adopt-legacy"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(treeDigest(stock), s);
    assert.equal(treeDigest(release), rel);
  });

  it("the crontab line is matched but never printed", posixOnly, async () => {
    const { sb } = legacySandbox();
    const line = `*/15 * * * * /home/sandbox/.openclaw/scripts/protect-plur1bus-deploy.sh ${CRON_MARKER}`;
    sb.setCrontab(`${line}\n`);
    for (const argv of [["--adopt-legacy"], ["--adopt-legacy", "--json"]]) {
      const r = await run(sb, argv);
      assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
      assert.match(r.out, /crontab/);
      assert.ok(!r.out.includes(CRON_MARKER), "the matched line is never printed");
      assert.ok(!r.out.includes("--quiet") && !r.out.includes("*/15"), r.out);
    }
  });

  it("--adopt-legacy without a legacy deploy changes nothing", async () => {
    const sb = createInstallerSandbox();
    const r = await run(sb, ["--adopt-legacy"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.match(r.stderr, /no legacy deploy/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
  });
});
