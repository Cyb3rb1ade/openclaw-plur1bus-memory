import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkJobRateLimit, recordJobRun } from "../lib/job-rate-limit.js";

describe("job-rate-limit", () => {
  function makeStatePath() {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-rate-"));
    return join(dir, "run-state.json");
  }

  it("allows first run", () => {
    const statePath = makeStatePath();
    const result = checkJobRateLimit("daily-consolidation", "agent-1", "ws-1", 86400000, statePath);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.lastRunAt, 0);
  });

  it("blocks second run before interval expires", async () => {
    const statePath = makeStatePath();
    const intervalMs = 100000;
    await recordJobRun("daily-consolidation", "agent-1", "ws-1", statePath);
    const result = checkJobRateLimit("daily-consolidation", "agent-1", "ws-1", intervalMs, statePath);
    assert.strictEqual(result.allowed, false);
    assert.ok(result.remainingMs > 0);
  });

  it("allows run after interval expires", async () => {
    const statePath = makeStatePath();
    const intervalMs = 50;
    await recordJobRun("daily-consolidation", "agent-1", "ws-1", statePath);
    await new Promise((r) => setTimeout(r, 80));
    const result = checkJobRateLimit("daily-consolidation", "agent-1", "ws-1", intervalMs, statePath);
    assert.strictEqual(result.allowed, true);
  });

  it("isolates different job keys", async () => {
    const statePath = makeStatePath();
    await recordJobRun("daily-consolidation", "agent-1", "ws-1", statePath);
    const result = checkJobRateLimit("rem-dream", "agent-1", "ws-1", 86400000, statePath);
    assert.strictEqual(result.allowed, true);
  });

  it("isolates different agents", async () => {
    const statePath = makeStatePath();
    await recordJobRun("daily-consolidation", "agent-1", "ws-1", statePath);
    const result = checkJobRateLimit("daily-consolidation", "agent-2", "ws-1", 86400000, statePath);
    assert.strictEqual(result.allowed, true);
  });

  it("isolates different workspaces", async () => {
    const statePath = makeStatePath();
    await recordJobRun("daily-consolidation", "agent-1", "ws-1", statePath);
    const result = checkJobRateLimit("daily-consolidation", "agent-1", "ws-2", 86400000, statePath);
    assert.strictEqual(result.allowed, true);
  });

  it("read-only check does not modify state", async () => {
    const statePath = makeStatePath();
    await recordJobRun("daily-consolidation", "agent-1", "ws-1", statePath);
    const before = JSON.parse(readFileSync(statePath, "utf8"));
    checkJobRateLimit("daily-consolidation", "agent-1", "ws-1", 86400000, statePath);
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepStrictEqual(before, after);
  });

  it("handles missing state file gracefully", () => {
    const statePath = join(tmpdir(), `nonexistent-${Date.now()}.json`);
    const result = checkJobRateLimit("daily-consolidation", "agent-1", "ws-1", 86400000, statePath);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.lastRunAt, 0);
  });

  it("handles corrupted state file gracefully", () => {
    const statePath = makeStatePath();
    writeFileSync(statePath, "not json", "utf8");
    const result = checkJobRateLimit("daily-consolidation", "agent-1", "ws-1", 86400000, statePath);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.lastRunAt, 0);
  });

  it("increments runCount on repeated runs", async () => {
    const statePath = makeStatePath();
    await recordJobRun("daily-consolidation", "agent-1", "ws-1", statePath);
    await recordJobRun("daily-consolidation", "agent-1", "ws-1", statePath);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const key = "daily-consolidation:agent-1:ws-1";
    assert.strictEqual(state.jobRateLimits[key].runCount, 2);
  });
});
