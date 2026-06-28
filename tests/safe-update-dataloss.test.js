/**
 * tests/safe-update-dataloss.test.js
 *
 * Regression: safeUpdate's semantic-content path must store the new version
 * BEFORE marking the old row superseded. If db.store fails after the supersede,
 * the old memory is hidden from active queries while the replacement never
 * exists — silent, unrecoverable data loss.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { safeUpdate } from "../lib/safe-update.js";

const OLD_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  text: "Original fact",
  summary: "Original fact",
  vector: [0.1, 0.2, 0.3],
  status: "active",
  versionNumber: 1,
};

describe("safeUpdate — supersede-after-store ordering", () => {
  it("does not supersede the old row when storing the new version fails", async () => {
    let supersedeCalled = false;
    const db = {
      getById: async () => ({ ...OLD_ROW }),
      update: async () => { supersedeCalled = true; },
      store: async () => { throw new Error("simulated store failure"); },
    };

    const patch = { text: "Corrected fact", vector: [0.11, 0.21, 0.31] };
    const evidence = { updateSource: "test", updateEvidence: "unit test", confidence: 0.9 };

    await assert.rejects(
      () => safeUpdate(db, OLD_ROW.id, patch, evidence, { skipDriftGate: true }),
      /simulated store failure/,
    );

    assert.strictEqual(
      supersedeCalled,
      false,
      "old row must NOT be marked superseded when the new-version store fails (data-loss guard)",
    );
  });
});
