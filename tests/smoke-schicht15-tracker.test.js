/**
 * Smoke-Test: Schicht 1.5 Promotion Tracking & Dedupe
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isKnowledgePromoted,
  recordKnowledgePromotion,
  checkMaxPromotions,
  readPromotedKnowledgeIds,
  computeContentHash,
} from "../lib/jobs/schicht15-tracker.js";
import { makeTempDir } from "./helpers/temp-dir.js";

describe("schicht15-tracker", () => {
  it("tracks promoted knowledge per workspace+agent", () => {
    const dir = makeTempDir("plur1bus-s15-");
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

  it("enforces maxPromotionsPerRun inside a 24-hour window, not for life", () => {
    const dir = makeTempDir("plur1bus-s15-");
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

    // A day later the window has moved on; the dedup lists still know both ids.
    const later = Date.now() + 25 * 60 * 60 * 1000;
    const check4 = checkMaxPromotions(dir, ws, agent, 2, { now: later });
    assert.strictEqual(check4.allowed, true);
    assert.strictEqual(check4.current, 0);
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-1", null), true);
  });

  it("does not count legacy promotions recorded without timestamps (unblocks a stuck workspace)", () => {
    const dir = makeTempDir("plur1bus-s15-");
    const statePath = join(dir, "run-state.json");
    // Live shape from 2026-06-27: seven ids, no promotedAt, blocked as "7/3".
    writeFileSync(statePath, JSON.stringify({
      promotedKnowledge: { "schicht15:ws-a:agent-1": { ids: ["a", "b", "c", "d", "e", "f", "g"], hashes: [], count: 7, lastRunAt: 1782916275916 } },
    }));
    const check = checkMaxPromotions(dir, "ws-a", "agent-1", 3);
    assert.strictEqual(check.allowed, true);
    assert.strictEqual(check.current, 0);
    assert.strictEqual(isKnowledgePromoted(dir, "ws-a", "agent-1", "a", null), true, "dedup keeps the old ids");
  });

  it("persists in run-state.json", () => {
    const dir = makeTempDir("plur1bus-s15-");
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

  it("computeContentHash returns stable sha256 for text", () => {
    const h1 = computeContentHash("Zabbix-Agent auf Ubuntu 22.04 installieren");
    const h2 = computeContentHash("Zabbix-Agent auf Ubuntu 22.04 installieren");
    assert.strictEqual(h1, h2, "same text must produce same hash");
    assert.strictEqual(typeof h1, "string");
    assert.strictEqual(h1.length, 64, "sha256 hex is 64 chars");
  });

  it("computeContentHash normalizes whitespace", () => {
    const h1 = computeContentHash("Hello World\r\n");
    const h2 = computeContentHash("Hello World\n");
    const h3 = computeContentHash("Hello World");
    assert.strictEqual(h1, h2, "CRLF vs LF must produce same hash");
    assert.strictEqual(h1, h3, "trailing newline must not change hash");
  });

  it("computeContentHash includes promotion-relevant metadata when present", () => {
    const fact = computeContentHash({
      text: "Use Postgres for the auth store.",
      category: "fact",
      scope: "agent-private",
      importance: 0.5,
    });
    const decision = computeContentHash({
      text: "Use Postgres for the auth store.",
      category: "decision",
      scope: "workspace",
      importance: 0.9,
    });

    assert.notStrictEqual(fact, decision, "same text with different promotion metadata must not collide");
  });

  it("computeContentHash returns null for empty/invalid input", () => {
    assert.strictEqual(computeContentHash(""), null);
    assert.strictEqual(computeContentHash(null), null);
    assert.strictEqual(computeContentHash(undefined), null);
    assert.strictEqual(computeContentHash(123), null);
    assert.strictEqual(computeContentHash("   \n\t  "), null);
  });

  it("deduplicates by contentHash even with different memoryId (Option A+)", () => {
    const dir = makeTempDir("plur1bus-s15-");
    const ws = "ws-a";
    const agent = "agent-1";
    const text = "Installation des Zabbix Agents unter Ubuntu Jammy";
    const hash = computeContentHash(text);

    // First promotion with mem-1
    recordKnowledgePromotion(dir, ws, agent, "mem-1", hash);
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-1", hash), true);

    // Same content, different memoryId → should be detected as duplicate via hash
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-2", hash), true);

    // Same content, different memoryId, but NO hash provided → falls back to memoryId-only, which is unknown
    // This is expected: hash-only dedup requires the hash to be passed in
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-2", null), false, "without hash, unknown memoryId is not promoted");

    // Different content, same memoryId (edge case) → memoryId match still wins
    const otherHash = computeContentHash("Completely different text");
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-1", otherHash), true, "memoryId match still wins");
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-3", otherHash), false, "unknown id + unknown hash is new");
  });

  it("safely handles broken/missing contentHash without silent double-promotion", () => {
    const dir = makeTempDir("plur1bus-s15-");
    const ws = "ws-a";
    const agent = "agent-1";

    // Promotion with valid hash
    recordKnowledgePromotion(dir, ws, agent, "mem-1", computeContentHash("Some knowledge"));
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-1", null), true);

    // Re-promotion with null hash → memoryId still catches it
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "mem-1", null), true);

    // Fresh entry with null hash (should not crash, should not falsely match unknown ids)
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "unknown-mem", null), false);

    // Fresh entry with empty string hash (treated as falsy, no match)
    assert.strictEqual(isKnowledgePromoted(dir, ws, agent, "unknown-mem", ""), false);
  });
});
