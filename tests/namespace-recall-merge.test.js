/**
 * Cross-namespace recall merge contracts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { emitRetrievalLedger, mergeNamespaceRecallResults } from "../lib/recall-pipeline.js";
import {
  addTraceCandidate,
  addTraceDecision,
  createRecallDecisionTrace,
} from "../lib/recall-decision-trace.js";

function memory(id, score, text, ownership = {}) {
  return {
    source: "vector",
    score,
    entry: {
      id,
      text,
      summary: text,
      category: "fact",
      storedBy: ownership.storedBy ?? "owner-a",
      workspaceKey: ownership.workspaceKey ?? "workspace-a",
      workspaceId: ownership.workspaceId ?? "workspace-a",
      agentId: ownership.agentId ?? "agent-a",
      ownerUserId: ownership.ownerUserId ?? "user-a",
      scope: ownership.scope ?? "agent-private",
      ...ownership,
    },
  };
}

function traceFor(namespace, candidate) {
  const trace = createRecallDecisionTrace({ query: "namespace merge" });
  addTraceCandidate(trace, {
    id: candidate.entry.id,
    source: candidate.source,
    score: candidate.score,
    summary: candidate.entry.summary,
  });
  addTraceDecision(trace, {
    memoryId: candidate.entry.id,
    action: "inclusion",
    stage: "per-namespace",
    reason: `selected by ${namespace}`,
    finalScore: candidate.score,
  });
  return trace;
}

describe("mergeNamespaceRecallResults", () => {
  it("globally orders, collapses IDs, deduplicates canonical content, and preserves ownership without mutating inputs", () => {
    const aHigh = memory("a-high", 0.95, "active namespace release plan");
    const aLow = memory("a-low", 0.80, "local diagnostics changed after restart", {
      storedBy: "agent-a",
      workspaceKey: "workspace-a",
      ownerUserId: "owner-a",
    });
    const sameIdLow = memory("same-id", 0.55, "lower score copy of the same card");
    const similarA = memory("similar-a", 0.45, "The user prefers a navy theme for the dashboard.");
    const bHigh = memory("b-high", 0.90, "legacy namespace migration deadline Friday", {
      storedBy: "agent-a",
      workspaceKey: "workspace-a",
      scope: "agent-private",
    });
    const sameIdHigh = memory("same-id", 0.65, "higher score copy of the same card", {
      storedBy: "agent-a",
      workspaceKey: "workspace-a",
    });
    const similarB = memory("similar-b", 0.44, "The user prefers a navy dashboard theme.");
    const inputs = [
      {
        namespace: "ns-a",
        queryVector: [0.1, 0.2, 0.3],
        canonical: [{ heading: "Knowledge", text: "# Knowledge\n\nCanonical dashboard policy.", score: 0.80 }],
        memories: [aHigh, aLow, sameIdLow, similarA],
        trace: traceFor("ns-a", aHigh),
      },
      {
        namespace: "ns-b",
        canonical: [{ heading: " knowledge ", text: "# Knowledge\n\nCanonical dashboard policy.", score: 0.90 }],
        memories: [bHigh, sameIdHigh, similarB],
        trace: traceFor("ns-b", bHigh),
      },
    ];
    const before = structuredClone(inputs);
    const master = createRecallDecisionTrace({ query: "namespace merge" });

    const merged = mergeNamespaceRecallResults(inputs, {
      maxOut: 4,
      canonicalMaxItems: 1,
      dedupEnabled: true,
      dedupJaccard: 0.78,
      trace: master,
    });

    assert.deepEqual(merged.memories.map((item) => item.entry.id), ["a-high", "b-high", "a-low"]);
    assert.equal(merged.canonical.length, 1);
    assert.equal(merged.canonical[0].namespace, "ns-b", "the highest scoring equivalent canonical item wins");
    assert.equal(merged.memories[0].namespace, "ns-a");
    assert.equal(merged.memories[1].namespace, "ns-b");
    assert.deepEqual(
      {
        storedBy: merged.memories[2].entry.storedBy,
        workspaceKey: merged.memories[2].entry.workspaceKey,
        ownerUserId: merged.memories[2].entry.ownerUserId,
        scope: merged.memories[2].entry.scope,
      },
      {
        storedBy: "agent-a",
        workspaceKey: "workspace-a",
        ownerUserId: "owner-a",
        scope: "agent-private",
      },
    );
    assert.notStrictEqual(merged.memories[0], aHigh, "merge returns a cloned wrapper");
    assert.notStrictEqual(merged.memories[0].entry, aHigh.entry, "merge returns a cloned entry");
    assert.deepEqual(merged.queryVector, [0.1, 0.2, 0.3]);
    assert.notStrictEqual(merged.queryVector, inputs[0].queryVector, "the pipeline result vector is cloned");
    assert.deepEqual(inputs, before, "merge must not mutate caller-owned results");
    assert.deepEqual(
      new Set(merged.trace.candidates.map((item) => item.namespace)),
      new Set(["ns-a", "ns-b"]),
    );
    assert.ok(
      merged.trace.decisions.some((item) => item.action === "deduped" && item.memoryId === "same-id"),
      "cross-namespace drops are recorded in the master trace",
    );
    assert.equal(merged.canonical.length + merged.memories.length, 4);
  });

  it("keeps similar different IDs when dedup is disabled while still enforcing the global cap", () => {
    const inputs = [
      {
        namespace: "ns-a",
        canonical: [],
        memories: [memory("a", 0.9, "The user prefers a navy theme for the dashboard.")],
      },
      {
        namespace: "ns-b",
        canonical: [],
        memories: [memory("b", 0.8, "The user prefers a navy dashboard theme."), memory("c", 0.7, "separate card")],
      },
    ];

    const merged = mergeNamespaceRecallResults(inputs, {
      maxOut: 2,
      canonicalMaxItems: 0,
      dedupEnabled: false,
      dedupJaccard: 0.78,
    });

    assert.deepEqual(merged.memories.map((item) => item.entry.id), ["a", "b"]);
    assert.equal(merged.memories.length, 2);
    assert.equal(merged.canonical.length + merged.memories.length, 2);
  });

  it("keeps the higher duplicate-ID score and preserves configured namespace order for score ties", () => {
    const inputs = [
      {
        namespace: "ns-first",
        canonical: [],
        memories: [memory("duplicate", 0.7, "first version"), memory("tie-first", 0.6, "first tie")],
      },
      {
        namespace: "ns-second",
        canonical: [],
        memories: [memory("duplicate", 0.9, "second version"), memory("tie-second", 0.6, "second tie")],
      },
    ];

    const merged = mergeNamespaceRecallResults(inputs, {
      maxOut: 3,
      canonicalMaxItems: 0,
      dedupEnabled: false,
      dedupJaccard: 0.78,
    });

    assert.deepEqual(merged.memories.map((item) => item.entry.id), ["duplicate", "tie-first", "tie-second"]);
    assert.equal(merged.memories[0].score, 0.9);
    assert.equal(merged.memories[0].namespace, "ns-second");
  });
});

describe("emitRetrievalLedger", () => {
  it("keeps callback and warning failures secondary to a successful recall result", () => {
    const callbackError = new Error("injected retrieval ledger failure");
    const loggerError = new Error("injected retrieval warning failure");
    const selected = [memory("selected", 0.9, "selected memory")];

    const outcome = emitRetrievalLedger({
      retrievalLogger() { throw callbackError; },
      logger: { warn() { throw loggerError; } },
      entry: {
        agentId: "agent-a",
        workspaceKey: "workspace-a",
        query: "recall query",
        resultsCount: selected.length,
        selectedIds: selected.map((item) => item.entry.id),
      },
    });

    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.error, callbackError);
    assert.strictEqual(outcome.loggingError, loggerError);
    assert.deepEqual(selected.map((item) => item.entry.id), ["selected"]);
  });

  it("observes asynchronous callback and warning failures without rejecting", async () => {
    const callbackError = new Error("injected async retrieval ledger failure");
    const loggerError = new Error("injected async retrieval warning failure");
    let callbackRejectionAttached = false;
    let warningRejectionAttached = false;

    const outcome = emitRetrievalLedger({
      retrievalLogger() {
        return {
          then(_resolve, reject) {
            callbackRejectionAttached = true;
            reject(callbackError);
          },
        };
      },
      logger: {
        warn() {
          return {
            then(_resolve, reject) {
              warningRejectionAttached = true;
              reject(loggerError);
            },
          };
        },
      },
      entry: { agentId: "agent-a", resultsCount: 0, selectedIds: [] },
    });

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.pending, true);
    assert.strictEqual(callbackRejectionAttached, true);
    assert.deepEqual(await outcome.settlement, {
      ok: false,
      error: callbackError,
      loggingError: loggerError,
    });
    assert.strictEqual(warningRejectionAttached, true);
  });
});
