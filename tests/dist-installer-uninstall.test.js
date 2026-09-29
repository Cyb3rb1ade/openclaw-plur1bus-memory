// tests/dist-installer-uninstall.test.js — installer uninstall and purge (HM1 Task 6,
// spec A.3 step 7, D89). Only the sandbox's shims; nothing outside the sandbox is touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readState, writeState } from "../scripts/dist/installer/state.mjs";
import { assertPurgeable } from "../scripts/dist/installer/uninstall.mjs";
import { createSnapshot, listSnapshots } from "../lib/snapshot/store-snapshot.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createInstallerSandbox, mutatingCalls, runSandboxInstaller } from "./helpers/installer-sandbox.js";

const ID = "memory-lancedb-namespaced";
const SLOT = "plugins.slots.memory";

const run = runSandboxInstaller;

const mutating = mutatingCalls;

/** Tracked install (installed from the feed tarball) with a store, a Node snapshot, a legacy tar and the model cache. */
async function installedSandbox({ previousSlot = null, config = { [SLOT]: ID } } = {}) {
  const sb = createInstallerSandbox({ scenario: { installed: true, config } });
  const baseDbPath = join(sb.home, ".openclaw", "memory", "lancedb-namespaced");
  mkdirSync(join(baseDbPath, "main"), { recursive: true });
  writeFileSync(join(baseDbPath, "main", "TEST-ONLY.lance"), "TEST ONLY rows\n");
  const snap = await createSnapshot({ stateDir: sb.stateDir, baseDbPath, label: "pre-test" });
  const legacyTar = join(sb.stateDir, "memory", ".snapshots", "plur1bus-20260101-000000.tar.gz");
  writeFileSync(legacyTar, "TEST ONLY legacy tar");
  // the plugin resolves its model cache as ${OPENCLAW_HOME}/models/plur1bus, whatever OPENCLAW_STATE_DIR says
  const modelCache = join(sb.home, "models", "plur1bus");
  mkdirSync(modelCache, { recursive: true });
  writeFileSync(join(modelCache, "model.onnx"), "TEST ONLY model");
  const stateModels = join(sb.stateDir, "models", "plur1bus");
  mkdirSync(stateModels, { recursive: true });
  writeFileSync(join(stateModels, "keep.txt"), "TEST ONLY not the plugin's cache");
  const vault = join(sb.stateDir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "note.md"), "# TEST ONLY\n");
  writeState(sb.stateDir, { previousSlot, installedVersion: "7.16.11", source: "tarball" });
  return { sb, baseDbPath, snap, legacyTar, modelCache, vault, stateModels };
}

