/**
 * tests/engine-memory-unimport.test.js — contract 1.13.0 `Engine.memory.unimport`.
 *
 * Real createEngine on temp stores, stub embedder, hard timeouts. Results are
 * checked against the raw rows (`getById`), the `_imports/` ledger and the
 * `_unimports/` sidecar, not counters alone.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, relative } from "node:path";

import { internalsOf } from "../engine/internals.js";
import { importCardId } from "../engine/memory-ops/import-id.js";
import { importLedgerPath } from "../engine/memory-ops/import-ledger.js";
import { importLockPath, withImportLock } from "../engine/memory-ops/import-lock.js";
import { createRebindLedger } from "../engine/memory-ops/rebind-ledger.js";
import { unimportLedgerPath } from "../engine/memory-ops/unimport-ledger.js";
import { readTombstonesFromRegistry } from "../lib/tombstone.js";
import { createEngine } from "../engine/create-engine.js";
import { createStubHost } from "../lib/host-services.js";
import { config, flatEmbedder, freshBaseDbPath, principal, setup, userAgent } from "./helpers/shared-workspace-engine.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import { prepareEngineSharedBase } from "./helpers/win32-shared-owner.js";

const TIMEOUT = { timeout: 90_000 };
const SENTINEL = "UNIMPORT_SENTINEL_9C1E";
const systemAgent = { origin: "system", background: false };
const AGENT = "anna";

function cardsFor(keys) {
  return keys.map((k) => ({
    idempotencyKey: k,
    text: `${SENTINEL} the garden shed fact number ${k} is distinct`,
    provenance: "imported",
    sourceRef: `hermes:${SENTINEL}:${k}`,
  }));
}

async function importRun(engine, runId, keys, extra = {}) {
  const req = { agentId: AGENT, principal: principal(AGENT), cards: cardsFor(keys), ...extra };
  if (runId) req.importRunId = runId;
  return engine.memory.import(req, principal(AGENT), systemAgent);
}

function unimport(engine, runId, extra = {}) {
  return engine.memory.unimport({ agentId: AGENT, importRunId: runId, dryRun: false, ...extra }, principal(AGENT), systemAgent);
}

async function rowOf(engine, id) {
  return internalsOf(engine).pool.withWriteDb(AGENT, async (db) => {
    await db.init();
    return db.getById(id);
  });
}

const idOf = (key) => importCardId(AGENT, key);

function ledgerLines(baseDbPath) {
  const path = importLedgerPath(baseDbPath, AGENT);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function sidecarLines(baseDbPath, runId) {
  const path = unimportLedgerPath(baseDbPath, AGENT, runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function treeHash(root, { skip = [] } = {}) {
  const h = createHash("sha256");
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      const st = statSync(full);
      if (st.isDirectory()) {
        h.update(`d:${rel}\n`);
        walk(full);
      } else {
        h.update(`f:${rel}:`);
        h.update(readFileSync(full));
      }
    }
  };
  walk(root);
  return h.digest("hex");
}

function stealImportLock(baseDbPath) {
  writeFileSync(importLockPath(baseDbPath, AGENT), JSON.stringify({
    nonce: "stolen", pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(),
  }));
}

function unlinkStolenLock(baseDbPath) {
  try { unlinkSync(importLockPath(baseDbPath, AGENT)); } catch { /* gone */ }
}

const code = (c) => (err) => err?.name === "MemoryOpError" && err.code === c;

function collectingLogger() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, logger: { info: push, warn: push, error: push, debug: push } };
}

