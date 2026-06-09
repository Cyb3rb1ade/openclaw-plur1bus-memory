/**
 * Smoke-Test: Schicht 1.5 Promotion Tracking & Dedupe
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isKnowledgePromoted,
  recordKnowledgePromotion,
  checkMaxPromotions,
  readPromotedKnowledgeIds,
} from "../lib/jobs/schicht15-tracker.js";

describe("schicht15-tracker", () => {
  it("tracks promoted knowledge per workspace+agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-s15-"));
    const ws = "ws-a";
    const agent = "agent-1";

    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-1", null), false);
    recordKnowledgePromotion(dir, ws, agent, "mem-1", "hash-a");
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-1", null), true);
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-1", "hash-a"), true);
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-2", null), false);

    // Different agent should not share
    assert.strictEqual(isKnowledgePromoted(dir, ws, "agent-2", "mem-1", null), false);

    // Different workspace should not share
    assert.strictEqual(isKnowledgePromoted(dir, "ws-b", agent, "mem-1", null), false);
  });

  it("enforces maxPromotionsPerRun", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-s15-"));
    const ws = "ws-a";
    const agent = "agent-1";

    const check1 = checkMaxPromotions(dir, ws, agent, 2);
    assert.strictEqual(check1.allowed, true);
    assert.strictEqual(check1.current, 0);

    recordKnowledgePromotion(dir, ws, agent, "mem-1", null);
    const check2 = checkMaxPromotions(dir, ws, agent, 2);
    assert.strictEqual(check2.allowed, true);
    assert.strictEqual(check2.current, 1);

    recordKnowledgePromotion(dir, ws, agent, "mem-2", null);
    const check3 = checkMaxPromotions(dir, ws, agent, 2);
    assert.strictEqual(check3.allowed, false);
    assert.strictEqual(check3.current, 2);
  });

  it("persists in run-state.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-s15-"));
    recordKnowledgePromotion(dir, "ws", "agent", "mem-x", "hash-x");
    const statePath = join(dir, "run-state.json");
    assert.ok(existsSync(statePath));
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(state.promotedKnowledge);
    const key = "schicht15:ws:agent";
    assert.ok(state.promotedKnowledge[key]);
    assert.ok(state.promotedKnowledge[key].ids.includes("mem-x"));
    assert.ok(state.promotedKnowledge[key].hashes.includes("hash-x"));
  });
});
