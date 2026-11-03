/**
 * tests/snapshot-store.test.js
 *
 * HM1 Task 3: the Node port of the store snapshot step (spec A.3 step 6,
 * ruling HM1-R8). Every test builds its own state dir and LanceDB store in a
 * temp dir; no test reads a real OpenClaw state dir or home.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  MAX_SNAPSHOTS,
  SNAPSHOT_SCHEMA,
  SnapshotError,
  compareStoreWithSnapshot,
  createSnapshot,
  listSnapshots,
  pruneSnapshots,
  purgePreRestore,
  restoreSnapshot,
  verifySnapshot,
} from "../lib/snapshot/store-snapshot.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "scripts", "snapshot-store.mjs");
/** Hard bound for one CLI child (a run takes well under 2 s; the headroom covers a slow Windows runner). */
const CLI_TIMEOUT_MS = 60_000;
const SECRET_MARKER = "sk-TEST-ONLY-must-never-be-copied";

/** Build a state dir with a two-agent store plus the memory side files. */
async function makeState(root = makeTempDir("plur1bus-snap-")) {
  const stateDir = join(root, ".openclaw");
  const baseDbPath = join(stateDir, "memory", "lancedb-namespaced");
  mkdirSync(baseDbPath, { recursive: true });
  for (const agent of ["main", "work"]) {
    const db = await lancedb.connect(join(baseDbPath, agent));
    const table = await db.createTable("memories", [
      { id: `${agent}-1`, text: "one", vector: [1, 0] },
      { id: `${agent}-2`, text: "two", vector: [0, 1] },
    ]);
    await table.add([{ id: `${agent}-3`, text: "three", vector: [1, 1] }]);
    await table.delete(`id = '${agent}-1'`);
  }
  writeFileSync(join(baseDbPath, "registry.json"), "{\"agents\":[\"main\",\"work\"]}\n");
  mkdirSync(join(stateDir, "memory", "_archive"), { recursive: true });
  writeFileSync(join(stateDir, "memory", "_archive", "old.jsonl"), "{\"id\":\"x\"}\n");
  // the engine writes both files in the workspace, not under memory/ (lib/metrics.js, lib/jobs/memory-compaction.js)
  mkdirSync(join(stateDir, "workspace", ".adaptive-learning"), { recursive: true });
  writeFileSync(join(stateDir, "workspace", "run-state.json"), "{\"lastRun\":1}\n");
  writeFileSync(join(stateDir, "workspace", ".adaptive-learning", "merge-proposals.jsonl"), "{\"p\":1}\n");
  mkdirSync(join(stateDir, "vault", "Notes"), { recursive: true });
  writeFileSync(join(stateDir, "vault", "Notes", "a.md"), "# vault note\n");
  writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify({ apiKey: SECRET_MARKER }));
  mkdirSync(join(stateDir, "credentials"), { recursive: true });
  writeFileSync(join(stateDir, "credentials", "token"), SECRET_MARKER);
  return { root, stateDir, baseDbPath };
}

async function rowsOf(baseDbPath, agent) {
  const db = await lancedb.connect(join(baseDbPath, agent));
  const table = await db.openTable("memories");
  const rows = await table.query().select(["id"]).toArray();
  return { count: await table.countRows(), ids: rows.map((r) => r.id).sort() };
}

function walkFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base));
    else out.push(p.slice(base.length + 1).split(sep).join("/"));
  }
  return out.sort();
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const snapshotsDir = (stateDir) => join(stateDir, "memory", ".snapshots");

/** fsImpl wrapper that makes the first `failures` table copies hit a vanished data file. */
function compactingFs(stalePath, failures) {
  let remaining = failures;
  let calls = 0;
  return {
    fsImpl: {
      ...nodeFs,
      async copyFile(src, dst, mode) {
        if (src === stalePath && remaining > 0) {
          calls += 1;
          remaining -= 1;
          await nodeFs.unlink(stalePath); // a compaction removed it mid-copy
          try {
            return await nodeFs.copyFile(src, dst, mode);
          } finally {
            if (remaining > 0) writeFileSync(stalePath, "stale fragment"); // the writer keeps churning
          }
        }
        return nodeFs.copyFile(src, dst, mode);
      },
    },
    calls: () => calls,
  };
}

