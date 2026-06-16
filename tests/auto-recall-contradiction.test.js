import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveContradictionWinner } from "../lib/memory-text-contradiction.js";

describe("auto-recall contradiction resolution", () => {
  it("ranks corrected memory above old memory when both recalled", () => {
    const oldMemory = { id: "old", text: "Postgres.", versionNumber: 1, status: "superseded", supersededBy: "new" };
    const newMemory = { id: "new", text: "MySQL.", versionNumber: 2, status: "active", supersededBy: "" };
    assert.strictEqual(resolveContradictionWinner(oldMemory, newMemory).id, "new");
  });
});
