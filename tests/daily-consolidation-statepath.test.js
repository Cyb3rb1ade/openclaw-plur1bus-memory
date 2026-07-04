import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("continues daily decay from the persisted cursor and records the next cursor", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-daily-decay-cursor-"));
    const logger = { info() {}, warn() {} };
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`,
      status: "active",
      memoryStrength: 1,
      halfLifeDays: 30,
      createdAt: Date.now() - 86400000,
    }));
    const updates = [];
    const statePath = join(workspaceDir, "run-state.json");
    writeFileSync(statePath, JSON.stringify({
      memoryDynamicsDecay: {
        "agent-1:ws-1": {
          cursorId: "11111111-1111-4111-8111-111111111110",
        },
      },
    }), "utf8");
    const db = {
      async init() {},
      async isAvailable() {
        return true;
      },
      table: {
        query() {
          const state = { offset: 0, limit: rows.length };
          return {
            limit(n) {
              state.limit = n;
              return this;
            },
            offset(n) {
              state.offset = n;
              return this;
            },
            async toArray() {
              return rows.slice(state.offset, state.offset + state.limit);
            },
          };
        },
      },
      async update(id, patch) {
        updates.push({ id, patch });
      },
    };
    const neoStore = {
      readRetrievalLedger: () => [],
      readRunState: () => ({}),
      writeRunState() {},
    };

    try {
      const result = await runConsolidation(db, "agent-1", {
        workspaceDir,
        workspaceKey: "ws-1",
        logger,
        neoStore,
        dynamicsDecayMaxRows: 1,
        dryRun: false,
      });

      assert.strictEqual(result.skipped, undefined);
      assert.deepStrictEqual(updates.map((update) => update.id), ["11111111-1111-4111-8111-111111111111"]);
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      assert.strictEqual(
        state.memoryDynamicsDecay["agent-1:ws-1"].cursorId,
        "11111111-1111-4111-8111-111111111111",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
