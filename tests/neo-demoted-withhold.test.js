import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreNeoRecallItem } from "../lib/neo-arch.js";

const QUERY = "weekly deploy checklist";

function item(status, extra = {}) {
  return {
    statement: "Always verify weekly releases with the same deployment checklist",
    category: "workflow_preference",
    status,
    salience: 0.8,
    recency: 0.8,
    origin: { trustLevel: "user_asserted", role: "user" },
    ...extra,
  };
}

describe("neo demoted withhold", () => {
  it("excludes demoted at -Infinity and keeps conflict finite", () => {
    const active = scoreNeoRecallItem(item("active"), QUERY);
    const demoted = scoreNeoRecallItem(item("demoted"), QUERY);
    const conflict = scoreNeoRecallItem(item("conflict"), QUERY);
    assert.equal(demoted, Number.NEGATIVE_INFINITY);
    assert.ok(Number.isFinite(conflict));
    assert.ok(conflict < active);
    assert.ok(active > 0);
  });
});
