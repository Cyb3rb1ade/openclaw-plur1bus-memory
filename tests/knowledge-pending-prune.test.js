/**
 * Regression: the KNOWLEDGE.md promotion queue never dropped entries whose
 * memory can no longer be promoted, so `pendingCount` — and the maintenance
 * nudge built from it — kept counting dead work.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { selectStalePendingKeys } from "../lib/knowledge-pending-prune.js";
import { selectSafeUuids, safeUuidList } from "../lib/sql-safety.js";

const ID_A = "550e8400-e29b-41d4-a716-446655440000";
const ID_B = "660e8400-e29b-41d4-a716-446655440001";
const ID_C = "770e8400-e29b-41d4-a716-446655440002";

const entry = (id) => ({ key: `main:${id}`, memoryId: id, sourceAgent: "main" });

describe("selectStalePendingKeys", () => {
  it("reports an invalidated row", () => {
    const stale = selectStalePendingKeys({
      pending: [entry(ID_A), entry(ID_B)],
      rows: [{ id: ID_A, epistemicStatus: "invalidated" }, { id: ID_B, epistemicStatus: "observed" }],
      queriedIds: [ID_A, ID_B],
    });
    assert.deepEqual(stale, [`main:${ID_A}`]);
  });

  it("reports a row the table no longer has", () => {
    const stale = selectStalePendingKeys({
      pending: [entry(ID_A), entry(ID_B)],
      rows: [{ id: ID_B, epistemicStatus: "" }],
      queriedIds: [ID_A, ID_B],
    });
    assert.deepEqual(stale, [`main:${ID_A}`]);
  });

  it("keeps a promotable row queued", () => {
    const stale = selectStalePendingKeys({
      pending: [entry(ID_A)],
      rows: [{ id: ID_A, epistemicStatus: "trusted" }],
      queriedIds: [ID_A],
    });
    assert.deepEqual(stale, []);
  });

  it("treats a missing epistemicStatus as promotable, not as stale", () => {
    // Legacy rows carry no status at all; normalizeEpistemicStatus resolves
    // that to "untrusted", which is promotable.
    const stale = selectStalePendingKeys({
      pending: [entry(ID_A)],
      rows: [{ id: ID_A }],
      queriedIds: [ID_A],
    });
    assert.deepEqual(stale, []);
  });

  it("never prunes an id that was not part of the query", () => {
    // ID_C sat beyond the query cap. Absent from `rows` means "not asked",
    // not "gone".
    const stale = selectStalePendingKeys({
      pending: [entry(ID_A), entry(ID_C)],
      rows: [{ id: ID_A, epistemicStatus: "invalidated" }],
      queriedIds: [ID_A],
    });
    assert.deepEqual(stale, [`main:${ID_A}`]);
  });

  it("prunes nothing when the query never ran", () => {
    assert.deepEqual(selectStalePendingKeys({ pending: [entry(ID_A)], rows: [], queriedIds: [] }), []);
    assert.deepEqual(selectStalePendingKeys({}), []);
  });

  it("returns each key once and keeps queue order", () => {
    const stale = selectStalePendingKeys({
      pending: [entry(ID_B), entry(ID_A), entry(ID_B)],
      rows: [],
      queriedIds: [ID_A, ID_B],
    });
    assert.deepEqual(stale, [`main:${ID_B}`, `main:${ID_A}`]);
  });

  it("ignores entries without a usable key or id", () => {
    const stale = selectStalePendingKeys({
      pending: [{ memoryId: ID_A }, { key: "main:x" }, null],
      rows: [],
      queriedIds: [ID_A],
    });
    assert.deepEqual(stale, []);
  });
});

describe("selectSafeUuids", () => {
  it("returns exactly the ids safeUuidList puts into the IN clause", () => {
    const ids = [ID_A, "'; DROP TABLE--", ID_B];
    const selected = selectSafeUuids(ids, 100);
    assert.deepEqual(selected, [ID_A, ID_B]);
    assert.equal(safeUuidList(ids, 100), selected.map((id) => `'${id}'`).join(","));
  });

  it("caps at maxItems, keeping input order", () => {
    assert.deepEqual(selectSafeUuids([ID_A, ID_B, ID_C], 2), [ID_A, ID_B]);
  });

  it("returns an empty list when nothing is valid", () => {
    assert.deepEqual(selectSafeUuids(["nope"], 100), []);
    assert.equal(safeUuidList(["nope"], 100), null);
  });

  it("rejects a non-array", () => {
    assert.throws(() => selectSafeUuids("nope"), /not an array/);
  });
});
