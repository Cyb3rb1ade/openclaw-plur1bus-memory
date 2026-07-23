/**
 * tests/safe-update-dataloss.test.js
 *
 * Regression: safeUpdate's semantic-content path must store the new version
 * BEFORE marking the old row superseded. If db.store fails after the supersede,
 * the old memory is hidden from active queries while the replacement never
 * exists — silent, unrecoverable data loss.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildUpdateEntry, safeUpdate } from "../lib/safe-update.js";

const OLD_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  text: "Original fact",
  summary: "Original fact",
  vector: [0.1, 0.2, 0.3],
  scope: "agent-private",
  agentId: "agent-a",
  storedBy: "agent-a",
  workspaceId: "",
  workspaceKey: "",
  ownerUserId: "",
  status: "active",
  versionNumber: 1,
};
const PATCH = { text: "Corrected fact", vector: [0.11, 0.21, 0.31] };
const EVIDENCE = { updateSource: "test", updateEvidence: "unit test", confidence: 0.9 };
const EMPTY_WORKSPACE_ALIASES = Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) });

describe("safeUpdate — supersede-after-store ordering", () => {
  it("preserves the exact valid binding for workspace and user replacements", () => {
    const workspaceNext = buildUpdateEntry({
      ...OLD_ROW,
      scope: "workspace",
      workspaceId: "ws-a",
      workspaceKey: "ws-a",
    }, PATCH, EVIDENCE, {
      agentId: "requester-agent",
      workspaceId: "requester-workspace",
      ownerUserId: `user:v1:${"b".repeat(64)}`,
    });
    assert.equal(workspaceNext.agentId, "agent-a");
    assert.equal(workspaceNext.storedBy, "agent-a");
    assert.equal(workspaceNext.workspaceId, "ws-a");
    assert.equal(workspaceNext.workspaceKey, "ws-a");
    assert.equal(workspaceNext.ownerUserId, "");

    const ownerUserId = `user:v1:${"a".repeat(64)}`;
    const userNext = buildUpdateEntry({
      ...OLD_ROW,
      scope: "user",
      workspaceId: "",
      workspaceKey: "",
      ownerUserId,
    }, PATCH, EVIDENCE);
    assert.equal(userNext.agentId, "agent-a");
    assert.equal(userNext.storedBy, "agent-a");
    assert.equal(userNext.workspaceId, "");
    assert.equal(userNext.workspaceKey, "");
    assert.equal(userNext.ownerUserId, ownerUserId);
  });

  it("rejects an unbound or conflicting source before idempotency or writes", async () => {
    for (const oldRow of [
      { ...OLD_ROW, scope: "workspace", workspaceId: "", workspaceKey: "" },
      { ...OLD_ROW, agentId: "agent-a", storedBy: "agent-b" },
    ]) {
      const storeCalls = [];
      const updateCalls = [];
      let idempotencyReads = 0;
      const db = {
        getById: async () => oldRow,
        store: async (entry) => storeCalls.push(entry),
        update: async (...args) => updateCalls.push(args),
      };
      const neoStore = {
        async readReconsolidationEvents() {
          idempotencyReads += 1;
          return [];
        },
      };

      await assert.rejects(
        () => safeUpdate(db, oldRow.id, PATCH, EVIDENCE, {
          neoStore,
          workspaceAliases: EMPTY_WORKSPACE_ALIASES,
          skipDriftGate: true,
        }),
        /invalid ownership tuple/,
      );
      assert.equal(idempotencyReads, 0);
      assert.equal(storeCalls.length, 0);
      assert.equal(updateCalls.length, 0);
    }
  });

  it("logs idempotency read failures redacted and fails before replacement", async () => {
    const storeCalls = [];
    const updateCalls = [];
    const debugCalls = [];
    const db = {
      getById: async () => ({ ...OLD_ROW }),
      store: async (entry) => storeCalls.push(entry),
      update: async (...args) => updateCalls.push(args),
    };
    const neoStore = {
      async readReconsolidationEvents() {
        throw new Error("sqlite token=super-secret");
      },
    };

    await assert.rejects(
      () => safeUpdate(db, OLD_ROW.id, PATCH, EVIDENCE, {
        neoStore,
        logger: { debug: (...args) => debugCalls.push(args) },
        skipDriftGate: true,
      }),
      /idempotency check failed/i,
    );

    assert.equal(storeCalls.length, 0);
    assert.equal(updateCalls.length, 0);
    assert.equal(debugCalls.length, 1);
    assert.match(String(debugCalls[0][0]), /idempotency check/i);
    assert.doesNotMatch(String(debugCalls[0][0]), /super-secret|token=/i);
  });

  it("does not supersede the old row when storing the new version fails", async () => {
    let supersedeCalled = false;
    const db = {
      getById: async () => ({ ...OLD_ROW }),
      update: async () => { supersedeCalled = true; },
      store: async () => { throw new Error("simulated store failure"); },
    };

    await assert.rejects(
      () => safeUpdate(db, OLD_ROW.id, PATCH, EVIDENCE, { skipDriftGate: true }),
      /simulated store failure/,
    );

    assert.strictEqual(
      supersedeCalled,
      false,
      "old row must NOT be marked superseded when the new-version store fails (data-loss guard)",
    );
  });
});
