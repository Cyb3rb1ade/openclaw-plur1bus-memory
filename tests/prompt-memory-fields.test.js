import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderPromptMemoryAttrs } from "../lib/prompt-memory-fields.js";

describe("renderPromptMemoryAttrs", () => {
  it("labels missing epistemic as untrusted without inventing a stored value", () => {
    const a = renderPromptMemoryAttrs({ status: "active" });
    assert.equal(a.epistemic, "untrusted");
    assert.equal(a.status, "active");
    assert.equal(a.createdAtMs, null);
  });

  it("does not treat missing status as superseded", () => {
    assert.equal(renderPromptMemoryAttrs({}).status, "active");
  });
});