describe("store snapshot (HM1-R8)", () => {
  it("snapshot contains the store and memory files and a manifest whose hashes match", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "pre-update", pluginVersion: "7.17.0", now: () => Date.UTC(2026, 8, 28, 10, 11, 12) });
    assert.equal(snap.id, "plur1bus-20260928T101112Z-pre-update");
    assert.equal(snap.dir, join(snapshotsDir(stateDir), snap.id));
    const manifest = JSON.parse(readFileSync(join(snap.dir, "snapshot.json"), "utf8"));
    assert.equal(manifest.schema, SNAPSHOT_SCHEMA);
    assert.equal(manifest.label, "pre-update");
    assert.equal(manifest.pluginVersion, "7.17.0");
    assert.equal(manifest.createdAt, "2026-09-28T10:11:12.000Z");
    const listed = manifest.files.map((f) => f.path).sort();
    const onDisk = walkFiles(snap.dir).filter((p) => p !== "snapshot.json");
    assert.deepEqual(listed, onDisk);
    for (const f of manifest.files) {
      assert.equal(f.sha256, sha256(join(snap.dir, ...f.path.split("/"))), f.path);
    }
    for (const want of ["store/registry.json", "memory/_archive/old.jsonl", "workspace/run-state.json", "workspace/.adaptive-learning/merge-proposals.jsonl"]) {
      assert.ok(listed.includes(want), want);
    }
    for (const agent of ["main", "work"]) {
      assert.ok(listed.some((p) => p.startsWith(`store/${agent}/memories.lance/_versions/`)));
      assert.ok(listed.some((p) => p.startsWith(`store/${agent}/memories.lance/data/`)));
    }
    assert.equal(snap.files, manifest.files.length);
    assert.equal(snap.bytes, manifest.files.reduce((n, f) => n + f.bytes, 0));
    await verifySnapshot({ dir: snap.dir });
    const copied = await rowsOf(join(snap.dir, "store"), "main");
    assert.deepEqual(copied, await rowsOf(baseDbPath, "main"));
  });

  it("never copies the vault or openclaw.json", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    const files = walkFiles(snap.dir);
    assert.ok(!files.some((p) => /(^|\/)vault(\/|$)|openclaw\.json|credentials/.test(p)), files.join("\n"));
    for (const p of files) {
      assert.ok(!readFileSync(join(snap.dir, ...p.split("/"))).includes(SECRET_MARKER), p);
    }
  });

  it("keeps at most five Node snapshots and never prunes legacy tar.gz", async () => {
    const { stateDir, baseDbPath } = await makeState();
    mkdirSync(snapshotsDir(stateDir), { recursive: true });
    const legacy = join(snapshotsDir(stateDir), "lancedb-20260101-000000.tar.gz");
    writeFileSync(legacy, "legacy tar");
    assert.equal(MAX_SNAPSHOTS, 5);
    const ids = [];
    const results = [];
    for (let i = 0; i < 7; i++) {
      const r = await createSnapshot({ stateDir, baseDbPath, label: "n", now: () => Date.UTC(2026, 8, 28, 10, 0, i) });
      results.push(r);
      ids.push(r.id);
    }
    assert.deepEqual(results[4].pruned, []);
    assert.deepEqual(results[5].pruned, [ids[0]]);
    assert.deepEqual(results[6].pruned, [ids[1]]);
    assert.deepEqual(results[6].warnings, []);
    const list = await listSnapshots({ stateDir });
    const node = list.filter((s) => s.kind === "snapshot").map((s) => s.id).sort();
    assert.deepEqual(node, ids.slice(2).sort());
    const tars = list.filter((s) => s.kind === "legacy-tar");
    assert.equal(tars.length, 1);
    assert.equal(tars[0].id, "lancedb-20260101-000000.tar.gz");
    assert.ok(existsSync(legacy));
    const removed = await pruneSnapshots({ stateDir, maxKeep: 1 });
    assert.deepEqual(removed.sort(), ids.slice(2, 6).sort());
    assert.ok(existsSync(legacy));
    assert.deepEqual((await listSnapshots({ stateDir })).map((s) => s.id).sort(), [ids[6], "lancedb-20260101-000000.tar.gz"].sort());
  });

  it("restore brings back the exact rows after the store was changed", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const before = { main: await rowsOf(baseDbPath, "main"), work: await rowsOf(baseDbPath, "work") };
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "pre-update" });
    const table = await (await lancedb.connect(join(baseDbPath, "main"))).openTable("memories");
    await table.add([{ id: "main-9", text: "new", vector: [2, 2] }]);
    await table.delete("id = 'main-2'");
    assert.notDeepEqual(await rowsOf(baseDbPath, "main"), before.main);
    const result = await restoreSnapshot({ stateDir, baseDbPath, id: snap.id });
    assert.deepEqual(await rowsOf(baseDbPath, "main"), before.main);
    assert.deepEqual(await rowsOf(baseDbPath, "work"), before.work);
    assert.ok(result.preRestorePath.startsWith(`${baseDbPath}.pre-restore-`));
    assert.ok(existsSync(result.preRestorePath), "pre-restore copy is kept for the caller");
    const parent = readdirSync(dirname(baseDbPath));
    assert.ok(!parent.some((n) => n.includes(".restore-")), parent.join(","));
  });

  it("restore of a tampered snapshot fails with digest-mismatch and leaves the store untouched", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    const table = await (await lancedb.connect(join(baseDbPath, "main"))).openTable("memories");
    await table.add([{ id: "main-9", text: "new", vector: [2, 2] }]);
    const current = await rowsOf(baseDbPath, "main");
    const storeFiles = walkFiles(baseDbPath).map((p) => [p, sha256(join(baseDbPath, p))]);
    writeFileSync(join(snap.dir, "store", "registry.json"), "{\"tampered\":true}\n");
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath, id: snap.id }), (e) => e instanceof SnapshotError && e.reason === "digest-mismatch");
    assert.deepEqual(await rowsOf(baseDbPath, "main"), current);
    assert.deepEqual(walkFiles(baseDbPath).map((p) => [p, sha256(join(baseDbPath, p))]), storeFiles);
    assert.deepEqual(readdirSync(dirname(baseDbPath)).filter((n) => n.startsWith("lancedb-namespaced.")), []);
    // An added file is tampering too.
    writeFileSync(join(snap.dir, "store", "registry.json"), readFileSync(join(baseDbPath, "registry.json")));
    await verifySnapshot({ dir: snap.dir });
    writeFileSync(join(snap.dir, "store", "planted.json"), "{}");
    await assert.rejects(verifySnapshot({ dir: snap.dir }), (e) => e instanceof SnapshotError && e.reason === "digest-mismatch");
  });

  it("a table compacted during the copy is retried and then refused as source-busy", async () => {
    // One vanished file: the table copy restarts once and succeeds.
    {
      const { stateDir, baseDbPath } = await makeState();
      const stale = join(baseDbPath, "main", "memories.lance", "data", "stale-fragment.lance");
      writeFileSync(stale, "stale fragment");
      const fake = compactingFs(stale, 1);
      const snap = await createSnapshot({ stateDir, baseDbPath, label: "busy1", fsImpl: fake.fsImpl });
      assert.equal(fake.calls(), 1);
      await verifySnapshot({ dir: snap.dir });
      assert.deepEqual(await rowsOf(join(snap.dir, "store"), "main"), await rowsOf(baseDbPath, "main"));
      assert.ok(!existsSync(join(snap.dir, "store", "main", "memories.lance", "data", "stale-fragment.lance")));
    }
    // Three vanished files in a row: source-busy, nothing left behind.
    {
      const { stateDir, baseDbPath } = await makeState();
      const stale = join(baseDbPath, "main", "memories.lance", "data", "stale-fragment.lance");
      writeFileSync(stale, "stale fragment");
      const fake = compactingFs(stale, 3);
      await assert.rejects(createSnapshot({ stateDir, baseDbPath, label: "busy3", fsImpl: fake.fsImpl }), (e) => e instanceof SnapshotError && e.reason === "source-busy");
      assert.equal(fake.calls(), 3);
      assert.deepEqual(existsSync(snapshotsDir(stateDir)) ? readdirSync(snapshotsDir(stateDir)) : [], []);
    }
    // A new version committed mid-copy changes the newest manifest: restart, then consistent.
    {
      const { stateDir, baseDbPath } = await makeState();
      let wrote = false;
      const fsImpl = {
        ...nodeFs,
        async copyFile(src, dst, mode) {
          if (!wrote && src.includes(`${sep}main${sep}memories.lance${sep}data${sep}`)) {
            wrote = true;
            const t = await (await lancedb.connect(join(baseDbPath, "main"))).openTable("memories");
            await t.add([{ id: "main-mid", text: "mid-copy", vector: [3, 3] }]);
          }
          return nodeFs.copyFile(src, dst, mode);
        },
      };
      const snap = await createSnapshot({ stateDir, baseDbPath, label: "moving", fsImpl });
      assert.ok(wrote);
      assert.deepEqual(await rowsOf(join(snap.dir, "store"), "main"), await rowsOf(baseDbPath, "main"));
      assert.ok((await rowsOf(join(snap.dir, "store"), "main")).ids.includes("main-mid"));
    }
    // A data file the newest manifest needs is gone for good: never a torn snapshot.
    {
      const { stateDir, baseDbPath } = await makeState();
      const dataDir = join(baseDbPath, "work", "memories.lance", "data");
      await nodeFs.unlink(join(dataDir, readdirSync(dataDir)[0]));
      await assert.rejects(createSnapshot({ stateDir, baseDbPath, label: "torn" }), (e) => e instanceof SnapshotError && e.reason === "source-busy");
    }
  });

  it("insufficient disk space refuses before copying", async () => {
    const { stateDir, baseDbPath } = await makeState();
    let copies = 0;
    const fsImpl = {
      ...nodeFs,
      async statfs() {
        return { bsize: 4096, bavail: 1, bfree: 1, blocks: 100, bfree_: 0, type: 0, files: 0, ffree: 0 };
      },
      async copyFile(...args) {
        copies += 1;
        return nodeFs.copyFile(...args);
      },
    };
    await assert.rejects(createSnapshot({ stateDir, baseDbPath, label: "full", fsImpl }), (e) => e instanceof SnapshotError && e.reason === "insufficient-disk");
    assert.equal(copies, 0);
    assert.deepEqual(existsSync(snapshotsDir(stateDir)) ? readdirSync(snapshotsDir(stateDir)) : [], []);
  });

  it("snapshots a store under a path with spaces and non-ASCII", async () => {
    const root = join(makeTempDir("p b-"), "Jürgen A");
    mkdirSync(root, { recursive: true });
    const { stateDir, baseDbPath } = await makeState(root);
    const before = await rowsOf(baseDbPath, "main");
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "ümlaut and space" });
    assert.match(snap.id, /^plur1bus-\d{8}T\d{6}Z-[A-Za-z0-9._-]+$/);
    await verifySnapshot({ dir: snap.dir });
    const table = await (await lancedb.connect(join(baseDbPath, "main"))).openTable("memories");
    await table.add([{ id: "main-9", text: "new", vector: [2, 2] }]);
    await restoreSnapshot({ stateDir, baseDbPath, id: snap.id });
    assert.deepEqual(await rowsOf(baseDbPath, "main"), before);
  });

  it("a killed create leaves no half snapshot under its final name", async () => {
    const { stateDir, baseDbPath } = await makeState();
    let n = 0;
    const fsImpl = {
      ...nodeFs,
      async copyFile(...args) {
        n += 1;
        if (n === 4) throw new Error("killed mid-copy");
        return nodeFs.copyFile(...args);
      },
    };
    await assert.rejects(createSnapshot({ stateDir, baseDbPath, label: "killed", fsImpl }), /killed mid-copy/);
    const left = existsSync(snapshotsDir(stateDir)) ? readdirSync(snapshotsDir(stateDir)) : [];
    assert.deepEqual(left.filter((n2) => n2.includes(".tmp-")), [], "temp staging dir removed");
    for (const name of left.filter((n2) => n2.startsWith("plur1bus-"))) {
      assert.ok(existsSync(join(snapshotsDir(stateDir), name, "snapshot.json")), name);
    }
    // A staging dir of a process that died (SIGKILL) is ignored by list and swept by the next create.
    mkdirSync(join(snapshotsDir(stateDir), "plur1bus-20260101T000000Z-x.tmp-999999999", "store"), { recursive: true });
    assert.deepEqual(await listSnapshots({ stateDir }), []);
    await createSnapshot({ stateDir, baseDbPath, label: "next" });
    assert.ok(!readdirSync(snapshotsDir(stateDir)).some((n2) => n2.includes(".tmp-")));
  });

  it("refuses unsafe paths", async () => {
    const { root, stateDir, baseDbPath } = await makeState();
    const unsafe = (e) => e instanceof SnapshotError && e.reason === "unsafe-path";
    await assert.rejects(createSnapshot({ stateDir, baseDbPath: stateDir, label: "x" }), unsafe);
    await assert.rejects(createSnapshot({ stateDir, baseDbPath: root, label: "x" }), unsafe);
    // baseDbPath containing the snapshots root (<state>/memory is the parent of .snapshots).
    const memoryDir = join(stateDir, "memory");
    await assert.rejects(createSnapshot({ stateDir, baseDbPath: memoryDir, label: "x" }), unsafe);
    await assert.rejects(createSnapshot({ stateDir, baseDbPath: join(memoryDir, ".snapshots"), label: "x" }), unsafe);
    const good = await createSnapshot({ stateDir, baseDbPath, label: "good" });
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath: memoryDir, id: good.id }), unsafe);
    assert.ok(existsSync(join(memoryDir, ".snapshots", good.id, "snapshot.json")), "memory dir untouched");
    assert.deepEqual(readdirSync(stateDir).filter((n) => n.startsWith("memory.")), []);
    const outside = makeTempDir("plur1bus-outside-");
    await nodeFs.rm(join(stateDir, "memory", "_archive"), { recursive: true });
    await nodeFs.symlink(outside, join(stateDir, "memory", "_archive"), "dir");
    await assert.rejects(createSnapshot({ stateDir, baseDbPath, label: "x" }), unsafe);
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath, id: "../../etc" }), unsafe);
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath, id: "plur1bus-20990101T000000Z-none" }), (e) => e instanceof SnapshotError && e.reason === "not-found");
  });
});