describe("Engine.memory.unimport (contract 1.13.0)", () => {
  it("T1/T3: undoes only the cards this run created; overlap and other runs stay; the key filter never widens", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t1-");
    const a = await importRun(engine, "runA", ["k1", "k2", "k3"]);
    assert.equal(a.created, 3);
    const b = await importRun(engine, "runB", ["k3", "k4", "k5"]);
    assert.equal(b.created, 2);
    assert.equal(b.matchedExisting, 1);

    const filtered = await unimport(engine, "runB", { idempotencyKeys: ["k1"] });
    assert.equal(filtered.selected, 0);
    assert.equal((await rowOf(engine, idOf("k1"))).status, "active");

    const res = await unimport(engine, "runB");
    assert.equal(res.selected, 2);
    assert.equal(res.unimported, 2);
    assert.deepEqual(res.cards.map((c) => c.idempotencyKey).sort(), ["k4", "k5"]);
    for (const k of ["k4", "k5"]) assert.equal((await rowOf(engine, idOf(k))).status, "deleted");
    for (const k of ["k1", "k2", "k3"]) assert.equal((await rowOf(engine, idOf(k))).status, "active");
    const freed = ledgerLines(baseDbPath).filter((l) => l.kind === "unimported");
    assert.deepEqual(freed.map((l) => l.idempotencyKey).sort(), ["k4", "k5"]);
    assert.ok(freed.every((l) => l.importRunId === "runB"));
    await engine.close({ budgetMs: 5_000 });
  });

  it("T5: dryRun is the default, writes nothing (tree hash) and predicts apply exactly", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t5-");
    await importRun(engine, "runD", ["d1", "d2"]);
    await internalsOf(engine).pool.withWriteDb(AGENT, (db) => db.update(idOf("d2"), { text: "edited by the user afterwards" }));
    const before = treeHash(baseDbPath);
    const dry = await engine.memory.unimport({ agentId: AGENT, importRunId: "runD" }, principal(AGENT), systemAgent);
    assert.equal(dry.dryRun, true);
    assert.equal(treeHash(baseDbPath), before, "dryRun changed the store tree");
    assert.equal(existsSync(join(baseDbPath, "_unimports")), false);
    assert.equal((await rowOf(engine, idOf("d1"))).status, "active");
    const applied = await unimport(engine, "runD");
    const strip = (r) => ({ ...r, dryRun: null });
    assert.deepEqual(strip(dry), strip(applied));
    assert.equal(applied.unimported, 1);
    assert.equal(applied.keptModified, 1);
    assert.equal(applied.cards.find((c) => c.idempotencyKey === "d2").reason, "content-changed");
    await engine.close({ budgetMs: 5_000 });
  });

  it("T4: a second apply changes nothing and reports already-unimported", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t4-");
    await importRun(engine, "runI", ["i1", "i2", "i3"]);
    const first = await unimport(engine, "runI");
    assert.equal(first.unimported, 3);
    const skip = ["_imports/.locks"];
    const before = treeHash(baseDbPath, { skip });
    const second = await unimport(engine, "runI");
    assert.equal(second.alreadyUnimported, 3);
    assert.equal(second.unimported, 0);
    assert.equal(treeHash(baseDbPath, { skip }), before, "rerun wrote to the store tree");
    assert.equal(ledgerLines(baseDbPath).filter((l) => l.kind === "unimported").length, 3);
    await engine.close({ budgetMs: 5_000 });
  });

  it("T7: a forgotten card stays forgotten: untouched, registry unchanged, re-import still refused", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t7-");
    await importRun(engine, "runF", ["f1", "f2"]);
    await engine.memory.forget(idOf("f1"), principal(AGENT), userAgent);
    const tombsBefore = readTombstonesFromRegistry(baseDbPath, AGENT).length;
    const res = await unimport(engine, "runF");
    assert.equal(res.alreadyForgotten, 1);
    assert.equal(res.unimported, 1);
    assert.equal(readTombstonesFromRegistry(baseDbPath, AGENT).length, tombsBefore);
    assert.equal(ledgerLines(baseDbPath).some((l) => l.kind === "unimported" && l.idempotencyKey === "f1"), false);
    const again = await importRun(engine, "runF2", ["f1"]);
    assert.equal(again.cards[0].outcome, "rejected");
    await engine.close({ budgetMs: 5_000 });
  });

  it("T8 (ruling a): after unimport a re-import of the same key creates it again, same id; no tombstone was written", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t8-");
    await importRun(engine, "runR", ["r1"]);
    const tombsBefore = readTombstonesFromRegistry(baseDbPath, AGENT).length;
    await unimport(engine, "runR");
    assert.equal(readTombstonesFromRegistry(baseDbPath, AGENT).length, tombsBefore);
    const again = await importRun(engine, "runR2", ["r1"]);
    assert.equal(again.cards[0].outcome, "created");
    assert.equal(again.cards[0].id, idOf("r1"));
    assert.equal((await rowOf(engine, idOf("r1"))).status, "active");
    // The same text under another key is not tombstone-blocked either.
    const other = await engine.memory.import(
      { agentId: AGENT, principal: principal(AGENT), cards: [{ ...cardsFor(["r1"])[0], idempotencyKey: "r1-other" }] },
      principal(AGENT), systemAgent,
    );
    assert.equal(other.cards[0].outcome, "created");
    // Rolling back the first run again does not touch the re-imported card.
    const rerun = await unimport(engine, "runR");
    assert.equal(rerun.alreadyUnimported, 1);
    assert.equal((await rowOf(engine, idOf("r1"))).status, "active");
    // ...and rolling back the second run undoes it.
    const second = await unimport(engine, "runR2");
    assert.equal(second.unimported, 1);
    assert.equal((await rowOf(engine, idOf("r1"))).status, "deleted");
    await engine.close({ budgetMs: 5_000 });
  });

  it("T6: kept cards keep their exact row; superseded, content, metadata, binding, rebound and shared are reported", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t6-");
    await importRun(engine, "runK", ["sup", "txt", "imp", "own", "reb", "shr", "ok"]);
    const pool = internalsOf(engine).pool;
    await engine.memory.correct(idOf("sup"), "a corrected garden shed fact", principal(AGENT), userAgent);
    await pool.withWriteDb(AGENT, async (db) => {
      await db.update(idOf("txt"), { text: "changed garden shed text" });
      await db.update(idOf("imp"), { importance: 0.99 });
      await db.update(idOf("own"), { ownerUserId: `user:v1:${"b".repeat(64)}` });
    });
    const rebinds = createRebindLedger({ baseDbPath });
    const rebindId = "11111111-2222-4333-8444-555555555555";
    rebinds.writeHeader(rebindId, { agentId: AGENT, fromOwner: `user:v1:${"c".repeat(64)}`, toOwner: `user:v2:${"d".repeat(64)}`, createdAt: 1 });
    rebinds.appendCard(rebindId, { cardId: idOf("reb"), fromOwner: "x", toOwner: "y", fromUpdatedAt: 0 });
    await engine.memory.share(idOf("shr"), "workspace", principal(AGENT), userAgent);

    const keptIds = ["sup", "txt", "imp", "own", "reb", "shr"].map(idOf);
    const rowsBefore = new Map();
    for (const id of keptIds) rowsBefore.set(id, JSON.stringify(await rowOf(engine, id)));

    const res = await unimport(engine, "runK", { force: true });
    const reasons = Object.fromEntries(res.cards.map((c) => [c.idempotencyKey, c.outcome === "kept-modified" ? c.reason : c.outcome]));
    assert.deepEqual(reasons, {
      sup: "superseded",
      txt: "unimported", // force overrides content-changed
      imp: "unimported", // force overrides metadata-changed
      own: "binding-changed",
      reb: "rebound",
      shr: "shared",
      ok: "unimported",
    });
    for (const id of ["sup", "own", "reb", "shr"].map(idOf)) {
      assert.equal(JSON.stringify(await rowOf(engine, id)), rowsBefore.get(id), `kept row ${id} was rewritten`);
    }
    await engine.close({ budgetMs: 5_000 });
  });

  it("T6 without force: content-changed and metadata-changed are kept and untouched", TIMEOUT, async () => {
    const { engine } = setup("unimp-t6b-");
    await importRun(engine, "runM", ["txt", "imp"]);
    await internalsOf(engine).pool.withWriteDb(AGENT, async (db) => {
      await db.update(idOf("txt"), { text: "changed garden shed text" });
      await db.update(idOf("imp"), { importance: 0.99 });
    });
    const before = JSON.stringify(await rowOf(engine, idOf("imp")));
    const res = await unimport(engine, "runM");
    assert.equal(res.keptModified, 2);
    assert.deepEqual(res.cards.map((c) => c.reason).sort(), ["content-changed", "metadata-changed"]);
    assert.equal(JSON.stringify(await rowOf(engine, idOf("imp"))), before);
    await engine.close({ budgetMs: 5_000 });
  });

  it("T6b: machine-maintained fields (retrieval, strength) do not count as modified", TIMEOUT, async () => {
    const { engine } = setup("unimp-t6c-");
    await importRun(engine, "runS", ["s1"]);
    await internalsOf(engine).pool.withWriteDb(AGENT, (db) => db.update(idOf("s1"), {
      retrievalCount: 7, lastRetrievedAt: Date.now(), memoryStrength: 2.5,
    }));
    const res = await unimport(engine, "runS");
    assert.equal(res.unimported, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("legacy and digest-less lines: no importRunId → not selectable; a digest-less line with moved updatedAt is kept as edited unless forced", TIMEOUT, async () => {
    const { engine } = setup("unimp-legacy-");
    await importRun(engine, null, ["l1"]);
    assert.equal((await unimport(engine, "runL")).selected, 0);
    internalsOf(engine).memoryImport.ledger.append(AGENT, {
      idempotencyKey: "l1", cardId: idOf("l1"), importedAt: 1, sourceRef: "", importRunId: "runL",
    });
    const kept = await unimport(engine, "runL");
    assert.equal(kept.cards[0].reason, "edited");
    const forced = await unimport(engine, "runL", { force: true });
    assert.equal(forced.unimported, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("T9: crash after the intent line, rerun converges (one intent, one done, key freed once)", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t9-");
    await importRun(engine, "runC", ["c1"]);
    const hooks = internalsOf(engine).memoryUnimport.hooks;
    hooks.afterIntent = () => { throw new Error("simulated crash"); };
    await assert.rejects(() => unimport(engine, "runC"));
    delete hooks.afterIntent;
    assert.equal((await rowOf(engine, idOf("c1"))).status, "active");
    const res = await unimport(engine, "runC");
    assert.equal(res.unimported, 1);
    assert.equal((await rowOf(engine, idOf("c1"))).status, "deleted");
    const lines = sidecarLines(baseDbPath, "runC");
    assert.equal(lines.filter((l) => l.kind === "done").length, 1);
    assert.equal(ledgerLines(baseDbPath).filter((l) => l.kind === "unimported").length, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("T10: crash after the soft delete (before the key is freed), rerun frees it; re-import creates", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t10-");
    await importRun(engine, "runC2", ["c2"]);
    const hooks = internalsOf(engine).memoryUnimport.hooks;
    hooks.afterTombstone = () => { throw new Error("simulated crash"); };
    await assert.rejects(() => unimport(engine, "runC2"));
    delete hooks.afterTombstone;
    assert.equal((await rowOf(engine, idOf("c2"))).status, "deleted");
    assert.equal(ledgerLines(baseDbPath).some((l) => l.kind === "unimported"), false);
    const res = await unimport(engine, "runC2");
    assert.equal(res.unimported, 1);
    assert.equal(ledgerLines(baseDbPath).filter((l) => l.kind === "unimported").length, 1);
    const again = await importRun(engine, "runC3", ["c2"]);
    assert.equal(again.cards[0].outcome, "created");
    await engine.close({ budgetMs: 5_000 });
  });

  it("crash after the key is freed (before done): rerun does not write a second unimported line", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-t10b-");
    await importRun(engine, "runC4", ["c4"]);
    const hooks = internalsOf(engine).memoryUnimport.hooks;
    hooks.afterLedger = () => { throw new Error("simulated crash"); };
    await assert.rejects(() => unimport(engine, "runC4"));
    delete hooks.afterLedger;
    const res = await unimport(engine, "runC4");
    assert.equal(res.unimported, 1);
    assert.equal(ledgerLines(baseDbPath).filter((l) => l.kind === "unimported").length, 1);
    assert.equal(sidecarLines(baseDbPath, "runC4").filter((l) => l.kind === "done").length, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("T11: a row gone without our intent is missing and its key stays blocked", TIMEOUT, async () => {
    const { engine } = setup("unimp-t11-");
    await importRun(engine, "runG", ["g1"]);
    await internalsOf(engine).pool.withWriteDb(AGENT, (db) => db.delete(idOf("g1")));
    const res = await unimport(engine, "runG");
    assert.equal(res.missing, 1);
    const again = await importRun(engine, "runG2", ["g1"]);
    assert.equal(again.cards[0].reason, "previously-imported-deleted");
    await engine.close({ budgetMs: 5_000 });
  });

  it("fence: lock lost after the intent → lock-lost, no store write; rerun converges", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-fence1-");
    await importRun(engine, "runL1", ["x1", "x2"]);
    const hooks = internalsOf(engine).memoryUnimport.hooks;
    hooks.afterIntent = () => stealImportLock(baseDbPath);
    await assert.rejects(() => unimport(engine, "runL1"), code("lock-lost"));
    delete hooks.afterIntent;
    assert.equal((await rowOf(engine, idOf("x1"))).status, "active", "store written after lock loss");
    assert.equal((await rowOf(engine, idOf("x2"))).status, "active");
    assert.equal(ledgerLines(baseDbPath).some((l) => l.kind === "unimported"), false);
    unlinkStolenLock(baseDbPath);
    const res = await unimport(engine, "runL1");
    assert.equal(res.unimported, 2);
    await engine.close({ budgetMs: 5_000 });
  });

  it("fence: lock lost after the soft delete → lock-lost, key not freed, later cards untouched; rerun converges", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-fence2-");
    await importRun(engine, "runL2", ["y1", "y2", "y3"]);
    const hooks = internalsOf(engine).memoryUnimport.hooks;
    let tombstones = 0;
    hooks.afterTombstone = () => { tombstones += 1; stealImportLock(baseDbPath); };
    await assert.rejects(() => unimport(engine, "runL2"), code("lock-lost"));
    delete hooks.afterTombstone;
    assert.equal(tombstones, 1);
    assert.equal(ledgerLines(baseDbPath).some((l) => l.kind === "unimported"), false, "ledger written after lock loss");
    const statuses = [];
    for (const k of ["y1", "y2", "y3"]) statuses.push((await rowOf(engine, idOf(k))).status);
    assert.equal(statuses.filter((s) => s === "deleted").length, 1);
    unlinkStolenLock(baseDbPath);
    const res = await unimport(engine, "runL2");
    assert.equal(res.unimported, 3);
    assert.equal(ledgerLines(baseDbPath).filter((l) => l.kind === "unimported").length, 3);
    await engine.close({ budgetMs: 5_000 });
  });

  it("respects the import lock: a held lock → lock-busy, nothing written", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-busy-");
    await importRun(engine, "runB1", ["b1"]);
    const lockOpts = internalsOf(engine).memoryUnimport.importLock;
    lockOpts.timeoutMs = 200;
    let release;
    const held = new Promise((r) => { release = r; });
    const holder = withImportLock(baseDbPath, AGENT, () => held);
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(() => unimport(engine, "runB1"), code("lock-busy"));
    assert.equal((await rowOf(engine, idOf("b1"))).status, "active");
    release();
    await holder;
    delete lockOpts.timeoutMs;
    assert.equal((await unimport(engine, "runB1")).unimported, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("AbortSignal: aborted before the call → nothing written, remaining = selected", TIMEOUT, async () => {
    const { engine } = setup("unimp-abort-");
    await importRun(engine, "runAb", ["a1", "a2"]);
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await unimport(engine, "runAb", { signal: ctrl.signal });
    assert.equal(res.remaining, 2);
    assert.equal(res.unimported, 0);
    assert.equal((await rowOf(engine, idOf("a1"))).status, "active");
    await engine.close({ budgetMs: 5_000 });
  });

  it("a corrupt sidecar (no complete line) is quarantined → ledger-corrupt before any store write", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-corrupt-");
    await importRun(engine, "runZ", ["z1"]);
    const path = unimportLedgerPath(baseDbPath, AGENT, "runZ");
    mkdirSync(join(baseDbPath, "_unimports", AGENT), { recursive: true });
    writeFileSync(path, "{\"v\":1,\"kind\":\"hea");
    await assert.rejects(() => unimport(engine, "runZ"), code("ledger-corrupt"));
    assert.equal(existsSync(path), false);
    assert.ok(readdirSync(join(baseDbPath, "_unimports", AGENT)).some((n) => n.includes(".corrupt-")));
    assert.equal((await rowOf(engine, idOf("z1"))).status, "active");
    await engine.close({ budgetMs: 5_000 });
  });

  it("T13: no card text or sourceRef in results, logs or the sidecar", TIMEOUT, async () => {
    const { logger, lines } = collectingLogger();
    const stateDir = makeTempDir("unimp-leak-state-");
    const baseDbPath = freshBaseDbPath("unimp-leak-");
    const wsDir = join(stateDir, "workspaces", "shared-ws");
    mkdirSync(wsDir, { recursive: true });
    const engine = prepareEngineSharedBase(createEngine(
      createStubHost({ stateDir, logger, workspaceDir: async () => wsDir }),
      config(baseDbPath),
      { internals: { embeddings: flatEmbedder() } },
    ));
    await importRun(engine, "runX", ["s1", "s2"]);
    const hooks = internalsOf(engine).memoryUnimport.hooks;
    hooks.afterIntent = (id) => { if (id === idOf("s2")) throw new Error(`crash ${SENTINEL}`); };
    const dry = await unimport(engine, "runX", { dryRun: true });
    await assert.rejects(() => unimport(engine, "runX"), (e) => !String(e.message).includes(SENTINEL));
    delete hooks.afterIntent;
    const res = await unimport(engine, "runX");
    for (const r of [dry, res]) assert.equal(JSON.stringify(r).includes(SENTINEL), false);
    assert.equal(readFileSync(unimportLedgerPath(baseDbPath, AGENT, "runX"), "utf8").includes(SENTINEL), false);
    const unimportedLines = ledgerLines(baseDbPath).filter((l) => l.kind === "unimported");
    assert.equal(JSON.stringify(unimportedLines).includes(SENTINEL), false);
    assert.ok(lines.length > 0, "logger captured nothing");
    assert.ok(lines.every((l) => !l.includes(SENTINEL)));
    await engine.close({ budgetMs: 5_000 });
  });

  it("T14: guards — invalid importRunId, too many keys, wrong origin", TIMEOUT, async () => {
    const { engine } = setup("unimp-guard-");
    for (const bad of ["../x", "", "x".repeat(65), 42]) {
      await assert.rejects(() => unimport(engine, bad), code("invalid-input"));
    }
    await assert.rejects(() => unimport(engine, "ok", { idempotencyKeys: Array.from({ length: 501 }, (_, i) => `k${i}`) }), code("invalid-input"));
    await assert.rejects(() => unimport(engine, "ok", { idempotencyKeys: [""] }), code("invalid-input"));
    await assert.rejects(() => unimport(engine, "ok", { agentId: "bernd" }), code("invalid-input"));
    await assert.rejects(
      () => engine.memory.unimport({ agentId: AGENT, importRunId: "ok" }, principal(AGENT), userAgent),
      code("denied"),
    );
    await assert.rejects(
      () => engine.memory.unimport({ agentId: AGENT, importRunId: "ok" }, principal(AGENT), { origin: "system", background: true }),
      code("denied"),
    );
    await assert.rejects(
      () => engine.memory.import({ agentId: AGENT, principal: principal(AGENT), cards: [], importRunId: "../x" }, principal(AGENT), systemAgent),
      code("invalid-input"),
    );
    const empty = await unimport(engine, "never-imported");
    assert.equal(empty.selected, 0);
    await engine.close({ budgetMs: 5_000 });
  });

  it("T17: derived.jobsSinceImport names derivation jobs that finished after the import", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-derived-");
    await importRun(engine, "runJ", ["j1"]);
    const dry1 = await unimport(engine, "runJ", { dryRun: true });
    assert.deepEqual(dry1.derived.jobsSinceImport, []);
    const dir = join(baseDbPath, "_jobs", AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ledger.jsonl"), [
      JSON.stringify({ v: 1, runId: "r1", job: "rem-dream", outcome: "completed", startedAt: Date.now(), finishedAt: Date.now() + 1_000 }),
      JSON.stringify({ v: 1, runId: "r2", job: "gc-run", outcome: "completed", startedAt: Date.now(), finishedAt: Date.now() + 1_000 }),
      JSON.stringify({ v: 1, runId: "r3", job: "meta-reflect", outcome: "failed", startedAt: Date.now(), finishedAt: Date.now() + 1_000 }),
    ].join("\n") + "\n");
    const dry2 = await unimport(engine, "runJ", { dryRun: true });
    assert.deepEqual(dry2.derived.jobsSinceImport, ["rem-dream"]);
    await engine.close({ budgetMs: 5_000 });
  });

  it("T16: an engine before 1.13 reading the unimported line keeps the key blocked (safe downgrade)", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-compat-");
    await importRun(engine, "runO", ["o1"]);
    await unimport(engine, "runO");
    // Vendored 1.11/1.12 parse: v === 1, string key and cardId, last line wins.
    const oldByKey = new Map();
    for (const line of readFileSync(importLedgerPath(baseDbPath, AGENT), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.v !== 1 || typeof row.idempotencyKey !== "string" || typeof row.cardId !== "string") continue;
      oldByKey.set(row.idempotencyKey, row);
    }
    assert.ok(oldByKey.get("o1"), "an old engine still sees the key as imported");
    assert.equal(internalsOf(engine).memoryImport.ledger.load(AGENT).byKey.has("o1"), false);
    await engine.close({ budgetMs: 5_000 });
  });
});
