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

/**
 * Builds a `<relevant-memories>`-shaped droppable block text with `count`
 * `<memory-record>` elements, mirroring the element/line structure
 * `lib/relevant-memory-context.js`'s `renderMemoryItems` actually emits
 * (one `  <memory-record ...><quoted-evidence>...</quoted-evidence></memory-record>`
 * line per record, joined by "\n").
 */
function memoriesBlock(count) {
  const items = Array.from({ length: count }, (_, i) => (
    `  <memory-record category="fact" source="memory" id="rec-${i}"><quoted-evidence>` +
    `Record number ${i} carries a reasonably long piece of evidence text so the block overflows.` +
    `</quoted-evidence></memory-record>`
  )).join("\n");
  return `<relevant-memories untrusted="true" mode="historical-evidence-only">\nRecall safety: facts are memory-derived, may be stale, verify before acting.\n${items}\n</relevant-memories>`;
}

describe("applyGlobalInjectBudget — F1 record-boundary trimming", () => {
  it("never cuts a <memory-record> element in half", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: memoriesBlock(30), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 800,
    });
    const opens = (out.match(/<memory-record\b/g) || []).length;
    const closes = (out.match(/<\/memory-record>/g) || []).length;
    assert.equal(opens, closes, "every opened <memory-record> must be closed");
    // No dangling "<" without a matching ">" anywhere near the end of a
    // record — i.e. the text must not end inside an element/attribute.
    assert.doesNotMatch(out, /<memory-record[^>]*$/);
    assert.doesNotMatch(out, /<quoted-evidence>[^<]*$/);
  });

  it("appends the truncation marker when the droppable block is trimmed", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: memoriesBlock(30), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 800,
    });
    assert.match(out, /<!-- memory context truncated -->/);
  });

  it("respects the cap", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: memoriesBlock(30), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 800,
    });
    assert.ok(out.length <= 800, `expected <= 800 chars, got ${out.length}`);
  });

  it("drops the droppable block entirely when not even one record fits", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: memoriesBlock(30), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 10,
    });
    assert.doesNotMatch(out, /<memory-record/);
    assert.match(out, /TIME/);
  });

  it("never touches a non-droppable block", () => {
    const nonDroppable = "TIME-CONTEXT-BLOCK-THAT-MUST-SURVIVE-INTACT";
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: memoriesBlock(30), droppable: true },
        { name: "time", text: nonDroppable, droppable: false },
      ],
      maxChars: 60,
    });
    assert.match(out, new RegExp(nonDroppable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("passes through untouched when maxChars is unset", () => {
    const blocks = [
      { name: "memories", text: memoriesBlock(30), droppable: true },
      { name: "time", text: "TIME", droppable: false },
    ];
    const out = applyGlobalInjectBudget({ blocks });
    assert.equal(out, blocks.map((b) => b.text).join("\n\n"));
  });
});
