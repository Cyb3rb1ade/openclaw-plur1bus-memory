/**
 * tests/importance-metrics.test.js
 *
 * Kennzahlen der Importance-Verteilung, read-only. Die Kennzahlen beantworten
 * eine Frage nach der Migration: ist die Skala noch kollabiert (heute 71,1 %
 * von main's aktiven Zeilen auf genau 0,70)?
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { summarizeImportance } from "../scripts/importance-metrics.mjs";

describe("importance metrics", () => {
  it("reports the dominant value and its share", () => {
    const rows = [
      ...Array.from({ length: 7 }, () => ({ importance: 0.7, status: "active" })),
      ...Array.from({ length: 3 }, () => ({ importance: 0.5, status: "active" })),
    ];
    const summary = summarizeImportance(rows);
    assert.strictEqual(summary.total, 10);
    assert.strictEqual(summary.topValue, "0.70");
    assert.ok(Math.abs(summary.topShare - 0.7) < 1e-9);
  });

  it("counts flashbulb and agent band separately", () => {
    const rows = [
      { importance: 0.5, halfLifeDays: 3650, status: "active" },
      { importance: 0.97, halfLifeDays: 36500, status: "active" },
      { importance: 0.5, halfLifeDays: 180, status: "active" },
      { importance: 0.9, halfLifeDays: 600, status: "deleted" },
    ];
    const summary = summarizeImportance(rows);
    assert.strictEqual(summary.total, 3);
    assert.ok(Math.abs(summary.flashbulbShare - 1 / 3) < 1e-9);
    assert.strictEqual(summary.agentBand, 1);
  });
});
