import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyConflictViaSafeUpdate } from "../lib/jobs/apply-conflict-resolution.js";

describe("applyConflictViaSafeUpdate", () => {
  it("refuses without confirm", async () => {
    const out = await applyConflictViaSafeUpdate({}, { id: "x" }, { confirm: false });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "confirm_required");
  });
});
