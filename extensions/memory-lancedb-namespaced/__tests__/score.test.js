/**
 * Tests für lib/score.js — distanceToScore.
 * Run: node --test __tests__/score.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { distanceToScore } from "../lib/score.js";

test("distanceToScore: distance 0 → score 1", () => {
  assert.equal(distanceToScore(0), 1);
});

test("distanceToScore: distance 1 → score 0.5", () => {
  assert.equal(distanceToScore(1), 0.5);
});

test("distanceToScore: distance 2 → score 0.333", () => {
  assert.ok(Math.abs(distanceToScore(2) - 1/3) < 1e-9);
});

test("distanceToScore: distance 100 → score ~0.01", () => {
  assert.ok(distanceToScore(100) < 0.011);
});

test("distanceToScore: undefined → 1 (treated as 0)", () => {
  assert.equal(distanceToScore(undefined), 1);
});

test("distanceToScore: never negative", () => {
  for (const d of [0, 0.5, 1, 1.5, 2, 5, 100]) {
    assert.ok(distanceToScore(d) > 0, `score for d=${d} must be > 0`);
    assert.ok(distanceToScore(d) <= 1, `score for d=${d} must be ≤ 1`);
  }
});
