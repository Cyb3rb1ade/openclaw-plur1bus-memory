import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFeedback } from "../lib/feedback-log.js";

let workspaceDir;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "feedback-log-dynamics-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("feedback-log dynamics", () => {
  it("weakens a negatively rated memory without changing its lifecycle status", async () => {
    const updates = [];
    const memoryId = "11111111-1111-4111-8111-111111111111";
    const db = {
      async getById(id) {
        assert.equal(id, memoryId);
        return { id, status: "active", memoryStrength: 0.75 };
      },
      async update(id, patch) {
        updates.push({ id, patch });
      },
    };

    await recordFeedback(workspaceDir, "incorrect recall", memoryId, "negative", {}, {
      applyDynamics: true,
      agentId: "lab-alpha",
      dbPool: {
        async withDb(agentId, fn) {
          assert.equal(agentId, "lab-alpha");
          return fn(db);
        },
      },
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, memoryId);
    assert.ok(Math.abs(updates[0].patch.memoryStrength - 0.6) < Number.EPSILON);
    assert.equal(Object.hasOwn(updates[0].patch, "status"), false);
  });
});
