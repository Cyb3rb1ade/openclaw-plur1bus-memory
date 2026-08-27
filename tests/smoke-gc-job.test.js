import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGcJob } from "../lib/jobs/gc-job.js";

describe("GC Job smoke", () => {
  it("returns error when missing baseDbPath", async () => {
    const result = await runGcJob({});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "missing_args");
  });

  it("returns error when missing dbPool", async () => {
    const result = await runGcJob({ baseDbPath: "/tmp/test" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "missing_args");
  });

  it("skips when no policy configured", async () => {
    const mockPool = {
      getDb: () => ({}),
    };
    const result = await runGcJob({
      baseDbPath: "/tmp/nonexistent-gc-path-" + Date.now(),
      dbPool: mockPool,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, "no_policy");
  });

  it("never leases reembedding control-plane directories as agent databases", async () => {
    const root = mkdtempSync(join(tmpdir(), "plur1bus-gc-control-plane-"));
    mkdirSync(join(root, "control"), { recursive: true });
    mkdirSync(join(root, "generations", "candidate"), { recursive: true });
    mkdirSync(join(root, "real-agent"), { recursive: true });
    writeFileSync(join(root, "real-agent", "memories.lance"), "fixture");
    const leased = [];
    const result = await runGcJob({
      baseDbPath: root,
      dbPool: {
        async withDb(agentId, operation) {
          leased.push(agentId);
          return operation({ scanActive: async () => [] });
        },
      },
      policy: { maxMemoryCount: 100 },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(leased, ["real-agent"]);
  });
});
