/**
 * tests/store-restore-tombstones.test.js
 *
 * Snapshot-Restore darf keine vergessene Erinnerung reaktivieren: die
 * append-only Tombstone-Registry (Geschwister des Stores) überlebt den Restore,
 * die Zeilen des Snapshots nicht — restoreSnapshot spielt die committed
 * Tombstones deshalb wieder ein (Node-Pfad, wie restore-snapshot.sh im Bash-Pfad).
 * Echter LanceDB-Store in einem Temp-Verzeichnis.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createSnapshot, restoreSnapshot, SnapshotError } from "../lib/snapshot/store-snapshot.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { forgetCard } from "../lib/telegram-commands/memory-edit.js";
import { readTombstoneRegistry } from "../lib/tombstone.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "snapshot-store.mjs");
const KEEP = "11111111-1111-4111-8111-111111111111";
const FORGET = "22222222-2222-4222-8222-222222222222";
const quiet = { info() {}, warn() {} };

async function makeStore(agents = ["main"]) {
  const root = makeTempDir("plur1bus-restore-tomb-");
  const stateDir = join(root, ".openclaw");
  const baseDbPath = join(stateDir, "memory", "lancedb-namespaced");
  mkdirSync(baseDbPath, { recursive: true });
  for (const agent of agents) {
    const db = await lancedb.connect(join(baseDbPath, agent));
    await db.createTable("memories", [
      { id: KEEP, text: "keep this one", vector: [1, 0], status: "active", epistemicStatus: "active", scope: "agent-private", agentId: agent },
      { id: FORGET, text: "forget this one", vector: [0, 1], status: "active", epistemicStatus: "active", scope: "agent-private", agentId: agent },
    ]);
  }
  return { root, stateDir, baseDbPath };
}

async function rowStatus(baseDbPath, agent, id) {
  const db = await lancedb.connect(join(baseDbPath, agent));
  const table = await db.openTable("memories");
  const rows = await table.query().where(`id = "${id}"`).toArray();
  return rows.length ? { status: rows[0].status, epistemicStatus: rows[0].epistemicStatus } : null;
}

/** Real /forget flow (attempted -> soft delete -> committed) against the live store. */
async function forget(root, baseDbPath, agent, id) {
  const adapter = createDbAdapter({ basePath: baseDbPath, logger: quiet });
  try {
    const r = await forgetCard(adapter, agent, id, {
      baseDbPath,
      archiveDir: join(root, "archive"),
      workspaceDir: join(root, "ws"),
      actor: "tester",
    });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally {
    await adapter.shutdown();
  }
}

describe("restoreSnapshot re-applies tombstones (audit store #1)", () => {
  it("a memory forgotten after the snapshot stays forgotten after restore", async () => {
    const { root, stateDir, baseDbPath } = await makeStore();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "before-forget" });
    await forget(root, baseDbPath, "main", FORGET);
    assert.equal((await rowStatus(baseDbPath, "main", FORGET)).status, "deleted");

    await restoreSnapshot({ stateDir, baseDbPath, id: snap.id });

    assert.deepEqual(await rowStatus(baseDbPath, "main", FORGET), { status: "deleted", epistemicStatus: "invalidated" },
      "the snapshot row was active; restore must re-apply the committed tombstone");
    assert.equal((await rowStatus(baseDbPath, "main", KEEP)).status, "active", "unrelated rows are untouched");
  });

  it("scripts/snapshot-store.mjs restore does the same", async () => {
    const { root, stateDir, baseDbPath } = await makeStore();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "before-forget" });
    await forget(root, baseDbPath, "main", FORGET);
    const r = spawnSync(process.execPath, [CLI, "restore", "--state-dir", stateDir, "--base-db-path", baseDbPath, "--id", snap.id, "--json"],
      { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.equal((await rowStatus(baseDbPath, "main", FORGET)).status, "deleted");
  });

  it("an agent whose store dir is not part of the snapshot is not an error", async () => {
    const { root, stateDir, baseDbPath } = await makeStore(["main", "late"]);
    await forget(root, baseDbPath, "late", FORGET);
    // Snapshot of a store that does not have the "late" agent (it was created later).
    rmSync(join(baseDbPath, "late"), { recursive: true, force: true });
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "no-late" });
    await restoreSnapshot({ stateDir, baseDbPath, id: snap.id });
    assert.equal(readTombstoneRegistry(baseDbPath, "late").tombstones.filter((t) => t.status === "committed").length, 1);
  });

  it("a registry that cannot be trusted fails the restore loudly (store is restored, error names the pre-restore copy)", async () => {
    const { stateDir, baseDbPath } = await makeStore();
    const snap = await createSnapshot({ stateDir, baseDbPath, label: "t" });
    mkdirSync(join(dirname(baseDbPath), "_tombstones"), { recursive: true });
    writeFileSync(join(dirname(baseDbPath), "_tombstones", "main.jsonl"), "NOT JSON\n");
    await assert.rejects(
      restoreSnapshot({ stateDir, baseDbPath, id: snap.id }),
      (e) => e instanceof SnapshotError && e.reason === "tombstone-reapply-failed" && /pre-restore/.test(e.message),
    );
  });
});
