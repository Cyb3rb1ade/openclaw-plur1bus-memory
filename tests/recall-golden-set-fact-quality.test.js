/**
 * tests/recall-golden-set-fact-quality.test.js
 *
 * Behavioral regression golden-set for categorization → importance → promotion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { categorizeMemoryWithReason } from "../lib/categorize.js";
import {
  computeMemoryImportance,
  shouldPromoteMemory,
  explainFactQuality,
} from "../lib/memory-fact-quality.js";

describe("Golden-Set: categorization → importance → promotion chain", () => {
  const cases = [
    {
      text: "ok",
      allowedCategories: ["conversation"],
      expectPromote: false,
      maxImportance: 0.25,
    },
    {
      text: "Today npm test passed",
      allowedCategories: ["conversation"],
      expectPromote: false,
      maxImportance: 0.45,
    },
    {
      text: "User prefers concise answers",
      allowedCategories: ["preference"],
      expectPromote: false,
      minImportance: 0.55,
      maxImportance: 0.69,
    },
    {
      text: "From now on, use German for repo prompts",
      allowedCategories: ["preference"],
      expectPromote: false,
      minImportance: 0.7,
    },
    {
      text: "Deployment läuft auf Node 22",
      allowedCategories: ["decision", "config"],
      expectPromote: false,
      minImportance: 0.6,
      maxImportance: 0.69,
    },
    {
      text: "Dreamdale is a festival, not a city",
      allowedCategories: ["fact", "decision", "entity"],
      expectPromote: true,
      minImportance: 0.7,
    },
    {
      text: "Auth bypass in group chats was fixed",
      allowedCategories: ["decision", "config", "debug"],
      expectPromote: true,
      minImportance: 0.7,
    },
    {
      text: "I am so angry and frustrated",
      allowedCategories: ["fact", "conversation"],
      expectPromote: false,
      maxImportance: 0.55,
    },
    {
      text: "node react postgres",
      allowedCategories: ["conversation"],
      expectPromote: false,
      maxImportance: 0.55,
    },
    {
      text: "Remember this: deploy on Fridays is forbidden",
      allowedCategories: ["decision", "fact"],
      expectPromote: true,
      minImportance: 0.7,
    },
  ];

  for (const tc of cases) {
    it(`handles "${tc.text}"`, () => {
      const { category, reason } = categorizeMemoryWithReason(tc.text);
      assert.ok(
        tc.allowedCategories.includes(category),
        `expected one of ${tc.allowedCategories.join("|")}, got ${category}; reason: ${reason}`,
      );
      const { importance, factQuality } = computeMemoryImportance({ text: tc.text, category });
      if (tc.minImportance !== undefined) {
        assert.ok(
          importance >= tc.minImportance,
          `expected importance >= ${tc.minImportance}, got ${importance}`,
        );
      }
      if (tc.maxImportance !== undefined) {
        assert.ok(
          importance <= tc.maxImportance,
          `expected importance <= ${tc.maxImportance}, got ${importance}`,
        );
      }
      const promote = shouldPromoteMemory(category, importance, factQuality);
      assert.strictEqual(
        promote,
        tc.expectPromote,
        `expected promote=${tc.expectPromote}, got ${promote}`,
      );
    });
  }
});

describe("Golden-Set: fact-quality edge cases", () => {
  it("rejects promotion for non-decision/non-fact categories even when important", () => {
    const { importance, factQuality } = computeMemoryImportance({
      text: "User prefers dark mode",
      category: "preference",
    });
    assert.ok(importance >= 0.55);
    const promote = shouldPromoteMemory("preference", importance, factQuality);
    assert.strictEqual(promote, false);
  });

  it("downranks trivial text", () => {
    const q = explainFactQuality("ok");
    assert.strictEqual(q.shouldDownrank, true);
    assert.strictEqual(q.importanceBand, "low");
  });

  it("promotes explicit remember instructions", () => {
    const q = explainFactQuality("Remember: always run lint before committing");
    assert.strictEqual(q.shouldPromote, true);
    assert.strictEqual(q.importanceBand, "high");
  });

  it("promotes correction signals", () => {
    const q = explainFactQuality("No longer Postgres, use MySQL instead");
    assert.strictEqual(q.shouldPromote, true);
    assert.ok(q.importanceBand === "high" || q.importanceBand === "medium");
  });
});
