import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSetupFeatureCrons } from "../scripts/setup-feature-crons.mjs";

describe("PLUR1BUS_SKIP_HOST_PATCH", () => {
  it("does not apply the host patch", async () => {
    const previous = process.env.PLUR1BUS_SKIP_HOST_PATCH;
    process.env.PLUR1BUS_SKIP_HOST_PATCH = "1";
    let called = 0;
    try {
      await runSetupFeatureCrons({
        argv: ["--dry-run", "--json"],
        openclawImpl: () => ({ ok: false, stdout: "", stderr: "missing" }),
        ensureCronDirectDispatchImpl: () => {
          called += 1;
          return { status: "patched" };
        },
      });
    } finally {
      if (previous == null) delete process.env.PLUR1BUS_SKIP_HOST_PATCH;
      else process.env.PLUR1BUS_SKIP_HOST_PATCH = previous;
    }
    assert.equal(called, 0);
  });
});