describe("store snapshot: fix round 1", () => {
  it("an invalid maxKeep is refused before any copy", async () => {
    const { stateDir, baseDbPath } = await makeState();
    let copies = 0;
    const fsImpl = { ...nodeFs, async copyFile(...a) { copies += 1; return nodeFs.copyFile(...a); } };
    for (const maxKeep of [0, -1, 1.5, "5"]) {
      await assert.rejects(createSnapshot({ stateDir, baseDbPath, label: "x", maxKeep, fsImpl }), RangeError);
    }
    await assert.rejects(pruneSnapshots({ stateDir, maxKeep: 0 }), RangeError);
    assert.equal(copies, 0);
    assert.ok(!existsSync(snapshotsDir(stateDir)) || readdirSync(snapshotsDir(stateDir)).length === 0);
  });

  it("a prune failure after a successful create is a warning, not a failure", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const first = await createSnapshot({ stateDir, baseDbPath, label: "a", now: () => Date.UTC(2026, 8, 28, 10, 0, 0) });
    const fsImpl = {
      ...nodeFs,
      async rm(p, o) {
        if (p === first.dir) throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
        return nodeFs.rm(p, o);
      },
    };
    const second = await createSnapshot({ stateDir, baseDbPath, label: "b", maxKeep: 1, fsImpl, now: () => Date.UTC(2026, 8, 28, 10, 0, 1) });
    assert.deepEqual(second.pruned, []);
    assert.equal(second.warnings.length, 1);
    assert.match(second.warnings[0], /pruning old snapshots failed/);
    await verifySnapshot({ dir: second.dir });
    assert.ok(existsSync(first.dir));
  });

  it("restore refuses before copying when the store's disk lacks 1.1x the store bytes", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    const before = walkFiles(baseDbPath).map((p) => [p, sha256(join(baseDbPath, p))]);
    let copies = 0;
    const fsImpl = {
      ...nodeFs,
      async statfs() { return { bsize: 4096, bavail: 1, bfree: 1, blocks: 100, type: 0, files: 0, ffree: 0 }; },
      async copyFile(...a) { copies += 1; return nodeFs.copyFile(...a); },
    };
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath, id: snap.id, fsImpl }), (e) => e instanceof SnapshotError && e.reason === "insufficient-disk");
    assert.equal(copies, 0);
    assert.deepEqual(walkFiles(baseDbPath).map((p) => [p, sha256(join(baseDbPath, p))]), before);
    assert.deepEqual(readdirSync(dirname(baseDbPath)).filter((n) => n.startsWith("lancedb-namespaced.")), []);
  });

  it("a failed rollback rename reports both errors and where the previous store is", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    const rowsBefore = await rowsOf(baseDbPath, "main");
    const fsImpl = {
      ...nodeFs,
      async rename(from, to) {
        if (from.includes(".restore-")) throw Object.assign(new Error("move-in failed"), { code: "EIO" });
        if (from.includes(".pre-restore-")) throw Object.assign(new Error("move-back failed"), { code: "EIO" });
        return nodeFs.rename(from, to);
      },
    };
    let err;
    await restoreSnapshot({ stateDir, baseDbPath, id: snap.id, fsImpl }).catch((e) => { err = e; });
    assert.ok(err, "restore must fail");
    assert.equal(err.name, "RestoreRollbackError");
    assert.match(err.cause.message, /move-in failed/);
    assert.match(err.rollbackError.message, /move-back failed/);
    assert.ok(err.preRestorePath.startsWith(`${baseDbPath}.pre-restore-`));
    assert.ok(err.message.includes(err.preRestorePath));
    assert.deepEqual(await rowsOf(err.preRestorePath, "main"), rowsBefore, "the previous store is intact where the error says");
    assert.ok(!readdirSync(dirname(baseDbPath)).some((n) => n.includes(".restore-") && !n.includes(".pre-restore-")));
  });
});

