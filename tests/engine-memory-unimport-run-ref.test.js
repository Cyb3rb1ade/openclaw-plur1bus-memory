/**
 * tests/engine-memory-unimport-run-ref.test.js — contract 1.15.0 additions to
 * `memory.import` / `memory.unimport`:
 *   - a card whose sourceRef carries `;run=<id>` (Harness importers) is
 *     attributed to that run even without `importRunId`, with a digest;
 *   - legacy ledger lines (no importRunId) are selected by that sourceRef run;
 *   - unimport drops the undone cards' graph edges and archives their
 *     Obsidian mirror notes; re-import after unimport works.
 *
 * Real createEngine on temp LanceDB stores (stub embedder), like
 * tests/engine-memory-unimport.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { internalsOf } from "../engine/internals.js";
import { importCardId } from "../engine/memory-ops/import-id.js";
import { importLedgerPath } from "../engine/memory-ops/import-ledger.js";
import { ledgerLineRunId, sourceRefRunId, IMPORT_SOURCE_REF_MAX } from "../engine/memory-ops/import.js";
import { archiveMemoryNotes, writeMemoryNotes } from "../lib/obsidian/memory-note-writer.js";
import { readTombstonesFromRegistry } from "../lib/tombstone.js";
import { principal, setup, auditLines } from "./helpers/shared-workspace-engine.js";
import { confirmedObsidianPolicy } from "./helpers/obsidian-mutation-policy.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const TIMEOUT = { timeout: 90_000 };
const systemAgent = { origin: "system", background: false };
const AGENT = "anna";
const idOf = (key) => importCardId(AGENT, key);

function harnessCards(keys, runId) {
  return keys.map((k, i) => ({
    idempotencyKey: k,
    text: `RUNREF_SENTINEL the lighthouse keeper fact number ${k} is distinct`,
    provenance: "imported",
    sourceRef: `hermes:default:memories/MEMORY.md#${i + 1};run=${runId}`,
  }));
}

function importHarness(engine, runId, keys) {
  // Like the Harness importers: no importRunId, the run lives in the sourceRef.
  return engine.memory.import(
    { agentId: AGENT, principal: principal(AGENT), cards: harnessCards(keys, runId) },
    principal(AGENT), systemAgent,
  );
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

function ledgerLines(baseDbPath) {
  const path = importLedgerPath(baseDbPath, AGENT);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("sourceRefRunId / ledgerLineRunId", () => {
  it("reads exactly one well-formed run segment and never guesses", () => {
    assert.equal(sourceRefRunId("hermes:default:memories/MEMORY.md#2;run=20261018-ab_12"), "20261018-ab_12");
    assert.equal(sourceRefRunId("x;foo=1;run=R1;bar=2"), "R1");
    assert.equal(sourceRefRunId("x;run=R1;run=R1"), "R1");
    assert.equal(sourceRefRunId("x;run=R1;run=R2"), "", "conflicting segments");
    assert.equal(sourceRefRunId("x;run=bad id"), "", "malformed id");
    assert.equal(sourceRefRunId("x;run="), "");
    assert.equal(sourceRefRunId("run=R1"), "", "the first segment is the source itself, not a field");
    assert.equal(sourceRefRunId("x#run=R1"), "");
    assert.equal(sourceRefRunId("agent-export:abc"), "");
    assert.equal(sourceRefRunId(undefined), "");
    assert.equal(sourceRefRunId(`${"a".repeat(IMPORT_SOURCE_REF_MAX - 7)};run=R1`), "", "at the cap the id may be cut");
    assert.equal(ledgerLineRunId({ importRunId: "A", sourceRef: "x;run=B" }), "A", "an explicit importRunId wins");
    assert.equal(ledgerLineRunId({ sourceRef: "x;run=B" }), "B");
    assert.equal(ledgerLineRunId({ sourceRef: "x" }), "");
  });
});

describe("Engine.memory.unimport with sourceRef runs (contract 1.15.0)", () => {
  it("import without importRunId records the sourceRef run with a digest; unimport undoes exactly that run, without a tombstone, and re-import works", TIMEOUT, async () => {
    const { baseDbPath, engine, workspaceDir } = setup("unimp-ref-");
    await importHarness(engine, "runA", ["a1", "a2"]);
    await importHarness(engine, "runB", ["b1"]);
    const lines = ledgerLines(baseDbPath);
    const a1 = lines.find((l) => l.idempotencyKey === "a1");
    assert.equal(a1.importRunId, "runA");
    assert.match(a1.digest.content, /^[0-9a-f]{16}$/);

    const tombsBefore = readTombstonesFromRegistry(baseDbPath, AGENT).length;
    const dry = await engine.memory.unimport({ agentId: AGENT, importRunId: "runA" }, principal(AGENT), systemAgent);
    assert.equal(dry.selected, 2);
    assert.equal(dry.unimported, 2);
    assert.equal((await rowOf(engine, idOf("a1"))).status, "active", "dryRun writes nothing");

    const applied = await unimport(engine, "runA");
    assert.equal(applied.unimported, 2);
    assert.deepEqual(applied.cards.map((c) => c.id).sort(), [idOf("a1"), idOf("a2")].sort());
    assert.equal((await rowOf(engine, idOf("a1"))).status, "deleted");
    assert.equal((await rowOf(engine, idOf("b1"))).status, "active", "another run is untouched");
    assert.equal(readTombstonesFromRegistry(baseDbPath, AGENT).length, tombsBefore, "no tombstone");
    assert.ok(auditLines(workspaceDir).some((l) => l.event === "memory.unimported" && l.memoryId === idOf("a1") && l.importRunId === "runA"));

    // Idempotent.
    const again = await unimport(engine, "runA");
    assert.equal(again.unimported, 0);
    assert.equal(again.alreadyUnimported, 2);

    // Re-import of the same content under a new run creates the cards again (same ids).
    const re = await importHarness(engine, "runC", ["a1", "a2"]);
    assert.deepEqual(re.cards.map((c) => c.outcome), ["created", "created"]);
    assert.equal((await rowOf(engine, idOf("a1"))).status, "active");
    // Rolling back runA again leaves runC's cards alone; rolling back runC undoes them.
    assert.equal((await unimport(engine, "runA")).unimported, 0);
    assert.equal((await rowOf(engine, idOf("a1"))).status, "active");
    assert.equal((await unimport(engine, "runC")).unimported, 2);
    await engine.close({ budgetMs: 5_000 });
  });

  it("cards the user changed after the import are kept and reported (pin, correction, edit)", TIMEOUT, async () => {
    const { engine } = setup("unimp-ref-kept-");
    await importHarness(engine, "runK", ["k1", "k2", "k3", "k4"]);
    const pool = internalsOf(engine).pool;
    await pool.withWriteDb(AGENT, (db) => db.update(idOf("k1"), { neverForget: true }));
    await pool.withWriteDb(AGENT, (db) => db.update(idOf("k2"), { text: "the user rewrote this card by hand" }));
    await engine.memory.correct(idOf("k3"), "the lighthouse keeper fact, corrected by the user", principal(AGENT), { origin: "user", background: false });
    const res = await unimport(engine, "runK");
    const by = Object.fromEntries(res.cards.map((c) => [c.idempotencyKey, c]));
    assert.equal(by.k1.outcome, "kept-modified");
    assert.equal(by.k1.reason, "metadata-changed");
    assert.equal(by.k2.outcome, "kept-modified");
    assert.equal(by.k2.reason, "content-changed");
    assert.equal(by.k3.outcome, "kept-modified");
    assert.equal(by.k3.reason, "superseded");
    assert.equal(by.k4.outcome, "unimported");
    assert.equal((await rowOf(engine, idOf("k1"))).status, "active");
    assert.equal((await rowOf(engine, idOf("k2"))).status, "active");
    await engine.close({ budgetMs: 5_000 });
  });

  it("legacy ledger lines without importRunId are selected by their sourceRef run", TIMEOUT, async () => {
    const { baseDbPath, engine } = setup("unimp-ref-legacy-");
    await importHarness(engine, "runL", ["l1", "l2"]);
    // Simulate lines an engine before 1.13 wrote: no importRunId, no digest.
    const path = importLedgerPath(baseDbPath, AGENT);
    const stripped = ledgerLines(baseDbPath).map(({ importRunId: _r, digest: _d, ...rest }) => rest);
    writeFileSync(path, stripped.map((l) => JSON.stringify(l)).join("\n") + "\n");
    assert.equal(ledgerLines(baseDbPath).some((l) => "importRunId" in l), false);

    const res = await unimport(engine, "runL");
    assert.equal(res.selected, 2);
    assert.equal(res.unimported, 2, "unmodified digest-less cards are undone (updatedAt unchanged)");
    assert.equal((await rowOf(engine, idOf("l1"))).status, "deleted");
    // ...and the freed key imports again.
    const re = await importHarness(engine, "runL2", ["l1"]);
    assert.equal(re.cards[0].outcome, "created");
    await engine.close({ budgetMs: 5_000 });
  });

  it("drops the undone cards' graph edges and keeps every other edge", TIMEOUT, async () => {
    const { engine, workspaceDir } = setup("unimp-ref-graph-");
    await importHarness(engine, "runG", ["g1"]);
    await importHarness(engine, "runH", ["h1", "h2"]);
    const neo = internalsOf(engine).getNeoStore({ agentId: AGENT, workspaceDir }, {}, "test");
    neo.appendGraphEdges([
      { id: "e1", source: idOf("g1"), target: idOf("h1"), type: "semantic", strength: 0.9 },
      { id: "e2", source: idOf("h2"), target: idOf("g1"), type: "semantic", strength: 0.8 },
      { id: "e3", source: idOf("h1"), target: idOf("h2"), type: "semantic", strength: 0.7 },
    ]);
    // An unparseable line survives verbatim.
    writeFileSync(neo.paths.graph, `${readFileSync(neo.paths.graph, "utf8")}{not json\n`);
    const res = await unimport(engine, "runG");
    assert.equal(res.unimported, 1);
    assert.equal(res.derived.graphEdgesRemoved, 2);
    assert.equal(res.derived.cleanupErrors, 0);
    const left = neo.readGraphEdges(100);
    assert.deepEqual(left.map((e) => e.id), ["e3"]);
    assert.match(readFileSync(neo.paths.graph, "utf8"), /\{not json\n$/);
    // A rerun converges: nothing left to remove.
    const rerun = await unimport(engine, "runG");
    assert.equal(rerun.alreadyUnimported, 1);
    assert.equal(rerun.derived.graphEdgesRemoved, 0);
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("archiveMemoryNotes (Obsidian mirrors of unimported cards)", () => {
  const ID1 = "aaaaaaaa-0000-0000-0000-000000000001";
  const ID2 = "aaaaaaaa-0000-0000-0000-000000000002";
  const record = (id) => ({ id, text: `mirror body ${id}`, summary: "s", category: "fact", importance: 0.5, createdAt: "2026-10-18T00:00:00.000Z", scope: "agent-private" });

  function vaultWithNotes() {
    const vault = makeTempDir("unimp-vault-");
    const cfg = { vaultPath: vault, reviewRoot: "plur1bus", workspaceKey: "workspace:v1:main" };
    const mutationPolicy = confirmedObsidianPolicy({ baseDbPath: vault, command: ["dashboards", "build"] });
    writeMemoryNotes(cfg, [record(ID1), record(ID2)], { mutationPolicy });
    return { vault, cfg, mutationPolicy, memoriesDir: join(vault, "plur1bus", "memories") };
  }

  it("moves only the named notes into the archive, byte for byte", () => {
    const { cfg, mutationPolicy, memoriesDir } = vaultWithNotes();
    const before = readFileSync(join(memoriesDir, `${ID1}.md`), "utf8");
    const archiveDir = makeTempDir("unimp-archive-");
    const out = archiveMemoryNotes(cfg, [ID1, "bbbbbbbb-0000-0000-0000-000000000009"], { archiveDir, mutationPolicy, clock: () => 0 });
    assert.deepEqual(out, { archived: 1, absent: 1, skipped: 0, errors: 0 });
    assert.equal(existsSync(join(memoriesDir, `${ID1}.md`)), false);
    assert.equal(existsSync(join(memoriesDir, `${ID2}.md`)), true);
    const dir = join(archiveDir, "obsidian-mirrors", "workspacev1main");
    const files = readdirSync(dir);
    assert.deepEqual(files, [`1970-01-01T00-00-00-000Z-${ID1}.md`]);
    assert.equal(readFileSync(join(dir, files[0]), "utf8"), before);
  });

  it("without vault_write nothing moves; a note naming another memory_id is left alone", () => {
    const { cfg, mutationPolicy, memoriesDir } = vaultWithNotes();
    const archiveDir = makeTempDir("unimp-archive-");
    const denied = archiveMemoryNotes(cfg, [ID1], { archiveDir, mutationPolicy: null });
    assert.equal(denied.denied, true);
    assert.equal(existsSync(join(memoriesDir, `${ID1}.md`)), true);
    mkdirSync(memoriesDir, { recursive: true });
    writeFileSync(join(memoriesDir, `${ID2}.md`), `---\nmemory_id: ${ID1}\n---\nforeign\n`);
    const out = archiveMemoryNotes(cfg, [ID2], { archiveDir, mutationPolicy });
    assert.equal(out.skipped, 1);
    assert.equal(existsSync(join(memoriesDir, `${ID2}.md`)), true);
  });
});
