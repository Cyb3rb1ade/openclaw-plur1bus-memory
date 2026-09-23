import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyGlobalInjectBudget, trimAtRecordBoundary, TRUNCATION_MARKER } from "../lib/inject-budget.js";

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

/**
 * Mirrors `lib/neo-arch.js`'s `formatNeoRecallContext` wrapper shape:
 * `<plur1bus-recall>` around a flat run of single-line `<memory-record>`
 * elements.
 */
function neoBlock(count) {
  const items = Array.from({ length: count }, (_, i) => (
    `  <memory-record lane="global" category="fact" trust="corroborated" status="active" ` +
    `epistemic="untrusted" id="neo-${i}" score="0.50"><quoted-evidence>` +
    `Neo record number ${i} carries a reasonably long piece of evidence text so the block overflows.` +
    `</quoted-evidence></memory-record>`
  )).join("\n");
  return `<plur1bus-recall untrusted="true" mode="historical-evidence-only">\nRecall safety: facts are memory-derived, may be stale, verify before acting.\n${items}\n</plur1bus-recall>`;
}

/**
 * Asserts every XML-ish element name found anywhere in `text` opens and
 * closes an equal number of times (an XML comment like the truncation
 * marker is not a tag and is ignored by this regex, since it never matches
 * `<[a-zA-Z]`).
 */
function assertTagsBalanced(text) {
  const names = new Set();
  for (const m of text.matchAll(/<\/?([a-zA-Z][\w-]*)/g)) names.add(m[1]);
  for (const name of names) {
    const opens = (text.match(new RegExp(`<${name}\\b`, "g")) || []).length;
    const closes = (text.match(new RegExp(`</${name}>`, "g")) || []).length;
    assert.equal(opens, closes, `<${name}> must open and close the same number of times`);
  }
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

describe("applyGlobalInjectBudget — fix round 1", () => {
  it("item 1 (MUST-FIX): closes <relevant-memories> when the outer budget cuts inside it", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: memoriesBlock(30), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 800,
    });
    assertTagsBalanced(out);
    assert.match(out, /<\/relevant-memories>/);
  });

  it("item 1 (MUST-FIX): closes <plur1bus-recall> when the outer budget cuts inside a neo block", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "neo", text: neoBlock(30), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 800,
    });
    assertTagsBalanced(out);
    assert.match(out, /<\/plur1bus-recall>/);
  });

  it("item 1 (MUST-FIX): closes <memory-semantic-lens> when the cut lands inside it, after <relevant-memories> already closed", () => {
    const lensItems = Array.from({ length: 20 }, (_, i) => (
      `  <memory-record category="fact" source="semantic-lens" id="lens-${i}"><quoted-evidence>` +
      `Lens record number ${i} carries a reasonably long piece of evidence text.` +
      `</quoted-evidence></memory-record>`
    )).join("\n");
    const text = `${memoriesBlock(2)}\n<memory-semantic-lens>\nErgänzende assoziative Erinnerungen aus nahen Graph-Communities.\n${lensItems}\n</memory-semantic-lens>`;
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text, droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: text.length - 200,
    });
    assertTagsBalanced(out);
    assert.match(out, /<\/relevant-memories>/);
    assert.match(out, /<\/memory-semantic-lens>/);
  });

  it("item 2 (SHOULD-FIX): drops a droppable block with no <memory-record> (e.g. a plain start-notice block) entirely, rather than slicing it", () => {
    const noticeText = "<plur1bus-start-notice>\n" + "This session just started. ".repeat(50) + "\n</plur1bus-start-notice>";
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "start", text: noticeText, droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 50,
    });
    assert.doesNotMatch(out, /plur1bus-start-notice/);
    assert.match(out, /TIME/);
  });

  it("item 2 (SHOULD-FIX): drops a memories block reduced to nudges/markers with no records left, rather than slicing it mid-character", () => {
    const markerOnlyText = "<knowledge-update-nudge>\n" + "Please review pending knowledge updates. ".repeat(20) + "\n</knowledge-update-nudge>";
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: markerOnlyText, droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 40,
    });
    assert.doesNotMatch(out, /knowledge-update-nudge/);
    assert.match(out, /TIME/);
  });

  it("item 4: strips a pre-existing trailing marker instead of doubling it up", () => {
    // 700 raw chars of memoriesBlock(10) comfortably spans the first two
    // complete records (record 0 ends at 345, record 1 at 545) plus part of
    // a third — this models a block an earlier pass already truncated (and
    // marked) mid-record, the way applyGlobalInjectBudget's own old bug used
    // to leave things, or the way a caller could otherwise hand it in.
    const alreadyTruncated = memoriesBlock(10).slice(0, 700) + TRUNCATION_MARKER;
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text: alreadyTruncated, droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: 650,
    });
    const markerCount = (out.match(/<!-- memory context truncated -->/g) || []).length;
    assert.equal(markerCount, 1, "the marker must never appear twice");
    assertTagsBalanced(out);
  });

  it("item 4: an overflow smaller than the marker's own length still yields a valid result (record dropped, not a truncated marker)", () => {
    // maxChars just 1 char under the untrimmed length: overflow is tiny,
    // far smaller than TRUNCATION_MARKER.length, but the marker still has to
    // fit in whatever budget is left for the trimmed block.
    const text = memoriesBlock(30);
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "memories", text, droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      maxChars: text.length + "\n\nTIME".length - 1,
    });
    assertTagsBalanced(out);
    assert.ok(out.length <= text.length + "\n\nTIME".length - 1);
  });

  it("item 4: trims several droppable blocks last-first, not the earliest one", () => {
    const out = applyGlobalInjectBudget({
      blocks: [
        { name: "neo", text: neoBlock(30), droppable: true },
        { name: "memories", text: memoriesBlock(30), droppable: true },
        { name: "time", text: "TIME", droppable: false },
      ],
      // Small enough to force trimming, but comfortably large enough that
      // the earlier ("neo") droppable block survives untouched while the
      // later ("memories") one is the one cut down.
      maxChars: neoBlock(30).length + 600,
    });
    assertTagsBalanced(out);
    assert.match(out, /<plur1bus-recall/, "the earlier droppable block (neo) must survive intact");
    const neoRecords = (out.match(/id="neo-\d+"/g) || []).length;
    assert.equal(neoRecords, 30, "neo's records must all still be present, untrimmed");
    const memoryRecords = (out.match(/id="rec-\d+"/g) || []).length;
    assert.ok(memoryRecords < 30, "the later (memories) droppable block must be the one trimmed");
  });
});

