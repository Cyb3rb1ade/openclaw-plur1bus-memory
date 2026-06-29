import { describe, it } from "node:test";
import assert from "node:assert";

import { summarizeClusterWithLlm } from "../lib/dreaming/rem-dream.js";

describe("rem-dream confidence normalization", () => {
  it("preserves explicit zero confidence from the LLM", async () => {
    const pattern = await summarizeClusterWithLlm(
      [{ text: "No clear recurring pattern." }],
      {},
      async () => JSON.stringify({
        patternName: "No clear pattern",
        description: "No reliable pattern emerged.",
        trend: "unknown",
        confidence: 0,
      }),
    );

    assert.strictEqual(pattern.confidence, 0);
  });
});
