/**
 * tests/store-tombstone-reconcile.test.js
 *
 * Audit store #2: /forget is attempted -> soft delete -> committed. A crash
 * between the soft delete and the committed line leaves an `attempted`
 * tombstone next to an already `deleted` row; `attempted` does not block
 * re-capture, so the forgotten text could be stored again. The startup
 * reconcile closes that gap: attempted + deleted row -> committed;
 * attempted + still active row after the grace period -> failed (the
 * deletion never happened); a young attempted one is left alone.
 * Real LanceDB stores in temp dirs; the crash is a real SIGKILL of a child.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { makeTempDir } from "./helpers/temp-dir.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { reconcileAttemptedTombstones } from "../lib/tombstone-reapply.js";
import { buildTombstone, appendTombstoneToRegistry, findBlockingTombstoneForCapture, readTombstoneRegistry } from "../lib/tombstone.js";
import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { config, flatEmbedder, freshBaseDbPath, principal, seedAndGetId } from "./helpers/shared-workspace-engine.js";
import { prepareEngineSharedBase } from "./helpers/win32-shared-owner.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = "33333333-3333-4333-8333-333333333333";
const TEXT = "the harbour master keeps the brass key in the blue drawer";
const quiet = { info() {}, warn() {} };

async function makeStore() {
  const root = makeTempDir("plur1bus-tomb-reconcile-");
  const baseDbPath = join(root, "lancedb-namespaced");
  mkdirSync(baseDbPath, { recursive: true });
  const db = await lancedb.connect(join(baseDbPath, "main"));
  await db.createTable("memories", [
    { id: ID, text: TEXT, vector: [1, 0], status: "active", epistemicStatus: "active", scope: "agent-private", agentId: "main" },
  ]);
  return { root, baseDbPath };
}

/** Runs /forget in a child that is SIGKILLed right after the soft delete, before the committed line. */
function crashDuringForget(root, baseDbPath) {
  const script = `
    import { createDbAdapter } from ${JSON.stringify(join(REPO, "lib/db-adapter.js"))};
    import { forgetCard } from ${JSON.stringify(join(REPO, "lib/telegram-commands/memory-edit.js"))};
    const real = createDbAdapter({ basePath: ${JSON.stringify(baseDbPath)}, logger: { info() {}, warn() {} } });
    const db = new Proxy(real, { get(t, k) {
      if (k === "tombstoneCard") return async (...a) => { const r = await t.tombstoneCard(...a); process.kill(process.pid, "SIGKILL"); return r; };
      const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
    } });
    await forgetCard(db, "main", ${JSON.stringify(ID)}, { baseDbPath: ${JSON.stringify(baseDbPath)}, archiveDir: ${JSON.stringify(join(root, "archive"))}, workspaceDir: ${JSON.stringify(join(root, "ws"))}, actor: "tester" });
    process.exit(0);`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
  assert.equal(r.signal, "SIGKILL", `child must have crashed mid-forget: ${r.stderr}`);
}

const statuses = (baseDbPath, agent = "main") => readTombstoneRegistry(baseDbPath, agent).tombstones.map((t) => t.status);
const blocks = (baseDbPath) => findBlockingTombstoneForCapture(baseDbPath, { agentId: "main", text: TEXT, scope: "agent-private" });

