import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDerivedRecordAccessible } from "../lib/neo-arch.js";

describe("derived record ACL", () => {
  it("denies a foreign agent when visibility is missing", () => {
    assert.equal(isDerivedRecordAccessible(
      { agentId: "a" },
      { agentId: "b" },
    ), false);
  });

  it("allows the owning agent on a legacy unscoped row", () => {
    assert.equal(isDerivedRecordAccessible(
      { agentId: "a" },
      { agentId: "a" },
    ), true);
  });
});
