import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMaintenanceNudges } from "../index.js";

describe("buildMaintenanceNudges conflict-log prompt build", () => {
  let dir;

  it("reads small conflict-log.jsonl fully and flags old conflicts", () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-small-"));
    const alDir = join(dir, ".adaptive-learning");
    mkdirSync(alDir, { recursive: true });
    const oldStamp = new Date(Date.now() - 31 * 86_400_000).toISOString();
    writeFileSync(
      join(alDir, "conflict-log.jsonl"),
      JSON.stringify({ timestamp: oldStamp, topic: "x" }) + "\n",
      "utf8",
    );

    const { conflictNudge } = buildMaintenanceNudges({ workspaceDir: dir, schicht15Enabled: false });
    assert.ok(conflictNudge.length > 0, "expected conflict nudge for old conflict");
  });

  it("does not flag recent small conflict-log", () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-recent-"));
    const alDir = join(dir, ".adaptive-learning");
    mkdirSync(alDir, { recursive: true });
    const recentStamp = new Date(Date.now() - 1 * 86_400_000).toISOString();
    writeFileSync(
      join(alDir, "conflict-log.jsonl"),
      JSON.stringify({ timestamp: recentStamp, topic: "x" }) + "\n",
      "utf8",
    );

    const { conflictNudge } = buildMaintenanceNudges({ workspaceDir: dir, schicht15Enabled: false });
    assert.strictEqual(conflictNudge, "", "expected no conflict nudge for recent conflict");
  });

  it("handles large conflict-log.jsonl without reading the whole file", () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-large-"));
    const alDir = join(dir, ".adaptive-learning");
    mkdirSync(alDir, { recursive: true });

    // Build a >1 MB log with many lines.
    const lines = [];
    const oldStamp = new Date(Date.now() - 31 * 86_400_000).toISOString();
    for (let i = 0; i < 6_000; i++) {
      lines.push(JSON.stringify({ timestamp: oldStamp, topic: `topic-${i}`, id: `id-${i}`, payload: "x".repeat(100) }));
    }
    writeFileSync(join(alDir, "conflict-log.jsonl"), lines.join("\n") + "\n", "utf8");

    const start = performance.now();
    const { conflictNudge } = buildMaintenanceNudges({ workspaceDir: dir, schicht15Enabled: false });
    const ms = performance.now() - start;

    assert.ok(conflictNudge.length > 0, "expected conflict nudge for large old conflict log");
    assert.ok(ms < 50, `large conflict-log read took ${ms.toFixed(1)} ms, expected < 50 ms`);
  });

  it("survives malformed lines in conflict-log.jsonl", () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-malformed-"));
    const alDir = join(dir, ".adaptive-learning");
    mkdirSync(alDir, { recursive: true });
    const oldStamp = new Date(Date.now() - 31 * 86_400_000).toISOString();
    writeFileSync(
      join(alDir, "conflict-log.jsonl"),
      "not-json\n" + JSON.stringify({ timestamp: oldStamp, topic: "x" }) + "\n",
      "utf8",
    );

    const { conflictNudge } = buildMaintenanceNudges({ workspaceDir: dir, schicht15Enabled: false });
    assert.ok(conflictNudge.length > 0, "expected conflict nudge despite malformed line");
  });

  it("returns empty nudges when workspaceDir is missing", () => {
    const { knowledgeNudge, conflictNudge } = buildMaintenanceNudges({ workspaceDir: null });
    assert.strictEqual(knowledgeNudge, "");
    assert.strictEqual(conflictNudge, "");
  });
});
