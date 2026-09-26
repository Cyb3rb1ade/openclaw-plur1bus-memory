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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { internalsOf } from "../engine/internals.js";
import { createMemoryWrite } from "../engine/memory-ops/write.js";
import { createSharedMemoryOps } from "../engine/memory-ops/shared.js";
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
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one resolve succeeds");
    assert.equal(refused.length, 1, "exactly one resolve is refused");
    assert.ok(code("conflict")(refused[0].reason) && refused[0].reason.message === "proposal is being resolved", `the other hits the in-process guard: ${refused[0].reason?.message}`);
    const acceptWon = results[0].status === "fulfilled";
    const listed = await engine.memory.proposals.list({}, anna, userAgent);
    assert.equal(listed.items.find((x) => x.id === P).status, acceptWon ? "accepted" : "rejected");

    const liveCopy = acceptWon ? results[0].value.id : S;
    const { proposalId: Q } = await engine.memory.propose(liveCopy, "Q text", bernd, userAgent);
    await engine.close({ budgetMs: 5_000 });

    await assert.rejects(() => engine.memory.proposals.accept(Q, anna, userAgent), code("storage"));
    await assert.rejects(() => engine.memory.proposals.reject(Q, anna, userAgent), code("storage"));
    await assert.rejects(() => engine.memory.proposals.list({}, anna, userAgent), code("storage"));
  });

  it("(i) a failed shared-copy lookup answers storage and leaves the proposal pending (never stale)", async () => {
    const { baseDbPath, engine } = setup("e2-accept-i-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The stationery cupboard is restocked on Fridays.", "stationery cupboard");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "The stationery cupboard is restocked on Mondays.", bernd, userAgent);

    const internals = internalsOf(engine);
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m), info() {}, debug() {}, error() {} };
    const failingLookup = createSharedMemoryOps({
      opsContext: internals.memoryOpsContext,
      pool: internals.pool,
      sharedMemoryPool: internals.sharedMemoryPool,
      memoryDbAdapter: internals.memoryDbAdapter,
      embeddings: internals.embeddings,
      baseDbPath,
      applyCorrection: async () => { throw new Error("not reached"); },
      logger,
      findAcrossPools: async () => { throw new Error("injected lookup failure"); },
    });
    const store = createProposalStore({ baseDbPath, logger });
    const proposals = createMemoryProposals({
      opsContext: internals.memoryOpsContext,
      sharedOps: failingLookup,
      store,
      memoryDbAdapter: internals.memoryDbAdapter,
      host: internals.host,
      logger,
    });

    await assert.rejects(() => proposals.accept(P, anna, userAgent), (err) => code("storage")(err) && err.message === "memory read failed");
    assert.equal(store.get("anna", P).status, "pending", "a read error is not a definite absence");
    assert.equal(store.get("anna", P).resolvedAt, null);
    assert.ok(warnings.some((w) => w.includes("injected lookup failure")), "the raw error goes to the log only");

    // With a working lookup the same proposal is still acceptable.
    const accepted = await engine.memory.proposals.accept(P, anna, userAgent);
    assert.equal(accepted.proposalId, P);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(j) recording the acceptance fails after the refresh: storage names the applied ids", async () => {
    const { baseDbPath, engine } = setup("e2-accept-j-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The plant shelf gets light in the afternoon.", "plant shelf");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const newText = "The plant shelf gets light in the morning.";
    const { proposalId: P } = await engine.memory.propose(S, newText, bernd, userAgent);

    const internals = internalsOf(engine);
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m), info() {}, debug() {}, error() {} };
    const realStore = createProposalStore({ baseDbPath, logger });
    const failingStore = {
      ...realStore,
      update: (proposal) => {
        if (proposal.status === "accepted") throw new Error("injected update failure");
        return realStore.update(proposal);
      },
    };
    const proposals = createMemoryProposals({
      opsContext: internals.memoryOpsContext,
      sharedOps: internals.memoryWrite.shared,
      store: failingStore,
      memoryDbAdapter: internals.memoryDbAdapter,
      host: internals.host,
      logger,
    });

    let caught;
    await assert.rejects(() => proposals.accept(P, anna, userAgent), (err) => {
      caught = err;
      return code("storage")(err) && err.message === "proposal applied but not recorded as accepted";
    });
    assert.equal(caught.detail.proposalId, P);
    assert.equal(typeof caught.detail.id, "string");
    assert.equal(typeof caught.detail.sourceId, "string");
    assert.notEqual(caught.detail.id, S);
    const applied = await engine.memory.show(caught.detail.id, bernd, userAgent);
    assert.equal(applied.text, newText, "the shared copy the detail names carries the proposal's text");
    assert.ok(warnings.some((w) => w.includes(P) && w.includes(caught.detail.id) && w.includes(caught.detail.sourceId)), "the failure is logged with all three ids");
    assert.equal(realStore.get("anna", P).status, "pending");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(k) ruling R10: the sharer's original is gone — accept answers conflict and the proposal stays pending", async () => {
    const { engine } = setup("e2-accept-k-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The umbrella stand is by the lift.", "umbrella stand");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "The umbrella stand is by the stairs.", bernd, userAgent);
    await engine.memory.forget(F, anna, userAgent);

    await assert.rejects(() => engine.memory.proposals.accept(P, anna, userAgent), (err) => code("conflict")(err)
      && err.message === "the original of this shared copy is no longer live; retract it instead");
    const listed = await engine.memory.proposals.list({}, anna, userAgent);
    assert.equal(listed.items.find((x) => x.id === P).status, "pending");
    const copy = await engine.memory.show(S, bernd, userAgent);
    assert.equal(copy.text, "The umbrella stand is by the lift.", "the copy is unchanged");

    await engine.close({ budgetMs: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Final-review fixes (E2): pool-scoped proposals, legacy shared rows,
// concurrent duplicate filing, reject's audit failure.
// ---------------------------------------------------------------------------

describe("Engine.memory proposals — final-review fixes (E2)", () => {
  const USER_Y = `user:v1:${"a".repeat(64)}`;
  const USER_Z = `user:v1:${"c".repeat(64)}`;

  it("(F1) a user-scope proposal is scoped to its pool: another principal of the same sharer agent neither lists nor resolves it", async () => {
    const { engine } = setup("e2-fix-pool-");
    const annaY = principal("anna", { user: USER_Y });
    const annaZ = principal("anna", { user: USER_Z });
    const berndY = principal("bernd", { user: USER_Y });
    const berndZ = principal("bernd", { user: USER_Z });
    const F = await seedAndGetId(engine, "anna", "The dentist appointment card is on the fridge.", "dentist card");
    const { sharedId: S } = await engine.memory.share(F, "user", annaY, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "The dentist card moved to the pinboard.", berndY, userAgent);

    const forAnnaY = await engine.memory.proposals.list({}, annaY, userAgent);
    assert.deepEqual(forAnnaY.items.map((x) => x.id), [P]);
    assert.equal("poolKey" in forAnnaY.items[0], false, "the pool key stays internal");
    const forBerndY = await engine.memory.proposals.list({}, berndY, userAgent);
    assert.deepEqual(forBerndY.items.map((x) => x.id), [P]);

    // The same agents under another user principal cannot reach the user pool.
    assert.equal((await engine.memory.proposals.list({}, annaZ, userAgent)).items.length, 0);
    assert.equal((await engine.memory.proposals.list({}, berndZ, userAgent)).items.length, 0);
    assert.equal((await engine.memory.proposals.list({}, principal("anna"), userAgent)).items.length, 0);

    await assert.rejects(() => engine.memory.proposals.accept(P, annaZ, userAgent), code("not-found"));
    await assert.rejects(() => engine.memory.proposals.reject(P, annaZ, userAgent), code("not-found"));
    const still = await engine.memory.proposals.list({}, annaY, userAgent);
    assert.equal(still.items[0].status, "pending", "refused resolves leave it pending (never stale)");

    const accepted = await engine.memory.proposals.accept(P, annaY, userAgent);
    assert.equal(accepted.proposalId, P);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(F1b) a proposal file without a pool key is unreachable: not listed, not resolvable", async () => {
    const { baseDbPath, engine } = setup("e2-fix-nopool-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The parking permits renew in January.", "parking permits");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "The parking permits renew in March.", bernd, userAgent);

    const file = join(dirname(baseDbPath), "_proposals", "anna", `${P}.json`);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(typeof onDisk.poolKey, "string", "propose records the pool key");
    delete onDisk.poolKey;
    writeFileSync(file, JSON.stringify(onDisk));

    assert.equal((await engine.memory.proposals.list({}, anna, userAgent)).items.length, 0);
    assert.equal((await engine.memory.proposals.list({}, bernd, userAgent)).items.length, 0);
    await assert.rejects(() => engine.memory.proposals.accept(P, anna, userAgent), code("not-found"));
    await assert.rejects(() => engine.memory.proposals.reject(P, anna, userAgent), code("not-found"));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).status, "pending");

    await engine.close({ budgetMs: 5_000 });
  });

  it("(F5) propose on a legacy shared row with no recorded sharer is denied before any store write", async () => {
    const { baseDbPath, engine } = setup("e2-fix-legacy-");
    const internals = internalsOf(engine);
    const writes = [];
    const realStore = createProposalStore({ baseDbPath });
    const store = { ...realStore, create: (x) => { writes.push(x); return realStore.create(x); } };
    const id = randomUUID();
    for (const legacy of [
      { id, scope: "workspace", text: "legacy text", sourceAgentId: "", sourceMemoryId: randomUUID() },
      { id, scope: "workspace", text: "legacy text", sourceAgentId: "anna", sourceMemoryId: "" },
    ]) {
      const proposals = createMemoryProposals({
        opsContext: internals.memoryOpsContext,
        sharedOps: { findSharedRow: async () => ({ card: legacy, sourceKind: "workspace" }) },
        store,
        memoryDbAdapter: internals.memoryDbAdapter,
        host: internals.host,
      });
      await assert.rejects(() => proposals.propose(id, "new text", principal("bernd"), userAgent),
        (err) => code("denied")(err) && err.message === "this shared copy has no recorded sharer");
    }
    assert.equal(writes.length, 0);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(F6) concurrent duplicate proposals by the same proposer on the same copy: exactly one is filed, the other conflicts", async () => {
    const { engine } = setup("e2-fix-dup-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The lobby lights switch off at ten.", "lobby lights");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);

    const results = await Promise.allSettled([
      engine.memory.propose(S, "The lobby lights switch off at eleven.", bernd, userAgent),
      engine.memory.propose(S, "The lobby lights switch off at midnight.", bernd, userAgent),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(refused.length, 1);
    assert.ok(code("conflict")(refused[0].reason), `loser conflicts: ${refused[0].reason?.message}`);
    assert.equal((await engine.memory.proposals.list({}, anna, userAgent)).items.length, 1);

    await engine.close({ budgetMs: 5_000 });
  });

  it("(F7) reject: an audit failure after the rejection was recorded answers storage naming the proposal", async () => {
    const { workspaceDir, engine } = setup("e2-fix-rejaudit-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const F = await seedAndGetId(engine, "anna", "The coat hooks are by the entrance.", "coat hooks");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "The coat hooks are by the kitchen.", bernd, userAgent);

    // Replace the audit log with a directory: the append fails (even as root).
    const auditFile = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    rmSync(auditFile, { force: true });
    mkdirSync(auditFile, { recursive: true });

    const originalWarn = console.warn;
    console.warn = () => {};
    let caught;
    try {
      await assert.rejects(() => engine.memory.proposals.reject(P, anna, userAgent), (err) => {
        caught = err;
        return code("storage")(err) && err.message === "audit failed";
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual({ ...caught.detail }, { proposalId: P });
    const listed = await engine.memory.proposals.list({}, anna, userAgent);
    assert.equal(listed.items.find((x) => x.id === P).status, "rejected");

    await engine.close({ budgetMs: 5_000 });
  });
});
