/**
 * tests/engine-memory-link.test.js — contract 1.16.0 `memory.link`:
 *   - attaches an additional source to an existing card without writing its row;
 *   - idempotent per sourceRef (`already-linked`, `already-source`);
 *   - unknown id and cards outside the caller's scope are `not-found`;
 *   - show/list report the links;
 *   - `memory.unimport` of the link's run removes only the link.
 *
 * Unit tests for the link ledger, then real createEngine on temp LanceDB
 * stores (flat stub embedder), like tests/engine-memory-unimport-run-ref.test.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { internalsOf } from "../engine/internals.js";
import { importCardId } from "../engine/memory-ops/import-id.js";
import { createLinkLedger, linkIdFor, linkLedgerPath } from "../engine/memory-ops/link-ledger.js";
import { MEMORY_LINK_MAX_PER_CARD } from "../engine/memory-ops/link.js";
import { withImportLock } from "../engine/memory-ops/import-lock.js";
import { auditLines, code, principal, seedAndGetId, setup, userAgent } from "./helpers/shared-workspace-engine.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const TIMEOUT = { timeout: 90_000 };
const systemAgent = { origin: "system", background: false };
const AGENT = "anna";
const idOf = (key) => importCardId(AGENT, key);
const ref = (n, runId) => `hermes:default:memories/MEMORY.md#${n};run=${runId}`;

function importCards(engine, runId, keys) {
  return engine.memory.import({
    agentId: AGENT,
    principal: principal(AGENT),
    cards: keys.map((k, i) => ({
      idempotencyKey: k,
      text: `LINK_SENTINEL the harbour master fact number ${k} is distinct`,
      provenance: "imported",
      sourceRef: ref(i + 1, runId),
    })),
  }, principal(AGENT), systemAgent);
}

function link(engine, id, req, agentId = AGENT) {
  return engine.memory.link(id, { provenance: "imported", ...req }, principal(agentId), systemAgent);
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

describe("link ledger (contract 1.16.0)", () => {
  it("linkIdFor is deterministic and separates agent, card and sourceRef", () => {
    const a = linkIdFor("anna", "c1", "x;run=R");
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(linkIdFor("anna", "c1", "x;run=R"), a);
    assert.notEqual(linkIdFor("bernd", "c1", "x;run=R"), a);
    assert.notEqual(linkIdFor("anna", "c2", "x;run=R"), a);
    assert.notEqual(linkIdFor("anna", "c1", "x;run=S"), a);
  });

  it("last line per link wins, torn and foreign lines are skipped, appends survive a torn tail", () => {
    const base = join(makeTempDir("link-ledger-"), "db");
    const ledger = createLinkLedger({ baseDbPath: base });
    assert.deepEqual(ledger.readLines("anna"), []);
    ledger.append("anna", { kind: "linked", linkId: "L1", cardId: "c1", sourceRef: "s1", provenance: "imported", importRunId: "R", at: 1 });
    ledger.append("anna", { kind: "linked", linkId: "L2", cardId: "c1", sourceRef: "s2", provenance: "imported", at: 2 });
    const path = linkLedgerPath(base, "anna");
    appendFileSync(path, "{\"v\":1,\"kind\":\"weird\",\"linkId\":\"L9\",\"cardId\":\"c9\"}\n{\"v\":1,\"kind\":\"linked\",\"linkId\":\"L3\"");
    ledger.append("anna", { kind: "unlinked", linkId: "L1", cardId: "c1", importRunId: "R", at: 3 });
    const state = ledger.load("anna");
    assert.deepEqual([...state.active.keys()], ["L2"]);
    assert.deepEqual([...state.unlinked.keys()], ["L1"]);
    assert.equal(state.byCardId.get("c1").length, 1);
    assert.equal(ledger.readLines("anna").length, 3, "the foreign and the torn line are skipped");
    // Re-link after unlink: active again.
    ledger.append("anna", { kind: "linked", linkId: "L1", cardId: "c1", sourceRef: "s1", provenance: "imported", importRunId: "S", at: 4 });
    assert.equal(ledger.load("anna").active.get("L1").importRunId, "S");
    assert.ok(existsSync(dirname(path)));
  });
});

describe("Engine.memory.link (contract 1.16.0)", () => {
  it("links an existing card without touching its row; idempotent; show and list report the link; audited", TIMEOUT, async () => {
    const { engine, workspaceDir } = setup("link-basic-");
    const target = await seedAndGetId(engine, AGENT, "The harbour master of Kiel is called Jonte Petersen", "harbour master");
    const before = await rowOf(engine, target);

    const dry = await link(engine, target, { sourceRef: ref(7, "runL"), dryRun: true });
    assert.equal(dry.outcome, "linked");
    assert.equal(dry.dryRun, true);
    assert.equal((await engine.memory.show(target, principal(AGENT), userAgent)).links, undefined, "dryRun writes nothing");

    const first = await link(engine, target, { sourceRef: ref(7, "runL"), idempotencyKey: "dup-7" });
    assert.deepEqual(first, { id: target, linkId: linkIdFor(AGENT, target, ref(7, "runL")), outcome: "linked", importRunId: "runL", dryRun: false });
    const again = await link(engine, target, { sourceRef: ref(7, "runL") });
    assert.equal(again.outcome, "already-linked");
    assert.equal(again.linkId, first.linkId);
    assert.equal(again.importRunId, "runL");
    // Same sourceRef from another run is still the same link (no-op, keeps its run).
    assert.equal((await link(engine, target, { sourceRef: ref(7, "runL"), importRunId: "runX" })).outcome, "already-linked");
    // An explicit run without a run segment in the sourceRef.
    const plain = await link(engine, target, { sourceRef: "agent-export:abc#3", importRunId: "runP" });
    assert.equal(plain.importRunId, "runP");
    const norun = await link(engine, target, { sourceRef: "agent-export:abc#4" });
    assert.equal(norun.importRunId, null);

    const after = await rowOf(engine, target);
    assert.equal(after.text, before.text);
    assert.equal(Number(after.updatedAt), Number(before.updatedAt), "the card row is never written");
    assert.deepEqual(Array.from(after.vector), Array.from(before.vector));

    const shown = await engine.memory.show(target, principal(AGENT), userAgent);
    assert.equal(shown.provenance, undefined, "a captured card does not become imported");
    assert.deepEqual(shown.links.map((l) => [l.sourceRef, l.importRunId, l.provenance]), [
      [ref(7, "runL"), "runL", "imported"],
      ["agent-export:abc#3", "runP", "imported"],
      ["agent-export:abc#4", null, "imported"],
    ]);
    assert.ok(shown.links.every((l) => typeof l.linkedAt === "number" && /^[0-9a-f]{32}$/.test(l.linkId)));
    const listed = await engine.memory.list({ topic: "harbour master" }, principal(AGENT), userAgent);
    assert.equal(listed.items.find((c) => c.id === target).links.length, 3);

    const audit = auditLines(workspaceDir).filter((l) => l.event === "memory.linked");
    assert.equal(audit.length, 3, "one audit line per written link, none for no-ops");
    assert.equal(audit[0].memoryId, target);
    assert.equal(audit[0].importRunId, "runL");
    assert.ok(!JSON.stringify(audit).includes("MEMORY.md"), "audit carries no sourceRef");
    await engine.close({ budgetMs: 5_000 });
  });

  it("a sourceRef equal to the card's own import source is already-source", TIMEOUT, async () => {
    const { engine } = setup("link-own-");
    await importCards(engine, "runA", ["a1"]);
    const res = await link(engine, idOf("a1"), { sourceRef: ref(1, "runA") });
    assert.equal(res.outcome, "already-source");
    assert.equal(res.importRunId, null);
    const shown = await engine.memory.show(idOf("a1"), principal(AGENT), userAgent);
    assert.equal(shown.sourceRef, ref(1, "runA"));
    assert.equal(shown.links, undefined);
    await engine.close({ budgetMs: 5_000 });
  });

  it("rejects bad input, foreign origins, unknown ids and cards outside the caller's scope", TIMEOUT, async () => {
    const { engine, baseDbPath } = setup("link-guard-");
    const target = await seedAndGetId(engine, AGENT, "Anna keeps her bicycle in the blue shed", "bicycle shed");
    const ok = { provenance: "imported", sourceRef: ref(1, "runG") };

    await assert.rejects(() => engine.memory.link(target, ok, principal(AGENT), userAgent), code("denied"));
    await assert.rejects(() => engine.memory.link(target, ok, principal(AGENT), { origin: "system", background: true }), code("denied"));
    await assert.rejects(() => engine.memory.link("not-a-uuid", ok, principal(AGENT), systemAgent), code("invalid-input"));
    await assert.rejects(() => engine.memory.link(target, null, principal(AGENT), systemAgent), code("invalid-input"));
    await assert.rejects(() => engine.memory.link(target, { ...ok, provenance: "captured" }, principal(AGENT), systemAgent), code("invalid-input"));
    await assert.rejects(() => engine.memory.link(target, { ...ok, sourceRef: "   " }, principal(AGENT), systemAgent), code("invalid-input"));
    await assert.rejects(() => engine.memory.link(target, { ...ok, sourceRef: "x".repeat(501) }, principal(AGENT), systemAgent), code("invalid-input"));
    await assert.rejects(() => engine.memory.link(target, { ...ok, importRunId: "bad id" }, principal(AGENT), systemAgent), code("invalid-input"));
    await assert.rejects(() => engine.memory.link(target, { ...ok, idempotencyKey: "k".repeat(257) }, principal(AGENT), systemAgent), code("invalid-input"));

    // Unknown id: stable not-found, nothing written.
    await assert.rejects(() => link(engine, idOf("never-imported"), { sourceRef: ref(2, "runG") }), code("not-found"));
    // bernd shares anna's workspace but not her agent-private card; carol lives elsewhere.
    await assert.rejects(() => link(engine, target, { sourceRef: ref(3, "runG") }, "bernd"), code("not-found"));
    await assert.rejects(() => link(engine, target, { sourceRef: ref(3, "runG") }, "carol"), code("not-found"));
    // A forgotten card is gone for link too.
    const gone = await seedAndGetId(engine, AGENT, "Anna once owned a red kayak named Wellenreiter", "red kayak");
    await engine.memory.forget(gone, principal(AGENT), userAgent);
    await assert.rejects(() => link(engine, gone, { sourceRef: ref(4, "runG") }), code("not-found"));

    assert.equal(existsSync(linkLedgerPath(baseDbPath, AGENT)), false, "no refused call wrote a link");
    assert.equal(existsSync(linkLedgerPath(baseDbPath, "bernd")), false);
    await engine.close({ budgetMs: 5_000 });
  });

  it("waits for the per-agent import lock and answers lock-busy when it stays held", TIMEOUT, async () => {
    const { engine, baseDbPath } = setup("link-lock-");
    const target = await seedAndGetId(engine, AGENT, "The Holtenau locks were rebuilt after 2010", "Holtenau locks");
    internalsOf(engine).memoryLink.importLock.timeoutMs = 100;
    let release;
    const held = withImportLock(baseDbPath, AGENT, () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => link(engine, target, { sourceRef: ref(1, "runB") }), code("lock-busy"));
    release();
    await held;
    assert.equal((await link(engine, target, { sourceRef: ref(1, "runB") })).outcome, "linked");
    await engine.close({ budgetMs: 5_000 });
  });

  it("caps the number of links per card with conflict", TIMEOUT, async () => {
    const { engine, baseDbPath } = setup("link-cap-");
    const target = await seedAndGetId(engine, AGENT, "The lighthouse at Falshoeft was switched off in 1969", "lighthouse");
    const ledger = createLinkLedger({ baseDbPath });
    for (let i = 0; i < MEMORY_LINK_MAX_PER_CARD; i++) {
      const sourceRef = `bulk:${i}`;
      ledger.append(AGENT, { kind: "linked", linkId: linkIdFor(AGENT, target, sourceRef), cardId: target, sourceRef, provenance: "imported", at: i });
    }
    await assert.rejects(() => link(engine, target, { sourceRef: "bulk:new" }), code("conflict"));
    assert.equal((await link(engine, target, { sourceRef: "bulk:0" })).outcome, "already-linked", "an existing link stays a no-op at the cap");
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("Engine.memory.unimport removes links of its run (contract 1.16.0)", () => {
  it("unlinks only the run's links; the linked card and other runs stay; dryRun, idempotence, re-link", TIMEOUT, async () => {
    const { engine, workspaceDir } = setup("link-unimp-");
    const existing = await seedAndGetId(engine, AGENT, "The ferry to Laboe leaves every hour on the hour", "ferry Laboe");
    const before = await rowOf(engine, existing);
    // Run R imports one new card and links one duplicate onto the existing card.
    await importCards(engine, "runR", ["r1"]);
    const linked = await link(engine, existing, { sourceRef: ref(2, "runR"), idempotencyKey: "r2" });
    // Another run links another source onto the same card.
    await link(engine, existing, { sourceRef: ref(5, "runS") });

    const dry = await engine.memory.unimport({ agentId: AGENT, importRunId: "runR" }, principal(AGENT), systemAgent);
    assert.equal(dry.unimported, 1);
    assert.deepEqual(dry.links, { selected: 1, unlinked: 1, alreadyUnlinked: 0, items: [{ linkId: linked.linkId, id: existing, outcome: "unlinked" }] });
    assert.equal((await engine.memory.show(existing, principal(AGENT), userAgent)).links.length, 2, "dryRun writes nothing");

    const applied = await unimport(engine, "runR");
    assert.equal(applied.unimported, 1);
    assert.deepEqual(applied.links, { selected: 1, unlinked: 1, alreadyUnlinked: 0, items: [{ linkId: linked.linkId, id: existing, outcome: "unlinked" }] });
    assert.equal((await rowOf(engine, idOf("r1"))).status, "deleted");
    const after = await rowOf(engine, existing);
    assert.equal(after.status, "active", "the linked card is never touched");
    assert.equal(after.text, before.text);
    assert.equal(Number(after.updatedAt), Number(before.updatedAt));
    const shown = await engine.memory.show(existing, principal(AGENT), userAgent);
    assert.deepEqual(shown.links.map((l) => l.importRunId), ["runS"], "another run's link stays");
    const audit = auditLines(workspaceDir).filter((l) => l.event === "memory.unlinked");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].memoryId, existing);
    assert.equal(audit[0].linkId, linked.linkId);
    assert.equal(audit[0].importRunId, "runR");

    const again = await unimport(engine, "runR");
    assert.deepEqual(again.links, { selected: 1, unlinked: 0, alreadyUnlinked: 1, items: [{ linkId: linked.linkId, id: existing, outcome: "already-unlinked" }] });
    assert.equal(auditLines(workspaceDir).filter((l) => l.event === "memory.unlinked").length, 1);

    // A later run may link the same source again; rolling back runR leaves it.
    assert.equal((await link(engine, existing, { sourceRef: ref(2, "runR"), importRunId: "runT" })).outcome, "linked");
    const third = await unimport(engine, "runR");
    assert.equal(third.links, undefined, "the re-linked source belongs to runT");
    assert.equal((await engine.memory.show(existing, principal(AGENT), userAgent)).links.length, 2);
    assert.equal((await unimport(engine, "runT")).links.unlinked, 1);
    await engine.close({ budgetMs: 5_000 });
  });

  it("a run that only linked is rolled back too; the key filter narrows links", TIMEOUT, async () => {
    const { engine } = setup("link-unimp-only-");
    const existing = await seedAndGetId(engine, AGENT, "The Kiel canal opened to ships in 1895", "Kiel canal");
    await link(engine, existing, { sourceRef: ref(1, "runO"), idempotencyKey: "o1" });
    await link(engine, existing, { sourceRef: ref(2, "runO") });

    const filtered = await unimport(engine, "runO", { idempotencyKeys: ["other"] });
    assert.equal(filtered.selected, 0);
    assert.equal(filtered.links, undefined, "the filter never widens; keyless links are not selected under a filter");
    const narrowed = await unimport(engine, "runO", { idempotencyKeys: ["o1"] });
    assert.equal(narrowed.links.unlinked, 1);
    assert.equal((await engine.memory.show(existing, principal(AGENT), userAgent)).links.length, 1);

    const rest = await unimport(engine, "runO");
    assert.equal(rest.selected, 0);
    assert.equal(rest.links.unlinked, 1);
    assert.equal(rest.links.alreadyUnlinked, 1);
    assert.equal((await engine.memory.show(existing, principal(AGENT), userAgent)).links, undefined);
    assert.equal((await rowOf(engine, existing)).status, "active");
    await engine.close({ budgetMs: 5_000 });
  });

  it("a link does not make an imported card look modified to its own run's unimport", TIMEOUT, async () => {
    const { engine } = setup("link-unimp-digest-");
    await importCards(engine, "runA", ["a1"]);
    await link(engine, idOf("a1"), { sourceRef: ref(9, "runB") });
    const undoB = await unimport(engine, "runB");
    assert.equal(undoB.selected, 0);
    assert.equal(undoB.links.unlinked, 1);
    assert.equal((await rowOf(engine, idOf("a1"))).status, "active", "rolling back the linking run keeps the card");
    await link(engine, idOf("a1"), { sourceRef: ref(9, "runC") });
    const undoA = await unimport(engine, "runA");
    assert.equal(undoA.unimported, 1, "the digest is unchanged by links");
    assert.equal(undoA.links, undefined);
    await engine.close({ budgetMs: 5_000 });
  });
});

describe("link ledger location", () => {
  it("lives under _links/<agentId>.jsonl inside baseDbPath", () => {
    // realpath: on macOS the temp dir is /var/... while the ledger resolves /private/var/...
    const base = join(realpathSync(makeTempDir("link-path-")), "db");
    mkdirSync(base, { recursive: true });
    assert.equal(linkLedgerPath(base, "anna"), join(base, "_links", "anna.jsonl"));
    assert.throws(() => linkLedgerPath(base, "../evil"));
    const ledger = createLinkLedger({ baseDbPath: base });
    ledger.append("anna", { kind: "linked", linkId: "L", cardId: "c", sourceRef: "s", provenance: "imported", at: 1 });
    const line = JSON.parse(readFileSync(linkLedgerPath(base, "anna"), "utf8").trim());
    assert.deepEqual(line, { v: 1, kind: "linked", linkId: "L", cardId: "c", sourceRef: "s", provenance: "imported", at: 1 });
  });
});
