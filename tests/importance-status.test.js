import { describe, it } from "node:test";
import assert from "node:assert";
import { IMPORTANCE_STATUS, normalizeImportanceStatus } from "../lib/importance-status.js";

describe("importance status", () => {
  it("knows three states", () => {
    assert.deepStrictEqual(
      Object.values(IMPORTANCE_STATUS).sort(),
      ["final", "pending", "pending_backfill"],
    );
  });

  it("treats absent or unknown values as final", () => {
    for (const value of [undefined, null, "", "quatsch", 7]) {
      assert.strictEqual(normalizeImportanceStatus(value), IMPORTANCE_STATUS.FINAL);
    }
  });

  it("keeps the two waiting states apart", () => {
    assert.strictEqual(normalizeImportanceStatus("pending"), IMPORTANCE_STATUS.PENDING);
    assert.strictEqual(normalizeImportanceStatus("pending_backfill"), IMPORTANCE_STATUS.PENDING_BACKFILL);
  });
});
