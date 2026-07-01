import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runConsolidation } from "../lib/jobs/daily-consolidation.js";

describe("daily-consolidation statePath wiring", () => {
  it("records a successful non-dry run and rate-limits the immediate second run", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-daily-consolidation-"));
    const logger = { info() {}, warn() {} };
    const db = {
      async init() {},
      async isAvailable() {
        return false;
      },
    };

    try {
      const first = await runConsolidation(db, "agent-1", {
        workspaceDir,
        workspaceKey: "ws-1",
        logger,
        dryRun: false,
      });

      assert.strictEqual(first.skipped, undefined);

      const statePath = join(workspaceDir, "run-state.json");
      assert.strictEqual(existsSync(statePath), true);

      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.ok(state.jobRateLimits["daily-consolidation:agent-1:ws-1"]);

      const second = await runConsolidation(db, "agent-1", {
        workspaceDir,
        workspaceKey: "ws-1",
        logger,
        dryRun: false,
      });

      assert.strictEqual(second.skipped, true);
      assert.strictEqual(second.reason, "rate_limited");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