describe("tombstone reconcile (audit store #2)", () => {
  it("crash between soft delete and committed: attempted + deleted row becomes committed and blocks re-capture", async () => {
    const { root, baseDbPath } = await makeStore();
    crashDuringForget(root, baseDbPath);
    assert.deepEqual(statuses(baseDbPath), ["attempted"]);
    assert.equal(blocks(baseDbPath), null, "precondition: an attempted tombstone does not block");

    const adapter = createDbAdapter({ basePath: baseDbPath, logger: quiet });
    try {
      const report = await reconcileAttemptedTombstones({ baseDbPath, adapter });
      assert.deepEqual(report.committed.map((e) => e.memoryId), [ID]);
      assert.deepEqual(statuses(baseDbPath), ["attempted", "committed"]);
      const committed = readTombstoneRegistry(baseDbPath, "main").tombstones.at(-1);
      const attempted = readTombstoneRegistry(baseDbPath, "main").tombstones[0];
      assert.equal(committed.tombstoneId, attempted.tombstoneId, "the commit closes the same attempt");
      assert.ok(blocks(baseDbPath), "the committed tombstone now blocks the same text");

      const again = await reconcileAttemptedTombstones({ baseDbPath, adapter });
      assert.deepEqual([again.committed, again.abandoned, again.pending, again.errors], [[], [], [], []]);
      assert.deepEqual(statuses(baseDbPath), ["attempted", "committed"], "idempotent");
    } finally {
      await adapter.shutdown();
    }
  });

  it("attempted + still active row: left alone while young, failed after the grace period; never committed", async () => {
    const { baseDbPath } = await makeStore();
    const tomb = buildTombstone({ card: { id: ID, text: TEXT, scope: "agent-private" }, agentId: "main", actor: "t" });
    appendTombstoneToRegistry(baseDbPath, "main", { ...tomb, status: "attempted" });
    const adapter = createDbAdapter({ basePath: baseDbPath, logger: quiet });
    try {
      const young = await reconcileAttemptedTombstones({ baseDbPath, adapter, now: Date.parse(tomb.deletedAt) + 1_000 });
      assert.deepEqual(young.pending.map((e) => e.memoryId), [ID]);
      assert.deepEqual(statuses(baseDbPath), ["attempted"]);

      const old = await reconcileAttemptedTombstones({ baseDbPath, adapter, now: Date.parse(tomb.deletedAt) + 3_600_000 });
      assert.deepEqual(old.abandoned.map((e) => e.memoryId), [ID]);
      assert.deepEqual(statuses(baseDbPath), ["attempted", "failed"]);
      assert.equal(blocks(baseDbPath), null, "the memory was never forgotten, so nothing blocks");
    } finally {
      await adapter.shutdown();
    }
  });

  it("a read error of the row is reported, never turned into a commit or a failure", async () => {
    const { baseDbPath } = await makeStore();
    const tomb = buildTombstone({ card: { id: ID, text: TEXT, scope: "agent-private" }, agentId: "main", actor: "t" });
    appendTombstoneToRegistry(baseDbPath, "main", { ...tomb, status: "attempted" });
    const adapter = { getCardRaw: async () => { throw new Error("lance exploded"); } };
    const report = await reconcileAttemptedTombstones({ baseDbPath, adapter, now: Date.parse(tomb.deletedAt) + 3_600_000 });
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0].error, /lance exploded/);
    assert.deepEqual(statuses(baseDbPath), ["attempted"]);
  });

  it("createEngine reconciles at startup (and close() waits for it)", { timeout: 90_000 }, async () => {
    const stateDir = makeTempDir("plur1bus-tomb-reconcile-eng-");
    const baseDbPath = freshBaseDbPath("tomb-reconcile-");
    const host = createStubHost({ stateDir, workspaceDir: async () => stateDir });
    const mk = () => prepareEngineSharedBase(createEngine(host, config(baseDbPath), { internals: { embeddings: flatEmbedder() } }));
    const first = mk();
    const id = await seedAndGetId(first, "anna", TEXT, "harbour");
    const adapter = internalsOf(first).memoryDbAdapter;
    const card = await adapter.getCardRaw("anna", id);
    // The crash: attempted line written, row soft-deleted, no committed line.
    const tomb = buildTombstone({ card, agentId: "anna", actor: "t" });
    appendTombstoneToRegistry(baseDbPath, "anna", { ...tomb, status: "attempted" });
    await adapter.tombstoneCard("anna", id);
    await first.close();
    assert.deepEqual(statuses(baseDbPath, "anna"), ["attempted"]);

    const second = mk();
    try {
      const deadline = Date.now() + 30_000;
      while (!statuses(baseDbPath, "anna").includes("committed") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(statuses(baseDbPath, "anna"), ["attempted", "committed"]);
    } finally {
      await second.close();
    }
  });
});
