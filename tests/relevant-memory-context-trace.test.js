// tests/relevant-memory-context-trace.test.js
//
// Decision-trace rendering for the <relevant-memories> context formatter.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatRelevantMemoriesContext,
} from "../lib/relevant-memory-context.js";
import {
  createRecallDecisionTrace,
  addTraceCandidate,
  addTraceDecision,
  attachTraceToMemory,
} from "../lib/recall-decision-trace.js";

const baseMemory = {
  id: "m1",
  category: "work",
  source: "dm",
  display: "helped with task",
  memoryStrength: 0.9,
};

function buildTrace() {
  const trace = createRecallDecisionTrace({ query: "project status" });
  addTraceCandidate(trace, {
    id: "m1",
    source: "vector",
    score: 0.91,
    text: "helped with task",
  });
  addTraceCandidate(trace, {
    id: "m2",
    source: "graph",
    score: 0.62,
    text: "related graph memory",
  });
  addTraceCandidate(trace, {
    id: "m3",
    source: "canonical",
    score: 0.88,
    text: "canonical reference",
  });
  addTraceDecision(trace, {
    memoryId: "m1",
    action: "inclusion",
    stage: "vector-score-filter",
    reason: "above threshold",
    finalScore: 0.91,
  });
  addTraceDecision(trace, {
    memoryId: "m2",
    action: "inclusion",
    stage: "associative-merge",
    reason: "graph-only association",
    finalScore: 0.62,
  });
  addTraceDecision(trace, {
    memoryId: "m3",
    action: "rejection",
    stage: "canonical-dedup",
    reason: "deduplicated by canonical hit",
  });
  return trace;
}

describe("formatRelevantMemoriesContext — decision trace disabled", () => {
  it("returns byte-for-byte identical output when no trace is provided", () => {
    const withoutTrace = formatRelevantMemoriesContext([baseMemory]);
    const withNullTrace = formatRelevantMemoriesContext([baseMemory], { decisionTrace: null });
    const withDisabledTrace = formatRelevantMemoriesContext([baseMemory], {
      decisionTrace: buildTrace(),
      traceOptions: { includeInPrompt: false },
    });

    assert.strictEqual(withNullTrace, withoutTrace, "null trace must not change output");
    assert.strictEqual(withDisabledTrace, withoutTrace, "disabled trace must not change output");
  });

  it("does not emit memory-decision-trace or trace attributes when disabled", () => {
    const out = formatRelevantMemoriesContext([baseMemory], {
      decisionTrace: buildTrace(),
      traceOptions: { includeInPrompt: false },
    });

    assert.ok(!out.includes("<memory-decision-trace>"), "no trace block when disabled");
    assert.ok(!out.includes("source-stage="), "no source-stage attribute when disabled");
    assert.ok(!out.includes("trace-reason="), "no trace-reason attribute when disabled");
    assert.ok(!out.includes("evidence="), "no evidence attribute when disabled");
  });
});

