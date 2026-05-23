/**
 * Tests für lib/frontmatter.js — KNOWLEDGE.md YAML-Frontmatter.
 * Run: node --test __tests__/frontmatter.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripFrontmatter, buildFrontmatter, withFrontmatter, parseSourceMemoryIds } from "../lib/frontmatter.js";

test("stripFrontmatter: kein Frontmatter → null + ganzer body", () => {
  const c = "# Heading\n\nContent here";
  const r = stripFrontmatter(c);
  assert.equal(r.frontmatter, null);
  assert.equal(r.body, c);
});

test("stripFrontmatter: extrahiert YAML zwischen ---", () => {
  const c = "---\nfoo: bar\nbaz: qux\n---\n\n# Body";
  const r = stripFrontmatter(c);
  assert.equal(r.frontmatter, "foo: bar\nbaz: qux");
  assert.equal(r.body, "\n# Body");
});

test("stripFrontmatter: unvollständiger Frontmatter (kein closing ---) → kein strip", () => {
  const c = "---\nfoo: bar\n# Body";
  const r = stripFrontmatter(c);
  assert.equal(r.frontmatter, null);
  assert.equal(r.body, c);
});

test("buildFrontmatter: minimal", () => {
  const fm = buildFrontmatter({ today: "2026-04-25" });
  assert.ok(fm.startsWith("---\ntype: knowledge\n"));
  assert.ok(fm.includes("last_verified: 2026-04-25"));
  assert.ok(fm.endsWith("---\n"));
});

test("buildFrontmatter: mit agent + sources", () => {
  const fm = buildFrontmatter({
    agentId: "agent-secondary",
    sourceMemoryIds: ["uuid-1", "uuid-2"],
    today: "2026-04-25",
  });
  assert.ok(fm.includes("agent: agent-secondary"));
  assert.ok(fm.includes("source_memories:"));
  assert.ok(fm.includes("- uuid-1"));
  assert.ok(fm.includes("- uuid-2"));
});

test("buildFrontmatter: source_memories cap auf 50", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `uuid-${i}`);
  const fm = buildFrontmatter({ sourceMemoryIds: ids, today: "2026-04-25" });
  const matches = (fm.match(/  - uuid-/g) || []).length;
  assert.equal(matches, 50);
});

test("withFrontmatter: appendet zu plainem body", () => {
  const out = withFrontmatter("# Body", { today: "2026-04-25" });
  assert.ok(out.startsWith("---\n"));
  assert.ok(out.includes("# Body"));
});

test("withFrontmatter: ersetzt bestehenden Frontmatter", () => {
  const c = "---\nold: stuff\n---\n\n# Body";
  const out = withFrontmatter(c, { today: "2026-04-25", agentId: "main" });
  assert.ok(!out.includes("old: stuff"));
  assert.ok(out.includes("agent: main"));
  assert.ok(out.includes("# Body"));
});

test("parseSourceMemoryIds: extrahiert Liste", () => {
  const fm = `agent: main\nsource_memories:\n  - uuid-1\n  - uuid-2\n  - uuid-3`;
  const ids = parseSourceMemoryIds(fm);
  assert.deepEqual(ids, ["uuid-1", "uuid-2", "uuid-3"]);
});

test("parseSourceMemoryIds: keine Liste vorhanden → []", () => {
  assert.deepEqual(parseSourceMemoryIds("agent: main\n"), []);
  assert.deepEqual(parseSourceMemoryIds(null), []);
  assert.deepEqual(parseSourceMemoryIds(""), []);
});

test("Round-Trip: build → strip → identische Daten", () => {
  const fm = buildFrontmatter({
    agentId: "test",
    sourceMemoryIds: ["a", "b"],
    today: "2026-04-25",
  });
  const wrapped = fm + "Body content";
  const r = stripFrontmatter(wrapped);
  assert.ok(r.frontmatter.includes("agent: test"));
  const ids = parseSourceMemoryIds(r.frontmatter);
  assert.deepEqual(ids, ["a", "b"]);
});
