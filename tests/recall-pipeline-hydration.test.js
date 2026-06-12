// tests/recall-pipeline-hydration.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hydrateGraphResults } from "../lib/recall-pipeline.js";

/**
 * Extracts the IDs targeted by a LanceDB-style where clause.
 * Handles:
 *   id = 'some-id'
 *   id IN ('id1','id2',...)
 */
function extractWhereIds(whereClause) {
  if (typeof whereClause !== "string") return new Set();
  const normalized = whereClause.trim();
  const inMatch = normalized.match(/^id\s+IN\s*\((.+)\)$/i);
  if (inMatch) {
    return new Set(inMatch[1].match(/'([^']*)'/g)?.map(s => s.slice(1, -1)) ?? []);
  }
  const eqMatch = normalized.match(/^id\s*=\s*'([^']*)'$/i);
  if (eqMatch) return new Set([eqMatch[1]]);
  return new Set();
}

function mockTable(rows = []) {
  return {
    query() {
      return {
        where(whereClause) {
          const ids = extractWhereIds(whereClause);
          return {
            limit() {
              return {
                async toArray() {
                  return rows.filter(r => ids.size === 0 || ids.has(r.id));
                },
              };
            },
          };
        },
      };
    },
  };
}

function makeLogger() {
  const warnings = [];
  return {
    warn(msg) { warnings.push(msg); },
    info() {},
    get warnings() { return warnings; },
  };
}

describe("hydrateGraphResults", () => {
  it("keeps source=graph and depth on hydrated results and populates text/summary", async () => {
    const row = {
      id: "m2",
      text: "hydrated text",
      summary: "hydrated summary",
      category: "fact",
      origin: "dm",
      status: "active",
    };
    const dbTable = mockTable([row]);
    const results = [
      { entry: { id: "m1", text: "seed", summary: "seed sum" }, score: 0.9, source: "vector" },
      { entry: { id: "m2" }, score: 0.5, source: "graph", depth: 2 },
    ];
    const out = await hydrateGraphResults(dbTable, results, console);
    assert.strictEqual(out.length, 2, "both results should be returned");
    const m2 = out.find(r => r.entry.id === "m2");
    assert.ok(m2, "graph result must be hydrated");
    assert.strictEqual(m2.source, "graph", "source must stay graph");
    assert.strictEqual(m2.depth, 2, "depth must be preserved");
    assert.strictEqual(m2.entry.text, "hydrated text", "text must be hydrated from DB");
    assert.strictEqual(m2.entry.summary, "hydrated summary", "summary must be hydrated from DB");
  });

  it("does not add source/depth to vector results", async () => {
    const results = [
      { entry: { id: "m1", text: "seed", summary: "seed sum" }, score: 0.9, source: "vector" },
    ];
    const out = await hydrateGraphResults(mockTable([]), results, console);
    const m1 = out.find(r => r.entry.id === "m1");
    assert.strictEqual(m1.source, "vector");
    assert.strictEqual(m1.depth, undefined);
  });

  it("filters out inactive/superseded graph rows", async () => {
    const rows = [
      { id: "m2", text: "active text", summary: "", status: "active" },
      { id: "m3", text: "superseded text", summary: "", status: "superseded" },
      { id: "m4", text: "archived text", summary: "", status: "archived" },
    ];
    const results = [
      { entry: { id: "m2" }, score: 0.5, source: "graph", depth: 1 },
      { entry: { id: "m3" }, score: 0.5, source: "graph", depth: 1 },
      { entry: { id: "m4" }, score: 0.5, source: "graph", depth: 1 },
    ];
    const out = await hydrateGraphResults(mockTable(rows), results, console);
    assert.deepStrictEqual(out.map(r => r.entry.id), ["m2"]);
  });

  it("drops hydration misses and warns", async () => {
    const logger = makeLogger();
    const results = [
      { entry: { id: "m2" }, score: 0.5, source: "graph", depth: 1 },
    ];
    const out = await hydrateGraphResults(mockTable([]), results, logger);
    assert.deepStrictEqual(out, []);
    assert.strictEqual(logger.warnings.length, 1);
    assert.match(logger.warnings[0], /missed 1 of 1 IDs/);
  });

  it("passes through graph results that already have text or summary", async () => {
    const results = [
      { entry: { id: "m2", text: "already has text" }, score: 0.5, source: "graph", depth: 1 },
      { entry: { id: "m3", summary: "already has summary" }, score: 0.5, source: "graph", depth: 1 },
    ];
    const out = await hydrateGraphResults(mockTable([]), results, console);
    assert.strictEqual(out.length, 2);
    const m2 = out.find(r => r.entry.id === "m2");
    const m3 = out.find(r => r.entry.id === "m3");
    assert.strictEqual(m2.entry.text, "already has text");
    assert.strictEqual(m3.entry.summary, "already has summary");
  });

  it("preserves depth: 0 as a valid value", async () => {
    const row = { id: "m2", text: "text", summary: "summary", status: "active" };
    const results = [
      { entry: { id: "m2" }, score: 0.5, source: "graph", depth: 0 },
    ];
    const out = await hydrateGraphResults(mockTable([row]), results, console);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].depth, 0);
  });

  it("returns empty for empty results array", async () => {
    const out = await hydrateGraphResults(mockTable([{ id: "m1", text: "x" }]), [], console);
    assert.deepStrictEqual(out, []);
  });
});
