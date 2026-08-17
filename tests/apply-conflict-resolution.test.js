import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConflictViaSafeUpdate,
  findResolvableConflict,
  resolutionApplyId,
  resolutionApplyText,
} from "../lib/jobs/apply-conflict-resolution.js";
import { createConfirmation } from "../lib/security.js";

const EXISTING = "00000000-0000-4000-8000-0000000000c1";
const NEW = "00000000-0000-4000-8000-0000000000c2";

describe("applyConflictViaSafeUpdate", () => {
  it("refuses without confirm", async () => {
    const out = await applyConflictViaSafeUpdate({}, { existingMemoryId: EXISTING, mergedText: "x", vector: [1] }, { confirm: false });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "confirm_required");
  });

  it("applies only after nonce-bound confirm payload is complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "conflict-apply-"));
    mkdirSync(join(root, ".adaptive-learning"), { recursive: true });
    writeFileSync(join(root, ".adaptive-learning", "conflict-resolved.jsonl"), `${JSON.stringify({
      original: { existingMemoryId: EXISTING, newMemoryId: NEW, existingText: "old", newText: "new" },
      resolution: "merge",
      recommendation: "apply_via_safe_reconsolidation",
      mergedText: "merged claim",
    })}\n`);
    const entry = findResolvableConflict(root, EXISTING);
    assert.equal(resolutionApplyId(entry), EXISTING);
    assert.equal(resolutionApplyText(entry), "merged claim");
    const confirm = createConfirmation({
      userId: "owner",
      chatId: "owner-dm",
      command: "conflict-apply",
      targetId: EXISTING,
    });
    assert.equal(confirm.command, "conflict-apply");
    assert.equal(confirm.targetId, EXISTING);
    let updated = 0;
    const db = {
      async getById(id) {
        return {
          id, text: "old", vector: [0.1, 0.2], status: "active",
          agentId: "agent-a", storedBy: "agent-a", scope: "agent-private",
        };
      },
      async store() {},
      async update() { updated += 1; },
    };
    const refused = await applyConflictViaSafeUpdate(db, {
      existingMemoryId: resolutionApplyId(entry),
      mergedText: resolutionApplyText(entry),
    }, { confirm: false, vector: [0.1, 0.2] });
    assert.equal(refused.ok, false);
    const applied = await applyConflictViaSafeUpdate(db, {
      existingMemoryId: resolutionApplyId(entry),
      mergedText: resolutionApplyText(entry),
    }, { confirm: true, vector: [0.1, 0.2] });
    assert.equal(applied.ok, true);
    assert.equal(updated, 1);
    rmSync(root, { recursive: true, force: true });
  });
});
