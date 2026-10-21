import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPlur1busCommandRunner } from "../engine/commands/plur1bus-command.js";
import { findNeoRecord, formatJsonCommandResult } from "../engine/commands/command-helpers.js";
import { behaviorCardsFromReactions, createNeoStore } from "../lib/neo-arch.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const AGENT = "curation-agent";
const REQUESTER = { requesterAgentId: AGENT, requesterWorkspaceKey: "default", requesterOwnerId: "owner" };
const ACTIONS = [
  ["promote", "promoted", "stale"], ["demote", "demoted", "stale"],
  ["prune", "pruned", "excluded"], ["tombstone", "tombstoned", "tombstoned"],
];

function readRows(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
function fixture(origin = "behavior", { denied = false, lookup = findNeoRecord } = {}) {
  const dir = makeTempDir("curation-r4-");
  const store = createNeoStore(dir, "default");
  const [behavior] = behaviorCardsFromReactions([{
    id: "reaction-1", workspaceKey: "default", agentId: AGENT,
    polarity: 1, explicitness: "explicit_instruction", evidence: "Bitte immer konkrete Testbelege nennen.",
    confidence: 0.6, intensity: 0.7, extractedAt: "2026-10-01T10:00:00.000Z",
  }]);
  const record = origin === "behavior" ? behavior : {
    id: "candidate-1", workspaceKey: "default", agentId: AGENT,
    status: "active", statement: "Ein konkreter gespeicherter Fakt.", category: "workflow_preference",
    sourceTurnIds: ["turn-1"], confidence: 0.6, salience: 0.7, createdAt: "2026-10-01T10:00:00.000Z",
  };
  record.visibility = { scope: "agent_private" };
  if (origin === "behavior") store.appendBehaviorCards([record]);
  else store.appendCandidates([record]);
  const commandCtx = { agentId: AGENT, workspaceDir: dir, workspaceKey: "default", userId: "owner", channel: "telegram" };
  const memoryCtx = { agentId: AGENT, workspaceDir: dir, workspaceIdentity: "workspace:v1:default", chatKind: "private" };
  const runner = createPlur1busCommandRunner({
    checkArgsLength: () => null, parsePlur1busArgs: () => [],
    obsidianActionNames: new Set(), knownPlur1busActions: new Set(["memory"]),
    resolveRegisteredMemoryContext: async () => memoryCtx,
    workspacePolicyGuard: { decision: () => ({ allowed: true }) },
    isDestructiveAction: () => true, isSensitiveChatRead: () => false,
    checkAuth: async () => denied ? { text: "Not authorized" } : null,
    getNeoStore: () => store, neoRequester: () => REQUESTER,
    findNeoRecord: lookup, formatJsonCommandResult,
  });
  return { dir, store, record, run: (action, id = record.id) => runner(commandCtx, ["memory", action, id]) };
}

describe("R4 memory status commands preserve the origin store", () => {
  for (const [action, status, embeddingStatus] of ACTIONS) {
    for (const origin of ["behavior", "candidates"]) {
      it(`${action} revises ${origin} in place and queues its actual embedding target`, async () => {
        const { store, record, run } = fixture(origin);
        const result = JSON.parse((await run(action)).text);
        assert.equal(result.id, record.id);
        assert.equal(result.status, status);
        assert.equal(result.embeddingStatus, embeddingStatus);
        const ownRows = readRows(origin === "behavior" ? store.paths.behavior : store.paths.candidates);
        const otherRows = readRows(origin === "behavior" ? store.paths.candidates : store.paths.behavior);
        assert.equal(ownRows.length, 2);
        assert.equal(ownRows.at(-1).status, status);
        assert.equal(otherRows.filter((row) => row.id === record.id).length, 0);
        const queue = readRows(store.paths.embeddings);
        assert.equal(queue.length, 1);
        assert.equal(queue[0].targetId, record.id);
        assert.equal(queue[0].targetType, origin === "behavior" ? "behavior" : "memory");
        assert.equal(queue[0].status, embeddingStatus);
      });
    }
    it(`${action} never mutates a record when authorization fails`, async () => {
      const { store, run } = fixture("behavior", { denied: true });
      assert.equal((await run(action)).text, "Not authorized");
      assert.equal(readRows(store.paths.behavior).length, 1);
      assert.equal(readRows(store.paths.candidates).length, 0);
      assert.equal(readRows(store.paths.embeddings).length, 0);
    });
    it(`${action} emits a content-free audit entry after the successful revision`, async () => {
      const { dir, record, run } = fixture("behavior");
      await run(action);
      const audit = readRows(join(dir, ".adaptive-learning", "destructive-ops.jsonl"));
      assert.equal(audit.length, 1);
      assert.equal(audit[0].recordId, record.id);
      assert.equal(audit[0].action, action);
      assert.equal(audit[0].status, status);
      assert.equal(audit[0].store, "behavior");
      assert.ok(!JSON.stringify(audit).includes(record.statement));
    });
  }

  it("a behavior demotion survives a flood of later candidate rows", async () => {
    const { store, record, run } = fixture();
    await run("demote");
    store.appendCandidates(Array.from({ length: 600 }, (_, n) => ({
      id: `filler-${n}`, statement: `Other candidate ${n}`, category: "workflow_preference",
      status: "active", createdAt: "2026-10-02T00:00:00.000Z",
    })));
    assert.equal(findNeoRecord(store, record.id, REQUESTER).status, "demoted");
    assert.equal(readRows(store.paths.candidates).some((row) => row.id === record.id), false);
  });

  it("bases the transition on the fresh revision read under the Neo write lock", async () => {
    const { store, run } = fixture("behavior", {
      lookup(currentStore, id, requester) {
        const snapshot = findNeoRecord(currentStore, id, requester);
        currentStore.appendBehaviorCards([{ ...snapshot, confidence: 0.1, salience: 0.2, statement: "Fresh content from a concurrent writer.", updatedAt: "2026-10-02T00:00:00.000Z" }]);
        return snapshot;
      },
    });
    const result = JSON.parse((await run("promote")).text);
    assert.equal(result.statement, "Fresh content from a concurrent writer.");
    assert.ok(Math.abs(result.salience - 0.4) < 1e-9);
    assert.ok(Math.abs(result.confidence - 0.3) < 1e-9);
    assert.equal(readRows(store.paths.behavior).at(-1).statement, result.statement);
    assert.equal(readRows(store.paths.candidates).length, 0);
  });

  it("refuses a record whose current owner changed after the authorized lookup", async () => {
    const { store, run } = fixture("behavior", {
      lookup(currentStore, id, requester) {
        const snapshot = findNeoRecord(currentStore, id, requester);
        currentStore.appendBehaviorCards([{ ...snapshot, agentId: "another-agent", updatedAt: "2026-10-02T00:00:00.000Z" }]);
        return snapshot;
      },
    });
    const result = await run("demote");
    assert.match(result.text, /No PLUR1BUS neo record found/);
    assert.equal(readRows(store.paths.behavior).length, 2);
    assert.equal(readRows(store.paths.behavior).at(-1).agentId, "another-agent");
    assert.equal(readRows(store.paths.candidates).length, 0);
    assert.equal(readRows(store.paths.embeddings).length, 0);
  });

  it("does not resurrect a record that disappeared before the locked revision", async () => {
    const { store, run } = fixture("behavior", {
      lookup(currentStore, id, requester) {
        const snapshot = findNeoRecord(currentStore, id, requester);
        unlinkSync(currentStore.paths.behavior);
        return snapshot;
      },
    });
    assert.match((await run("promote")).text, /No PLUR1BUS neo record found/);
    assert.equal(readRows(store.paths.behavior).length, 0);
    assert.equal(readRows(store.paths.candidates).length, 0);
    assert.equal(readRows(store.paths.embeddings).length, 0);
  });

  it("audits the committed transition even when the subsequent embedding queue is unavailable", async () => {
    const { dir, store, run } = fixture();
    store.appendEmbeddingQueue = () => { throw new Error("embedding queue unavailable"); };
    await assert.rejects(run("demote"), /embedding queue unavailable/);
    assert.equal(readRows(store.paths.behavior).at(-1).status, "demoted");
    const audit = readRows(join(dir, ".adaptive-learning", "destructive-ops.jsonl"));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].status, "demoted");
  });

  it("keeps an unknown ID read-only", async () => {
    const { store, run } = fixture();
    assert.match((await run("promote", "unknown-id")).text, /No PLUR1BUS neo record found/);
    assert.equal(readRows(store.paths.behavior).length, 1);
    assert.equal(readRows(store.paths.candidates).length, 0);
    assert.equal(readRows(store.paths.embeddings).length, 0);
  });
});
