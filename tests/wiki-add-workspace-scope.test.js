/**
 * tests/wiki-add-workspace-scope.test.js — audit engine-telegram F2:
 * `/wiki add` writes `scope: "workspace"`, so the row must live where every
 * other workspace row lives (the shared workspace pool), be visible to the
 * other agents of that workspace and not to another workspace. Legacy rows
 * already in an agent's private table stay readable and deletable.
 *
 * Real createEngine on temp LanceDB stores (flat stub embedder), like
 * tests/engine-memory-shared-ops.test.js.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { internalsOf } from "../engine/internals.js";
import { runWikiCommand } from "../lib/wiki-command.js";
import { SHARED_MEMORY_UNSUPPORTED } from "../lib/shared-memory-pool.js";
import { principal, setup, userAgent } from "./helpers/shared-workspace-engine.js";

const TIMEOUT = { timeout: 90_000 };
const FOUND = /\[Wiki\] Hafenmeister/;
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function wikiFor(engine, agentId, { sharedPool } = {}) {
  const internals = internalsOf(engine);
  const { memoryCtx, workspaceDir } = await internals.memoryOpsContext.resolve(principal(agentId), userAgent);
  const run = (args) => runWikiCommand({ args, messages: [] }, {
    pool: internals.pool,
    sharedPool: sharedPool ?? internals.sharedMemoryPool,
    embeddings: internals.embeddings,
    reranker: null,
    callLlm: null,
    cfg: {},
    api: { logger: quietLogger },
    llmCfg: null,
    ctx: memoryCtx,
    workspaceDir,
  });
  return { run, memoryCtx, internals };
}

const privateWikiRows = (internals, agentId) => internals.pool.withDb(agentId, async (db) => {
  await db.init();
  return db.table.query().where("memoryKind = 'wiki'").toArray();
});
const sharedWikiRows = (internals, memoryCtx) => internals.sharedMemoryPool.withWorkspaceReadDb(memoryCtx, async (db) => {
  if (!db) return [];
  await db.init();
  return db.table.query().where("memoryKind = 'wiki'").toArray();
});

describe("/wiki add scope=workspace (audit F2)", () => {
  it("stores in the shared workspace pool, visible to a second agent of the workspace", TIMEOUT, async () => {
    const { engine } = setup("wiki-f2-share-");
    try {
      const anna = await wikiFor(engine, "anna");
      const bernd = await wikiFor(engine, "bernd");
      const added = await anna.run("add Hafenmeister: Der Hafenmeister heisst Olsen und arbeitet montags.");
      assert.match(added.text, /Hafenmeister/);

      assert.equal((await privateWikiRows(anna.internals, "anna")).length, 0, "no wiki row in anna's private table");
      const shared = await sharedWikiRows(anna.internals, anna.memoryCtx);
      assert.equal(shared.length, 1, "one wiki row in the shared workspace pool");
      assert.equal(shared[0].scope, "workspace");
      assert.equal(shared[0].workspaceId, anna.memoryCtx.workspaceIdentity);
      assert.equal(shared[0].storedBy, "anna");

      const seenByBernd = await bernd.run("Hafenmeister");
      assert.match(seenByBernd.text, FOUND, seenByBernd.text);
      const seenByAnna = await anna.run("Hafenmeister");
      assert.match(seenByAnna.text, FOUND, "the author still finds it");

      const duplicate = await bernd.run("add Hafenmeister: Der Hafenmeister heisst Olsen und arbeitet montags.");
      assert.match(duplicate.text, /Similar entry already exists|Ähnlicher Eintrag/, "bernd's duplicate check sees the shared row");
      assert.equal((await sharedWikiRows(anna.internals, anna.memoryCtx)).length, 1);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("stays invisible to another workspace", TIMEOUT, async () => {
    const { engine } = setup("wiki-f2-foreign-");
    try {
      const anna = await wikiFor(engine, "anna");
      const carol = await wikiFor(engine, "carol");
      assert.notEqual(anna.memoryCtx.workspaceIdentity, carol.memoryCtx.workspaceIdentity);
      await anna.run("add Hafenmeister: Der Hafenmeister heisst Olsen.");
      const result = await carol.run("Hafenmeister");
      assert.doesNotMatch(result.text, FOUND);
      assert.match(result.text, /No entry found|Kein/);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("deletes a shared wiki row by id and by query for any agent of the workspace", TIMEOUT, async () => {
    const { engine } = setup("wiki-f2-delete-");
    try {
      const anna = await wikiFor(engine, "anna");
      const bernd = await wikiFor(engine, "bernd");
      await anna.run("add Hafenmeister: Der Hafenmeister heisst Olsen.");
      const [row] = await sharedWikiRows(anna.internals, anna.memoryCtx);
      const byId = await bernd.run(`delete id:${row.id}`);
      assert.match(byId.text, /deleted|gelöscht/i, byId.text);
      assert.equal((await sharedWikiRows(anna.internals, anna.memoryCtx)).length, 0);
      assert.doesNotMatch((await anna.run("Hafenmeister")).text, FOUND);

      await anna.run("add Lotse: Der Lotse heisst Berg.");
      assert.equal((await sharedWikiRows(anna.internals, anna.memoryCtx)).length, 1);
      await anna.run("delete Lotse");
      assert.equal((await sharedWikiRows(anna.internals, anna.memoryCtx)).length, 0);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("keeps legacy workspace wiki rows in the private table findable and deletable", TIMEOUT, async () => {
    const { engine } = setup("wiki-f2-legacy-");
    try {
      const anna = await wikiFor(engine, "anna");
      const id = randomUUID();
      await anna.internals.pool.withDb("anna", async (db) => {
        await db.init();
        const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
        await db.store({
          id, text: "Hafenmeister: Altbestand Olsen", summary: "[Wiki] Hafenmeister", origin: "note", vector,
          importance: 0.9, category: "knowledge", memoryKind: "wiki", createdAt: Date.now(), mergedFrom: "[]", expiresAt: 0,
          agentId: "anna", storedBy: "anna", scope: "workspace",
          workspaceId: anna.memoryCtx.workspaceIdentity, workspaceKey: anna.memoryCtx.workspaceIdentity, ownerUserId: "",
        });
      });
      assert.match((await anna.run("Hafenmeister")).text, FOUND);
      await anna.run(`delete id:${id}`);
      assert.equal((await privateWikiRows(anna.internals, "anna")).length, 0);
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });

  it("keeps the private-table placement where shared memory is unsupported, but never hides other shared failures", TIMEOUT, async () => {
    const { engine } = setup("wiki-f2-fallback-");
    try {
      const unsupported = Object.assign(new Error("shared memory is not supported on this platform"), { code: SHARED_MEMORY_UNSUPPORTED });
      const anna = await wikiFor(engine, "anna", { sharedPool: {
        withWorkspaceDb: async () => { throw unsupported; },
        withWorkspaceReadDb: async () => { throw unsupported; },
      } });
      assert.match((await anna.run("add Hafenmeister: Der Hafenmeister heisst Olsen.")).text, /Hafenmeister/);
      assert.equal((await privateWikiRows(anna.internals, "anna")).length, 1, "stored privately as before");
      assert.match((await anna.run("Hafenmeister")).text, FOUND, "and still found");

      const broken = await wikiFor(engine, "bernd", { sharedPool: {
        withWorkspaceDb: async () => { throw new Error("shared storage exploded"); },
        withWorkspaceReadDb: async (_ctx, fn) => fn(null),
      } });
      const failed = await broken.run("add Lotse: Der Lotse heisst Berg.");
      assert.match(failed.text, /exploded/);
      assert.equal((await privateWikiRows(broken.internals, "bernd")).length, 0, "a failing shared write does not fall back silently");
    } finally {
      await engine.close({ budgetMs: 5_000 });
    }
  });
});
