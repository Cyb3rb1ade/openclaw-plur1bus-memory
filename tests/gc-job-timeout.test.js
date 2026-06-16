import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGcJob } from "../lib/jobs/gc-job.js";

describe("gc-job timeout", () => {
  it("returns timeout reason when scanActive hangs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-gc-timeout-"));
    const agentDir = join(dir, "agent-1");
    mkdirSync(agentDir, { recursive: true });
    // Minimal marker so listAgentIds finds it.
    writeFileSync(join(agentDir, "memories.lance"), "", "utf8");

    const dbPool = {
      getDb: () => ({
        scanActive: () => new Promise(() => {}), // never resolves
      }),
    };

    const result = await runGcJob({
      baseDbPath: dir,
      dbPool,
      policy: { maxMemoryCount: 100 },
      timeoutMs: 50,
    });

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "timeout");
    assert.strictEqual(result.timeoutMs, 50);
  });

  it("completes normally when scanActive is fast", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plur1bus-gc-fast-"));
    const agentDir = join(dir, "agent-1");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "memories.lance"), "", "utf8");

    const dbPool = {
      getDb: () => ({
        scanActive: async () => [],
      }),
    };

    const result = await runGcJob({
      baseDbPath: dir,
      dbPool,
      policy: { maxMemoryCount: 100 },
      timeoutMs: 1000,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, undefined);
    assert.strictEqual(result.processed, 1);
  });
});