describe("formatRelevantMemoriesContext — decision trace enabled", () => {
  it("renders a compact <memory-decision-trace> block after compact recall safety marker", () => {
    const trace = buildTrace();
    const out = formatRelevantMemoriesContext([baseMemory], {
      decisionTrace: trace,
      traceOptions: { includeInPrompt: true },
    });

    assert.ok(out.includes("<memory-decision-trace>"), "missing trace block");
    assert.ok(out.includes("<trace-summary"), "missing trace summary");
    assert.ok(out.includes('totalCandidates="3"'), "expected 3 total candidates");
    assert.ok(out.includes('included="2"'), "expected 2 included decisions");
    assert.ok(out.includes('rejected="1"'), "expected 1 rejected decision");

    const safetyPos = out.indexOf("Recall safety:");
    const tracePos = out.indexOf("<memory-decision-trace>");
    const firstRecordPos = out.indexOf("<memory-record");
    assert.ok(safetyPos < tracePos, "trace block must appear after compact recall safety marker");
    assert.ok(tracePos < firstRecordPos, "trace block must appear before memory records");
  });

  it("renders per-memory trace attributes from the decision trace", () => {
    const trace = buildTrace();
    const out = formatRelevantMemoriesContext(
      [
        baseMemory,
        { id: "m2", category: "fact", source: "group", display: "graph hit", memoryStrength: 0.8 },
      ],
      { decisionTrace: trace, traceOptions: { includeInPrompt: true } },
    );

    assert.ok(out.includes('source-stage="vector-score-filter"'), "missing source-stage for m1");
    assert.ok(out.includes('score="0.910"'), "missing score for m1");
    assert.ok(out.includes('trace-reason="above_threshold"'), "missing trace-reason for m1");

    assert.ok(out.includes('source-stage="associative-merge"'), "missing source-stage for m2");
    assert.ok(out.includes('evidence="weak-association"'), "graph candidate should show weak-association evidence");
    assert.ok(out.includes('trace-reason="graph-only_association"'), "missing trace-reason for m2");
  });

  it("prefers trace metadata attached directly to the memory object", () => {
    const trace = createRecallDecisionTrace();
    const mem = { ...baseMemory };
    attachTraceToMemory(mem, {
      stage: "attached-stage",
      score: 0.99,
      evidence: "direct-attached",
      reason: "from memory symbol",
    });

    const out = formatRelevantMemoriesContext([mem], {
      decisionTrace: trace,
      traceOptions: { includeInPrompt: true },
    });

    assert.ok(out.includes('source-stage="attached-stage"'), "attached stage missing");
    assert.ok(out.includes('score="0.990"'), "attached score missing");
    assert.ok(out.includes('evidence="direct-attached"'), "attached evidence missing");
    assert.ok(out.includes('trace-reason="from_memory_symbol"'), "attached reason missing");
  });

  it("does not render trace attributes for memories with no trace entry", () => {
    const trace = createRecallDecisionTrace();
    addTraceCandidate(trace, { id: "m1", source: "vector", score: 0.9 });
    addTraceDecision(trace, { memoryId: "m1", action: "inclusion", stage: "vector", reason: "ok" });

    const out = formatRelevantMemoriesContext(
      [
        baseMemory,
        { id: "m2", category: "fact", source: "dm", display: "no trace", memoryStrength: 0.8 },
      ],
      { decisionTrace: trace, traceOptions: { includeInPrompt: true } },
    );

    const m2Record = out.split("<memory-record").find((s) => s.includes('id="m2"'));
    assert.ok(m2Record, "m2 record missing");
    assert.ok(!m2Record.includes("source-stage="), "m2 should not have source-stage");
    assert.ok(!m2Record.includes("score="), "m2 should not have score");
    assert.ok(!m2Record.includes("trace-reason="), "m2 should not have trace-reason");
  });
});

describe("formatRelevantMemoriesContext — trace attribute sanitization", () => {
  it("sanitizes malicious trace stage, evidence, and reason values", () => {
    const trace = createRecallDecisionTrace();
    addTraceCandidate(trace, {
      id: "m1",
      source: "vector",
      score: 0.9,
    });
    addTraceDecision(trace, {
      memoryId: "m1",
      action: "inclusion",
      stage: 'stage" data-x="y',
      reason: "<script>alert(1)</script>",
    });
    attachTraceToMemory(baseMemory, {
      stage: 'stage" data-x="y',
      evidence: 'evil" data-y="z',
      reason: "<script>alert(1)</script>",
    });

    const out = formatRelevantMemoriesContext([baseMemory], {
      decisionTrace: trace,
      traceOptions: { includeInPrompt: true },
    });

    assert.ok(!out.includes('data-x="y"'), "malicious stage must be sanitized");
    assert.ok(!out.includes('data-y="z"'), "malicious evidence must be sanitized");
    assert.ok(!out.includes("<script>"), "script tag in reason must be sanitized");
    assert.ok(out.includes('stage="stage_data-x_y"'), "stage should be underscore-sanitized");
    assert.ok(out.includes('evidence="evil_data-y_z"'), "evidence should be underscore-sanitized");
    assert.ok(out.includes('trace-reason="_script_alert_1_script_"'), "reason should be underscore-sanitized");
  });
});
