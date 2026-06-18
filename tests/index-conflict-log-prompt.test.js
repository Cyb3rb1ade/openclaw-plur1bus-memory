import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMaintenanceNudges, appendConflictLog } from "../index.js";

describe("buildMaintenanceNudges conflict-log prompt build", () => {
  let dir;

  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      dir = null;
    }
  });

  it("reads conflict-review-summary.json and flags old conflicts", () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-summary-"));
    const alDir = join(dir, ".adaptive-learning");
    mkdirSync(alDir, { recursive: true });
    const oldStamp = new Date(Date.now() - 31 * 86_400_000).toISOString();
    writeFileSync(
      join(alDir, "conflict-review-summary.json"),
      JSON.stringify({
        count: 5,
        oldestTimestamp: new Date(oldStamp).getTime(),
        newestTimestamp: new Date(oldStamp).getTime(),
        sizeBytes: 2_000_000,
        pendingCount: 0,
        lastUpdatedAt: oldStamp,
      }),
      "utf8",
    );

    const { conflictNudge } = buildMaintenanceNudges({ workspaceDir: dir, schicht15Enabled: false });
    assert.ok(conflictNudge.length > 0, "expected conflict nudge for old conflict summary");
  });

  it("does not flag recent summary", () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-summary-recent-"));
    const alDir = join(dir, ".adaptive-learning");
    mkdirSync(alDir, { recursive: true });
    const recentStamp = new Date(Date.now() - 1 * 86_400_000).toISOString();
    writeFileSync(
      join(alDir, "conflict-review-summary.json"),
      JSON.stringify({
        count: 5,
        oldestTimestamp: new Date(recentStamp).getTime(),
        newestTimestamp: new Date(recentStamp).getTime(),
        sizeBytes: 1024,
        pendingCount: 0,
        lastUpdatedAt: recentStamp,
      }),
      "utf8",
    );

    const { conflictNudge } = buildMaintenanceNudges({ workspaceDir: dir, schicht15Enabled: false });
    assert.strictEqual(conflictNudge, "", "expected no conflict nudge for recent summary");
  });

  it("falls back to lazy log rebuild when summary is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-missing-summary-"));
    const alDir = join(dir, ".adaptive-learning");
    mkdirSync(alDir, { recursive: true });
    const oldStamp = new Date(Date.now() - 31 * 86_400_000).toISOString();
    writeFileSync(
      join(alDir, "conflict-log.jsonl"),
      JSON.stringify({ timestamp: oldStamp, topic: "x" }) + "\n",
      "utf8",
    );

    const { conflictNudge } = buildMaintenanceNudges({ workspaceDir: dir, schicht15Enabled: false });
    assert.ok(conflictNudge.length > 0, "expected conflict nudge via fallback rebuild");
  });

  it("appendConflictLog creates and updates summary", () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-conflict-append-"));
    const oldStamp = new Date(Date.now() - 31 * 86_400_000).toISOString();

    appendConflictLog(dir, { timestamp: oldStamp, topic: "x" });

    const summaryPath = join(dir, ".adaptive-learning", "conflict-review-summary.json");
    assert.ok(existsSync(summaryPath), "summary should be created");
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.strictEqual(summary.count, 1, "count should be 1 after first append to empty log");
    assert.strictEqual(summary.oldestTimestamp, new Date(oldStamp).getTime(), "oldest timestamp should match");
    assert.strictEqual(summary.newestTimestamp, new Date(oldStamp).getTime(), "newest timestamp should match");
    assert.ok(summary.sizeBytes > 0, "sizeBytes should be positive");
    assert.ok(summary.lastUpdatedAt, "lastUpdatedAt should be set");

    const newerStamp = new Date(Date.now() - 1 * 86_400_000).toISOString();
    appendConflictLog(dir, { timestamp: newerStamp, topic: "y", pending: true });
    const summary2 = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.strictEqual(summary2.count, 2, "count should be 2 after second append");
    assert.strictEqual(summary2.oldestTimestamp, new Date(oldStamp).getTime(), "oldest timestamp should stay");
    assert.strictEqual(summary2.newestTimestamp, new Date(newerStamp).getTime(), "newest timestamp should update");
    assert.strictEqual(summary2.pendingCount, 1, "pendingCount should increment for pending entry");
  });

  it("returns empty nudges when workspaceDir is missing", () => {
    const { knowledgeNudge, conflictNudge } = buildMaintenanceNudges({ workspaceDir: null });
    assert.strictEqual(knowledgeNudge, "");
    assert.strictEqual(conflictNudge, "");
  });
});
