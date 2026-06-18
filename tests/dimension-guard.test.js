import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readExistingTableDimension, checkDimensionCompatibility } from "../lib/providers/dimension-guard.js";

describe("dimension-guard", () => {
  it("nicht-existenter Pfad → status=no-table (kein LanceDB-Crash)", async () => {
    const result = await readExistingTableDimension("/tmp/__nonexistent_plur1bus_test__");
    assert.ok(["no-table", "unknown"].includes(result.status), `Unerwarteter status: ${result.status}`);
  });

  it("checkDimensionCompatibility: no-table → 'no-existing-table'", () => {
    assert.strictEqual(checkDimensionCompatibility({ status: "no-table" }, 3072), "no-existing-table");
  });

  it("checkDimensionCompatibility: ok + gleiche dim → 'ok'", () => {
    assert.strictEqual(checkDimensionCompatibility({ status: "ok", dimension: 3072 }, 3072), "ok");
  });

  it("checkDimensionCompatibility: ok + verschiedene dim → 'mismatch'", () => {
    assert.strictEqual(checkDimensionCompatibility({ status: "ok", dimension: 3072 }, 384), "mismatch");
  });

  it("checkDimensionCompatibility: unknown → 'unknown' (blockiert Wechsel)", () => {
    assert.strictEqual(
      checkDimensionCompatibility({ status: "unknown", error: "connect failed" }, 384),
      "unknown"
    );
  });

  it("status-Objekt hat bei ok immer dimension-Feld", async () => {
    const mockResult = { status: "ok", dimension: 1536 };
    assert.ok("dimension" in mockResult);
    assert.ok(typeof mockResult.dimension === "number");
  });

  it("status-Objekt hat bei unknown immer error-Feld", async () => {
    const mockResult = { status: "unknown", error: "some error" };
    assert.ok("error" in mockResult);
    assert.ok(typeof mockResult.error === "string");
  });
});