describe("store snapshot: compare the live store (HM1-R-F2)", () => {
  it("an untouched store matches its snapshot, even after it was read through LanceDB", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "pre-update" });
    await rowsOf(baseDbPath, "main");
    await rowsOf(baseDbPath, "work");
    if (process.platform !== "win32") symlinkSync(join(stateDir, "vault"), join(baseDbPath, "vault-link")); // the copy skips symlinks, so does the compare
    const cmp = await compareStoreWithSnapshot({ stateDir, baseDbPath, id: snap.id });
    assert.equal(cmp.unchanged, true, cmp.detail);
    assert.ok(cmp.files > 5);
    // side files outside the store are not part of the comparison
    writeFileSync(join(stateDir, "workspace", "run-state.json"), "{\"lastRun\":2}\n");
    assert.equal((await compareStoreWithSnapshot({ stateDir, baseDbPath, id: snap.id })).unchanged, true);
  });

  it("a new, changed (same size) or missing file, a LanceDB write and a missing store all differ", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "pre-update" });
    const cmp = () => compareStoreWithSnapshot({ stateDir, baseDbPath, id: snap.id });
    const reg = join(baseDbPath, "registry.json");
    const orig = readFileSync(reg);

    writeFileSync(join(baseDbPath, "extra.txt"), "x");
    assert.deepEqual(await cmp(), { unchanged: false, detail: "store/extra.txt is new since the snapshot", files: (await cmp()).files });
    rmSync(join(baseDbPath, "extra.txt"));

    writeFileSync(reg, Buffer.from(orig.toString("utf8").replace("main", "MAIN")));
    assert.match((await cmp()).detail, /store\/registry\.json changed since the snapshot/);
    writeFileSync(reg, orig);
    assert.equal((await cmp()).unchanged, true);

    rmSync(reg);
    assert.match((await cmp()).detail, /store\/registry\.json is gone since the snapshot/);
    writeFileSync(reg, orig);

    const table = await (await lancedb.connect(join(baseDbPath, "main"))).openTable("memories");
    await table.add([{ id: "main-9", text: "new", vector: [2, 2] }]);
    const after = await cmp();
    assert.equal(after.unchanged, false);
    assert.match(after.detail, /^store\/main\//);

    rmSync(baseDbPath, { recursive: true });
    assert.match((await cmp()).detail, /^no store at /);
    await assert.rejects(compareStoreWithSnapshot({ stateDir, baseDbPath, id: "plur1bus-20990101T000000Z-none" }), (e) => e instanceof SnapshotError && e.reason === "not-found");
  });
});

