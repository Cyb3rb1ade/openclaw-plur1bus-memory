/**
 * tests/recall-decision-trace.test.js — Unit tests for recall decision trace helpers.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  createRecallDecisionTrace,
  addTraceCandidate,
  addTraceDecision,
  addTraceGuard,
  addTraceStoreDecision,
  summarizeTrace,
  serializeTraceForDebug,
  attachTraceToMemory,
  getMemoryTrace,
  textPreview,
} from "../lib/recall-decision-trace.js";

describe("createRecallDecisionTrace", () => {
  it("creates a trace with sensible defaults", () => {
    const trace = createRecallDecisionTrace();
    assert.ok(trace.traceId.startsWith("rdt-"));
    assert.ok(typeof trace.createdAt === "string");
    assert.deepStrictEqual(trace.query, { text: "", hash: undefined });
    assert.strictEqual(trace.config.maxCandidates, 50);
    assert.strictEqual(trace.config.maxTextPreviewChars, 160);
    assert.deepStrictEqual(trace.candidates, []);
    assert.deepStrictEqual(trace.decisions, []);
    assert.deepStrictEqual(trace.guards, []);
    assert.deepStrictEqual(trace.storeDecisions, []);
    assert.strictEqual(trace.summary.totalCandidates, 0);
  });

  it("accepts query, hash and config overrides", () => {
    const trace = createRecallDecisionTrace({
      query: "What database do we use?",
      queryHash: "abc123",
      maxCandidates: 10,
      maxTextPreviewChars: 80,
      config: { foo: "bar" },
    });
    assert.strictEqual(trace.query.text, "What database do we use?");
    assert.strictEqual(trace.query.hash, "abc123");
    assert.strictEqual(trace.config.maxCandidates, 10);
    assert.strictEqual(trace.config.maxTextPreviewChars, 80);
    assert.strictEqual(trace.config.foo, "bar");
  });

  it("previews the query text instead of storing it verbatim", () => {
    const longQuery = "a".repeat(500);
    const trace = createRecallDecisionTrace({ query: longQuery });
    assert.ok(trace.query.text.endsWith("…"));
    assert.ok(trace.query.text.length <= 161);
    assert.ok(trace.query.text.length < longQuery.length);
  });
});

describe("textPreview", () => {
  it("returns short text unchanged", () => {
    assert.strictEqual(textPreview("hello world"), "hello world");
  });

  it("truncates long text with ellipsis", () => {
    const long = "word ".repeat(100).trim();
    const preview = textPreview(long, 20);
    assert.ok(preview.endsWith("…"));
    assert.ok(preview.length <= 21);
  });

  it("falls back to a default limit", () => {
    const long = "a".repeat(300);
    const preview = textPreview(long);
    assert.ok(preview.endsWith("…"));
    assert.ok(preview.length <= 161);
  });

  it("strips control characters", () => {
    assert.strictEqual(textPreview("hello\x00\x01world"), "hello world");
  });

  it("collapses whitespace", () => {
    assert.strictEqual(textPreview("hello   \n\tworld"), "hello world");
  });

  it("handles non-string input", () => {
    assert.strictEqual(textPreview(null), "");
    assert.strictEqual(textPreview(undefined), "");
    assert.strictEqual(textPreview(123), "123");
  });
});

describe("addTraceCandidate", () => {
  it("normalizes and adds a candidate", () => {
    const trace = createRecallDecisionTrace();
    const candidate = addTraceCandidate(trace, {
      id: "m1",
      text: "We use Postgres",
      summary: "Postgres database",
      source: "vector",
      score: 0.91,
      vectorScore: 0.88,
      importanceBoost: 0.03,
    });
    assert.strictEqual(candidate.id, "m1");
    assert.strictEqual(candidate.source, "vector");
    assert.strictEqual(candidate.preview, "Postgres database");
    assert.strictEqual(candidate.score, 0.91);
    assert.strictEqual(candidate.vectorScore, 0.88);
    assert.strictEqual(candidate.importanceBoost, 0.03);
    assert.strictEqual(trace.candidates.length, 1);
    assert.strictEqual(trace.summary.totalCandidates, 1);
  });

  it("stores text preview, not full text", () => {
    const trace = createRecallDecisionTrace({ maxTextPreviewChars: 20 });
    const longText = "This is a very long memory text that should absolutely be truncated.";
    const candidate = addTraceCandidate(trace, { id: "m2", text: longText });
    assert.ok(candidate.preview.endsWith("…"));
    assert.ok(candidate.preview.length <= 21);
    assert.ok(!candidate.text);
    assert.ok(!candidate.fullText);
  });

  it("caps candidates at maxCandidates", () => {
    const trace = createRecallDecisionTrace({ maxCandidates: 3 });
    for (let i = 0; i < 5; i++) {
      addTraceCandidate(trace, { id: `m${i}` });
    }
    assert.strictEqual(trace.candidates.length, 3);
    assert.strictEqual(trace.candidates[0].id, "m2");
    assert.strictEqual(trace.candidates[2].id, "m4");
  });

  it("rejects invalid inputs", () => {
    assert.throws(() => addTraceCandidate(null, {}), TypeError);
    assert.throws(() => addTraceCandidate({}, null), TypeError);
  });
});

describe("addTraceDecision", () => {
  it("records allowed actions", () => {
    const trace = createRecallDecisionTrace();
    for (const action of ["inclusion", "rejection", "downrank", "superseded", "deduped", "merged"]) {
      addTraceDecision(trace, { memoryId: "m1", action, reason: `${action} reason` });
    }
    assert.strictEqual(trace.decisions.length, 6);
    assert.strictEqual(trace.summary.included, 1);
    assert.strictEqual(trace.summary.rejected, 1);
    assert.strictEqual(trace.summary.downranked, 1);
    assert.strictEqual(trace.summary.superseded, 1);
    assert.strictEqual(trace.summary.deduped, 1);
    assert.strictEqual(trace.summary.merged, 1);
  });

  it("rejects unknown actions", () => {
    const trace = createRecallDecisionTrace();
    assert.throws(() => addTraceDecision(trace, { memoryId: "m1", action: "banana" }), TypeError);
  });

  it("stores score breakdown", () => {
    const trace = createRecallDecisionTrace();
    addTraceDecision(trace, {
      memoryId: "m1",
      action: "inclusion",
      finalScore: 0.95,
      scoreBreakdown: { vectorScore: 0.9, importanceBoost: 0.05 },
    });
    const decision = trace.decisions[0];
    assert.strictEqual(decision.finalScore, 0.95);
    assert.strictEqual(decision.scoreBreakdown.vectorScore, 0.9);
    assert.strictEqual(decision.scoreBreakdown.importanceBoost, 0.05);
  });
});

describe("addTraceGuard", () => {
  it("records passing and failing guards", () => {
    const trace = createRecallDecisionTrace();
    addTraceGuard(trace, { name: "minScore", passed: true });
    addTraceGuard(trace, { name: "acl", passed: false, reason: "workspace mismatch", memoryId: "m1" });
    assert.strictEqual(trace.guards.length, 2);
    assert.strictEqual(trace.summary.guardPass, 1);
    assert.strictEqual(trace.summary.guardFail, 1);
  });

  it("rejects invalid inputs", () => {
    assert.throws(() => addTraceGuard(null, {}), TypeError);
    assert.throws(() => addTraceGuard({}, null), TypeError);
  });
});

describe("addTraceStoreDecision", () => {
  it("counts accepted and rejected store decisions", () => {
    const trace = createRecallDecisionTrace();
    addTraceStoreDecision(trace, { memoryId: "m1", action: "stored", reason: "new memory" });
    addTraceStoreDecision(trace, { memoryId: "m2", action: "deduped", reason: "duplicate" });
    assert.strictEqual(trace.storeDecisions.length, 2);
    assert.strictEqual(trace.summary.storeAccepted, 1);
    assert.strictEqual(trace.summary.storeRejected, 1);
  });
});

describe("summarizeTrace", () => {
  it("recalculates summary from trace contents", () => {
    const trace = createRecallDecisionTrace();
    addTraceCandidate(trace, { id: "m1" });
    addTraceCandidate(trace, { id: "m2" });
    addTraceDecision(trace, { memoryId: "m1", action: "inclusion" });
    addTraceDecision(trace, { memoryId: "m2", action: "rejection" });
    addTraceGuard(trace, { name: "g1", passed: true });
    addTraceStoreDecision(trace, { memoryId: "m1", action: "stored" });

    const summary = summarizeTrace(trace);
    assert.strictEqual(summary.totalCandidates, 2);
    assert.strictEqual(summary.included, 1);
    assert.strictEqual(summary.rejected, 1);
    assert.strictEqual(summary.guardPass, 1);
    assert.strictEqual(summary.storeAccepted, 1);
  });

  it("throws on non-object input", () => {
    assert.throws(() => summarizeTrace(null), TypeError);
  });
});

describe("serializeTraceForDebug", () => {
  it("returns valid JSON without full text", () => {
    const trace = createRecallDecisionTrace({
      query: "a".repeat(300),
      maxTextPreviewChars: 30,
    });
    addTraceCandidate(trace, { id: "m1", text: "b".repeat(300) });
    addTraceDecision(trace, { memoryId: "m1", action: "inclusion", reason: "c".repeat(300) });

    const json = serializeTraceForDebug(trace);
    const parsed = JSON.parse(json);
    assert.ok(parsed.traceId);
    assert.ok(parsed.query.text.endsWith("…"));
    assert.ok(parsed.candidates[0].preview.endsWith("…"));
    assert.ok(parsed.decisions[0].reason.endsWith("…"));
    assert.strictEqual(parsed.summary.totalCandidates, 1);
  });

  it("uses custom maxTextPreviewChars", () => {
    const trace = createRecallDecisionTrace();
    addTraceCandidate(trace, { id: "m1", text: "word ".repeat(20).trim() });
    const json = serializeTraceForDebug(trace, { maxTextPreviewChars: 10 });
    const parsed = JSON.parse(json);
    assert.ok(parsed.candidates[0].preview.endsWith("…"));
    assert.ok(parsed.candidates[0].preview.length <= 11);
  });

  it("throws on non-object input", () => {
    assert.throws(() => serializeTraceForDebug(null), TypeError);
  });
});

describe("attachTraceToMemory / getMemoryTrace", () => {
  it("attaches and retrieves trace metadata", () => {
    const memory = { id: "m1", text: "secret" };
    const trace = createRecallDecisionTrace();
    attachTraceToMemory(memory, trace);
    assert.strictEqual(getMemoryTrace(memory), trace);
  });

  it("does not leak into JSON", () => {
    const memory = { id: "m1", text: "secret" };
    const trace = createRecallDecisionTrace();
    attachTraceToMemory(memory, trace);
    const json = JSON.stringify(memory);
    assert.ok(!json.includes("plur1bus"));
    assert.ok(!json.includes("traceId"));
  });

  it("returns undefined for unattached memory", () => {
    assert.strictEqual(getMemoryTrace({ id: "m1" }), undefined);
    assert.strictEqual(getMemoryTrace(null), undefined);
  });

  it("throws on invalid memory", () => {
    assert.throws(() => attachTraceToMemory(null, {}), TypeError);
  });
});


// ── Trace array caps ───────────────────────────────────────────────────────

describe("addTraceDecision cap", () => {
  it("caps decisions at maxDecisions and keeps the most recent entries", () => {
    const trace = createRecallDecisionTrace({ maxDecisions: 3 });
    for (let i = 0; i < 5; i++) {
      addTraceDecision(trace, { memoryId: `m${i}`, action: "inclusion", reason: `r${i}` });
    }
    assert.strictEqual(trace.decisions.length, 3);
    assert.strictEqual(trace.decisions[0].memoryId, "m2");
    assert.strictEqual(trace.decisions[2].memoryId, "m4");
  });
});

describe("addTraceGuard cap", () => {
  it("caps guards at maxGuards and keeps the most recent entries", () => {
    const trace = createRecallDecisionTrace({ maxGuards: 3 });
    for (let i = 0; i < 5; i++) {
      addTraceGuard(trace, { name: `g${i}`, passed: i % 2 === 0, reason: `r${i}` });
    }
    assert.strictEqual(trace.guards.length, 3);
    assert.strictEqual(trace.guards[0].name, "g2");
    assert.strictEqual(trace.guards[2].name, "g4");
  });
});

describe("addTraceStoreDecision cap", () => {
  it("caps store decisions at maxStoreDecisions and keeps the most recent entries", () => {
    const trace = createRecallDecisionTrace({ maxStoreDecisions: 3 });
    for (let i = 0; i < 5; i++) {
      addTraceStoreDecision(trace, {
        memoryId: `m${i}`,
        action: i % 2 === 0 ? "stored" : "deduped",
        reason: `r${i}`,
      });
    }
    assert.strictEqual(trace.storeDecisions.length, 3);
    assert.strictEqual(trace.storeDecisions[0].memoryId, "m2");
    assert.strictEqual(trace.storeDecisions[2].memoryId, "m4");
  });
});
