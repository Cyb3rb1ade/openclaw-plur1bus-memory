// tests/recall-decision-trace-temporal.test.js
// P5 Temporal Provenance + Operational Action Guard — decision trace tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRecallDecisionTrace,
  addTraceCandidate,
  addTraceDecision,
} from "../lib/recall-decision-trace.js";
import { enrichTraceWithTemporalProvenance } from "../lib/temporal-provenance.js";

const NOW_ISO = "2026-06-17T01:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

describe("RecallDecisionTrace temporal enrichment", () => {
  it("adds temporal metadata to candidates", () => {
    const trace = createRecallDecisionTrace({ query: "cron duplicates" });
    addTraceCandidate(trace, {
      id: "m1",
      text: "Cronjob may produce duplicates",
      source: "vector",
      score: 0.9,
    });
    const memories = [{
      id: "m1",
      display: "Cronjob may produce duplicates",
      createdAt: "2026-06-16T12:00:00.000Z",
    }];
    enrichTraceWithTemporalProvenance(trace, memories, { now: NOW_MS });

    const candidate = trace.candidates.find(c => c.id === "m1");
    assert.ok(candidate.temporal, "expected temporal metadata on candidate");
    assert.strictEqual(candidate.temporal.freshness, "stale");
    assert.strictEqual(candidate.temporal.isOperational, true);
    assert.strictEqual(candidate.temporal.requiresLiveVerification, true);
  });

  it("adds temporal metadata to decisions", () => {
    const trace = createRecallDecisionTrace({ query: "cron duplicates" });
    addTraceDecision(trace, {
      memoryId: "m1",
      action: "inclusion",
      stage: "vector",
      reason: "vector recall",
    });
    const memories = [{
      id: "m1",
      display: "Cronjob may produce duplicates",
      createdAt: "2026-06-16T12:00:00.000Z",
    }];
    enrichTraceWithTemporalProvenance(trace, memories, { now: NOW_MS });

    const decision = trace.decisions.find(d => d.memoryId === "m1");
    assert.ok(decision.temporal, "expected temporal metadata on decision");
    assert.strictEqual(decision.temporal.operationalRisk, "high");
  });

  it("adds guard records for stale operational memories", () => {
    const trace = createRecallDecisionTrace({ query: "cron duplicates" });
    addTraceCandidate(trace, { id: "m1", text: "Cronjob may produce duplicates", source: "vector", score: 0.9 });
    addTraceDecision(trace, { memoryId: "m1", action: "inclusion", stage: "vector" });
    const memories = [{
      id: "m1",
      display: "Cronjob may produce duplicates",
      createdAt: "2026-06-16T12:00:00.000Z",
    }];
    enrichTraceWithTemporalProvenance(trace, memories, { now: NOW_MS });

    const guard = trace.guards.find(g => g.name === "operational-live-verification-required");
    assert.ok(guard, "expected operational live-verification guard");
    assert.strictEqual(guard.passed, false);
    assert.strictEqual(guard.memoryId, "m1");
    assert.ok(guard.reason.includes("live verification"));
  });

  it("does not add guard for fresh operational memories", () => {
    const trace = createRecallDecisionTrace({ query: "cron duplicates" });
    addTraceCandidate(trace, { id: "m1", text: "Cronjob may produce duplicates", source: "vector", score: 0.9 });
    const memories = [{
      id: "m1",
      display: "Cronjob may produce duplicates",
      createdAt: "2026-06-17T00:55:00.000Z",
    }];
    enrichTraceWithTemporalProvenance(trace, memories, { now: NOW_MS });

    const guard = trace.guards.find(g => g.name === "operational-live-verification-required");
    assert.strictEqual(guard, undefined);
  });

  it("does not add guard for non-operational memories", () => {
    const trace = createRecallDecisionTrace({ query: "preferences" });
    addTraceCandidate(trace, { id: "m1", text: "User prefers concise answers", source: "vector", score: 0.9 });
    const memories = [{
      id: "m1",
      display: "User prefers concise answers",
      createdAt: "2026-06-16T12:00:00.000Z",
    }];
    enrichTraceWithTemporalProvenance(trace, memories, { now: NOW_MS });

    const guard = trace.guards.find(g => g.name === "operational-live-verification-required");
    assert.strictEqual(guard, undefined);
  });

  it("handles missing memory for a candidate gracefully", () => {
    const trace = createRecallDecisionTrace({ query: "cron duplicates" });
    addTraceCandidate(trace, { id: "m1", text: "Cronjob may produce duplicates", source: "vector", score: 0.9 });
    enrichTraceWithTemporalProvenance(trace, [], { now: NOW_MS });

    const candidate = trace.candidates.find(c => c.id === "m1");
    assert.strictEqual(candidate.temporal, undefined);
  });
});