describe("plugin installer: uninstall", () => {
  it("uninstall keeps the store and snapshots", async () => {
    const { sb, baseDbPath, snap, legacyTar, modelCache } = await installedSandbox();
    const r = await run(sb, ["--uninstall", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(mutating(sb.openclawCalls()), [["plugins", "uninstall", ID, "--force"]]);
    assert.equal(sb.shimState().installed, false);
    assert.ok(existsSync(join(baseDbPath, "main", "TEST-ONLY.lance")));
    assert.ok(existsSync(snap.dir));
    assert.ok(existsSync(legacyTar));
    assert.ok(existsSync(join(modelCache, "model.onnx")));
    assert.match(r.stderr, /kept/i);
    const st = readState(sb.stateDir);
    assert.ok(st === null || (st.installedVersion === null && st.inProgress === undefined), JSON.stringify(st));
    assert.equal(JSON.parse(r.stdout).mode, "uninstall");
  });

  it("purge without --yes-delete-memories is refused non-interactively", async () => {
    const { sb, baseDbPath, snap, legacyTar, modelCache, vault, stateModels } = await installedSandbox();
    const preRestore = `${baseDbPath}.pre-restore-20260101T000000Z`;
    mkdirSync(preRestore, { recursive: true });
    writeFileSync(join(preRestore, "old.lance"), "TEST ONLY");
    const r = await run(sb, ["--uninstall", "--purge"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.ok(r.stderr.includes(preRestore), "the purge lists the .pre-restore-* copies it deletes");
    assert.match(r.stderr, /--yes-delete-memories/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.ok(existsSync(baseDbPath));

    // interactive: the second confirmation declined → nothing changes
    const answers = ["delete", "no"];
    const asked = [];
    const r2 = await run(sb, ["--uninstall", "--purge"], { isTTY: true, prompt: async (q) => (asked.push(q), answers.shift()) });
    assert.equal(r2.code, EXIT.FAILED, r2.out);
    assert.equal(asked.length, 2);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.ok(existsSync(baseDbPath));

    // --yes-delete-memories: store, Node snapshots and model cache go; legacy tar and vault stay
    const r3 = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(r3.code, EXIT.OK, r3.out);
    assert.deepEqual(mutating(sb.openclawCalls()), [["plugins", "uninstall", ID, "--force"]]);
    assert.equal(existsSync(baseDbPath), false);
    assert.equal(existsSync(snap.dir), false);
    assert.deepEqual((await listSnapshots({ stateDir: sb.stateDir })).map((s) => s.kind), ["legacy-tar"]);
    assert.ok(existsSync(legacyTar));
    assert.equal(existsSync(modelCache), false, "purge deletes ${OPENCLAW_HOME}/models/plur1bus");
    assert.ok(existsSync(join(stateModels, "keep.txt")), "a models dir under OPENCLAW_STATE_DIR is not the plugin's cache and stays");
    assert.equal(existsSync(preRestore), false);
    assert.ok(existsSync(join(vault, "note.md")), "the vault is never purged");
    assert.deepEqual(readdirSync(join(sb.stateDir, "memory")).filter((n) => /\.tmp-/.test(n)), []);
  });

  it("an interrupted purge is continued only by --uninstall --purge with fresh confirmation (T6-d)", async () => {
    const { sb, baseDbPath, snap } = await installedSandbox();
    writeState(sb.stateDir, { previousSlot: null, installedVersion: "7.16.11", source: "tarball", inProgress: { op: "uninstall", step: "uninstall", purge: true, snapshotId: null, previousVersion: "7.16.11" } });
    for (const argv of [[], ["--update", "--yes"], ["--uninstall"], ["--adopt-legacy"]]) {
      const r = await run(sb, argv);
      assert.equal(r.code, EXIT.NEEDS_CHOICE, `${argv}: ${r.out}`);
      assert.match(r.stderr, /interrupted uninstall with purge at step uninstall/);
      assert.match(r.stderr, /--uninstall --purge/);
    }
    // the same mode still needs the confirmation again
    const r2 = await run(sb, ["--uninstall", "--purge"]);
    assert.equal(r2.code, EXIT.NEEDS_CHOICE, r2.out);
    assert.match(r2.stderr, /--yes-delete-memories/);
    assert.deepEqual(mutating(sb.openclawCalls()), []);
    assert.ok(existsSync(join(baseDbPath, "main", "TEST-ONLY.lance")), "store kept");
    assert.ok(existsSync(snap.dir), "snapshots kept");

    const r3 = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(r3.code, EXIT.OK, r3.out);
    assert.equal(existsSync(baseDbPath), false);
  });

  it("purge after two interactive confirmations", async () => {
    const { sb, baseDbPath } = await installedSandbox();
    const answers = ["delete", "yes"];
    const r = await run(sb, ["--uninstall", "--purge"], { isTTY: true, prompt: async () => answers.shift() });
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(existsSync(baseDbPath), false);
  });

  it("the previous memory slot is restored", async () => {
    const { sb } = await installedSandbox({ previousSlot: "memory-lancedb-stock" });
    const r = await run(sb, ["--uninstall"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.deepEqual(mutating(sb.openclawCalls()), [
      ["plugins", "uninstall", ID, "--force"],
      ["config", "set", SLOT, "memory-lancedb-stock"],
    ]);
    assert.equal(sb.shimState().config[SLOT], "memory-lancedb-stock");

    // memory-core was the previous slot → OpenClaw's own reset stands, no config write
    const { sb: sb2 } = await installedSandbox({ previousSlot: "memory-core" });
    const r2 = await run(sb2, ["--uninstall"]);
    assert.equal(r2.code, EXIT.OK, r2.out);
    assert.deepEqual(mutating(sb2.openclawCalls()), [["plugins", "uninstall", ID, "--force"]]);
    assert.equal(sb2.shimState().config[SLOT], "memory-core");
  });

  it("a failed uninstall exits 1 and deletes nothing", async () => {
    const { sb, baseDbPath } = await installedSandbox();
    sb.setScenario({ uninstallExit: 1 });
    const r = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.ok(existsSync(baseDbPath));
    assert.equal(readState(sb.stateDir).installedVersion, "7.16.11");
    // run 36518766808: the summary kept only OpenClaw's Debug/Try/Help hints
    assert.match(r.stderr, /uninstall: openclaw plugins uninstall .* failed \(exit 1\): \[openclaw\] Command failed \| \[openclaw\] Reason: TEST ONLY uninstall failure;/);
    assert.doesNotMatch(r.stderr, /OPENCLAW_DEBUG|Try: openclaw doctor/);
  });

  it("purge refuses a baseDbPath naming the state dir or the home in another case or through a symlink", async () => {
    const { sb, baseDbPath } = await installedSandbox();
    // realpaths first, so a macOS /var -> /private/var link does not hide the case fold
    const state = realpathSync(sb.stateDir);
    const home = realpathSync(sb.home);
    const flip = (p) => p.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    // win32 folds case: the state dir, the home and an ancestor in another case are refused
    for (const p of [flip(state), flip(home), flip(join(state, ".."))]) {
      assert.throws(() => assertPurgeable(p, { stateDir: state, home, platform: "win32" }), /unsafe-purge-path/, p);
    }
    // a store below the state dir in another case is fine on win32
    assert.doesNotThrow(() => assertPurgeable(flip(join(state, "memory", "lancedb-namespaced")), { stateDir: state, home, platform: "win32" }));
    assert.equal(assertPurgeable(baseDbPath, { stateDir: sb.stateDir, home: sb.home }), baseDbPath);
    if (process.platform === "win32") return; // symlinks need privileges there; the case fold above covers win32
    const links = join(sb.root, "links");
    mkdirSync(links, { recursive: true });
    symlinkSync(sb.stateDir, join(links, "state-link"));
    symlinkSync(sb.home, join(links, "home-link"));
    for (const p of [join(links, "state-link"), join(links, "home-link"), join(links, "home-link", ".")]) {
      assert.throws(() => assertPurgeable(p, { stateDir: sb.stateDir, home: sb.home, platform: process.platform }), /unsafe-purge-path/, p);
    }
    // end to end: the configured baseDbPath is a symlink to that sandbox's own state dir → exit 3, nothing changes
    const root2 = makeTempDir("plur1bus-installer-purge-link-");
    const link2 = join(root2, "state-link");
    const sb2 = createInstallerSandbox({ root: root2, scenario: { installed: true, config: { [SLOT]: ID, [`plugins.entries.${ID}.config.baseDbPath`]: link2 } } });
    symlinkSync(sb2.stateDir, link2);
    writeFileSync(join(sb2.stateDir, "TEST-ONLY-keep.txt"), "TEST ONLY");
    const r = await run(sb2, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(r.code, EXIT.INCOMPATIBLE, r.out);
    assert.match(r.stderr, /unsafe-purge-path/);
    assert.deepEqual(mutating(sb2.openclawCalls()), []);
    assert.ok(existsSync(join(sb2.stateDir, "TEST-ONLY-keep.txt")));
    assert.ok(existsSync(sb.stateDir) && existsSync(join(baseDbPath, "main", "TEST-ONLY.lance")));
  });
});