describe("snapshot-store CLI", () => {
  // spawnSync blocks the event loop, so neither node:test's --test-timeout nor an outer timer can interrupt a hung
  // CLI child: the bound has to live on the child itself. A timed-out child sets r.error, which fails the test
  // with the command name instead of the job eating its whole budget.
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL" });
    assert.equal(r.error, undefined, `snapshot-store CLI ${args[0] ?? "(no command)"} did not finish within ${CLI_TIMEOUT_MS} ms: ${r.error?.message}`);
    return r;
  };

  it("create, list, verify, restore, prune with --json; exit 2 on usage, 1 on SnapshotError", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const created = run("create", "--state-dir", stateDir, "--base-db-path", baseDbPath, "--label", "cli", "--json");
    assert.equal(created.status, 0, created.stderr);
    const doc = JSON.parse(created.stdout);
    assert.equal(doc.schema, SNAPSHOT_SCHEMA);
    assert.equal(doc.ok, true);
    const id = doc.result.id;
    assert.deepEqual(doc.result.pruned, []);
    const human = run("create", "--state-dir", stateDir, "--base-db-path", baseDbPath, "--label", "cli2");
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /pruned nothing/);
    const second = JSON.parse(run("list", "--state-dir", stateDir, "--json").stdout).result.find((s) => s.label === "cli2");
    await nodeFs.rm(join(snapshotsDir(stateDir), second.id), { recursive: true });
    const listed = JSON.parse(run("list", "--state-dir", stateDir, "--json").stdout);
    assert.deepEqual(listed.result.map((s) => s.id), [id]);
    assert.equal(run("verify", "--state-dir", stateDir, "--id", id, "--json").status, 0);
    const restored = run("restore", "--state-dir", stateDir, "--base-db-path", baseDbPath, "--id", id, "--json");
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(run("prune", "--state-dir", stateDir, "--json").status, 0);

    assert.equal(run().status, 2);
    assert.equal(run("explode", "--state-dir", stateDir).status, 2);
    assert.equal(run("create", "--state-dir", stateDir).status, 2);
    const missing = run("verify", "--state-dir", stateDir, "--id", "plur1bus-20990101T000000Z-none", "--json");
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).error.reason, "not-found");
  });
});

