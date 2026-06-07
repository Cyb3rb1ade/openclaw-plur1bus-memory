/**
 * Task 1: Link formatting helpers + module skeleton
 *
 * Tests:
 * 1. formatLinkTarget constructs vault-relative wikilink path
 * 2. formatLinkTarget falls back to plur1bus_id when path missing
 * 3. formatDisplayTitle uses title first
 * 4. formatDisplayTitle falls back to summary slice
 * 5. formatDisplayTitle falls back to plur1bus_id
 * 6. buildLinkLine produces correct wikilink markdown
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  formatLinkTarget,
  formatDisplayTitle,
  buildLinkLine,
} from "../lib/obsidian/graph-link-writer.js";

describe("graph-link-writer: helpers", () => {
  it("formatLinkTarget constructs vault-relative wikilink path", () => {
    const record = { path: "records/decisions/dec-abc.md" };
    assert.strictEqual(
      formatLinkTarget(record, "plur1bus"),
      "plur1bus/records/decisions/dec-abc"
    );
  });

  it("formatLinkTarget falls back to plur1bus_id when path missing", () => {
    const record = { plur1bus_id: "dec-xyz", plur1bus_type: "decision" };
    assert.strictEqual(formatLinkTarget(record, "plur1bus"), "plur1bus/records/decision/dec-xyz");
  });

  it("formatDisplayTitle uses title first", () => {
    assert.strictEqual(
      formatDisplayTitle({ title: "My Note", summary: "Sum" }),
      "My Note"
    );
  });

  it("formatDisplayTitle falls back to summary slice", () => {
    const long = "A".repeat(80);
    assert.strictEqual(formatDisplayTitle({ summary: long }).length, 60);
  });

  it("formatDisplayTitle falls back to plur1bus_id", () => {
    assert.strictEqual(
      formatDisplayTitle({ plur1bus_id: "dec-abc" }),
      "dec-abc"
    );
  });

  it("buildLinkLine produces correct wikilink markdown", () => {
    const line = buildLinkLine(
      { path: "records/decisions/dec-abc.md" },
      "plur1bus",
      "Meine Decision",
      "memoryId"
    );
    assert.strictEqual(
      line,
      "- [[plur1bus/records/decisions/dec-abc|Meine Decision]] _(memoryId)_"
    );
  });
});
