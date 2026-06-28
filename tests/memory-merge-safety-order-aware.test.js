import { describe, it } from "node:test";
import assert from "node:assert";
import { hasMeaningfulDifference, isSafeDuplicate } from "../lib/memory-merge-safety.js";

// Role reversal = the SAME significant-token multiset in a DIFFERENT order
// ("Erik->Eva" vs "Eva->Erik"). That is a distinct fact, not a duplicate.
// A genuinely different token (extra/synonym word) is NOT a role reversal and
// must keep flowing through the existing tech-synonym / merge logic.

describe("hasMeaningfulDifference — order awareness", () => {
  it("flags role-reversed text (same tokens, different order)", () => {
    assert.strictEqual(hasMeaningfulDifference("Erik überweist Eva 50€", "Eva überweist Erik 50€"), true);
    assert.strictEqual(hasMeaningfulDifference("Eva liebt Erik", "Erik liebt Eva"), true);
  });
  it("does not flag an added article (same significant tokens, same order)", () => {
    assert.strictEqual(hasMeaningfulDifference("Projekt Alpha nutzt Auth-Service", "Projekt Alpha nutzt den Auth-Service"), false);
  });
  it("does not flag a tech synonym with an extra token as a reorder", () => {
    assert.strictEqual(hasMeaningfulDifference("Projekt Alpha nutzt Node 20.", "Projekt Alpha nutzt Node.js 20."), false);
  });
});

describe("isSafeDuplicate — order awareness", () => {
  it("does NOT treat role-reversed facts as duplicates", () => {
    assert.strictEqual(isSafeDuplicate("Erik überweist Eva 50€", "Eva überweist Erik 50€"), false);
    assert.strictEqual(isSafeDuplicate("Eva liebt Erik", "Erik liebt Eva"), false);
  });
  it("still treats an added article as a duplicate", () => {
    assert.strictEqual(isSafeDuplicate("Projekt Alpha nutzt Auth-Service", "Projekt Alpha nutzt den Auth-Service"), true);
  });
});
