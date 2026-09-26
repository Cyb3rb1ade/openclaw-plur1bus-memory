/**
 * tests/engine-memory-share-unsupported.test.js — E4 Task 6: `Engine.memory.share`
 * and `Engine.memory.proposals.accept` answer a typed `unsupported` MemoryOpError
 * on a platform without shared memory, before any row, archive or
 * `.plur1bus-shared` directory is written. Shared reads are unchanged (E4-R2).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { internalsOf } from "../engine/internals.js";
import { stableDirectoryCapabilitiesSupported } from "../lib/directory-capability.js";
import { archiveCount, code, principal, seedAndGetId, setup, userAgent } from "./helpers/shared-workspace-engine.js";

const NIL_UUID = "00000000-0000-4000-8000-000000000000";

describe("Engine.memory.share on a platform without shared memory (E4 Task 6, E4-R2)", () => {
  it("(b) share answers unsupported before any write, whether or not the source id exists; reads and list are unaffected", async () => {
    const { baseDbPath, stateDir, engine } = setup("e4-share-unsupported-b-");
    const anna = principal("anna");
    const id = await seedAndGetId(engine, "anna", "The spare keys are in the drawer by the door.", "spare keys");

    const internals = internalsOf(engine);
    internals.sharedMemoryPool.supported = false;

    const archivesBefore = archiveCount(stateDir, "anna");

    await assert.rejects(
      () => engine.memory.share(id, "workspace", anna, userAgent),
      (err) => code("unsupported")(err) && err.name === "MemoryOpError"
        && err.message === "shared memory is not supported on this platform"
        && err.detail && Object.keys(err.detail).length === 2
        && err.detail.capability === "shared-memory" && err.detail.reason === "platform",
    );
    assert.equal(existsSync(join(baseDbPath, ".plur1bus-shared")), false, "no shared root was created");
    assert.equal(archiveCount(stateDir, "anna"), archivesBefore, "nothing was archived");

    // A source id that doesn't even exist still answers unsupported: the
    // check is a platform property, answered before any anti-oracle lookup.
    await assert.rejects(
      () => engine.memory.share(NIL_UUID, "workspace", anna, userAgent),
      code("unsupported"),
    );

    const listed = await engine.memory.list({ topic: "spare keys" }, anna, userAgent);
    assert.ok(listed.items.some((c) => c.id === id), "anna's card is still listed");

    await engine.close({ budgetMs: 5_000 });
  });
});

describe("Engine.memory.proposals.accept on a platform without shared memory (E4 Task 6, E4-R2)", {
  skip: stableDirectoryCapabilitiesSupported() ? false : `fd-backed directory capabilities are unavailable on ${process.platform}`,
}, () => {
  it("(c) accept answers unsupported before refreshing the shared copy; the proposal stays pending; a foreign accept still answers not-found", async () => {
    const { engine } = setup("e4-share-unsupported-c-");
    const anna = principal("anna");
    const bernd = principal("bernd");
    const carol = principal("carol");
    const F = await seedAndGetId(engine, "anna", "The conference room booking link changed.", "conference room");
    const { sharedId: S } = await engine.memory.share(F, "workspace", anna, userAgent);
    const { proposalId: P } = await engine.memory.propose(S, "The conference room booking link changed again.", bernd, userAgent);

    const internals = internalsOf(engine);
    internals.sharedMemoryPool.supported = false;

    await assert.rejects(
      () => engine.memory.proposals.accept(P, anna, userAgent),
      (err) => code("unsupported")(err)
        && err.detail && err.detail.capability === "shared-memory" && err.detail.reason === "platform",
    );

    const pending = await (async () => {
      internals.sharedMemoryPool.supported = true;
      try {
        const list = await engine.memory.proposals.list({ status: "pending" }, anna, userAgent);
        return list.items.find((item) => item.id === P);
      } finally {
        internals.sharedMemoryPool.supported = false;
      }
    })();
    assert.ok(pending, "the proposal file still says pending");

    // A foreign proposal is resolved/authorised before the platform check
    // ever runs, so carol still gets the usual anti-oracle answer.
    await assert.rejects(() => engine.memory.proposals.accept(P, carol, userAgent), code("not-found"));

    internals.sharedMemoryPool.supported = true;
    await engine.close({ budgetMs: 5_000 });
  });
});
