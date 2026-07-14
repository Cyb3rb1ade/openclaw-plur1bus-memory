import { describe, it } from "node:test";
import assert from "node:assert";

import { buildReviewNarrativeLead } from "../lib/review-narrative-lead.js";

function countSentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

describe("buildReviewNarrativeLead", () => {
  it("returns a calm lead for an empty summary", () => {
    const lead = buildReviewNarrativeLead({}, null);
    assert.ok(lead);
    assert.match(lead, /nichts Auffaelliges/);
    assert.ok(!lead.includes("\n-"));
    const count = countSentences(lead);
    assert.ok(count >= 2 && count <= 4, `expected 2-4 sentences, got ${count}`);
  });

  it("returns a lead mentioning counts for a full summary", () => {
    const lead = buildReviewNarrativeLead({ findings: 3, proposals: 2, conflicts: 1, duplicates: 4 }, null);
    assert.ok(lead);
    assert.match(lead, /3 Funde/);
    assert.match(lead, /2 Vorschlaege/);
    assert.match(lead, /1 Widerspruch/);
    assert.match(lead, /4 Duplikate/);
    assert.ok(!lead.includes("\n-"));
    const count = countSentences(lead);
    assert.ok(count >= 2 && count <= 4, `expected 2-4 sentences, got ${count}`);
  });

  it("colors the lead with mood when provided", () => {
    const withoutMood = buildReviewNarrativeLead({ findings: 1 }, null);
    const withMood = buildReviewNarrativeLead({ findings: 1 }, { label: "freudig", dominant: "joy", intensity: "hoch", trend: "steigend" });
    assert.ok(withMood);
    assert.notStrictEqual(withMood, withoutMood);
    assert.match(withMood, /aufgeraeumt/);
  });

  it("does not color the lead when mood is balanced or unknown", () => {
    const lead = buildReviewNarrativeLead({ findings: 1 }, { label: "ausgeglichen", dominant: "joy", intensity: "mittel", trend: "stabil" });
    assert.doesNotMatch(lead, /aufgeraeumt/);
  });

  it("enforces a length cap", () => {
    const lead = buildReviewNarrativeLead(
      { findings: 999999, proposals: 999999, conflicts: 999999, duplicates: 999999 },
      { label: "traurig", dominant: "sadness", intensity: "hoch", trend: "steigend" },
    );
    assert.ok(lead.length <= 400);
  });

  it("fails open on malformed input", () => {
    const lead = buildReviewNarrativeLead(null, undefined);
    assert.ok(lead === null || typeof lead === "string");
  });

  it("never contains bullet markers", () => {
    const lead = buildReviewNarrativeLead({ findings: 2, conflicts: 1 }, null);
    assert.ok(!/^[-*]\s/m.test(lead));
  });
});
