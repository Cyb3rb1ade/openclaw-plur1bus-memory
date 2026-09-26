/**
 * tests/engine-memory-proposals.test.js — E2 Task 5 (spec decision D31):
 * change proposals against a shared copy — the store, `memory.propose`,
 * `memory.proposals.list`, and the `memory.proposal` event.
 *
 * Part 1: filing and listing (Task 5). Part 2: `proposals.accept`/`.reject`
 * (Task 6).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { internalsOf } from "../engine/internals.js";
import { createMemoryWrite } from "../engine/memory-ops/write.js";
import { createMemoryProposals } from "../engine/memory-ops/proposals.js";
import { createProposalStore } from "../engine/memory-ops/proposal-store.js";
import { code, cronAgent, principal, seedAndGetId, setup, userAgent } from "./helpers/shared-workspace-engine.js";

describe("Engine.memory.propose / .proposals.list (E2 Task 5, D31)", () => {
  it("(a) bernd files a proposal against anna's shared copy; the file, the result and the event agree", async () => {
    const { baseDbPath, engine } = setup("e2-propose-a-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The office plants are watered every Tuesday morning.", "office plants");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);

    const events = [];
    engine.events.on("memory.proposal", (payload) => events.push(payload));

    const result = await engine.memory.propose(S, "F better", bernd, userAgent, { note: "typo" });
    assert.equal(result.sharedId, S);
    assert.equal(result.sharerAgentId, "anna");
    assert.equal(typeof result.proposalId, "string");

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { proposalId: result.proposalId, status: "pending", sharerAgentId: "anna", proposerAgentId: "bernd", sharedId: S });

    const filePath = join(dirname(baseDbPath), "_proposals", "anna", `${result.proposalId}.json`);
    assert.ok(existsSync(filePath), "the proposal file exists under anna's proposal directory");
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(onDisk.id, result.proposalId);
    assert.equal(onDisk.sharedId, S);
    assert.equal(onDisk.status, "pending");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(b) proposals.list: sharer and proposer both see it, an outsider does not, a status filter narrows it, limit 0 is invalid", async () => {
    const { engine } = setup("e2-propose-b-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const carol = principal("carol");
    const F = await seedAndGetId(engine, "anna", "The recycling goes out on Thursdays.", "recycling");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    await engine.memory.propose(S, "F better", bernd, userAgent, { note: "typo" });

    const forAnna = await engine.memory.proposals.list({}, anna, userAgent);
    assert.equal(forAnna.items.length, 1);
    assert.equal(forAnna.items[0].oldText, "The recycling goes out on Thursdays.");
    assert.equal(forAnna.items[0].newText, "F better");
    assert.equal(forAnna.items[0].note, "typo");
    assert.equal(forAnna.items[0].status, "pending");
    assert.equal(forAnna.truncated, false);
    assert.equal(forAnna.unreadable, 0);

    const forBernd = await engine.memory.proposals.list({}, bernd, userAgent);
    assert.equal(forBernd.items.length, 1);
    assert.equal(forBernd.items[0].id, forAnna.items[0].id);

    const forCarol = await engine.memory.proposals.list({}, carol, userAgent);
    assert.equal(forCarol.items.length, 0);

    const filtered = await engine.memory.proposals.list({ status: "accepted" }, anna, userAgent);
    assert.equal(filtered.items.length, 0);

    await assert.rejects(() => engine.memory.proposals.list({ limit: 0 }, anna, userAgent), code("invalid-input"));

    await engine.close({ budgetMs: 5_000 });
  });

  it("(c) filing rules: a second pending proposal conflicts, no-op text and bad ids/ownership are invalid or not-found, background is denied", async () => {
    const { engine } = setup("e2-propose-c-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const carol = principal("carol");
    const F = await seedAndGetId(engine, "anna", "The kitchen fridge is cleaned monthly.", "kitchen fridge");
    const berndOwn = await seedAndGetId(engine, "bernd", "Bernd's own private note about lunch.", "bernd lunch");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);

    await engine.memory.propose(S, "F better", bernd, userAgent);

    // A second pending proposal by the same proposer against the same copy conflicts.
    await assert.rejects(() => engine.memory.propose(S, "F better again", bernd, userAgent), code("conflict"));

    // Proposing the copy's own current text is a no-op, not a proposal.
    const current = await engine.memory.show(S, bernd, userAgent);
    await assert.rejects(() => engine.memory.propose(S, current.text, bernd, userAgent), code("invalid-input"));

    // An unknown id.
    await assert.rejects(() => engine.memory.propose(randomUUID(), "x", bernd, userAgent), code("not-found"));

    // carol cannot even see the workspace copy (different workspace).
    await assert.rejects(() => engine.memory.propose(S, "x", carol, userAgent), code("not-found"));

    // The sharer proposes against her own share: she corrects it directly instead.
    await assert.rejects(() => engine.memory.propose(S, "x", anna, userAgent), code("invalid-input"));

    // bernd's own private card is not a shared copy.
    await assert.rejects(() => engine.memory.propose(berndOwn, "x", bernd, userAgent), code("invalid-input"));

    // A background caller is refused before any of the above is even checked.
    await assert.rejects(() => engine.memory.propose(S, "x", bernd, cronAgent), code("denied"));

    await engine.close({ budgetMs: 5_000 });
  });

  it("(d) a corrupt neighboring proposal file does not hide the real one; listFor counts it as unreadable", async () => {
    const { baseDbPath, engine } = setup("e2-propose-d-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The mail is collected at noon.", "mail collection");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    await engine.memory.propose(S, "F better", bernd, userAgent);

    const annaDir = join(dirname(baseDbPath), "_proposals", "anna");
    mkdirSync(annaDir, { recursive: true });
    writeFileSync(join(annaDir, "garbage.json"), "{");

    const listed = await engine.memory.proposals.list({}, anna, userAgent);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.unreadable, 1);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(e) after Engine.close(), propose refuses with storage", async () => {
    const { engine } = setup("e2-propose-e-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The gym towels are replaced weekly.", "gym towels");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);

    await engine.close({ budgetMs: 5_000 });

    await assert.rejects(() => engine.memory.propose(S, "x", bernd, userAgent), code("storage"));
  });
});

// ---------------------------------------------------------------------------
// Part 2 of 2 (E2 Task 6): the sharer accepts or rejects a proposal.
// ---------------------------------------------------------------------------

describe("Engine.memory.proposals.accept / .reject (E2 Task 6, D31)", () => {
  it("(a–c, f) only the sharer resolves; accept refreshes the shared copy, reject records the note, resolved proposals conflict", async () => {
    const { engine } = setup("e2-accept-a-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const carol = principal("carol");
    const F = await seedAndGetId(engine, "anna", "The printer toner is ordered every quarter.", "printer toner");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "F better", bernd, userAgent);

    const events = [];
    engine.events.on("memory.proposal", (payload) => events.push(payload));

    // (a) anyone but the sharer: not-found (the proposal is filed under the sharer).
    await assert.rejects(() => engine.memory.proposals.accept(P, bernd, userAgent), code("not-found"));
    await assert.rejects(() => engine.memory.proposals.accept(P, carol, userAgent), code("not-found"));
    await assert.rejects(() => engine.memory.proposals.reject(P, bernd, userAgent), code("not-found"));
    assert.equal(events.length, 0, "refused calls emit nothing");

    const accepted = await engine.memory.proposals.accept(P, anna, userAgent);
    assert.equal(accepted.proposalId, P);
    const S2 = accepted.id;
    const F2 = accepted.sourceId;
    assert.equal(typeof S2, "string");
    assert.notEqual(S2, S);
    assert.notEqual(F2, F);

    const refreshed = await engine.memory.show(S2, bernd, userAgent);
    assert.equal(refreshed.text, "F better");
    assert.equal(refreshed.sharedBy, "anna");
    await assert.rejects(() => engine.memory.show(S, bernd, userAgent), code("not-found"));

    const acceptedList = await engine.memory.proposals.list({ status: "accepted" }, anna, userAgent);
    assert.equal(acceptedList.items.length, 1);
    assert.equal(acceptedList.items[0].id, P);
    assert.equal(acceptedList.items[0].resultId, S2);
    assert.equal(typeof acceptedList.items[0].resolvedAt, "number");
    assert.deepEqual(events.at(-1), { proposalId: P, status: "accepted", sharerAgentId: "anna", proposerAgentId: "bernd", sharedId: S });

    // (b) a resolved proposal cannot be resolved again.
    await assert.rejects(() => engine.memory.proposals.accept(P, anna, userAgent), code("conflict"));
    await assert.rejects(() => engine.memory.proposals.reject(P, anna, userAgent), code("conflict"));

    // (c) reject with a note.
    const { proposalId: Q } = await engine.memory.propose(S2, "Q text", bernd, userAgent);
    const rejected = await engine.memory.proposals.reject(Q, anna, userAgent, { note: "no" });
    assert.deepEqual(rejected, { proposalId: Q, status: "rejected" });
    const rejectedList = await engine.memory.proposals.list({ status: "rejected" }, anna, userAgent);
    assert.equal(rejectedList.items.length, 1);
    assert.equal(rejectedList.items[0].id, Q);
    assert.equal(rejectedList.items[0].resolutionNote, "no");
    assert.equal(typeof rejectedList.items[0].resolvedAt, "number");
    assert.equal(events.at(-1).status, "rejected");
    assert.equal(events.at(-1).proposalId, Q);
    const stillThere = await engine.memory.show(S2, bernd, userAgent);
    assert.equal(stillThere.text, "F better", "reject never changes the shared copy");

    // (f) fail-closed input and caller checks.
    await assert.rejects(() => engine.memory.proposals.accept(P, anna, cronAgent), code("denied"));
    await assert.rejects(() => engine.memory.proposals.accept("nope", anna, userAgent), code("invalid-input"));
    await assert.rejects(() => engine.memory.proposals.reject(P, anna, userAgent, { note: "x".repeat(501) }), code("invalid-input"));
    await assert.rejects(() => engine.memory.proposals.accept(randomUUID(), anna, userAgent), code("not-found"));

    await engine.close({ budgetMs: 5_000 });
  });

  it("(d) accept after the sharer retracted the copy marks the proposal stale and conflicts", async () => {
    const { engine } = setup("e2-accept-d-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The meeting room projector needs a new bulb.", "projector bulb");
    const { sharedId: S2 } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: R } = await engine.memory.propose(S2, "R text", bernd, userAgent);

    const events = [];
    engine.events.on("memory.proposal", (payload) => events.push(payload));

    await engine.memory.forget(S2, anna, userAgent);
    await assert.rejects(() => engine.memory.proposals.accept(R, anna, userAgent), (err) => code("conflict")(err)
      && err.message === "shared copy is gone; proposal marked stale");

    const stale = await engine.memory.proposals.list({ status: "stale" }, anna, userAgent);
    assert.equal(stale.items.length, 1);
    assert.equal(stale.items[0].id, R);
    assert.equal(typeof stale.items[0].resolvedAt, "number");
    assert.equal(stale.items[0].resultId, null);
    assert.equal(events.at(-1).status, "stale");
    assert.equal(events.at(-1).proposalId, R);

    // Stale is terminal.
    await assert.rejects(() => engine.memory.proposals.accept(R, anna, userAgent), code("conflict"));

    await engine.close({ budgetMs: 5_000 });
  });

  it("(e) accept after the sharer refreshed the copy herself marks the proposal stale and never applies it", async () => {
    const { engine } = setup("e2-accept-e-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The water cooler is refilled on Wednesdays.", "water cooler");
    const { sharedId: S5 } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: T } = await engine.memory.propose(S5, "T text", bernd, userAgent);

    const { id: S6 } = await engine.memory.correct(S5, "anna's own change", anna, userAgent);
    await assert.rejects(() => engine.memory.proposals.accept(T, anna, userAgent), code("conflict"));

    const listed = await engine.memory.proposals.list({}, anna, userAgent);
    assert.equal(listed.items.find((x) => x.id === T).status, "stale");
    const current = await engine.memory.show(S6, bernd, userAgent);
    assert.equal(current.text, "anna's own change", "the proposal was not applied over the newer content");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(g) a partial refresh failure leaves the proposal pending and rethrows storage with its detail", async () => {
    const { baseDbPath, engine } = setup("e2-accept-g-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The bike rack is in the basement.", "bike rack");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "The bike rack moved to the courtyard.", bernd, userAgent);

    const internals = internalsOf(engine);
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m), info() {}, debug() {}, error() {} };
    const failingWrite = createMemoryWrite({
      opsContext: internals.memoryOpsContext,
      memoryDbAdapter: internals.memoryDbAdapter,
      baseDbPath,
      pool: internals.pool,
      sharedMemoryPool: internals.sharedMemoryPool,
      embeddings: internals.embeddings,
      logger,
      shareCopy: async () => ({ ok: false, error: "share.store_error: injected", code: "storage" }),
    });
    const store = createProposalStore({ baseDbPath, logger });
    const proposals = createMemoryProposals({
      opsContext: internals.memoryOpsContext,
      sharedOps: failingWrite.shared,
      store,
      memoryDbAdapter: internals.memoryDbAdapter,
      host: internals.host,
      logger,
    });

    let caught;
    await assert.rejects(() => proposals.accept(P, anna, userAgent), (err) => {
      caught = err;
      return code("storage")(err) && err.message === "share refresh failed after correcting the original";
    });
    assert.equal(caught.detail.sharedId, S, "detail preserved: the old copy is still live");
    assert.equal(typeof caught.detail.sourceId, "string");
    assert.equal(store.get("anna", P).status, "pending", "the proposal is not marked accepted");
    assert.equal(store.get("anna", P).resolvedAt, null);
    assert.ok(warnings.some((w) => w.includes(P) && w.includes(caught.detail.sourceId)), "the failure is logged with the proposal and the ids");

    // The in-process guard was released: the same id can be resolved afterwards.
    const rejected = await engine.memory.proposals.reject(P, anna, userAgent, { note: "retry later" });
    assert.equal(rejected.status, "rejected");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(h) a concurrent resolve of the same proposal conflicts; after close() accept/reject refuse with storage", async () => {
    const { engine } = setup("e2-accept-h-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The front door code changes monthly.", "door code");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "The front door code changes weekly.", bernd, userAgent);

    const results = await Promise.allSettled([
      engine.memory.proposals.accept(P, anna, userAgent),
      engine.memory.proposals.reject(P, anna, userAgent),
    ]);
    assert.equal(results[0].status, "fulfilled", `accept wins: ${results[0].reason?.message}`);
    assert.equal(results[1].status, "rejected");
    assert.ok(code("conflict")(results[1].reason) && results[1].reason.message === "proposal is being resolved", `concurrent reject hits the in-process guard: ${results[1].reason?.message}`);
    const listed = await engine.memory.proposals.list({}, anna, userAgent);
    assert.equal(listed.items.find((x) => x.id === P).status, "accepted");

    const { proposalId: Q } = await engine.memory.propose(results[0].value.id, "Q text", bernd, userAgent);
    await engine.close({ budgetMs: 5_000 });

    await assert.rejects(() => engine.memory.proposals.accept(Q, anna, userAgent), code("storage"));
    await assert.rejects(() => engine.memory.proposals.reject(Q, anna, userAgent), code("storage"));
    await assert.rejects(() => engine.memory.proposals.list({}, anna, userAgent), code("storage"));
  });
});