describe("store snapshot: a custom snapshotsDir (ruling F18)", () => {
  it("create, list, compare, restore and prune use snapshotsDir, and a store inside it is refused", async () => {
    const { root, stateDir, baseDbPath } = await makeState();
    const snapshotsDir = join(root, "hermes-snapshots");
    const opts = { stateDir, baseDbPath, snapshotsDir };
    const a = await createSnapshot({ ...opts, label: "a", now: () => Date.UTC(2026, 8, 30, 10, 0, 0) });
    assert.ok(a.dir.startsWith(snapshotsDir + sep), a.dir);
    assert.equal(existsSync(join(stateDir, "memory", ".snapshots")), false, "the default dir is not used");
    assert.deepEqual((await listSnapshots(opts)).map((s) => s.id), [a.id]);
    assert.deepEqual(await listSnapshots({ stateDir }), []);
    assert.equal((await compareStoreWithSnapshot({ ...opts, id: a.id })).unchanged, true);
    await assert.rejects(compareStoreWithSnapshot({ stateDir, baseDbPath, id: a.id }), (e) => e instanceof SnapshotError && e.reason === "not-found");

    writeFileSync(join(baseDbPath, "registry.json"), "{\"agents\":[\"changed\"]}\n");
    assert.equal((await compareStoreWithSnapshot({ ...opts, id: a.id })).unchanged, false);
    const restored = await restoreSnapshot({ ...opts, id: a.id });
    assert.equal(readFileSync(join(baseDbPath, "registry.json"), "utf8"), "{\"agents\":[\"main\",\"work\"]}\n");
    assert.ok(restored.preRestorePath);
    rmSync(restored.preRestorePath, { recursive: true, force: true });

    const b = await createSnapshot({ ...opts, label: "b", now: () => Date.UTC(2026, 8, 30, 11, 0, 0) });
    assert.deepEqual(await pruneSnapshots({ ...opts, maxKeep: 1 }), [a.id]);
    assert.deepEqual((await listSnapshots(opts)).map((s) => s.id), [b.id]);

    // assertSafeBase checks the custom dir, too
    const inside = join(snapshotsDir, "store");
    mkdirSync(inside, { recursive: true });
    await assert.rejects(createSnapshot({ stateDir, baseDbPath: inside, snapshotsDir }), (e) => e instanceof SnapshotError && e.reason === "unsafe-path");
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath: inside, snapshotsDir, id: b.id }), (e) => e.reason === "unsafe-path");
    await assert.rejects(createSnapshot({ stateDir, baseDbPath, snapshotsDir: join(baseDbPath, "snaps") }), (e) => e.reason === "unsafe-path");
  });
});

