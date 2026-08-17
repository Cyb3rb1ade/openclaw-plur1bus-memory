import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasPostCutoffEmptySkillEvidence } from "../lib/jobs/skill-miner.js";

describe("skill-miner post-cutoff preflight", () => {
  it("does not depend on scan pagination", async () => {
    const rows = [
      { epistemicStatus: "", createdAt: 200, category: "fact" },
    ];
    let whereUsed = "";
    const table = {
      schema: async () => ({ fields: [{ name: "createdAt" }, { name: "epistemicStatus" }, { name: "category" }] }),
      query() {
        return {
          where(clause) {
            whereUsed = clause;
            return this;
          },
          limit(n) {
            assert.equal(n, 1);
            return this;
          },
          async toArray() { return rows; },
        };
      },
    };
    const dirty = await hasPostCutoffEmptySkillEvidence(table, 100, null);
    assert.equal(dirty, true);
    assert.match(whereUsed, /createdAt >= 100/);
    assert.match(whereUsed, /epistemicStatus/);
  });

  it("fails closed when where() is unavailable", async () => {
    const table = {
      schema: async () => ({ fields: [] }),
      query() { return { async toArray() { return []; } }; },
    };
    assert.equal(await hasPostCutoffEmptySkillEvidence(table, 100, null), true);
  });
});
