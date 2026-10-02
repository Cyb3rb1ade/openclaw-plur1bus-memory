// tests/dist-hermes-uninstall.test.js — `install-plugin --host hermes --uninstall [--purge]` (HM2 Task 9): memory.provider
// back before the directory goes (HM2-R17a, R24/R24a), agent/store/sidecar kept, the journal kept and counted (F28), the
// purge guard (host profile, Hermes-only agents, no other bound home — F4) and its confirmations, and every kill point
// with resume and --rollback. Shims and temp homes only (hermes-sandbox.js).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT } from "../scripts/dist/installer/report.mjs";
import { readHermesState } from "../scripts/dist/installer/hermes/state.mjs";
import { createHermesSandbox, runHermesInstaller, TEMPLATE_CONFIG } from "./helpers/hermes-sandbox.js";
import { treeDigest, walkTree } from "./helpers/installer-sandbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "..", "scripts", "dist", "installer", "main.mjs");
const run = runHermesInstaller;
const POSIX_KILL = process.platform === "win32" && "POSIX kill of the installer process";
const strays = (sb) => [...walkTree(sb.home), ...walkTree(sb.root)].filter((p) => /plur1bus\.tmp-\d+$|\.plur1bus-prev-\d+$|\.plur1bus-removed-\d+$|\.tmp-\d+$/.test(p));
const registry = (sb) => JSON.parse(readFileSync(join(sb.plur1busHome, "hosts", "hermes-bindings.json"), "utf8")).bindings;
const HONCHO = TEMPLATE_CONFIG.replace("memory:\n", "memory:\n  provider: honcho\n");

function runChild(sb, argv, { killAt } = {}) {
  const code = `import { runInstaller } from ${JSON.stringify(MAIN)};\nprocess.exitCode = await runInstaller(process.argv.slice(1));\n`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", "--host", "hermes", "--feed-file", sb.feedFile, ...argv], {
    env: { ...sb.env, PLUR1BUS_PLUGIN_TEST_FREE_BYTES: String(64 * 1024 ** 3), ...(killAt ? { PLUR1BUS_PLUGIN_TEST_KILL_AT: killAt } : {}) },
    encoding: "utf8",
    timeout: 120_000,
  });
}

async function installed(opts = {}, argv = []) {
  const sb = createHermesSandbox(opts);
  const r = await run(sb, argv);
  assert.equal(r.code, EXIT.OK, r.out);
  mkdirSync(join(sb.plur1busHome, "state", "lancedb"), { recursive: true });
  writeFileSync(join(sb.plur1busHome, "state", "lancedb", "memories.lance"), "TEST ONLY store\n");
  mkdirSync(join(sb.hermesHome, "plur1bus"), { recursive: true });
  writeFileSync(join(sb.hermesHome, "plur1bus", "journal.ndjson"), '{"turn":"TEST ONLY 1"}\n{"turn":"TEST ONLY 2"}\n');
  return sb;
}

function assertKept(sb) {
  assert.equal(existsSync(join(sb.plur1busHome, "state", "lancedb", "memories.lance")), true, "the store is kept");
  assert.equal(existsSync(join(sb.plur1busHome, "manifest.json")), true, "the sidecar home is kept");
  assert.equal(existsSync(sb.sidecarBin), true, "the sidecar binary is kept");
  assert.ok(JSON.parse(readFileSync(join(sb.plur1busHome, "config.json"), "utf8")).agents["hermes-default"], "the agent is kept");
}

function assertUninstalled(sb) {
  assert.equal(existsSync(join(sb.hermesHome, "plugins", "plur1bus")), false, "no provider dir");
  assert.equal(existsSync(join(sb.hermesHome, "plur1bus.json")), false, "no binding");
  assert.equal(existsSync(join(sb.hermesHome, ".plur1bus-installer.json")), false, "no state");
  assert.deepEqual(strays(sb), []);
}

