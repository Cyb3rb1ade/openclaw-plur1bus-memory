// tests/dist-installer-uninstall.test.js — installer uninstall and purge (HM1 Task 6,
// spec A.3 step 7, D89). Only the sandbox's shims; nothing outside the sandbox is touched.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readState, writeState } from "../scripts/dist/installer/state.mjs";
import { createSnapshot, listSnapshots } from "../lib/snapshot/store-snapshot.js";
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
  const modelCache = join(sb.stateDir, "models", "plur1bus");
  mkdirSync(modelCache, { recursive: true });
  writeFileSync(join(modelCache, "model.onnx"), "TEST ONLY model");
  const vault = join(sb.stateDir, "vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "note.md"), "# TEST ONLY\n");
  writeState(sb.stateDir, { previousSlot, installedVersion: "7.16.11", source: "tarball" });
  return { sb, baseDbPath, snap, legacyTar, modelCache, vault };
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
    const { sb, baseDbPath, snap, legacyTar, modelCache, vault } = await installedSandbox();
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
    assert.equal(existsSync(modelCache), false);
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
  });
});
