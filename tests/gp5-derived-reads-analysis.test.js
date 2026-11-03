import { test } from "node:test";
import assert from "node:assert/strict";
import { isDerivedRecordAccessible, stampDerivedVisibility } from "../lib/neo-arch.js";

// Analysis-only: unresolved acceptance cases, no changed runtime behavior.
test.todo("R5 owner decision: global_user stamped with ownerUserId is visible to its canonical owner", () => {
  const record = stampDerivedVisibility({ id: "pattern-a", agentId: "agent-a" }, { scope: "user", agentId: "agent-a", ownerUserId: "telegram:owner" });
  assert.equal(isDerivedRecordAccessible(record, { requesterAgentId: "agent-a", ownerUserId: "telegram:owner" }), true);
  assert.equal(isDerivedRecordAccessible(record, { requesterAgentId: "agent-a", ownerUserId: "telegram:other" }), false);
});
test.todo("R5 owner decision: auto recall authorizes pattern metadata before rendering name and description");
test.todo("R5 owner decision: graph requester adaptation preserves endpoint authorization in auto, warm and tool recall");
test.todo("R5 owner decision: capture dedup and constellation report exclude foreign derived metadata");
test.todo("R5 owner decision: CRR retains serialized and hydrated endpoint checks after scoped reads");
test.todo("R5 migration: conflicting ownerId/ownerUserId fail closed and legacy migration is reversible");
test.todo("R5 migration: foreign rows cannot exhaust scoped read limits or survive in an old prompt cache");
