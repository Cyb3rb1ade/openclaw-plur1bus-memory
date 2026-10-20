/**
 * tests/store-restore-recovery.test.js
 *
 * Audit store #6: restoreSnapshot moves the store to `<store>.pre-restore-<ts>`
 * and then the staged copy into place. A crash between the two renames left
 * no store at all and nothing that said so. A journal next to the store
 * (`<store>.restore-journal`, written before the first rename) lets the next
 * restore or engine start put the previous store back — and only then: a
 * missing store with an old pre-restore copy from an earlier, finished restore
 * is never "recovered". The crash is a real SIGKILL of a child process.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createSnapshot, finishRestoreJournalSync, recoverInterruptedRestoreSync, restoreSnapshot } from "../lib/snapshot/store-snapshot.js";
import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { config, flatEmbedder } from "./helpers/shared-workspace-engine.js";
import { prepareEngineSharedBase } from "./helpers/win32-shared-owner.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

async function makeStore() {
  const root = makeTempDir("plur1bus-restore-recovery-");
  const stateDir = join(root, ".openclaw");
  const baseDbPath = join(stateDir, "memory", "lancedb-namespaced");
  mkdirSync(baseDbPath, { recursive: true });
  const db = await lancedb.connect(join(baseDbPath, "main"));
  await db.createTable("memories", [{ id: "m1", text: "one", vector: [1, 0] }, { id: "m2", text: "two", vector: [0, 1] }]);
  return { root, stateDir, baseDbPath };
}

async function ids(baseDbPath) {
  const table = await (await lancedb.connect(join(baseDbPath, "main"))).openTable("memories");
  return (await table.query().select(["id"]).toArray()).map((r) => r.id).sort();
}

async function addRow(baseDbPath, id) {
  const table = await (await lancedb.connect(join(baseDbPath, "main"))).openTable("memories");
  await table.add([{ id, text: id, vector: [1, 1] }]);
}

/** Restore in a child that is SIGKILLed on the second rename (staged copy -> store), the store already moved away. */
function crashBetweenRenames(stateDir, baseDbPath, id) {
  const script = `
    import * as nodeFs from "node:fs/promises";
    import { restoreSnapshot } from ${JSON.stringify(join(REPO, "lib/snapshot/store-snapshot.js"))};
    const fsImpl = { ...nodeFs, async rename(from, to) {
      if (from.includes(".restore-")) process.kill(process.pid, "SIGKILL");
      return nodeFs.rename(from, to);
    } };
    await restoreSnapshot({ stateDir: ${JSON.stringify(stateDir)}, baseDbPath: ${JSON.stringify(baseDbPath)}, id: ${JSON.stringify(id)}, fsImpl });
    process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
  assert.equal(r.signal, "SIGKILL", `child must have crashed between the renames: ${r.stderr}`);
}

const siblings = (baseDbPath) => readdirSync(dirname(baseDbPath)).filter((n) => n.startsWith("lancedb-namespaced.")).sort();

describe("restore crash between the two renames (audit store #6)", () => {
  it("recoverInterruptedRestoreSync puts the previous store back", async () => {
    const { stateDir, baseDbPath } = await makeStore();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    await addRow(baseDbPath, "m3"); // live state newer than the snapshot
    crashBetweenRenames(stateDir, baseDbPath, snap.id);
    assert.equal(existsSync(baseDbPath), false, "precondition: the crash left no store");

    const result = recoverInterruptedRestoreSync(baseDbPath);
    assert.equal(result.action, "rolled-back");
    assert.deepEqual(await ids(baseDbPath), ["m1", "m2", "m3"], "the pre-restore store is the live store again");
    assert.deepEqual(siblings(baseDbPath), [], `no pre-restore, staging or journal left: ${siblings(baseDbPath)}`);
    assert.equal(recoverInterruptedRestoreSync(baseDbPath).action, "none", "idempotent");
  });

  it("the next restoreSnapshot recovers first and then restores", async () => {
    const { stateDir, baseDbPath } = await makeStore();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    await addRow(baseDbPath, "m3");
    crashBetweenRenames(stateDir, baseDbPath, snap.id);
    await restoreSnapshot({ stateDir, baseDbPath, id: snap.id });
    assert.deepEqual(await ids(baseDbPath), ["m1", "m2"], "restored from the snapshot");
    const left = siblings(baseDbPath);
    assert.equal(left.filter((n) => n.includes(".pre-restore-")).length, 1, `exactly the pre-restore copy of the second restore: ${left}`);
    assert.ok(!left.some((n) => n.endsWith(".restore-journal") || /\.restore-\d+$/.test(n)), left.join(","));
  });

  it("a missing store with an old pre-restore copy but no journal is never touched", async () => {
    const { stateDir, baseDbPath } = await makeStore();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    await restoreSnapshot({ stateDir, baseDbPath, id: snap.id }); // finished restore, leaves <store>.pre-restore-<ts>
    const [pre] = siblings(baseDbPath);
    renameSync(baseDbPath, `${baseDbPath}.moved-by-operator`); // operator starts fresh on purpose
    const result = recoverInterruptedRestoreSync(baseDbPath);
    assert.equal(result.action, "none");
    assert.equal(existsSync(baseDbPath), false);
    assert.ok(existsSync(join(dirname(baseDbPath), pre)), "the old pre-restore copy stays where it is");
  });

  it("a journal next to a store that is in place means the tombstones may not be re-applied: needs-reapply until finished", async () => {
    const { stateDir, baseDbPath } = await makeStore();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    await restoreSnapshot({ stateDir, baseDbPath, id: snap.id });
    // Crash after the swap, before the re-apply: the journal is still there.
    writeFileSync(`${baseDbPath}.restore-journal`, JSON.stringify({
      schema: "plur1bus.restore-journal/1", id: snap.id, target: baseDbPath,
      preRestorePath: `${baseDbPath}.pre-restore-20260101T000000Z`, staging: `${baseDbPath}.restore-4242`, startedAt: "2026-01-01T00:00:00.000Z",
    }));
    const r = recoverInterruptedRestoreSync(baseDbPath);
    assert.equal(r.action, "needs-reapply");
    assert.equal(recoverInterruptedRestoreSync(baseDbPath).action, "needs-reapply", "stays until finished");
    assert.deepEqual(await ids(baseDbPath), ["m1", "m2"], "the store in place is not touched");
    finishRestoreJournalSync(baseDbPath);
    assert.equal(recoverInterruptedRestoreSync(baseDbPath).action, "none");
  });

  it("an unreadable or foreign journal is set aside and never acted on", async () => {
    const { baseDbPath } = await makeStore();
    writeFileSync(`${baseDbPath}.restore-journal`, JSON.stringify({
      schema: "plur1bus.restore-journal/1", target: baseDbPath,
      preRestorePath: "/etc/somewhere-else.pre-restore-1", staging: `${baseDbPath}.restore-1`,
    }));
    const r = recoverInterruptedRestoreSync(baseDbPath);
    assert.equal(r.action, "none");
    assert.ok(readdirSync(dirname(baseDbPath)).some((n) => n.startsWith("lancedb-namespaced.restore-journal.corrupt-")));
    assert.deepEqual(await ids(baseDbPath), ["m1", "m2"]);
  });

  it("createEngine recovers the interrupted restore before it touches the store", { timeout: 90_000 }, async () => {
    const { root, stateDir, baseDbPath } = await makeStore();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    crashBetweenRenames(stateDir, baseDbPath, snap.id);
    assert.equal(existsSync(baseDbPath), false);
    const host = createStubHost({ stateDir: root, workspaceDir: async () => root });
    const engine = prepareEngineSharedBase(createEngine(host, config(baseDbPath), { internals: { embeddings: flatEmbedder() } }));
    try {
      assert.ok(existsSync(join(baseDbPath, "main")), "the previous store is back right after createEngine returned");
      assert.deepEqual(await ids(baseDbPath), ["m1", "m2"]);
    } finally {
      await engine.close();
    }
  });
});
