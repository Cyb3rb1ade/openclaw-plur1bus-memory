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
  resolveGraphConfig,
  collectTier1Links,
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

describe("graph-link-writer: config", () => {
  it("resolveGraphConfig returns defaults when graphLinks absent", () => {
    const cfg = resolveGraphConfig({});
    assert.strictEqual(cfg.maxPerNote, 5);
    assert.strictEqual(cfg.includeSemantic, false);
    assert.deepStrictEqual(cfg.tiers, ["explicit", "type", "semantic"]);
    assert.strictEqual(cfg.blockId, "graph-links");
    assert.strictEqual(cfg.semanticThreshold, 0.78);
  });

  it("resolveGraphConfig merges user config over defaults", () => {
    const cfg = resolveGraphConfig({ graphLinks: { maxPerNote: 3, tiers: ["explicit"] } });
    assert.strictEqual(cfg.maxPerNote, 3);
    assert.deepStrictEqual(cfg.tiers, ["explicit"]);
    assert.strictEqual(cfg.includeSemantic, false);
    assert.strictEqual(cfg.blockId, "graph-links");
  });
});

describe("graph-link-writer: tier1", () => {
  const reviewRoot = "plur1bus";
  const byId = {
    "src-001": { plur1bus_id: "src-001", path: "records/sources/src-001.md", title: "Kimi Docs" },
    "dec-abc": { plur1bus_id: "dec-abc", path: "records/decisions/dec-abc.md", title: "Auth Decision" },
  };

  it("collects memoryIds as links", () => {
    const record = { plur1bus_id: "cand-x", memoryIds: ["dec-abc"], sourceRefs: [] };
    const links = collectTier1Links(record, byId, reviewRoot, 5);
    assert.strictEqual(links.length, 1);
    assert.match(links[0], /\[\[plur1bus\/records\/decisions\/dec-abc\|Auth Decision\]\]/);
    assert.match(links[0], /_\(memoryId\)_/);
  });

  it("collects sourceRefs as links", () => {
    const record = { plur1bus_id: "dec-x", memoryIds: [], sourceRefs: ["src-001"] };
    const links = collectTier1Links(record, byId, reviewRoot, 5);
    assert.strictEqual(links.length, 1);
    assert.match(links[0], /Kimi Docs/);
    assert.match(links[0], /_\(Quelle\)_/);
  });

  it("skips unknown IDs", () => {
    const record = { plur1bus_id: "x", memoryIds: ["nonexistent"], sourceRefs: [] };
    const links = collectTier1Links(record, byId, reviewRoot, 5);
    assert.strictEqual(links.length, 0);
  });

  it("respects maxPerNote", () => {
    const record = { plur1bus_id: "x", memoryIds: ["dec-abc", "src-001"], sourceRefs: ["src-001"] };
    const links = collectTier1Links(record, byId, reviewRoot, 1);
    assert.strictEqual(links.length, 1);
  });
});
