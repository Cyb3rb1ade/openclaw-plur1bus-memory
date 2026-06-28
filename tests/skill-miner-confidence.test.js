/**
 * tests/skill-miner-confidence.test.js
 *
 * Regression: the confidence gate only fired for `typeof confidence === "number"`.
 * A non-numeric confidence (string "0.3", or missing) bypassed the gate and a
 * bogus confidence flowed downstream, defeating the min-confidence filter.
 * Coerce to a number; non-finite → 0 (treated as low).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { extractSkillFromEvidence } from "../lib/jobs/skill-miner/llm-extractor.js";

const group = { memories: [{ text: "did the thing" }, { text: "did it again" }] };

function opts(llmJson) {
  return {
    callLlm: async () => JSON.stringify(llmJson),
    llmCfg: { model: "m" },
    timeoutMs: 1000,
  };
}

describe("skill-miner confidence gate", () => {
  it("skips a low string confidence (coerced, not bypassed)", async () => {
    const res = await extractSkillFromEvidence(group, opts({
      confidence: "0.3", skillName: "x", instructions: "do x",
    }));
    assert.strictEqual(res.skip, true, "string '0.3' must be coerced and skipped as low confidence");
    assert.strictEqual(res.reason, "low_confidence");
  });

  it("skips when confidence is missing/non-numeric (treated as 0)", async () => {
    const res = await extractSkillFromEvidence(group, opts({
      confidence: "high", skillName: "x", instructions: "do x",
    }));
    assert.strictEqual(res.skip, true, "non-numeric confidence must not bypass the gate");
  });

  it("still accepts a genuinely high numeric confidence", async () => {
    const res = await extractSkillFromEvidence(group, opts({
      confidence: 0.9, skillName: "x", instructions: "do x",
    }));
    assert.notStrictEqual(res.skip, true, "high confidence must pass");
    assert.strictEqual(res.confidence, 0.9);
  });
});
