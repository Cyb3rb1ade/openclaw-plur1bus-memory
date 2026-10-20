/**
 * tests/engine-memory-import-ledger-consistency.test.js — audit engine-import-adapters
 * (2026-10-19): the import result, the store and the `_imports/` ledger must agree.
 *
 *  1. a batch duplicate shares the fate of the first entry with its key
 *  2. a ledger write failure never leaves a card reported `created` yet invisible to unimport
 *  3. unimport re-checks the row after the archive, before it writes intent and tombstone
 *  4. a backfilled ledger line never freezes a user's edit as the unimport baseline
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { importCardId } from "../engine/memory-ops/import-id.js";
import { importLedgerPath } from "../engine/memory-ops/import-ledger.js";
import { unimportLedgerPath } from "../engine/memory-ops/unimport-ledger.js";
import { memoryOpError } from "../engine/memory-ops/errors.js";
import { createStubHost } from "../lib/host-services.js";
import { config, flatEmbedder, freshBaseDbPath, principal, setup } from "./helpers/shared-workspace-engine.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const TIMEOUT = { timeout: 90_000 };
const AGENT = "anna";
const systemAgent = { origin: "system", background: false };
const idOf = (key) => importCardId(AGENT, key);

const card = (key, extra = {}) => ({
  idempotencyKey: key,
  text: `The garden shed fact number ${key} is distinct`,
  provenance: "imported",
  sourceRef: `hermes:MEMORY.md#${key}`,
  ...extra,
});

function importRun(engine, runId, cards) {
  const req = { agentId: AGENT, principal: principal(AGENT), cards };
  if (runId) req.importRunId = runId;
  return engine.memory.import(req, principal(AGENT), systemAgent);
}

function unimport(engine, runId, extra = {}) {
  return engine.memory.unimport({ agentId: AGENT, importRunId: runId, dryRun: false, ...extra }, principal(AGENT), systemAgent);
}

const withDb = (engine, fn) => internalsOf(engine).pool.withWriteDb(AGENT, async (db) => {
  await db.init();
  return fn(db);
});
const rowOf = (engine, id) => withDb(engine, (db) => db.getById(id));

function ledgerLines(baseDbPath) {
  const path = importLedgerPath(baseDbPath, AGENT);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function engineWithEmbedder(prefix, embeddings) {
  return createEngine(
    createStubHost({ stateDir: makeTempDir(`${prefix}state-`) }),
    config(freshBaseDbPath(prefix)),
    { internals: { embeddings } },
  );
}

describe("memory.import: batch duplicates follow the first entry", () => {
  it("first entry rejected (embed failure) → the duplicate is rejected too, nothing is claimed as existing", TIMEOUT, async () => {
    const embeddings = { ...flatEmbedder(), embedBatch: async () => { throw new Error("embed backend down"); } };
    const engine = engineWithEmbedder("imp-dup-fail-", embeddings);
    const res = await importRun(engine, "runD", [card("k1"), card("k1")]);
    assert.deepEqual(res.cards.map((c) => c.outcome), ["rejected", "rejected"]);
    assert.deepEqual(res.cards.map((c) => c.reason), ["storage", "storage"]);
    assert.equal(res.created, 0);
    assert.equal(res.matchedExisting, 0);
    assert.equal(res.rejected, 2);
    assert.equal(await rowOf(engine, idOf("k1")), null);
    await engine.close({ budgetMs: 5_000 });
  });

  it("first entry created → the duplicate is matched-existing/duplicate-in-batch with the card's id", TIMEOUT, async () => {
    const { engine } = setup("imp-dup-ok-");
    const res = await importRun(engine, "runD", [card("k1"), card("k1"), card("k2")]);
    assert.deepEqual(res.cards.map((c) => c.outcome), ["created", "matched-existing", "created"]);
    assert.equal(res.cards[1].reason, "duplicate-in-batch");
    assert.equal(res.cards[1].id, idOf("k1"));
    assert.equal(res.created, 2);
    assert.equal(res.matchedExisting, 1);
    assert.equal((await rowOf(engine, idOf("k1"))).status, "active");
    await engine.close({ budgetMs: 5_000 });
  });

  it("dryRun keeps the answer; an invalid first entry does not shadow a valid later entry with the same key", TIMEOUT, async () => {
    const { engine } = setup("imp-dup-dry-");
    const dry = await engine.memory.import(
      { agentId: AGENT, principal: principal(AGENT), cards: [card("k1"), card("k1")], dryRun: true },
      principal(AGENT),
      systemAgent,
    );
    assert.deepEqual(dry.cards.map((c) => c.outcome), ["created", "matched-existing"]);
    assert.equal(dry.cards[1].reason, "duplicate-in-batch");
    const bad = await importRun(engine, "runE", [{ ...card("k9"), provenance: "dm" }, card("k9")]);
    assert.deepEqual(bad.cards.map((c) => c.outcome), ["rejected", "created"]);
    assert.equal(bad.cards[0].reason, "provenance-not-imported");
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("memory.import: a failed ledger write is not reported as created", () => {
  it("ledger append fails after the store → rejected/storage, the card is taken back, the retry creates it and unimport sees it", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("imp-ledfail-");
    const { ledger } = internalsOf(engine).memoryImport;
    const realAppend = ledger.append;
    ledger.append = () => { throw memoryOpError("storage", "import ledger write failed"); };
    const failed = await importRun(engine, "runL", [card("k1")]);
    ledger.append = realAppend;
    assert.equal(failed.cards[0].outcome, "rejected");
    assert.equal(failed.cards[0].reason, "storage");
    assert.equal(failed.created, 0);
    assert.equal(await rowOf(engine, idOf("k1")), null, "the card must not stay live without a ledger line");
    assert.equal(ledgerLines(baseDbPath).length, 0);

    const retry = await importRun(engine, "runL", [card("k1")]);
    assert.equal(retry.cards[0].outcome, "created");
    const dry = await unimport(engine, "runL", { dryRun: true });
    assert.equal(dry.selected, 1);
    const applied = await unimport(engine, "runL");
    assert.equal(applied.unimported, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("ledger and take-back both fail → still rejected (never created); the retry heals the line and the run can undo the card", TIMEOUT, async () => {
    const { engine } = setup("imp-ledfail2-");
    const { ledger } = internalsOf(engine).memoryImport;
    const realAppend = ledger.append;
    ledger.append = () => { throw memoryOpError("storage", "import ledger write failed"); };
    await withDb(engine, async (db) => { db.delete = async () => { throw new Error("delete refused"); }; });
    const failed = await importRun(engine, "runL", [card("k1")]);
    ledger.append = realAppend;
    await withDb(engine, async (db) => { delete db.delete; });
    assert.equal(failed.cards[0].outcome, "rejected");
    assert.equal(failed.created, 0);
    assert.equal((await rowOf(engine, idOf("k1"))).status, "active");

    const retry = await importRun(engine, "runL", [card("k1")]);
    assert.equal(retry.cards[0].outcome, "matched-existing");
    const applied = await unimport(engine, "runL");
    assert.equal(applied.selected, 1);
    assert.equal(applied.unimported, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("healthy ledger: created cards have a line with run id and digest (counter-test)", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("imp-ledok-");
    const res = await importRun(engine, "runL", [card("k1")]);
    assert.equal(res.cards[0].outcome, "created");
    const lines = ledgerLines(baseDbPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].importRunId, "runL");
    assert.ok(lines[0].digest);
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("memory.unimport: the row is re-checked before intent and tombstone", () => {
  it("a user edit between the decision and the soft delete keeps the card (kept-modified), no intent, no unimported line", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-toctou-");
    await importRun(engine, "runT", [card("k1"), card("k2")]);
    const { hooks } = internalsOf(engine).memoryUnimport;
    hooks.afterArchive = async (cardId, db) => {
      if (cardId === idOf("k1")) await db.update(cardId, { text: "the user rewrote this card meanwhile" });
    };
    const res = await unimport(engine, "runT");
    delete hooks.afterArchive;
    const k1 = res.cards.find((c) => c.idempotencyKey === "k1");
    assert.equal(k1.outcome, "kept-modified");
    assert.equal(k1.reason, "content-changed");
    assert.equal(res.unimported, 1);
    assert.equal(res.keptModified, 1);
    const row = await rowOf(engine, idOf("k1"));
    assert.equal(row.status, "active");
    assert.equal(row.text, "the user rewrote this card meanwhile");
    assert.equal(ledgerLines(baseDbPath).some((l) => l.kind === "unimported" && l.cardId === idOf("k1")), false);
    const sidecar = unimportLedgerPath(baseDbPath, AGENT, "runT");
    const sidecarLines = readFileSync(sidecar, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(sidecarLines.some((l) => l.kind === "intent" && l.cardId === idOf("k1")), false);
    assert.equal((await rowOf(engine, idOf("k2"))).status, "deleted");
    await engine.close({ budgetMs: 5_000 });
  });

  it("an edit during a forced run is still kept (a rerun with force undoes it)", TIMEOUT, async () => {
    const { engine } = setup("unimp-toctou2-");
    await importRun(engine, "runT", [card("k1")]);
    const { hooks } = internalsOf(engine).memoryUnimport;
    hooks.afterArchive = async (cardId, db) => { await db.update(cardId, { text: "edited during the run" }); };
    const raced = await unimport(engine, "runT", { force: true });
    delete hooks.afterArchive;
    assert.equal(raced.unimported, 0);
    assert.equal(raced.keptModified, 1);
    assert.equal((await rowOf(engine, idOf("k1"))).status, "active");
    const forced = await unimport(engine, "runT", { force: true });
    assert.equal(forced.unimported, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("no concurrent change: the card is unimported as before", TIMEOUT, async () => {
    const { engine } = setup("unimp-toctou3-");
    await importRun(engine, "runT", [card("k1")]);
    const calls = [];
    internalsOf(engine).memoryUnimport.hooks.afterArchive = async (cardId) => { calls.push(cardId); };
    const res = await unimport(engine, "runT");
    delete internalsOf(engine).memoryUnimport.hooks.afterArchive;
    assert.deepEqual(calls, [idOf("k1")]);
    assert.equal(res.unimported, 1);
    assert.equal((await rowOf(engine, idOf("k1"))).status, "deleted");
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("memory.import: backfill never freezes a user change as the baseline", () => {
  it("run A's ledger line is lost, the user edits, run B re-imports → unimport(B) keeps the edited card", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("imp-backfill-");
    await importRun(engine, "runA", [card("txt"), card("meta"), card("raw")]);
    rmSync(importLedgerPath(baseDbPath, AGENT), { force: true });
    await withDb(engine, async (db) => {
      // user paths bump updatedAt (safe-update); a raw write does not — the text check covers it
      await db.update(idOf("txt"), { text: "edited by the user", updatedAt: Date.now() + 5 });
      await db.update(idOf("meta"), { importance: 0.99, updatedAt: Date.now() + 5 });
      await db.update(idOf("raw"), { text: "edited without an updatedAt bump" });
    });
    const b = await importRun(engine, "runB", [card("txt"), card("meta"), card("raw")]);
    assert.equal(b.matchedExisting, 3);
    const res = await unimport(engine, "runB");
    assert.equal(res.unimported, 0);
    assert.equal(res.keptModified, 3);
    assert.ok(res.cards.every((c) => c.reason === "edited"));
    for (const k of ["txt", "meta", "raw"]) assert.equal((await rowOf(engine, idOf(k))).status, "active");
    await engine.close({ budgetMs: 5_000 });
  });

  it("crash between store and ledger, retry of the same run, card untouched → still rolled back by that run (counter-test)", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("imp-backfill2-");
    const first = await importRun(engine, "runA", [card("k1")]);
    assert.equal(first.created, 1);
    const before = await rowOf(engine, idOf("k1"));
    rmSync(importLedgerPath(baseDbPath, AGENT), { force: true });
    const retry = await importRun(engine, "runA", [card("k1")]);
    assert.equal(retry.cards[0].outcome, "matched-existing");
    const line = ledgerLines(baseDbPath)[0];
    assert.equal(line.backfilled, true);
    assert.equal(line.importRunId, "runA");
    assert.equal(line.importedAt, Number(before.sourceTimestamp), "importedAt is the card's creation time, not the retry time");
    assert.ok(line.digest);
    const res = await unimport(engine, "runA");
    assert.equal(res.unimported, 1);
    assert.equal((await rowOf(engine, idOf("k1"))).status, "deleted");
    await engine.close({ budgetMs: 5_000 });
  });

  it("an edited card is still undone with force (the owner decides)", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("imp-backfill3-");
    await importRun(engine, "runA", [card("k1")]);
    rmSync(importLedgerPath(baseDbPath, AGENT), { force: true });
    await withDb(engine, (db) => db.update(idOf("k1"), { text: "edited by the user", updatedAt: Date.now() + 5 }));
    await importRun(engine, "runB", [card("k1")]);
    assert.equal((await unimport(engine, "runB")).keptModified, 1);
    const forced = await unimport(engine, "runB", { force: true });
    assert.equal(forced.unimported, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("a row whose own sourceRef names run X is attributed to X, not to the retrying run B", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("imp-backfill4-");
    const cardX = card("k1", { sourceRef: "hermes:MEMORY.md#1;run=runX" });
    await importRun(engine, null, [cardX]);
    rmSync(importLedgerPath(baseDbPath, AGENT), { force: true });
    await importRun(engine, "runB", [cardX]);
    assert.equal((await unimport(engine, "runB")).selected, 0);
    const x = await unimport(engine, "runX");
    assert.equal(x.selected, 1);
    assert.equal(x.unimported, 1);
    await engine.close({ budgetMs: 5_000 });
  });
});
