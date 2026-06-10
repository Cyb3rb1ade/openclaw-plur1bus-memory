import { describe, it } from "node:test";
import assert from "node:assert";
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
});
