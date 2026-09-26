/**
 * tests/engine-memory-proposals.test.js — E2 Task 5 (spec decision D31):
 * change proposals against a shared copy — the store, `memory.propose`,
 * `memory.proposals.list`, and the `memory.proposal` event.
 *
 * Part 1 of 2: filing and listing. Task 6 extends this file with
 * `proposals.accept`/`.reject`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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
