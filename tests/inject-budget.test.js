import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyGlobalInjectBudget } from "../lib/inject-budget.js";

describe("applyGlobalInjectBudget", () => {
  it("trims memories before time context", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: "M".repeat(100), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 20,
    });
    assert.match(out, /TIME/);
    assert.ok(out.length <= 28);
  });
});