describe("store snapshot: workspace side files (engine audit snapshot 2)", () => {
  it("saves run-state.json and merge-proposals.jsonl from the workspace, not from memory/", async () => {
    const { stateDir, baseDbPath } = await makeState();
    // stale lookalikes at the old, wrong location must not be what is saved
    writeFileSync(join(stateDir, "memory", "run-state.json"), "{\"stale\":true}\n");
    writeFileSync(join(stateDir, "memory", "merge-proposals.jsonl"), "{\"stale\":true}\n");
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "ws" });
    const files = walkFiles(snap.dir);
    assert.ok(files.includes("workspace/run-state.json"), files.join("\n"));
    assert.ok(files.includes("workspace/.adaptive-learning/merge-proposals.jsonl"));
    assert.ok(!files.includes("memory/run-state.json"));
    assert.ok(!files.includes("memory/merge-proposals.jsonl"));
    assert.equal(readFileSync(join(snap.dir, "workspace", "run-state.json"), "utf8"), "{\"lastRun\":1}\n");
    assert.equal(readFileSync(join(snap.dir, "workspace", ".adaptive-learning", "merge-proposals.jsonl"), "utf8"), "{\"p\":1}\n");
    await verifySnapshot({ dir: snap.dir });
  });

  it("takes an explicit workspaceDir outside the state dir, and copes with a missing workspace", async () => {
    const { root, stateDir, baseDbPath } = await makeState();
    const workspaceDir = join(root, "agent-workspace");
    mkdirSync(join(workspaceDir, ".adaptive-learning"), { recursive: true });
    writeFileSync(join(workspaceDir, "run-state.json"), "{\"custom\":1}\n");
    writeFileSync(join(workspaceDir, ".adaptive-learning", "merge-proposals.jsonl"), "{\"custom\":2}\n");
    const snap = await createSnapshot({ stateDir, baseDbPath, workspaceDir, label: "custom" });
    assert.equal(readFileSync(join(snap.dir, "workspace", "run-state.json"), "utf8"), "{\"custom\":1}\n");
    assert.equal(readFileSync(join(snap.dir, "workspace", ".adaptive-learning", "merge-proposals.jsonl"), "utf8"), "{\"custom\":2}\n");

    const none = await createSnapshot({ stateDir, baseDbPath, workspaceDir: join(root, "no-such-workspace"), label: "none", now: () => Date.UTC(2030, 0, 1) });
    assert.ok(!walkFiles(none.dir).some((p) => p.startsWith("workspace/")));
    await verifySnapshot({ dir: none.dir });
  });
});

describe("store snapshot: pre-restore copies (engine audit snapshot 1)", () => {
  const preRestoreCopies = (baseDbPath) =>
    readdirSync(dirname(baseDbPath)).filter((n) => n.startsWith("lancedb-namespaced.pre-restore-")).sort();

  async function restoreN(stateDir, baseDbPath, id, n, extra = {}) {
    const results = [];
    for (let i = 0; i < n; i++) {
      writeFileSync(join(baseDbPath, "registry.json"), `{"gen":${i}}\n`);
      results.push(await restoreSnapshot({ stateDir, baseDbPath, id, ...extra }));
    }
    return results;
  }

  it("keeps every copy by default (unchanged behaviour)", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "p" });
    const results = await restoreN(stateDir, baseDbPath, snap.id, 4);
    assert.equal(preRestoreCopies(baseDbPath).length, 4);
    assert.deepEqual(results[3].purgedPreRestore, []);
    assert.deepEqual(results[3].warnings, []);
  });

  it("keepPreRestore: N removes the older copies after a successful restore and keeps the new one", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "p" });
    await restoreN(stateDir, baseDbPath, snap.id, 3);
    assert.equal(preRestoreCopies(baseDbPath).length, 3);
    writeFileSync(join(baseDbPath, "registry.json"), "{\"gen\":99}\n");
    const last = await restoreSnapshot({ stateDir, baseDbPath, id: snap.id, keepPreRestore: 2 });
    const left = preRestoreCopies(baseDbPath);
    assert.equal(left.length, 2, left.join(","));
    assert.ok(left.includes(last.preRestorePath.split(sep).pop()), "the copy of this restore is kept");
    assert.equal(last.purgedPreRestore.length, 2);
    assert.equal(readFileSync(join(last.preRestorePath, "registry.json"), "utf8"), "{\"gen\":99}\n");
    assert.deepEqual(last.warnings, []);
    assert.deepEqual(await rowsOf(baseDbPath, "main"), await rowsOf(join(snap.dir, "store"), "main"));
  });

  it("a failed restore purges nothing", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "p" });
    await restoreN(stateDir, baseDbPath, snap.id, 3);
    const before = preRestoreCopies(baseDbPath);
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath, id: "plur1bus-20990101T000000Z-none", keepPreRestore: 1 }), (e) => e.reason === "not-found");
    assert.deepEqual(preRestoreCopies(baseDbPath), before);
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath, id: snap.id, keepPreRestore: -1 }), RangeError);
    assert.deepEqual(preRestoreCopies(baseDbPath), before);
  });

  it("purgePreRestore keeps the newest N, ignores lookalikes, and honours a pending restore journal", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "p" });
    await restoreN(stateDir, baseDbPath, snap.id, 4);
    const lookalikes = [
      `${baseDbPath}.pre-restore-old`, // wrong suffix
      `${baseDbPath}.bak.20260101`,
      `${baseDbPath}-x.pre-restore-20260101T000000Z`, // another store's copy
    ];
    for (const l of lookalikes) mkdirSync(l);
    writeFileSync(`${baseDbPath}.pre-restore-20260102T000000Z`, "a file, not a directory");
    const realCopies = () => readdirSync(dirname(baseDbPath), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^lancedb-namespaced\.pre-restore-\d{8}T\d{6}Z(-\d+)?$/.test(e.name)).map((e) => e.name);
    assert.equal(realCopies().length, 4);

    writeFileSync(`${baseDbPath}.pending-restore`, "{}");
    const skipped = await purgePreRestore({ stateDir, baseDbPath, keep: 1 });
    assert.equal(skipped.skipped, "restore-pending");
    assert.deepEqual(skipped.removed, []);
    assert.equal(realCopies().length, 4);
    rmSync(`${baseDbPath}.pending-restore`);

    const purged = await purgePreRestore({ stateDir, baseDbPath, keep: 2 });
    assert.equal(purged.removed.length, 2);
    assert.equal(purged.kept.length, 2);
    assert.equal(realCopies().length, 2);
    for (const l of lookalikes) assert.ok(existsSync(l), l);
    assert.ok(existsSync(`${baseDbPath}.pre-restore-20260102T000000Z`));
    // the live store is untouched
    assert.deepEqual(await rowsOf(baseDbPath, "main"), await rowsOf(join(snap.dir, "store"), "main"));
    assert.deepEqual((await purgePreRestore({ stateDir, baseDbPath, keep: 2 })).removed, []);
    await assert.rejects(purgePreRestore({ stateDir, baseDbPath, keep: 1.5 }), RangeError);
    await assert.rejects(purgePreRestore({ stateDir, baseDbPath: stateDir, keep: 1 }), (e) => e.reason === "unsafe-path");
  });

  it("the CLI offers purge-pre-restore and restore --keep-pre-restore", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "cli" });
    await restoreN(stateDir, baseDbPath, snap.id, 3);
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL" });
    const purge = run("purge-pre-restore", "--state-dir", stateDir, "--base-db-path", baseDbPath, "--keep", "1", "--json");
    assert.equal(purge.status, 0, purge.stderr);
    assert.equal(JSON.parse(purge.stdout).result.removed.length, 2);
    assert.equal(preRestoreCopies(baseDbPath).length, 1);
    writeFileSync(join(baseDbPath, "registry.json"), "{\"gen\":7}\n");
    const restored = run("restore", "--state-dir", stateDir, "--base-db-path", baseDbPath, "--id", snap.id, "--keep-pre-restore", "1", "--json");
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).result.purgedPreRestore.length, 1);
    assert.equal(preRestoreCopies(baseDbPath).length, 1);
    assert.equal(run("purge-pre-restore", "--state-dir", stateDir).status, 2);
    assert.equal(run("purge-pre-restore", "--state-dir", stateDir, "--base-db-path", baseDbPath, "--keep", "x").status, 2);
  });
});