describe("trimAtRecordBoundary", () => {
  it("returns null when no <memory-record> element is present", () => {
    assert.equal(trimAtRecordBoundary("<plur1bus-start-notice>hello</plur1bus-start-notice>", 10), null);
  });

  it("returns null when allowedLen is not positive", () => {
    assert.equal(trimAtRecordBoundary(memoriesBlock(5), 0), null);
    assert.equal(trimAtRecordBoundary(memoriesBlock(5), -5), null);
  });

  it("strips a pre-existing marker (and anything after it, e.g. a previous pass's wrapper closing) before re-measuring", () => {
    // Models exactly what a prior truncation pass produces: the wrapper
    // opened, some records, then MARKER + the wrapper's own closing tag —
    // not the wrapper's normal (unclipped) close before the marker.
    const stillOpen = memoriesBlock(10).replace(/\n<\/relevant-memories>$/, "");
    const alreadyTruncated = stillOpen + TRUNCATION_MARKER + "\n</relevant-memories>";
    // record 0 ends at char 345 in memoriesBlock(10); 450 leaves enough room
    // for it plus the marker (35 chars) plus the wrapper's own closing tag.
    const out = trimAtRecordBoundary(alreadyTruncated, 450);
    assert.ok(out !== null);
    assert.equal((out.match(/<!-- memory context truncated -->/g) || []).length, 1);
    assertTagsBalanced(out);
  });
});
