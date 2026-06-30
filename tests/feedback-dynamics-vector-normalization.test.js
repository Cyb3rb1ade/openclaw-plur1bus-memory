import { describe, it } from "node:test";
import assert from "node:assert";
import { MemoryDB } from "../index.js";

describe("MemoryDB update row normalization", () => {
  it("normalizes LanceDB vector wrappers before re-adding updated rows", () => {
    const db = new MemoryDB("/tmp/vector-normalization-test", 3);
    db.schemaFieldNames = new Set(["id", "text", "vector", "status", "memoryStrength", "lastDynamicsAt"]);

    const normalized = db.normalizeEntryForTable({
      id: "11111111-1111-4111-8111-111111111111",
      text: "hello",
      vector: {
        values: [0.1, 0.2, 0.3],
        isValid: true,
      },
      status: "active",
    });

    assert.deepStrictEqual(normalized.vector, [0.1, 0.2, 0.3]);
  });
});