describe("hermes installer: uninstall", () => {
  it("uninstall restores the previous memory.provider and keeps the store and sidecar (Review Focus 5, F28)", async () => {
    const sb = await installed({ configYaml: HONCHO }, ["--replace-provider"]);
    const n = sb.log().length;
    const r = await run(sb, ["--uninstall", "--json"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(sb.provider(), "honcho");
    // R17a: the value was restored while the provider directory still existed
    const set = sb.log().slice(n).find((e) => e.bin === "hermes" && e.argv[1] === "set");
    assert.deepEqual(set.argv, ["config", "set", "memory.provider", "honcho"]);
    assert.equal(set.providerDir, true);
    assertUninstalled(sb);
    assert.deepEqual(registry(sb), {}, "this home's registry entry is gone");
    assertKept(sb);
    // the journal stays and is counted
    assert.equal(existsSync(join(sb.hermesHome, "plur1bus", "journal.ndjson")), true);
    assert.match(r.out, /journal\.ndjson is kept \(2 undelivered turn\(s\)\)/);
    assert.deepEqual(JSON.parse(r.stdout).journal, { path: join(sb.hermesHome, "plur1bus", "journal.ndjson"), entries: 2 });
    // again: nothing installed, nothing to do
    const again = await run(sb, ["--uninstall"]);
    assert.equal(again.code, EXIT.OK);
    assert.match(again.out, /not installed/);
  });

  it("uninstall goes back to the built-in store: config unset from 0.21.5, the line edit on 0.21.4 and unknown versions (HM2-R24a)", async () => {
    const a = await installed();
    const n = a.log().length;
    assert.equal((await run(a, ["--uninstall"])).code, EXIT.OK);
    assert.deepEqual(a.log().slice(n).filter((e) => e.bin === "hermes" && ["set", "unset"].includes(e.argv[1])).map((e) => e.argv), [["config", "unset", "memory.provider"]]);
    assert.equal(a.provider(), "");
    for (const hermesVersion of ["0.21.4", "vgit"]) {
      const b = await installed({ scenario: { hermesVersion }, configYaml: HONCHO }, ["--replace-provider"]);
      const m = b.log().length;
      const r = await run(b, ["--uninstall"]);
      assert.equal(r.code, EXIT.OK, r.out);
      assert.deepEqual(b.log().slice(m).filter((e) => e.bin === "hermes" && ["set", "unset"].includes(e.argv[1])), [], `${hermesVersion}: no config set/unset`);
      assert.match(readFileSync(join(b.hermesHome, "config.yaml"), "utf8"), /^ {2}provider: honcho$/m);
      assertUninstalled(b);
    }
  });

  it("an unreadable memory.provider stops the uninstall before any change (HM2-R17a)", async () => {
    const sb = await installed();
    const before = treeDigest(sb.hermesHome);
    sb.setScenario({ configGetExit: 1 });
    const r = await run(sb, ["--uninstall"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.match(r.out, /cannot be read/);
    assert.equal(treeDigest(sb.hermesHome), before);
  });

  it("purge refuses a home with non-hermes agents", async () => {
    const sb = await installed();
    const cfg = join(sb.plur1busHome, "config.json");
    const c = JSON.parse(readFileSync(cfg, "utf8"));
    c.agents.main = { createdAt: "2026-09-30T00:00:00Z" };
    writeFileSync(cfg, JSON.stringify(c, null, 2));
    const before = [treeDigest(sb.hermesHome), treeDigest(sb.plur1busHome)];
    const r = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /purge-refused: it serves agents that are not Hermes ones: main/);
    assert.deepEqual([treeDigest(sb.hermesHome), treeDigest(sb.plur1busHome)], before, "nothing changed");
  });

  it("purge refuses a full-profile home", async () => {
    const sb = await installed();
    const mf = join(sb.plur1busHome, "manifest.json");
    writeFileSync(mf, JSON.stringify({ ...JSON.parse(readFileSync(mf, "utf8")), profile: "full" }));
    const before = [treeDigest(sb.hermesHome), treeDigest(sb.plur1busHome)];
    const r = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /purge-refused: .*full PLUR1BUS harness/);
    assert.deepEqual([treeDigest(sb.hermesHome), treeDigest(sb.plur1busHome)], before);
  });

  it("purge refuses while another Hermes home is bound (F4)", async () => {
    const sb = await installed();
    const work = join(sb.hermesRoot, "profiles", "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "config.yaml"), TEMPLATE_CONFIG);
    assert.equal((await run(sb, ["--hermes-profile", "work"])).code, EXIT.OK);
    const before = treeDigest(sb.plur1busHome);
    const r = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /other Hermes homes are bound to it: hermes-work/);
    assert.equal(treeDigest(sb.plur1busHome), before);
  });

  it("purge without --yes-delete-memories is refused non-interactively", async () => {
    const sb = await installed();
    const before = [treeDigest(sb.hermesHome), treeDigest(sb.plur1busHome)];
    const r = await run(sb, ["--uninstall", "--purge"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /--yes-delete-memories/);
    assert.deepEqual([treeDigest(sb.hermesHome), treeDigest(sb.plur1busHome)], before);
    assert.equal((await run(sb, ["--uninstall", "--yes-delete-memories"])).code, EXIT.FAILED, "--yes-delete-memories needs --purge");
  });

  it("purge after two confirmations (or --yes-delete-memories) deletes the sidecar, its home and the journal", async () => {
    const sb = await installed();
    const asked = [];
    const answers = ["delete", "y"];
    const r = await run(sb, ["--uninstall", "--purge", "--json"], { isTTY: true, prompt: async (q) => (asked.push(q), answers.shift()) });
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(asked.length, 2);
    assertUninstalled(sb);
    assert.equal(existsSync(sb.plur1busHome), false, "the home with the store is gone");
    assert.equal(existsSync(sb.sidecarBin), false);
    assert.equal(existsSync(join(sb.hermesHome, "plur1bus")), false, "the journal is gone");
    assert.ok(sb.plur1busCalls().some((a) => a.slice(3).join(" ") === "service uninstall"));
    // a wrong first answer changes nothing
    const no = await installed();
    const before = treeDigest(no.plur1busHome);
    const r2 = await run(no, ["--uninstall", "--purge"], { isTTY: true, prompt: async () => "no" });
    assert.equal(r2.code, EXIT.FAILED);
    assert.equal(treeDigest(no.plur1busHome), before);
    // --yes-delete-memories
    const y = await installed();
    assert.equal((await run(y, ["--uninstall", "--purge", "--yes-delete-memories"])).code, EXIT.OK);
    assert.equal(existsSync(y.plur1busHome), false);
  });

  // F19 for the uninstall
  const KILL_POINTS = [
    // between the value change and restoredFrom (final review Minor 6): --rollback still re-activates plur1bus
    { point: "uninstall.provider-changed", step: "provider-value", undoable: true },
    { point: "uninstall.provider-value", step: "provider-value", undoable: true },
    { point: "uninstall.provider-moved", step: "provider", undoable: true },
    { point: "uninstall.binding", step: "binding", undoable: false },
    { point: "uninstall.purge", step: "purge", undoable: false, purge: true },
    { point: "uninstall.purge-stopped", step: "purge", undoable: false, purge: true },
  ];
  async function killedUninstall({ point, purge }) {
    const sb = await installed({ configYaml: HONCHO }, ["--replace-provider"]);
    const before = treeDigest(sb.hermesHome);
    const k = runChild(sb, ["--uninstall", ...(purge ? ["--purge", "--yes-delete-memories"] : [])], { killAt: point });
    assert.notEqual(k.status, 0, `${point}: not killed\n${k.stdout}${k.stderr}`);
    return { sb, before };
  }
  for (const kp of KILL_POINTS) {
    it(`uninstall killed at ${kp.point}: the next --uninstall finishes it`, { skip: POSIX_KILL }, async () => {
      const { sb } = await killedUninstall(kp);
      assert.equal(readHermesState(sb.hermesHome).inProgress.op, "uninstall");
      assert.equal(readHermesState(sb.hermesHome).inProgress.step, kp.step);
      // another mode does not continue it
      assert.equal((await run(sb, [])).code, EXIT.NEEDS_CHOICE);
      if (kp.purge) assert.equal((await run(sb, ["--uninstall"])).code, EXIT.NEEDS_CHOICE, "a purge is finished only by a purge");
      const r = await run(sb, ["--uninstall", ...(kp.purge ? ["--purge", "--yes-delete-memories"] : [])]);
      assert.equal(r.code, EXIT.OK, r.out);
      assert.equal(sb.provider(), "honcho");
      assertUninstalled(sb);
      if (kp.purge) assert.equal(existsSync(sb.plur1busHome), false);
      else assertKept(sb);
    });
    it(`uninstall killed at ${kp.point}: --rollback ${kp.undoable ? "restores the install" : "is refused past the point of no return"}`, { skip: POSIX_KILL }, async () => {
      const { sb, before } = await killedUninstall(kp);
      const r = await run(sb, ["--rollback", "--json"]);
      if (!kp.undoable) {
        assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
        assert.match(r.out, /past the point where it can be undone/);
        return;
      }
      assert.equal(r.code, EXIT.FAILED, r.out);
      assert.equal(JSON.parse(r.stdout).steps.find((x) => x.id === "rollback").status, "ok", r.out);
      assert.equal(sb.provider(), "plur1bus");
      assert.equal(treeDigest(sb.hermesHome), before, "the Hermes home is as it was installed");
      assert.deepEqual(Object.keys(registry(sb)), ["hermes-default"]);
      assert.deepEqual(strays(sb), []);
    });
  }
});

describe("hermes installer: uninstall (T9 review)", () => {
  it("on 0.21.4 the uninstall undoes the install's line edit exactly and leaves no backup (review 1, 8)", async () => {
    // the template without a memory.provider key: byte-identical afterwards
    const a = createHermesSandbox({ scenario: { hermesVersion: "0.21.4" } });
    const before = readFileSync(join(a.hermesHome, "config.yaml"), "utf8");
    assert.equal((await run(a, [])).code, EXIT.OK);
    const r = await run(a, ["--uninstall"]);
    assert.equal(r.code, EXIT.OK, r.out);
    assert.equal(readFileSync(join(a.hermesHome, "config.yaml"), "utf8"), before, "byte for byte");
    assert.deepEqual(readdirSync(a.hermesHome).filter((n) => n.includes("plur1bus-bak")), [], "no backup is left");
    // no config.yaml before the install: none after the uninstall
    const b = createHermesSandbox({ scenario: { hermesVersion: "0.21.4" }, configYaml: null });
    assert.equal((await run(b, [])).code, EXIT.OK);
    assert.equal(existsSync(join(b.hermesHome, "config.yaml")), true);
    assert.equal((await run(b, ["--uninstall"])).code, EXIT.OK);
    assert.equal(existsSync(join(b.hermesHome, "config.yaml")), false);
    // an original quoted value with a comment comes back as it was
    const quoted = TEMPLATE_CONFIG.replace("memory:\n", "memory:\n  provider: \"none\" # keep\n");
    const c = createHermesSandbox({ scenario: { hermesVersion: "0.21.4" }, configYaml: quoted });
    assert.equal((await run(c, ["--replace-provider"])).code, EXIT.OK);
    assert.equal((await run(c, ["--uninstall"])).code, EXIT.OK);
    assert.equal(readFileSync(join(c.hermesHome, "config.yaml"), "utf8"), quoted);
    // without a recorded undo: the raw previous value, and it says so
    const d = createHermesSandbox({ scenario: { hermesVersion: "0.21.4" } });
    assert.equal((await run(d, [])).code, EXIT.OK);
    const sf = join(d.hermesHome, ".plur1bus-installer.json");
    const st = JSON.parse(readFileSync(sf, "utf8"));
    delete st.configEdit.undo;
    writeFileSync(sf, JSON.stringify(st));
    const rd = await run(d, ["--uninstall"]);
    assert.equal(rd.code, EXIT.OK, rd.out);
    assert.match(rd.out, /recorded no undo/);
    assert.match(readFileSync(join(d.hermesHome, "config.yaml"), "utf8"), /^ {2}provider: ""$/m);
    assert.deepEqual(readdirSync(d.hermesHome).filter((n) => n.includes("plur1bus-bak")), []);
  });

  it("a plugins/plur1bus the installer does not own is refused; a plur1bus provider MANIFEST counts as ours (review 9)", async () => {
    const sb = createHermesSandbox();
    mkdirSync(join(sb.hermesHome, "plugins", "plur1bus"), { recursive: true });
    writeFileSync(join(sb.hermesHome, "plugins", "plur1bus", "__init__.py"), "# TEST ONLY: someone else's\n");
    const before = treeDigest(sb.hermesHome);
    const r = await run(sb, ["--uninstall"]);
    assert.equal(r.code, EXIT.NEEDS_CHOICE, r.out);
    assert.match(r.out, /was not installed by this installer/);
    assert.equal(treeDigest(sb.hermesHome), before);
    // an installed provider whose state and binding are gone is still recognised by its MANIFEST.json
    const m = await installed();
    for (const f of [".plur1bus-installer.json", "plur1bus.json"]) rmSync(join(m.hermesHome, f));
    const r2 = await run(m, ["--uninstall"]);
    assert.equal(r2.code, EXIT.OK, r2.out);
    assert.equal(existsSync(join(m.hermesHome, "plugins", "plur1bus")), false);
  });

  it("purge stops the sidecar before the lock and keeps the home when the stop fails (review 2)", async () => {
    const sb = await installed();
    sb.setScenario({ daemonStopExit: 1 });
    const r = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories", "--json"]);
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.equal(existsSync(join(sb.plur1busHome, "manifest.json")), true, "the home is kept");
    const doc = JSON.parse(r.stdout);
    assert.ok(doc.manualSteps.some((m) => /daemon stop/.test(m)));
    assert.ok(!doc.manualSteps.some((m) => /^remove .*\.plur1bus/.test(m)), "never asks to delete the home");
    // the stop and the service removal come before the lock is taken (no lock file is held across them)
    const ok = await installed();
    const calls = [];
    const runSpy = (file, args, o) => {
      if (/plur1bus/.test(file)) calls.push({ args: args.slice(3).join(" "), lock: existsSync(join(ok.plur1busHome, "hosts", ".hermes-bindings.lock")) });
      return ok.run(file, args, o);
    };
    assert.equal((await run(ok, ["--uninstall", "--purge", "--yes-delete-memories"], { run: runSpy })).code, EXIT.OK);
    for (const c of calls.filter((x) => /^(daemon stop|service uninstall)/.test(x.args))) assert.equal(c.lock, false, c.args);
  });
});

describe("hermes installer: uninstall (T9 re-review)", () => {
  it("a failed home deletion is a failed purge: manual step, state stays at purge, the next run finishes it", async () => {
    const sb = await installed();
    const r = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories", "--json"], { env: { ...sb.env, PLUR1BUS_PLUGIN_TEST_FAIL_AT: "purge.rm" } });
    assert.equal(r.code, EXIT.FAILED, r.out);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.steps.find((x) => x.id === "purge").status, "failed");
    assert.ok(doc.manualSteps.some((m) => m.startsWith(`remove ${sb.plur1busHome} (EBUSY`)), JSON.stringify(doc.manualSteps));
    const st = readHermesState(sb.hermesHome);
    assert.equal(st.inProgress.step, "purge");
    assert.equal(st.uninstall.homeRemoveStarted, true);
    // the next run finishes the deletion it had decided under the lock
    const again = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(again.code, EXIT.OK, again.out);
    assert.equal(existsSync(sb.plur1busHome), false);
    assert.equal(existsSync(sb.sidecarBin), false);
    assertUninstalled(sb);
  });
});

describe("hermes installer: uninstall (T10 review 2)", () => {
  it("a resumed purge of an intact home re-checks the shared-home guard and refuses once another home is bound", async () => {
    const sb = await installed();
    const r = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"], { env: { ...sb.env, PLUR1BUS_PLUGIN_TEST_FAIL_AT: "purge.rm" } });
    assert.equal(r.code, EXIT.FAILED, r.out);
    assert.equal(readHermesState(sb.hermesHome).uninstall.homeRemoveStarted, true);
    // another profile binds to the still intact home before the re-run
    const work = join(sb.hermesRoot, "profiles", "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "config.yaml"), TEMPLATE_CONFIG);
    assert.equal((await run(sb, ["--hermes-profile", "work"])).code, EXIT.OK);
    const again = await run(sb, ["--uninstall", "--purge", "--yes-delete-memories"]);
    assert.equal(again.code, EXIT.NEEDS_CHOICE, again.out);
    assert.match(again.out, /other Hermes homes are bound to it: hermes-work/);
    assert.equal(existsSync(join(sb.plur1busHome, "manifest.json")), true, "the shared home is kept");
  });
});
