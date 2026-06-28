/**
 * tests/pattern-detector-nan-timestamp.test.js
 *
 * Regression: getTimestamp returned new Date(str).getTime() (= NaN for an
 * unparseable createdAt) and returned immediately. The keyword path's lookback
 * check `ts < cutoff` is false for NaN, so the malformed turn was NOT excluded,
 * and NaN flowed into recencyHours → scorePattern → NaN, poisoning the sort.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { detectPatterns, scorePattern } from "../lib/pattern-detector.js";

describe("pattern-detector NaN timestamp guard", () => {
  it("produces finite scores when turns have an unparseable createdAt", async () => {
    const turns = [
      { createdAt: "not-a-real-date", text: "deployment pipeline broke again today" },
      { createdAt: "also-garbage", text: "deployment pipeline broke again yesterday" },
      { createdAt: "still-bad", text: "deployment pipeline broke again now" },
    ];

    const patterns = await detectPatterns(turns, {
      now: Date.now(),
      lookbackDays: 365,
      minOccurrences: 2,
    });

    for (const p of patterns) {
      assert.ok(Number.isFinite(p.recencyHours), `recencyHours must be finite, got ${p.recencyHours}`);
      assert.ok(Number.isFinite(scorePattern(p)), `score must be finite, got ${scorePattern(p)}`);
    }
  });
});
