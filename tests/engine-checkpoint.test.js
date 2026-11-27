/**
 * tests/engine-checkpoint.test.js — PR-15.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CHECKPOINT_REASONS, createCheckpointStore, resolveCompactedAt } from "../engine/checkpoint/checkpoint-store.js";

describe("checkpoint store", () => {
  it("records the host clock and is idempotent for the same digest", () => {
    let now = 1_000;
    const store = createCheckpointStore({ clock: () => now });
    const first = store.checkpoint("agent-a", "compaction", { sessionKey: "s1" });
    assert.equal(first.written, true);
    assert.match(first.digest, /^[a-f0-9]{32}$/);
    assert.equal(store.lastAt("agent-a", "compaction"), 1_000);
    assert.equal(store.checkpoint("agent-a", "compaction", { sessionKey: "s1", at: 1_000 }).written, false);
    now = 2_000;
    assert.equal(store.checkpoint("agent-a", "compaction", { sessionKey: "s1" }).written, true);
    assert.equal(store.lastAt("agent-a", "compaction"), 2_000);
    assert.equal(store.lastAt("agent-b", "compaction"), null);
  });

  it("accepts the four reasons and rejects anything else", () => {
    assert.deepEqual(CHECKPOINT_REASONS, ["compaction", "session-end", "shutdown", "manual"]);
    const store = createCheckpointStore({ clock: () => 1 });
    for (const reason of CHECKPOINT_REASONS) store.checkpoint("a", reason);
    assert.throws(() => store.checkpoint("a", "reboot"), /unknown checkpoint reason/);
  });
});

describe("resolveCompactedAt — the step-4 gate", () => {
  it("is identical to the old expression when only compactedAt is given", () => {
    const store = createCheckpointStore({ clock: () => 9 });
    const old = (event, hookCtx) => event?.compactedAt || hookCtx?.compactedAt || null;
    for (const [event, hookCtx] of [[{ compactedAt: 5 }, {}], [{}, { compactedAt: 7 }], [{}, {}], [{ compactedAt: 0 }, { compactedAt: 3 }]]) {
      assert.equal(resolveCompactedAt({ event, hookCtx, store, agentId: "a" }), old(event, hookCtx));
    }
  });

  it("falls back to the checkpoint when the host reported none on the event", () => {
    const store = createCheckpointStore({ clock: () => 42 });
    store.checkpoint("a", "compaction");
    assert.equal(resolveCompactedAt({ event: {}, hookCtx: {}, store, agentId: "a" }), 42);
    assert.equal(resolveCompactedAt({ event: { compactedAt: 7 }, hookCtx: {}, store, agentId: "a" }), 7);
    assert.equal(resolveCompactedAt({ event: {}, hookCtx: {}, store: null, agentId: "a" }), null);
  });
});
