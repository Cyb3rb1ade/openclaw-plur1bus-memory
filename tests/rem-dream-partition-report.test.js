/**
 * rem-dream: Zusammenfassung je ACL-Partition in der Kommando-Antwort.
 *
 * Bisher trug `partitions[]` nur `scope` und `skipped`; Grund, Kandidatenzahl
 * und Run-Key der übrigen Partitionen gingen verloren, weil die Top-Level-
 * Felder nur aus dem ersten Lauf mit Report (sonst dem ersten Lauf) stammen.
 * Im 8.2-Labor war deshalb nicht erkennbar, warum die workspace-Partition
 * übersprungen wurde (Antwort: sie liest seit 5311ce7 nur den geteilten Pool).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeRemPartitionRun } from "../lib/dreaming/rem-dream.js";

describe("describeRemPartitionRun", () => {
  it("überträgt Grund, Zähler und Run-Key eines übersprungenen Laufs", () => {
    assert.deepEqual(describeRemPartitionRun({
      scope: "workspace",
      result: { skipped: true, reason: "too_few_memories", count: 0, runKey: "rem:w:a:k:2026-W35" },
    }), { scope: "workspace", skipped: true, reason: "too_few_memories", count: 0, runKey: "rem:w:a:k:2026-W35" });
  });

  it("meldet einen Lauf mit Report als nicht übersprungen und nennt die Musterzahl", () => {
    assert.deepEqual(describeRemPartitionRun({
      scope: "agent-private",
      result: {
        report: { runKey: "rem:a:a:k:2026-W35", weekOf: "2026-W35", patternsFound: 2, narrative: "…", aclBindings: {} },
        trends: [],
      },
    }), { scope: "agent-private", skipped: false, runKey: "rem:a:a:k:2026-W35", patternsFound: 2 });
  });

  it("lässt fehlende oder falsch typisierte Felder weg statt zu raten", () => {
    assert.deepEqual(describeRemPartitionRun({ scope: "user", result: null }), { scope: "user", skipped: false });
    assert.deepEqual(describeRemPartitionRun({
      scope: "user",
      result: { skipped: true, reason: "", count: "3", runKey: 7 },
    }), { scope: "user", skipped: true });
    assert.deepEqual(describeRemPartitionRun({
      scope: "agent-private",
      result: { report: { patternsFound: 1.5, runKey: "" } },
    }), { scope: "agent-private", skipped: false });
  });
});