describe("store snapshot: restore after the swap, path containment (engine audit snapshot 3, 4)", () => {
  const POSIX = process.platform === "win32" ? { skip: "directory fsync and symlinks are POSIX-only" } : {};

  it("a directory fsync failure after the swap is a warning, not a failed restore", POSIX, async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "f" });
    writeFileSync(join(baseDbPath, "registry.json"), "{\"gen\":1}\n");
    const parent = dirname(baseDbPath);
    const fsImpl = {
      ...nodeFs,
      async open(p, ...rest) {
        if (p === parent) throw Object.assign(new Error("fsync boom"), { code: "EIO" });
        return nodeFs.open(p, ...rest);
      },
    };
    const result = await restoreSnapshot({ stateDir, baseDbPath, id: snap.id, fsImpl });
    assert.equal(readFileSync(join(baseDbPath, "registry.json"), "utf8"), "{\"agents\":[\"main\",\"work\"]}\n");
    assert.ok(result.preRestorePath && existsSync(result.preRestorePath));
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /fsync of .* failed after the swap: fsync boom/);
    assert.ok(result.warnings[0].includes(result.preRestorePath), "the warning names the previous store");
  });

  it("a failure before the swap (staging fsync) still fails the restore and leaves the store alone", POSIX, async () => {
    const { stateDir, baseDbPath } = await makeState();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "f" });
    writeFileSync(join(baseDbPath, "registry.json"), "{\"gen\":1}\n");
    const fsImpl = {
      ...nodeFs,
      async open(p, ...rest) {
        if (String(p).startsWith(`${baseDbPath}.restore-`)) throw Object.assign(new Error("staging boom"), { code: "EIO" });
        return nodeFs.open(p, ...rest);
      },
    };
    await assert.rejects(restoreSnapshot({ stateDir, baseDbPath, id: snap.id, fsImpl }), /staging boom/);
    assert.equal(readFileSync(join(baseDbPath, "registry.json"), "utf8"), "{\"gen\":1}\n");
  });

  it("a store reached through a symlink to a sibling named ..name is not refused as an escape", POSIX, async () => {
    const { stateDir, baseDbPath } = await makeState();
    const real = join(dirname(baseDbPath), "..lancedb-real");
    await nodeFs.rename(baseDbPath, real);
    symlinkSync(real, baseDbPath);
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "dots" });
    assert.ok(walkFiles(snap.dir).includes("store/registry.json"));
  });

  it("a store named ..x inside the snapshots directory is refused, a ..x sibling next to it is not", async () => {
    const { stateDir, baseDbPath } = await makeState();
    const inside = join(snapshotsDir(stateDir), "..store");
    mkdirSync(inside, { recursive: true });
    await assert.rejects(createSnapshot({ stateDir, baseDbPath: inside }), (e) => e instanceof SnapshotError && e.reason === "unsafe-path");
    const sibling = join(stateDir, "memory", "..store");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "registry.json"), "{}\n");
    const snap = await createSnapshot({ stateDir, baseDbPath: sibling, label: "sibling" });
    assert.ok(walkFiles(snap.dir).includes("store/registry.json"));
    void baseDbPath;
  });
});
