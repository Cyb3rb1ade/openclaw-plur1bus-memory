/**
 * Cross-namespace recall merge contracts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { emitRetrievalLedger, mergeNamespaceRecallResults } from "../lib/recall-pipeline.js";
import {
  addTraceCandidate,
  addTraceDecision,
  addTraceGuard,
  addTraceStoreDecision,
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

function saturatedTrace(namespace, count) {
  const trace = createRecallDecisionTrace({
    query: "saturated namespace merge",
    maxCandidates: count,
    maxDecisions: count,
    maxGuards: count,
    maxStoreDecisions: count,
  });
  for (let index = 0; index < count; index++) {
    const memoryId = `${namespace}-${index}`;
    addTraceCandidate(trace, {
      id: memoryId,
      source: "vector",
      score: index / count,
      summary: `candidate ${memoryId}`,
    });
    addTraceDecision(trace, {
      memoryId,
      action: "inclusion",
      stage: "per-namespace",
      reason: `selected ${memoryId}`,
    });
    addTraceGuard(trace, {
      name: `guard-${memoryId}`,
      passed: true,
      memoryId,
      reason: `allowed ${memoryId}`,
    });
    addTraceStoreDecision(trace, {
      memoryId,
      action: "accepted",
      reason: `stored ${memoryId}`,
    });
  }
  return trace;
}

describe("mergeNamespaceRecallResults", () => {
  it("keeps text duplicates from disjoint known validity windows across namespaces", () => {
    const text = "Alex worked at Firma A.";
    const first = memory("history-a", 0.9, text, {
      validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2025-01-01"),
    });
    const second = memory("history-b", 0.8, text, {
      validFrom: Date.parse("2025-01-01"), validUntil: Date.parse("2026-01-01"),
    });
    const overlapping = memory("history-overlap", 0.7, text, {
      validFrom: Date.parse("2025-06-01"), validUntil: Date.parse("2026-06-01"),
    });
    const merged = mergeNamespaceRecallResults([
      { namespace: "ns-a", memories: [first] },
      { namespace: "ns-b", memories: [second, overlapping] },
    ], { maxOut: 5, dedupEnabled: true, dedupJaccard: 0.78 });
    assert.deepEqual(merged.memories.map((item) => item.entry.id), ["history-a", "history-b"]);
  });

  it("keeps canonical-origin copies when their known validity windows are disjoint", () => {
    const first = memory("origin-history-a", 0.9, "same origin history", {
      sourceAgentId: "agent-a", sourceMemoryId: "source-row",
      validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2025-01-01"),
    });
    const second = memory("origin-history-b", 0.8, "same origin history", {
      sourceAgentId: "agent-a", sourceMemoryId: "source-row",
      validFrom: Date.parse("2025-01-01"), validUntil: Date.parse("2026-01-01"),
    });
    const merged = mergeNamespaceRecallResults([
      { namespace: "ns-a", sourceKind: "private", memories: [first] },
      { namespace: "ns-b", sourceKind: "workspace", memories: [second] },
    ], { maxOut: 5, dedupEnabled: false });
    assert.deepEqual(merged.memories.map((item) => item.entry.id), ["origin-history-a", "origin-history-b"]);
  });

  it("lets a higher-priority canonical-origin bridge replace every overlapping winner", () => {
    const origin = { sourceAgentId: "agent-a", sourceMemoryId: "source-row" };
    const first = memory("origin-a", 0.9, "first historical version", {
      ...origin, validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2025-01-01"),
    });
    const second = memory("origin-b", 0.8, "second historical version", {
      ...origin, validFrom: Date.parse("2025-01-01"), validUntil: Date.parse("2026-01-01"),
    });
    const bridge = memory("origin-bridge", 0.7, "bridging historical version", {
      ...origin, validFrom: Date.parse("2024-06-01"), validUntil: Date.parse("2025-06-01"),
    });

    const merged = mergeNamespaceRecallResults([
      { namespace: "workspace-a", sourceKind: "workspace", memories: [first] },
      { namespace: "workspace-b", sourceKind: "workspace", memories: [second] },
      { namespace: "private", sourceKind: "private", memories: [bridge] },
    ], { maxOut: 2, dedupEnabled: false });

    assert.deepEqual(merged.memories.map((item) => item.entry.id), ["origin-bridge"]);
  });

  it("keeps disjoint canonical-origin winners when a lower-priority bridge overlaps both", () => {
    const origin = { sourceAgentId: "agent-a", sourceMemoryId: "source-row" };
    const first = memory("origin-a", 0.9, "first historical version", {
      ...origin, validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2025-01-01"),
    });
    const second = memory("origin-b", 0.8, "second historical version", {
      ...origin, validFrom: Date.parse("2025-01-01"), validUntil: Date.parse("2026-01-01"),
    });
    const bridge = memory("origin-bridge", 0.99, "bridging historical version", {
      ...origin, validFrom: Date.parse("2024-06-01"), validUntil: Date.parse("2025-06-01"),
    });

    const merged = mergeNamespaceRecallResults([
      { namespace: "private-a", sourceKind: "private", memories: [first] },
      { namespace: "private-b", sourceKind: "private", memories: [second] },
      { namespace: "workspace", sourceKind: "workspace", memories: [bridge] },
    ], { maxOut: 2, dedupEnabled: false });

    assert.deepEqual(merged.memories.map((item) => item.entry.id), ["origin-a", "origin-b"]);
  });

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

  it("keeps every child namespace represented when all master trace categories reach their caps", () => {
    const cap = 4;
    const master = createRecallDecisionTrace({
      query: "saturated namespace merge",
      maxCandidates: cap,
      maxDecisions: cap,
      maxGuards: cap,
      maxStoreDecisions: cap,
    });

    const merged = mergeNamespaceRecallResults([
      { namespace: "ns-a", canonical: [], memories: [], trace: saturatedTrace("ns-a", cap) },
      { namespace: "ns-b", canonical: [], memories: [], trace: saturatedTrace("ns-b", cap) },
    ], {
      maxOut: 0,
      canonicalMaxItems: 0,
      trace: master,
    });

    const expectedNamespaces = ["ns-a", "ns-b", "ns-a", "ns-b"];
    assert.deepEqual(merged.trace.candidates.map((entry) => entry.namespace), expectedNamespaces);
    assert.deepEqual(merged.trace.decisions.map((entry) => entry.namespace), expectedNamespaces);
    assert.deepEqual(merged.trace.guards.map((entry) => entry.namespace), expectedNamespaces);
    assert.deepEqual(merged.trace.storeDecisions.map((entry) => entry.namespace), expectedNamespaces);
    assert.deepEqual(
      merged.trace.candidates.map((entry) => entry.id),
      ["ns-a-2", "ns-b-2", "ns-a-3", "ns-b-3"],
      "the capped merge retains the newest fair suffix from each child trace",
    );
  });

  it("fairly caps child and global decisions by namespace without disturbing other trace categories", () => {
    const cap = 4;
    const inputs = [
      {
        namespace: "ns-a",
        canonical: [],
        memories: [
          memory("a-selected", 0.9, "selected from namespace a"),
          memory("a-drop-1", 0.7, "first global drop from namespace a"),
          memory("a-drop-2", 0.5, "newest global drop from namespace a"),
        ],
        trace: saturatedTrace("ns-a", cap),
      },
      {
        namespace: "ns-b",
        canonical: [],
        memories: [
          memory("b-selected", 0.8, "selected from namespace b"),
          memory("b-drop-1", 0.6, "first global drop from namespace b"),
          memory("b-drop-2", 0.4, "newest global drop from namespace b"),
        ],
        trace: saturatedTrace("ns-b", cap),
      },
    ];
    const before = structuredClone(inputs);
    const runMerge = () => mergeNamespaceRecallResults(inputs, {
      maxOut: 2,
      canonicalMaxItems: 0,
      dedupEnabled: false,
      trace: createRecallDecisionTrace({
        query: "child and global saturation",
        maxCandidates: cap,
        maxDecisions: cap,
        maxGuards: cap,
        maxStoreDecisions: cap,
      }),
    });

    const first = runMerge();
    const second = runMerge();
    const decisionIdentity = (entry) => ({
      namespace: entry.namespace,
      stage: entry.stage,
      memoryId: entry.memoryId,
    });
    const expectedDecisions = [
      { namespace: "ns-a", stage: "per-namespace", memoryId: "ns-a-3" },
      { namespace: "ns-b", stage: "per-namespace", memoryId: "ns-b-3" },
      { namespace: "ns-a", stage: "namespace-result-dedup", memoryId: "a-drop-2" },
      { namespace: "ns-b", stage: "namespace-result-dedup", memoryId: "b-drop-2" },
    ];

    assert.equal(first.trace.decisions.length, cap);
    assert.deepEqual(first.trace.decisions.map(decisionIdentity), expectedDecisions);
    assert.deepEqual(second.trace.decisions.map(decisionIdentity), expectedDecisions);
    assert.deepEqual(
      first.trace.candidates.map((entry) => entry.namespace),
      ["ns-a", "ns-b", "ns-a", "ns-b"],
    );
    assert.deepEqual(
      first.trace.guards.map((entry) => entry.namespace),
      ["ns-a", "ns-b", "ns-a", "ns-b"],
    );
    assert.deepEqual(
      first.trace.storeDecisions.map((entry) => entry.namespace),
      ["ns-a", "ns-b", "ns-a", "ns-b"],
    );
    assert.deepEqual(
      {
        totalCandidates: first.trace.summary.totalCandidates,
        included: first.trace.summary.included,
        deduped: first.trace.summary.deduped,
        guardPass: first.trace.summary.guardPass,
        storeAccepted: first.trace.summary.storeAccepted,
      },
      { totalCandidates: cap, included: 2, deduped: 2, guardPass: cap, storeAccepted: cap },
      "summary counts describe the retained fair suffix",
    );
    assert.deepEqual(inputs, before, "fair trace selection must not mutate namespace inputs");
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

  it("never copies callback query, memory, or credential text into warnings", () => {
    const queryText = "PRIVATE-QUERY-7788";
    const memoryText = "PRIVATE-MEMORY-9911";
    const credential = "sk-proj-AbCdEf0123456789+/=_-more";
    const callbackError = new Error(
      `ledger failed query=${queryText} memory=${memoryText} credential=${credential}`,
    );
    const warnings = [];

    const outcome = emitRetrievalLedger({
      retrievalLogger() { throw callbackError; },
      logger: { warn(message) { warnings.push(message); } },
      entry: { agentId: "agent-a", resultsCount: 0, selectedIds: [] },
    });

    assert.strictEqual(outcome.error, callbackError, "the internal outcome retains the original cause");
    assert.strictEqual(warnings.length, 1);
    assert.ok(!warnings[0].includes(queryText));
    assert.ok(!warnings[0].includes(memoryText));
    assert.ok(!warnings[0].includes(credential));
    assert.match(warnings[0], /retrieval callback failed/i);
  });
});
