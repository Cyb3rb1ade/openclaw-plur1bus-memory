/**
 * tests/valid-time.test.js
 *
 * Phase 2 — Bi-Temporal Memory. Covers isEntryValidAt/normalizeCapturedTimestamp
 * /hasDisjointValidityWindows/combineValidTimeForMerge/buildValidTimeClosePatch
 * (lib/valid-time.js), recall-pipeline validAt threading (all chokepoints),
 * the query-side (memory_recall) and capture-side (memory_store) triggers,
 * prompt labeling, safe-update inheritance, and migration idempotency.
 *
 * Convention: FIXED_NOW + at(offsetMs) — no bare Date.now() in fixtures, per
 * the task brief's flagged flakiness risk. Row construction goes through
 * makeRow()/projectRecallEntry() (the real projection/filter chain), not
 * hand-built already-filtered objects.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";

import {
  isEntryValidAt,
  normalizeCapturedTimestamp,
  hasDisjointValidityWindows,
  combineValidTimeForMerge,
  buildValidTimeClosePatch,
} from "../lib/valid-time.js";
import {
  runRecallPipeline as runRecallPipelineRaw,
  isRecallEntryLive,
  projectRecallEntry,
  hydrateGraphResults,
} from "../lib/recall-pipeline.js";
import { makeEmbeddings, makeRow as makeHarnessRow, mockTable } from "./helpers/golden-recall-harness.js";
import { buildUpdateEntry, safeUpdate } from "../lib/safe-update.js";
import { formatRelevantMemoriesContext } from "../lib/relevant-memory-context.js";
import { runMemoryCompaction } from "../lib/jobs/memory-compaction.js";
import { createDbAdapter } from "../lib/db-adapter.js";
import { LocalTransformersEmbeddingProvider } from "../lib/providers/embedding-local-transformers.js";
import plugin, { MemoryDB, applyValidTimeCloseToLanceDb } from "../index.js";

const FIXED_NOW = Date.parse("2026-08-11T12:00:00.000Z");
function at(offsetMs) {
  return FIXED_NOW + offsetMs;
}
const DAY = 86400000;

const roots = [];
const liveMemoryDbs = new Set();
const gatewayStopHandlers = new Set();

function trackMemoryDb(db) {
  liveMemoryDbs.add(db);
  return db;
}

async function shutdownMemoryDb(db) {
  liveMemoryDbs.delete(db);
  await db.shutdown();
}

async function shutdownTestResources() {
  const handlers = [...gatewayStopHandlers];
  gatewayStopHandlers.clear();
  for (const handler of handlers) await handler({}, {});

  const dbs = [...liveMemoryDbs];
  liveMemoryDbs.clear();
  for (const db of dbs) await db.shutdown();
}

afterEach(async () => {
  await shutdownTestResources();
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});
function tmpRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// ─── Pure functions (lib/valid-time.js) ────────────────────────────────────

describe("valid-time — isEntryValidAt (pure)", () => {
  it("no validAt supplied -> no filtering at all (every entry passes)", () => {
    assert.equal(isEntryValidAt({ validFrom: at(DAY), validUntil: at(2 * DAY) }, null), true);
    assert.equal(isEntryValidAt({ validFrom: at(DAY), validUntil: at(2 * DAY) }, undefined), true);
  });

  it("validFrom=0 (unknown lower bound) never excludes", () => {
    assert.equal(isEntryValidAt({ validFrom: 0, validUntil: 0 }, at(-100 * DAY)), true);
  });

  it("validUntil=0 (still open) never excludes", () => {
    assert.equal(isEntryValidAt({ validFrom: at(-DAY), validUntil: 0 }, at(1000 * DAY)), true);
  });

  it("left-inclusive: validAt === validFrom is included", () => {
    assert.equal(isEntryValidAt({ validFrom: at(0), validUntil: 0 }, at(0)), true);
  });

  it("right-exclusive: validAt === validUntil is EXCLUDED (belongs to the successor)", () => {
    assert.equal(isEntryValidAt({ validFrom: 0, validUntil: at(0) }, at(0)), false);
  });

  it("validAt strictly before validUntil is included", () => {
    assert.equal(isEntryValidAt({ validFrom: 0, validUntil: at(0) }, at(0) - 1), true);
  });

  it("validAt before validFrom is excluded", () => {
    assert.equal(isEntryValidAt({ validFrom: at(0), validUntil: 0 }, at(0) - 1), false);
  });

  it("treats LanceDB BigInt zero sentinels as an open validity window", () => {
    assert.equal(isEntryValidAt({ validFrom: 0n, validUntil: 0n }, BigInt(at(0))), true);
  });

  it("applies left-inclusive and right-exclusive boundaries to known BigInt bounds", () => {
    const from = BigInt(at(-DAY));
    const until = BigInt(at(DAY));
    const entry = { validFrom: from, validUntil: until };
    assert.equal(isEntryValidAt(entry, from - 1n), false);
    assert.equal(isEntryValidAt(entry, from), true);
    assert.equal(isEntryValidAt(entry, until - 1n), true);
    assert.equal(isEntryValidAt(entry, until), false);
  });

  it("does not coerce out-of-safe-range BigInt bounds lossily", () => {
    const unsafeBound = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    assert.equal(isEntryValidAt({ validFrom: unsafeBound, validUntil: 0n }, at(0)), true);
    assert.equal(isEntryValidAt({ validFrom: 0n, validUntil: unsafeBound }, at(0)), true);
  });

  it("Test 6 (§12): createdAt is never read as validFrom — a row with createdAt set but validFrom unset resolves unconstrained", () => {
    const entry = { createdAt: at(-1000 * DAY), validFrom: 0, validUntil: 0 };
    assert.equal(isEntryValidAt(entry, at(-2000 * DAY)), true, "an ancient validAt query must not be excluded by an unrelated createdAt");
  });

  it("Test 7 (§12): updatedAt is never read as validUntil — an edited row's updatedAt does not close its validUntil", () => {
    const entry = { updatedAt: at(-DAY), validFrom: 0, validUntil: 0 };
    assert.equal(isEntryValidAt(entry, at(1000 * DAY)), true, "a future validAt query must not be excluded by an unrelated updatedAt");
  });
});

describe("valid-time — normalizeCapturedTimestamp (pure)", () => {
  it("Test 8 (§12): unparseable/vague relative phrases resolve to 0, never a guessed date", () => {
    assert.equal(normalizeCapturedTimestamp("letzten Monat"), 0);
    assert.equal(normalizeCapturedTimestamp("irgendwann"), 0);
    assert.equal(normalizeCapturedTimestamp(""), 0);
    assert.equal(normalizeCapturedTimestamp(null), 0);
    assert.equal(normalizeCapturedTimestamp(undefined), 0);
    assert.equal(normalizeCapturedTimestamp("unknown"), 0);
  });

  it("parses a real ISO date to its ms epoch", () => {
    assert.equal(normalizeCapturedTimestamp("2025-06-01"), Date.parse("2025-06-01"));
  });

  it("passes a real ms-epoch number through unchanged (floored)", () => {
    assert.equal(normalizeCapturedTimestamp(1234567890123.7), 1234567890123);
  });

  it("rejects out-of-range numbers (negative, absurdly large) as unknown", () => {
    assert.equal(normalizeCapturedTimestamp(-5), 0);
    assert.equal(normalizeCapturedTimestamp(1e16), 0);
  });

  it("never throws on a malformed value", () => {
    assert.doesNotThrow(() => normalizeCapturedTimestamp({ not: "a date" }));
    assert.doesNotThrow(() => normalizeCapturedTimestamp([1, 2, 3]));
  });
});

describe("valid-time — buildValidTimeClosePatch (pure)", () => {
  it("Test 4 (§12): refuses to close with an unknown (0/unparseable) boundary", () => {
    assert.throws(
      () => buildValidTimeClosePatch({ validFrom: 0 }, { validUntil: undefined, actor: "human-x" }),
      /refuse to close with an unknown boundary/,
    );
    assert.throws(
      () => buildValidTimeClosePatch({ validFrom: 0 }, { validUntil: "not a date", actor: "human-x" }),
      /refuse to close with an unknown boundary/,
    );
  });

  it("Test 5 (§12): refuses an inverted interval (validUntil <= validFrom)", () => {
    const record = { validFrom: at(DAY) };
    assert.throws(
      () => buildValidTimeClosePatch(record, { validUntil: at(DAY), actor: "human-x" }),
      /must be after validFrom/,
    );
    assert.throws(
      () => buildValidTimeClosePatch(record, { validUntil: at(0), actor: "human-x" }),
      /must be after validFrom/,
    );
  });

  it("accepts a real, forward-moving boundary", () => {
    const record = { validFrom: at(0) };
    const patch = buildValidTimeClosePatch(record, { validUntil: at(DAY), actor: "human-x" });
    assert.equal(patch.validUntil, at(DAY));
  });

  it("requires a non-empty actor identity", () => {
    assert.throws(
      () => buildValidTimeClosePatch({}, { validUntil: at(DAY) }),
      /actor is required/,
    );
  });

  it("accepts closing a row with no known validFrom (0) at all", () => {
    const patch = buildValidTimeClosePatch({ validFrom: 0 }, { validUntil: at(DAY), actor: "human-x" });
    assert.equal(patch.validUntil, at(DAY));
  });
});

describe("valid-time — hasDisjointValidityWindows / combineValidTimeForMerge (pure, Test 13 §12)", () => {
  it("both sides silent (no known bounds at all) -> never disjoint", () => {
    assert.equal(hasDisjointValidityWindows({}, {}), false);
    assert.equal(hasDisjointValidityWindows({ validFrom: 0, validUntil: 0 }, { validFrom: 0, validUntil: 0 }), false);
  });

  it("disjoint known windows (A ends before B starts) -> true, blocked", () => {
    const a = { validFrom: at(-2 * DAY), validUntil: at(-DAY) };
    const b = { validFrom: at(0), validUntil: 0 };
    assert.equal(hasDisjointValidityWindows(a, b), true);
    assert.equal(hasDisjointValidityWindows(b, a), true, "must be symmetric regardless of argument order");
  });

  it("overlapping known windows -> not disjoint", () => {
    const a = { validFrom: at(-2 * DAY), validUntil: at(DAY) };
    const b = { validFrom: at(-DAY), validUntil: at(2 * DAY) };
    assert.equal(hasDisjointValidityWindows(a, b), false);
  });

  it("one side unknown, other known -> not disjoint (silence is not evidence of disjointness)", () => {
    const a = { validFrom: 0, validUntil: 0 };
    const b = { validFrom: at(0), validUntil: at(DAY) };
    assert.equal(hasDisjointValidityWindows(a, b), false);
  });

  it("combineValidTimeForMerge preserves an unknown/open direction instead of narrowing it", () => {
    const cases = [
      {
        name: "known lower/open upper plus fully bounded",
        a: { validFrom: Date.parse("2025-01-01"), validUntil: 0 },
        b: { validFrom: Date.parse("2025-02-01"), validUntil: Date.parse("2025-06-01") },
        want: { validFrom: Date.parse("2025-01-01"), validUntil: 0 },
      },
      {
        name: "unknown lower/known upper plus fully bounded",
        a: { validFrom: 0, validUntil: Date.parse("2025-06-01") },
        b: { validFrom: Date.parse("2025-02-01"), validUntil: Date.parse("2025-07-01") },
        want: { validFrom: 0, validUntil: Date.parse("2025-07-01") },
      },
      {
        name: "BigInt bounds use the same conservative contract",
        a: { validFrom: BigInt(Date.parse("2025-01-01")), validUntil: 0n },
        b: { validFrom: BigInt(Date.parse("2025-02-01")), validUntil: BigInt(Date.parse("2025-06-01")) },
        want: { validFrom: Date.parse("2025-01-01"), validUntil: 0 },
      },
    ];
    for (const testCase of cases) {
      assert.deepEqual(combineValidTimeForMerge(testCase.a, testCase.b), testCase.want, testCase.name);
    }
  });

  it("combineValidTimeForMerge with one side fully unknown keeps both directions unknown", () => {
    const a = { validFrom: 0, validUntil: 0 };
    const b = { validFrom: at(-DAY), validUntil: at(DAY) };
    const combined = combineValidTimeForMerge(a, b);
    assert.equal(combined.validFrom, 0);
    assert.equal(combined.validUntil, 0);
  });

  it("combineValidTimeForMerge with both sides fully unknown resolves to 0/0", () => {
    const combined = combineValidTimeForMerge({}, {});
    assert.equal(combined.validFrom, 0);
    assert.equal(combined.validUntil, 0);
  });
});

describe("valid-time — lib/jobs/memory-compaction.js (§8b, real runMemoryCompaction path, Test 14 §12)", () => {
  function makeDbTable(rows) {
    const archived = new Set();
    const added = [];
    return {
      query: () => ({ limit: () => ({ toArray: async () => rows }) }),
      update: async ({ where, values }) => {
        const m = where.match(/id = '([0-9a-f-]{36})'/i);
        const id = m ? m[1] : where;
        if (values.status === "archived") archived.add(id);
      },
      add: async (items) => { for (const item of items) added.push(item); },
      _archived: archived,
      _added: added,
    };
  }

  it("Test 14: compaction candidate loading carries validFrom/validUntil and blocks a disjoint merge before clustering", async () => {
    const keepId = "9d2f6a10-1111-4a11-8a11-111111111111";
    const memId = "9d2f6a10-2222-4a11-8a11-222222222222";
    // Textually compatible (mem's text is a substring of keep's), high
    // cosine similarity (identical vectors) -> would cluster and attempt an
    // LLM merge, EXCEPT the two rows have known, disjoint validity windows
    // (mem's validUntil <= keep's validFrom) — this must redirect to the
    // existing mark_redundant action, never a merge action.
    const rows = [
      { id: keepId, text: "works at Firma B in the platform team full time", vector: [1, 0, 0], createdAt: Date.now(), importance: 0.5, category: "other", origin: "dm", storedBy: "", confirmed: false, epistemicStatus: "", validFrom: 2_000_000, validUntil: 0 },
      { id: memId, text: "works at Firma B in the platform team", vector: [1, 0, 0], createdAt: Date.now() - 1000, importance: 0.5, category: "other", origin: "dm", storedBy: "", confirmed: false, epistemicStatus: "", validFrom: 0, validUntil: 1_000_000 },
    ];
    const table = makeDbTable(rows);
    const workspaceDir = tmpRoot("plur1bus-compaction-validtime-");
    const result = await runMemoryCompaction(
      { table },
      { similarityThreshold: 0.5, lookbackDays: 30, maxBatchSize: 50, dryRun: false, autoApply: false, logger: { info() {}, warn() {} }, workspaceDir },
    );
    assert.equal(result.compacted, 1, "one action generated for the one similarity cluster");
    assert.equal(result.merged, 0, "must never become a merge action");
    assert.equal(result.proposals, 1, "mark_redundant is not low-risk auto-apply, so it is persisted as a proposal");

    const proposalPath = join(workspaceDir, ".adaptive-learning", "merge-proposals.jsonl");
    const lines = readFileSync(proposalPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.actions.length, 1);
    assert.equal(entry.actions[0].type, "mark_redundant");
    assert.equal(entry.actions[0].reason, "compatible_text_disjoint_validity_window");
  });

  it("auto-apply does not archive identical text when validity windows are disjoint", async () => {
    const newerId = "8d2f6a10-1111-4a11-8a11-111111111111";
    const olderId = "8d2f6a10-2222-4a11-8a11-222222222222";
    const rows = [
      {
        id: newerId, text: "same historical assignment", vector: [1, 0, 0], createdAt: Date.now(),
        importance: 0.5, category: "fact", origin: "dm", validFrom: 2_000_000, validUntil: 3_000_000,
      },
      {
        id: olderId, text: "same historical assignment", vector: [1, 0, 0], createdAt: Date.now() - 1000,
        importance: 0.5, category: "fact", origin: "dm", validFrom: 500_000, validUntil: 1_000_000,
      },
    ];
    const table = makeDbTable(rows);
    const result = await runMemoryCompaction(
      { table },
      {
        similarityThreshold: 0.5, lookbackDays: 30, maxBatchSize: 50,
        dryRun: false, autoApply: true, logger: { info() {}, warn() {} },
        workspaceDir: tmpRoot("plur1bus-compaction-identical-disjoint-"),
      },
    );
    assert.equal(result.deleted, 0);
    assert.equal(result.executed, 0);
    assert.deepEqual([...table._archived], []);
  });
});

// ─── Test 22 (§12): memory_recall validAt param -> runRecallPipeline (§5d) ─
//
// index.js's `memory_recall` tool handler lives inside an `api.registerTool`
// closure and is not exported — this is the same pre-existing testability
// gap Phase 1's own report documented for the memory_store tool handler
// (tests/epistemic-status.test.js's "Requirement 3" describe block, ~line
// 804-828: "no test in this repo instantiates the full plugin to call any
// command/tool handler"). What IS verified here, exercising the real,
// exported normalizeCapturedTimestamp on the EXACT expression index.js uses
// at its `_recallBaseParams.validAt` construction (index.js, memory_recall
// tool, ~line 7841-7845):
//
//   validAt: (() => {
//     const v = normalizeCapturedTimestamp(params.validAt);
//     return v === 0 ? null : v;
//   })(),
//
// — an omitted/unparseable params.validAt must produce `null` (zero
// filtering), never `0` (which isEntryValidAt would treat as "epoch start",
// not "no query") and never a guessed "now". The downstream wiring
// (`_recallBaseParams` spread first into `runMergedNamespaceRecall`'s
// `baseParams`, then into `runRecallPipeline({...baseParams, ...})` at
// index.js ~line 786 — `validAt` is never among the fields runMergedNamespaceRecall
// overrides) is verified by code reading, matching the Phase-1 precedent
// for this exact class of gap.
describe("valid-time — Test 22 (§12): memory_recall's validAt normalization, exact index.js expression", () => {
  function recallBaseParamsValidAt(rawParamsValidAt) {
    // Mirrors index.js's _recallBaseParams.validAt construction verbatim.
    const v = normalizeCapturedTimestamp(rawParamsValidAt);
    return v === 0 ? null : v;
  }

  it("an omitted validAt param produces null, not 0 and not now", () => {
    assert.equal(recallBaseParamsValidAt(undefined), null);
  });

  it("an unparseable validAt param produces null, never a guessed date", () => {
    assert.equal(recallBaseParamsValidAt("last week sometime"), null);
  });

  it("a real ISO date string produces the correct ms-epoch value", () => {
    assert.equal(recallBaseParamsValidAt("2025-06-01"), Date.parse("2025-06-01"));
  });
});

// ─── Test 23 (§12): valid-from/valid-until prompt attributes (§9 labeling) ─

describe("valid-time — Test 23 (§12): formatRelevantMemoriesContext valid-from/valid-until attributes (real path)", () => {
  it("renders LanceDB Int64 BigInt bounds safely and treats 0n as absent", () => {
    const out = formatRelevantMemoriesContext([
      {
        id: "bigint-bounds", category: "work", source: "dm", display: "bounded history", memoryStrength: 1,
        validFrom: BigInt(Date.parse("2025-01-01T00:00:00.000Z")),
        validUntil: BigInt(Date.parse("2025-06-01T00:00:00.000Z")),
      },
      {
        id: "bigint-open", category: "work", source: "dm", display: "open history", memoryStrength: 1,
        validFrom: 0n, validUntil: 0n,
      },
    ]);
    assert.match(out, /id="bigint-bounds"[^>]*valid-from="2025-01-01T00:00:00\.000Z"/);
    assert.match(out, /id="bigint-bounds"[^>]*valid-until="2025-06-01T00:00:00\.000Z"/);
    assert.doesNotMatch(out, /id="bigint-open"[^>]*valid-(?:from|until)=/);
  });

  it("renders valid-until only when known; omits it entirely for validUntil: 0", () => {
    const withKnown = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0, validUntil: at(-DAY) },
    ]);
    assert.match(withKnown, /valid-until="[\d-]+T[\d:.]+Z"/, "a memory with a known validUntil must render the attribute");

    const withUnknown = formatRelevantMemoriesContext([
      { id: "2", category: "work", source: "dm", display: "hello", memoryStrength: 1.0, validUntil: 0 },
    ]);
    assert.ok(!withUnknown.includes("valid-until="), "a memory with validUntil: 0 (unknown/open) must omit the attribute entirely");
  });

  it("renders valid-from only when known; omits it for validFrom: 0", () => {
    const withKnown = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0, validFrom: at(-DAY) },
    ]);
    assert.match(withKnown, /valid-from="[\d-]+T[\d:.]+Z"/);

    const withUnknown = formatRelevantMemoriesContext([
      { id: "2", category: "work", source: "dm", display: "hello", memoryStrength: 1.0, validFrom: 0 },
    ]);
    assert.ok(!withUnknown.includes("valid-from="));
  });

  it("reads validFrom/validUntil from the raw memory object m, not from buildTemporalProvenance's output (structural separation, §9)", () => {
    // A memory with a known validUntil but an otherwise ordinary System-Time
    // provenance (createdAt just now, not stale) must still render
    // valid-until — proving the attribute is NOT derived from freshness/age.
    const out = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0, createdAt: FIXED_NOW, validUntil: at(-DAY) },
    ], { now: FIXED_NOW });
    assert.match(out, /valid-until=/, "validUntil must render even when System-Time freshness shows the record as fresh, not stale");
  });

  it("renders both attributes together when both bounds are known", () => {
    const out = formatRelevantMemoriesContext([
      { id: "1", category: "work", source: "dm", display: "hello", memoryStrength: 1.0, validFrom: at(-2 * DAY), validUntil: at(-DAY) },
    ]);
    assert.match(out, /valid-from="[\d-]+T[\d:.]+Z"/);
    assert.match(out, /valid-until="[\d-]+T[\d:.]+Z"/);
  });
});

// ─── lib/db-adapter.js (§6d-style, real projection/migration paths) ───────

describe("valid-time — lib/db-adapter.js migration + rowToCard (real paths)", () => {
  function schemaOf(fieldNames) {
    return async () => ({ fields: fieldNames.map((name) => ({ name })) });
  }

  it("_ensureValidTimeColumns adds both columns when missing, is idempotent", async () => {
    const addedColumns = [];
    const mockTableSchema = {
      schema: schemaOf(["id", "text", "vector", "status"]),
      async addColumns(cols) { for (const col of cols) addedColumns.push(col.name); },
    };
    const adapter = createDbAdapter({ basePath: "/tmp/test-validtime-db", getTable: async () => mockTableSchema, logger: { info() {}, warn() {} } });
    await adapter._ensureValidTimeColumns("agent-a", mockTableSchema);
    for (const name of ["validFrom", "validUntil"]) {
      assert.ok(addedColumns.includes(name), `${name} should be added`);
    }

    const addedColumns2 = [];
    const mockTableSchema2 = {
      schema: schemaOf(["id", "text", "validFrom", "validUntil"]),
      async addColumns(cols) { for (const col of cols) addedColumns2.push(col.name); },
    };
    const adapter2 = createDbAdapter({ basePath: "/tmp/test-validtime-db-2", getTable: async () => mockTableSchema2, logger: { info() {}, warn() {} } });
    await adapter2._ensureValidTimeColumns("agent-a", mockTableSchema2);
    assert.strictEqual(addedColumns2.length, 0, "no columns should be added when already present");
  });

  it("getCard (rowToCard) carries validFrom/validUntil through so a human-review surface can see the window", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const rows = [{ id, text: "t", summary: "s", status: "active", validFrom: at(-DAY), validUntil: at(DAY), createdAt: Date.now() }];
    const table = { query() { return { where() { return { limit() { return { async toArray() { return rows; } }; } }; } }; } };
    const adapter = createDbAdapter({ basePath: "/tmp/test-validtime-getcard", getTable: async () => table, logger: { info() {}, warn() {} } });
    const card = await adapter.getCard("agent-a", id);
    assert.equal(card.validFrom, at(-DAY));
    assert.equal(card.validUntil, at(DAY));
  });

  it("getCard (rowToCard) defaults validFrom/validUntil to 0 for a legacy row with no such columns", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const rows = [{ id, text: "t", summary: "s", status: "active", createdAt: Date.now() }];
    const table = { query() { return { where() { return { limit() { return { async toArray() { return rows; } }; } }; } }; } };
    const adapter = createDbAdapter({ basePath: "/tmp/test-validtime-getcard-legacy", getTable: async () => table, logger: { info() {}, warn() {} } });
    const card = await adapter.getCard("agent-a", id);
    assert.equal(card.validFrom, 0);
    assert.equal(card.validUntil, 0);
  });
});

describe("valid-time — index.js MemoryDB.findMergeCandidate (real projection path, §8a)", () => {
  it("carries validFrom/validUntil through the merge-candidate projection", async () => {
    const db = trackMemoryDb(new MemoryDB("/tmp/fake-validtime-mergecandidate", 4));
    db.init = async () => true;
    db.table = {
      async countRows() { return 1; },
      vectorSearch() {
        return {
          where() {
            return {
              limit() {
                return {
                  async toArray() {
                    return [{ id: "a", text: "candidate text", importance: 0.5, validFrom: at(-DAY), validUntil: at(DAY), _distance: 0.1 }];
                  },
                };
              },
            };
          },
          limit() {
            return { async toArray() { return [{ id: "a", text: "candidate text", importance: 0.5, validFrom: at(-DAY), validUntil: at(DAY), _distance: 0.1 }]; } };
          },
        };
      },
    };
    const candidate = await db.findMergeCandidate([1, 0, 0, 0], 0, 1);
    assert.ok(candidate, "a candidate should be found");
    assert.equal(candidate.entry.validFrom, at(-DAY));
    assert.equal(candidate.entry.validUntil, at(DAY));
  });
});

describe("valid-time — index.js normalizeEntryForTable defaults + applyValidTimeCloseToLanceDb adapter (real paths, step 3)", () => {
  const CLOSE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("normalizeEntryForTable defaults validFrom/validUntil to 0 when absent, preserves explicit values", async () => {
    const db = trackMemoryDb(new MemoryDB("/tmp/fake-validtime-normalize", 4));
    const withDefaults = db.normalizeEntryForTable({ id: "a", text: "t" });
    assert.equal(withDefaults.validFrom, 0);
    assert.equal(withDefaults.validUntil, 0);
    const withExplicit = db.normalizeEntryForTable({ id: "b", text: "t", validFrom: at(-DAY), validUntil: at(DAY) });
    assert.equal(withExplicit.validFrom, at(-DAY));
    assert.equal(withExplicit.validUntil, at(DAY));
  });

  it("applyValidTimeCloseToLanceDb persists the close patch and writes the destructive-op audit log", async () => {
    const workspaceDir = tmpRoot("plur1bus-validtime-audit-");
    const updateCalls = [];
    const db = {
      async getById(id) {
        return {
          id, agentId: "agent-a", storedBy: "agent-a", scope: "agent-private",
          validFrom: BigInt(at(-2 * DAY)), validUntil: BigInt(at(-DAY)),
        };
      },
      async update(id, patch) { updateCalls.push([id, patch]); },
    };
    const result = await applyValidTimeCloseToLanceDb(db, CLOSE_ID, "2026-08-11T00:00:00.000Z", {
      ctx: { agentId: "agent-a", userPrincipal: "" },
      actor: "agent-a-user",
      reason: "superseded by Firma B",
      workspaceDir,
    });
    assert.equal(result.ok, true);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0][1].validUntil, Date.parse("2026-08-11T00:00:00.000Z"));

    const logPath = join(workspaceDir, ".adaptive-learning", "destructive-ops.jsonl");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.operation, "validity_close");
    assert.equal(entry.memoryId, CLOSE_ID);
    assert.equal(entry.previousValidUntil, at(-DAY), "the BigInt prior bound must be present as JSON-safe epoch milliseconds");
    assert.equal(entry.newValidUntil, Date.parse("2026-08-11T00:00:00.000Z"));
  });

  it("applyValidTimeCloseToLanceDb rejects a cross-agent close (fail-closed via checkAccess)", async () => {
    const updateCalls = [];
    const db = {
      async getById(id) { return { id, agentId: "agent-a", storedBy: "agent-a", scope: "agent-private", validFrom: 0 }; },
      async update(id, patch) { updateCalls.push([id, patch]); },
    };
    const result = await applyValidTimeCloseToLanceDb(db, CLOSE_ID, "2026-08-11", {
      ctx: { agentId: "agent-b" },
      actor: "agent-b-user",
      reason: "should not be allowed",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /acl\./);
    assert.equal(updateCalls.length, 0);
  });

  it("applyValidTimeCloseToLanceDb refuses an unknown boundary through the real adapter path (Test 4 §12, real path variant)", async () => {
    const db = {
      async getById(id) { return { id, agentId: "agent-a", storedBy: "agent-a", scope: "agent-private", validFrom: 0 }; },
      async update() { throw new Error("must not be called"); },
    };
    await assert.rejects(
      () => applyValidTimeCloseToLanceDb(db, CLOSE_ID, undefined, { ctx: { agentId: "agent-a" }, actor: "agent-a-user" }),
      /refuse to close with an unknown boundary/,
    );
  });

  it("applyValidTimeCloseToLanceDb rejects an invalid id before touching the database", async () => {
    let dbCalls = 0;
    const db = {
      async getById() { dbCalls++; return null; },
      async update() { dbCalls++; },
    };
    await assert.rejects(
      () => applyValidTimeCloseToLanceDb(db, "not-a-uuid", "2026-08-11", {
        ctx: { agentId: "agent-a" }, actor: "agent-a-user",
      }),
      /Invalid memory ID format/,
    );
    assert.equal(dbCalls, 0);
  });
});

// ─── lib/recall-pipeline.js — real runRecallPipeline path (step 4) ────────

function memoryCtx(overrides = {}) {
  return {
    agentId: "agent-a",
    workspaceIdentity: "workspace:v1:workspace-a",
    userPrincipal: "user:v1:" + "a".repeat(64),
    workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
    ...overrides,
  };
}

function scopedRow(id, text, ownership = {}) {
  return {
    id, text, summary: "", category: "fact", origin: "dm", status: "active",
    importance: 0.5, memoryStrength: 1, _distance: 0.1,
    validFrom: 0, validUntil: 0,
    ...ownership,
  };
}

describe("valid-time — runRecallPipeline (real path, §0 bi-temporal history, Tests 1-3 §12)", () => {
  it("handles projected LanceDB BigInt sentinels and bounds on the real recall path", async () => {
    const validAt = Date.parse("2025-06-01T00:00:00.000Z");
    const openRow = makeHarnessRow({
      id: "bigint-open-row",
      text: "open BigInt history",
      distance: 0.1,
      agentId: "agent-a",
      validFrom: 0n,
      validUntil: 0n,
    });
    const closedRow = makeHarnessRow({
      id: "bigint-closed-row",
      text: "closed BigInt history",
      distance: 0.2,
      agentId: "agent-a",
      validFrom: 0n,
      validUntil: BigInt(validAt),
    });

    const result = await runRecallPipelineRaw({
      agentId: "agent-a",
      query: "BigInt history",
      dbTable: mockTable([openRow, closedRow]),
      embeddings: makeEmbeddings(),
      topN: 2,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      logger: { warn() {}, info() {} },
      validAt,
    });

    assert.deepEqual(result.memories.map((memory) => memory.entry.id), ["bigint-open-row"]);
  });

  it("validAt owns valid-time filtering and skips the legacy createdAt year filter", async () => {
    const row = makeHarnessRow({
      id: "historical-created-later",
      text: "worked at Firma A during 2025",
      distance: 0.1,
      agentId: "agent-a",
      status: "active",
      createdAt: Date.parse("2026-08-01T00:00:00.000Z"),
      validFrom: Date.parse("2025-01-01T00:00:00.000Z"),
      validUntil: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const result = await runRecallPipelineRaw({
      agentId: "agent-a",
      query: "Where did they work in 2025?",
      dbTable: mockTable([row]),
      embeddings: makeEmbeddings(),
      topN: 5,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      logger: { warn() {}, info() {} },
      validAt: Date.parse("2025-06-01T00:00:00.000Z"),
    });
    assert.deepEqual(result.memories.map((memory) => memory.entry.id), ["historical-created-later"]);
  });

  it("validAt oversamples ANN candidates before filtering so nearer invalid rows cannot starve history", async () => {
    const validAt = Date.parse("2025-06-01T00:00:00.000Z");
    const rows = [
      ...Array.from({ length: 3 }, (_, index) => makeHarnessRow({
        id: `near-invalid-${index}`,
        text: `near invalid ${index}`,
        distance: 0.01 + index * 0.01,
        agentId: "agent-a",
        validFrom: Date.parse("2026-01-01T00:00:00.000Z"),
        validUntil: 0,
      })),
      makeHarnessRow({
        id: "far-valid-history",
        text: "far valid history",
        distance: 0.2,
        agentId: "agent-a",
        validFrom: Date.parse("2025-01-01T00:00:00.000Z"),
        validUntil: Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    ];
    let requestedLimit = 0;
    const table = {
      vectorSearch() {
        return {
          limit(limit) {
            requestedLimit = limit;
            return { async toArray() { return rows.slice(0, limit); } };
          },
        };
      },
    };
    const result = await runRecallPipelineRaw({
      agentId: "agent-a",
      query: "history",
      dbTable: table,
      embeddings: makeEmbeddings(),
      topN: 1,
      candidateTopK: 2,
      candidateHardLimit: 5,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      logger: { warn() {}, info() {} },
      validAt,
    });
    assert.equal(requestedLimit, 5, "historical recall should fetch up to the existing candidate hard cap");
    assert.deepEqual(result.memories.map((memory) => memory.entry.id), ["far-valid-history"]);
  });

  it("pushes validAt filtering into vector search before the hard limit", async () => {
    const validAt = Date.parse("2025-06-01T00:00:00.000Z");
    const invalidRows = Array.from({ length: 101 }, (_, index) => makeHarnessRow({
      id: `closer-invalid-${index}`,
      text: `closer invalid ${index}`,
      distance: index / 1000,
      agentId: "agent-a",
      validFrom: Date.parse("2026-01-01T00:00:00.000Z"),
      validUntil: 0,
    }));
    const validRow = makeHarnessRow({
      id: "valid-after-one-hundred",
      text: "valid historical row",
      distance: 0.2,
      agentId: "agent-a",
      validFrom: Date.parse("2025-01-01T00:00:00.000Z"),
      validUntil: Date.parse("2026-01-01T00:00:00.000Z"),
    });
    const legacyRow = makeHarnessRow({
      id: "legacy-after-one-hundred",
      text: "legacy unknown window",
      distance: 0.21,
      agentId: "agent-a",
      validFrom: 0,
      validUntil: 0,
    });
    const rows = [...invalidRows, validRow, legacyRow];
    let appliedPredicate = "";
    const table = {
      vectorSearch() {
        let selected = rows;
        return {
          where(predicate) {
            appliedPredicate = predicate;
            selected = [validRow, legacyRow];
            return this;
          },
          limit(limit) {
            return { async toArray() { return selected.slice(0, limit); } };
          },
        };
      },
    };
    const result = await runRecallPipelineRaw({
      agentId: "agent-a",
      query: "historical row",
      dbTable: table,
      embeddings: makeEmbeddings(),
      topN: 2,
      candidateTopK: 2,
      candidateHardLimit: 100,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      logger: { warn() {}, info() {} },
      validAt,
    });
    assert.equal(
      appliedPredicate,
      `(validFrom = 0 OR validFrom <= ${validAt}) AND (validUntil = 0 OR validUntil > ${validAt})`,
    );
    assert.deepEqual(
      result.memories.map((memory) => memory.entry.id),
      ["valid-after-one-hundred", "legacy-after-one-hundred"],
    );
  });

  it("retries a legacy vector search exactly once without valid-time columns", async () => {
    const legacyRow = makeHarnessRow({
      id: "legacy-schema-row",
      text: "legacy schema memory",
      distance: 0.1,
      agentId: "agent-a",
    });
    delete legacyRow.validFrom;
    delete legacyRow.validUntil;
    let vectorSearchCalls = 0;
    let predicateCalls = 0;
    const table = {
      vectorSearch() {
        vectorSearchCalls += 1;
        return {
          where() {
            predicateCalls += 1;
            return {
              limit() {
                return {
                  async toArray() {
                    const error = new Error(
                      'Failed to execute query stream: GenericFailure, lance error: LanceError(Schema): Schema error: No field named "validFrom". Valid fields are id, text',
                    );
                    error.code = "GenericFailure";
                    throw error;
                  },
                };
              },
            };
          },
          limit() {
            return { async toArray() { return [legacyRow]; } };
          },
        };
      },
    };

    const result = await runRecallPipelineRaw({
      agentId: "agent-a",
      query: "legacy",
      dbTable: table,
      embeddings: makeEmbeddings(),
      topN: 1,
      recallMinScore: 0,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
      logger: { warn() {}, info() {} },
      validAt: Date.parse("2025-06-01T00:00:00.000Z"),
    });

    assert.deepEqual(result.memories.map((memory) => memory.entry.id), ["legacy-schema-row"]);
    assert.equal(predicateCalls, 1);
    assert.equal(vectorSearchCalls, 2);
  });

  it("does not retry a valid-time vector predicate after an unrelated read error", async () => {
    let vectorSearchCalls = 0;
    const table = {
      vectorSearch() {
        vectorSearchCalls += 1;
        return {
          where() {
            return {
              limit() {
                return {
                  async toArray() {
                    throw new Error("storage unavailable");
                  },
                };
              },
            };
          },
        };
      },
    };

    await assert.rejects(
      runRecallPipelineRaw({
        agentId: "agent-a",
        query: "legacy",
        dbTable: table,
        embeddings: makeEmbeddings(),
        topN: 1,
        recallMinScore: 0,
        importanceBoost: 0,
        canonicalEnabled: false,
        associativeEnabled: false,
        dedupEnabled: false,
        logger: { warn() {}, info() {} },
        validAt: Date.parse("2025-06-01T00:00:00.000Z"),
      }),
      /storage unavailable/,
    );
    assert.equal(vectorSearchCalls, 1);
  });

  it("does not treat generic valid-time predicate failures as missing legacy columns", async () => {
    for (const message of [
      "failed evaluating validFrom column",
      "invalid validFrom field predicate",
    ]) {
      let vectorSearchCalls = 0;
      const table = {
        vectorSearch() {
          vectorSearchCalls += 1;
          return {
            where() {
              return {
                limit() {
                  return { async toArray() { throw new Error(message); } };
                },
              };
            },
            limit() {
              return { async toArray() { return []; } };
            },
          };
        },
      };

      await assert.rejects(
        runRecallPipelineRaw({
          agentId: "agent-a",
          query: "legacy",
          dbTable: table,
          embeddings: makeEmbeddings(),
          topN: 1,
          recallMinScore: 0,
          importanceBoost: 0,
          canonicalEnabled: false,
          associativeEnabled: false,
          dedupEnabled: false,
          logger: { warn() {}, info() {} },
          validAt: Date.parse("2025-06-01T00:00:00.000Z"),
        }),
        new RegExp(message),
      );
      assert.equal(vectorSearchCalls, 1, `must not retry after: ${message}`);
    }
  });

  it("Test 1: current query (validAt=now) returns the current version", async () => {
    const rows = [
      makeHarnessRow({ id: "firma-a", text: "arbeitet bei Firma", distance: 0.1, agentId: "agent-a", status: "active", validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2026-06-30") }),
      makeHarnessRow({ id: "firma-b", text: "arbeitet bei Firma", distance: 0.1, agentId: "agent-a", status: "active", validFrom: Date.parse("2026-07-01"), validUntil: 0 }),
    ];
    const result = await runRecallPipelineRaw({
      agentId: "agent-a", query: "arbeitet bei Firma", dbTable: mockTable(rows), embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} }, validAt: FIXED_NOW,
    });
    assert.deepEqual(result.memories.map((m) => m.entry.id), ["firma-b"], "only the current version (B) should be returned");
  });

  it("Test 2: historical query (validAt=past) returns the historical version — §0's decision holds (both rows status:active)", async () => {
    const rows = [
      makeHarnessRow({ id: "firma-a", text: "arbeitet bei Firma", distance: 0.1, agentId: "agent-a", status: "active", validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2026-06-30") }),
      makeHarnessRow({ id: "firma-b", text: "arbeitet bei Firma", distance: 0.1, agentId: "agent-a", status: "active", validFrom: Date.parse("2026-07-01"), validUntil: 0 }),
    ];
    assert.equal(rows[0].status, "active", "A must stay active, not superseded (§0)");
    assert.equal(rows[1].status, "active", "B must stay active, not superseded (§0)");
    const result = await runRecallPipelineRaw({
      agentId: "agent-a", query: "arbeitet bei Firma", dbTable: mockTable(rows), embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} }, validAt: Date.parse("2025-06-01"),
    });
    assert.deepEqual(result.memories.map((m) => m.entry.id), ["firma-a"], "a historical query must return the historically-valid row, not the successor");
  });

  it("Test 3: storing a new fact does not destroy the old row — both remain queryable at their respective validAt windows", async () => {
    const rows = [
      makeHarnessRow({ id: "firma-a", text: "arbeitet bei Firma", distance: 0.1, agentId: "agent-a", status: "active", validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2026-06-30") }),
      makeHarnessRow({ id: "firma-b", text: "arbeitet bei Firma", distance: 0.1, agentId: "agent-a", status: "active", validFrom: Date.parse("2026-07-01"), validUntil: 0 }),
    ];
    const table = mockTable(rows);
    const base = { agentId: "agent-a", query: "arbeitet bei Firma", dbTable: table, embeddings: makeEmbeddings(), topN: 5, recallMinScore: 0, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false, logger: { warn() {}, info() {} } };
    const past = await runRecallPipelineRaw({ ...base, validAt: Date.parse("2025-06-01") });
    const current = await runRecallPipelineRaw({ ...base, validAt: FIXED_NOW });
    assert.deepEqual(past.memories.map((m) => m.entry.id), ["firma-a"]);
    assert.deepEqual(current.memories.map((m) => m.entry.id), ["firma-b"]);
    assert.equal(rows.length, 2, "the underlying table still holds both rows — nothing was deleted by either query");
  });
});

describe("valid-time — trust x time orthogonality (§6, Test 10)", () => {
  it("Test 10: historical trusted does not outrank current observed once validUntil is known", async () => {
    const rows = [
      makeHarnessRow({ id: "a-trusted-historical", text: "shared content variant", distance: 0.3, agentId: "agent-a", epistemicStatus: "trusted", validFrom: 0, validUntil: at(-DAY) }),
      makeHarnessRow({ id: "b-observed-current", text: "shared content variant", distance: 0.3, agentId: "agent-a", epistemicStatus: "observed", validFrom: at(-DAY), validUntil: 0 }),
    ];
    const result = await runRecallPipelineRaw({
      agentId: "agent-a", query: "shared content variant", dbTable: mockTable(rows), embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} }, validAt: FIXED_NOW,
    });
    assert.deepEqual(result.memories.map((m) => m.entry.id), ["b-observed-current"], "A's +0.25 trust boost never runs — A is excluded at the hard validAt filter before scoring");
  });
});

describe("valid-time — isRecallEntryLive independent exclusion reasons (Tests 11-12, 19 §12)", () => {
  it("Test 11: invalidated is not the same as historically closed — independent, separately-triggerable exclusion reasons", () => {
    const closed = projectRecallEntry(makeHarnessRow({ id: "closed", text: "x", agentId: "agent-a", status: "active", epistemicStatus: "", validFrom: 0, validUntil: at(-DAY) }));
    const invalidated = projectRecallEntry(makeHarnessRow({ id: "invalidated", text: "y", agentId: "agent-a", status: "active", epistemicStatus: "invalidated", validFrom: 0, validUntil: 0 }));
    assert.equal(isRecallEntryLive(closed, FIXED_NOW, null), true, "without a validAt query, a historically-closed row is still live");
    assert.equal(isRecallEntryLive(closed, FIXED_NOW, FIXED_NOW), false, "with validAt, a historically-closed row is excluded");
    assert.equal(isRecallEntryLive(invalidated, FIXED_NOW, null), false, "invalidated is excluded even without a validAt query at all");
    assert.equal(isRecallEntryLive(invalidated, FIXED_NOW, FIXED_NOW), false, "invalidated stays excluded with validAt too");
  });

  it("Test 12: expiresAt (TTL) and validUntil are independent axes", () => {
    const ttlExpired = projectRecallEntry(makeHarnessRow({ id: "ttl-expired", text: "x", agentId: "agent-a", validUntil: at(1000 * DAY), expiresAt: at(-DAY) }));
    assert.equal(isRecallEntryLive(ttlExpired, FIXED_NOW, null), false, "a TTL-expired row must be excluded even without any validAt query");

    const historicallyClosed = projectRecallEntry(makeHarnessRow({ id: "historically-closed", text: "y", agentId: "agent-a", validUntil: at(-DAY), expiresAt: 0 }));
    assert.equal(isRecallEntryLive(historicallyClosed, FIXED_NOW, null), true, "default recall (no validAt) must not exclude a historically-closed-but-not-expired row");
    assert.equal(isRecallEntryLive(historicallyClosed, FIXED_NOW, FIXED_NOW), false, "validAt=now must exclude a row whose validity window closed in the past");
  });

  it("Test 19: legacy rows (validFrom=validUntil=0) are never excluded by validAt, real runRecallPipeline path", async () => {
    const legacy = makeHarnessRow({ id: "legacy", text: "legacy fact about topic", agentId: "agent-a" });
    const result = await runRecallPipelineRaw({
      agentId: "agent-a", query: "legacy fact about topic", dbTable: mockTable([legacy]), embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} }, validAt: at(-10000 * DAY),
    });
    assert.deepEqual(result.memories.map((m) => m.entry.id), ["legacy"]);
  });
});

describe("valid-time — ACL orthogonality (§6, subtractive-only, Tests 16-18 §12)", () => {
  it("Test 16: cross-agent historical recall is blocked — ACL runs regardless of what validAt alone would decide", async () => {
    const foreign = scopedRow("foreign-1", "foreign historical fact", {
      scope: "agent-private", agentId: "agent-b", storedBy: "agent-b",
      validFrom: at(-2 * DAY), validUntil: at(-DAY),
    });
    const result = await runRecallPipelineRaw({
      memoryCtx: memoryCtx({ agentId: "agent-a" }),
      query: "foreign historical fact",
      dbTable: mockTable([foreign]),
      embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0,
      canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} },
      validAt: at(-1.5 * DAY), // inside the foreign row's validity window
    });
    assert.deepEqual(result.memories, [], "a foreign agent's row must be denied by ACL even when validAt would otherwise include it");
  });

  it("Test 17: cross-workspace historical recall is blocked", async () => {
    const foreign = scopedRow("foreign-ws-1", "foreign workspace historical fact", {
      scope: "workspace", workspaceId: "workspace:v1:workspace-b", workspaceKey: "workspace:v1:workspace-b",
      validFrom: at(-2 * DAY), validUntil: at(-DAY),
    });
    const result = await runRecallPipelineRaw({
      memoryCtx: memoryCtx({ agentId: "agent-a", workspaceIdentity: "workspace:v1:workspace-a" }),
      query: "foreign workspace historical fact",
      dbTable: mockTable([foreign]),
      embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0,
      canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} },
      validAt: at(-1.5 * DAY),
    });
    assert.deepEqual(result.memories, [], "cross-workspace ACL must still deny even when validAt matches the row's window");
  });

  it("Test 18: scope enforcement (agent-private) holds with validAt set, independent of whether validAt itself would include or exclude the row", async () => {
    const inWindow = scopedRow("agent-private-in-window", "secret fact", {
      scope: "agent-private", agentId: "agent-b", storedBy: "agent-b",
      validFrom: at(-2 * DAY), validUntil: 0,
    });
    const outOfWindow = scopedRow("agent-private-out-of-window", "secret fact old", {
      scope: "agent-private", agentId: "agent-b", storedBy: "agent-b",
      validFrom: at(-2 * DAY), validUntil: at(-DAY),
    });
    const result = await runRecallPipelineRaw({
      memoryCtx: memoryCtx({ agentId: "agent-a" }), // mismatched — neither row belongs to agent-a
      query: "secret fact",
      dbTable: mockTable([inWindow, outOfWindow]),
      embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0,
      canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} },
      validAt: FIXED_NOW,
    });
    assert.deepEqual(result.memories, [], "both rows must be denied by ACL regardless of what validAt alone would have decided for each");
  });
});

// ─── Test 21 (§12): all four graph liveness chokepoints, independently ────
// (lib/recall-pipeline.js: hydrateGraphResults' :878/:904/:956, and
// authorizeGraphEdges' endpoint gate). Each sub-test isolates exactly one
// site — a fixture that only that site's candidate can reach — per the
// task brief's explicit warning that Phase 1 missed a chokepoint here by
// treating one site as representative of all four.

const HYDRATION_ACL_CTX = Object.freeze({
  agentId: "agent-a",
  workspaceId: "",
  workspaceIdentity: "",
  userPrincipal: "",
  workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
});

describe("valid-time — Test 21 (§12): graph liveness chokepoints respect validAt independently", () => {
  it("Site :878 — hydrateGraphResults' early-return branch (graphOnly.length === 0) respects validAt", async () => {
    const liveEntry = projectRecallEntry(makeHarnessRow({ id: "vec-live", text: "t", agentId: "agent-a", validFrom: at(-DAY), validUntil: 0 }));
    const closedEntry = projectRecallEntry(makeHarnessRow({ id: "vec-closed", text: "t", agentId: "agent-a", validFrom: 0, validUntil: at(-DAY) }));
    const results = [
      { entry: liveEntry, score: 0.9, source: "vector" },
      { entry: closedEntry, score: 0.9, source: "vector" },
    ];
    // No candidate is source:"graph" with empty text/summary -> graphOnly.length === 0 -> takes the early-return branch at :878.
    const out = await hydrateGraphResults(mockTable([]), results, { warn() {}, info() {} }, {
      aclCtx: HYDRATION_ACL_CTX, now: FIXED_NOW, validAt: FIXED_NOW,
    });
    assert.deepEqual(out.map((r) => r.entry.id), ["vec-live"], "the historically-closed vector candidate must be excluded via the early-return branch's filterRecallCandidatesByLifecycle call");

    const outWithoutValidAt = await hydrateGraphResults(mockTable([]), results, { warn() {}, info() {} }, {
      aclCtx: HYDRATION_ACL_CTX, now: FIXED_NOW, validAt: null,
    });
    assert.ok(outWithoutValidAt.map((r) => r.entry.id).includes("vec-closed"), "sanity: without validAt, the same candidate is included — proves the :878 exclusion is specifically validAt-driven");
  });

  it("Site :904 — hydrateGraphResults' freshly-hydrated graph-only row respects validAt", async () => {
    const row = { id: "graph-hydrated", text: "hydrated text", summary: "", status: "active", agentId: "agent-a", scope: "agent-private", storedBy: "agent-a", validFrom: 0, validUntil: at(-DAY) };
    const results = [{ entry: { id: "graph-hydrated" }, score: 0.5, source: "graph", depth: 1 }];
    const out = await hydrateGraphResults(mockTable([], [row]), results, { warn() {}, info() {} }, {
      aclCtx: HYDRATION_ACL_CTX, now: FIXED_NOW, validAt: FIXED_NOW,
    });
    assert.deepEqual(out, [], "a graph-only candidate hydrated to a historically-closed row must be excluded at :904");

    const outWithoutValidAt = await hydrateGraphResults(mockTable([], [row]), results, { warn() {}, info() {} }, {
      aclCtx: HYDRATION_ACL_CTX, now: FIXED_NOW, validAt: null,
    });
    assert.equal(outWithoutValidAt.length, 1, "sanity: without validAt, the same freshly-hydrated row is included");
  });

  it("Site :956 — hydrateGraphResults' already-hydrated graph row (text/summary already present) respects validAt", async () => {
    const companionRow = { id: "companion", text: "companion text", summary: "", status: "active", agentId: "agent-a", scope: "agent-private", storedBy: "agent-a", validFrom: 0, validUntil: 0 };
    const alreadyHydratedEntry = projectRecallEntry(makeHarnessRow({ id: "graph-already", text: "already there", agentId: "agent-a", validFrom: 0, validUntil: at(-DAY) }));
    const results = [
      // graph-only companion forces graphOnly.length > 0, so the function
      // proceeds past the :878 early return into the per-item loop.
      { entry: { id: "companion" }, score: 0.5, source: "graph", depth: 1 },
      // already has text -> isGraphOnly === false -> takes the :956 else-branch,
      // never touches the DB for this item at all.
      { entry: alreadyHydratedEntry, score: 0.5, source: "graph", depth: 1 },
    ];
    const out = await hydrateGraphResults(mockTable([], [companionRow]), results, { warn() {}, info() {} }, {
      aclCtx: HYDRATION_ACL_CTX, now: FIXED_NOW, validAt: FIXED_NOW,
    });
    const ids = out.map((r) => r.entry.id);
    assert.ok(ids.includes("companion"), "companion graph-only candidate should hydrate fine and stay included");
    assert.ok(!ids.includes("graph-already"), "the already-hydrated candidate with a closed validity window must be excluded via the :956 branch, without a DB round-trip");

    const outWithoutValidAt = await hydrateGraphResults(mockTable([], [companionRow]), results, { warn() {}, info() {} }, {
      aclCtx: HYDRATION_ACL_CTX, now: FIXED_NOW, validAt: null,
    });
    assert.ok(outWithoutValidAt.map((r) => r.entry.id).includes("graph-already"), "sanity: without validAt, the same already-hydrated candidate is included");
  });

  it("Site :1268 — authorizeGraphEdges' endpoint gate respects validAt (real runRecallPipeline path, associative spread)", async () => {
    const ownerCtx = memoryCtx({ agentId: "agent-a" });
    const seed = makeHarnessRow({ id: "seed", text: "seed text", agentId: "agent-a", distance: 0.1 });
    const closedEndpoint = {
      id: "endpoint-closed", text: "endpoint text", summary: "", status: "active",
      agentId: "agent-a", scope: "agent-private", storedBy: "agent-a",
      importance: 0.5, memoryStrength: 1, createdAt: FIXED_NOW,
      validFrom: 0, validUntil: at(-DAY),
    };
    const graphEdges = [{ source: "seed", target: "endpoint-closed", type: "semantic", strength: 0.9, directed: false }];
    const baseOpts = {
      memoryCtx: ownerCtx,
      query: "seed text",
      dbTable: mockTable([seed], [seed, closedEndpoint]),
      embeddings: makeEmbeddings(),
      topN: 10, recallMinScore: 0, importanceBoost: 0,
      canonicalEnabled: false, associativeEnabled: true,
      graphEdges, graphConfig: { graphHydrationRelevanceThreshold: 0 },
      dedupEnabled: false,
      logger: { warn() {}, info() {} },
    };

    const excluded = await runRecallPipelineRaw({ ...baseOpts, validAt: FIXED_NOW });
    const excludedIds = excluded.memories.map((m) => m.entry.id);
    assert.ok(excludedIds.includes("seed"));
    assert.ok(!excludedIds.includes("endpoint-closed"), "the historically-closed graph endpoint must never be authorized for traversal at :1268");

    const included = await runRecallPipelineRaw({ ...baseOpts, validAt: null });
    const includedIds = included.memories.map((m) => m.entry.id);
    assert.ok(includedIds.includes("endpoint-closed"), "sanity: without validAt, the same endpoint is authorized and surfaces via associative spread");
  });
});

describe("valid-time — Test 20 (§12): runRecallPipeline without validAt is unaffected by turning validAt filtering on for an all-unknown-window fixture", () => {
  it("identical output with validAt omitted vs. validAt=now, when no row carries a known validFrom/validUntil", async () => {
    const rows = [
      makeHarnessRow({ id: "r1", text: "alpha fact about topic", distance: 0.1, agentId: "agent-a" }),
      makeHarnessRow({ id: "r2", text: "beta fact about topic", distance: 0.3, agentId: "agent-a" }),
    ];
    const base = { agentId: "agent-a", query: "alpha beta fact about topic", dbTable: mockTable(rows), embeddings: makeEmbeddings(), topN: 5, recallMinScore: 0, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false, logger: { warn() {}, info() {} } };
    const withoutValidAt = await runRecallPipelineRaw({ ...base });
    const withValidAtNow = await runRecallPipelineRaw({ ...base, validAt: FIXED_NOW });
    assert.deepEqual(
      withoutValidAt.memories.map((m) => ({ id: m.entry.id, score: m.score })),
      withValidAtNow.memories.map((m) => ({ id: m.entry.id, score: m.score })),
      "an all-unknown-validity fixture must produce identical output whether validAt filtering is on or off",
    );
  });
});

describe("valid-time — recall dedup preserves disjoint historical rows", () => {
  it("keeps identical text with disjoint known windows and renders both labeled IDs when validAt is absent", async () => {
    const rows = [
      makeHarnessRow({
        id: "historical-2024", text: "Alex worked at Firma A.", distance: 0.1, agentId: "agent-a",
        validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2025-01-01"),
      }),
      makeHarnessRow({
        id: "historical-2025", text: "Alex worked at Firma A.", distance: 0.2, agentId: "agent-a",
        validFrom: Date.parse("2025-01-01"), validUntil: Date.parse("2026-01-01"),
      }),
    ];
    const result = await runRecallPipelineRaw({
      agentId: "agent-a", query: "Firma A", dbTable: mockTable(rows), embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} },
    });
    assert.deepEqual(result.memories.map((item) => item.entry.id), ["historical-2024", "historical-2025"]);
    const context = formatRelevantMemoriesContext(result.memories.map(({ entry }) => ({
      id: entry.id,
      category: entry.category,
      source: entry.origin,
      display: entry.text,
      validFrom: entry.validFrom,
      validUntil: entry.validUntil,
    })));
    assert.match(context, /id="historical-2024"[^>]*valid-from="2024-01-01T00:00:00\.000Z"[^>]*valid-until="2025-01-01T00:00:00\.000Z"/);
    assert.match(context, /id="historical-2025"[^>]*valid-from="2025-01-01T00:00:00\.000Z"[^>]*valid-until="2026-01-01T00:00:00\.000Z"/);
  });

  it("continues to deduplicate identical text when known windows overlap", async () => {
    const rows = [
      makeHarnessRow({
        id: "overlap-a", text: "Alex worked at Firma A.", distance: 0.1, agentId: "agent-a",
        validFrom: Date.parse("2024-01-01"), validUntil: Date.parse("2025-07-01"),
      }),
      makeHarnessRow({
        id: "overlap-b", text: "Alex worked at Firma A.", distance: 0.2, agentId: "agent-a",
        validFrom: Date.parse("2025-01-01"), validUntil: Date.parse("2026-01-01"),
      }),
    ];
    const result = await runRecallPipelineRaw({
      agentId: "agent-a", query: "Firma A", dbTable: mockTable(rows), embeddings: makeEmbeddings(),
      topN: 5, recallMinScore: 0, importanceBoost: 0, canonicalEnabled: false, associativeEnabled: false,
      logger: { warn() {}, info() {} },
    });
    assert.deepEqual(result.memories.map((item) => item.entry.id), ["overlap-a"]);
  });
});

describe("valid-time — lib/safe-update.js buildUpdateEntry verbatim inheritance (§5c, Blocker-2 analogue, Test 26 §12)", () => {
  const OLD_ROW = {
    id: "22222222-2222-2222-2222-222222222222",
    text: "Original fact",
    summary: "Original fact",
    vector: [0.1, 0.2, 0.3],
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: "",
    status: "active",
    versionNumber: 1,
    validFrom: at(-30 * DAY),
    validUntil: at(-DAY),
  };
  const PATCH = { text: "Corrected wording of the same fact", vector: [0.11, 0.21, 0.31] };
  const EVIDENCE = { updateSource: "test", updateEvidence: "unit test", confidence: 0.9 };

  it("Test 26: a content-changing safeUpdate() carries validFrom/validUntil forward verbatim, unchanged by the rewording", () => {
    const newEntry = buildUpdateEntry(OLD_ROW, PATCH, EVIDENCE, {});
    assert.equal(newEntry.validFrom, OLD_ROW.validFrom, "a rewording of the claim's text does not change when the claim started being true");
    assert.equal(newEntry.validUntil, OLD_ROW.validUntil, "nor when it stopped being true");
  });

  it("a legacy row with no validFrom/validUntil at all defaults to 0/0 on a content-changing update, never fabricates a bound", () => {
    const legacyRow = { ...OLD_ROW, validFrom: undefined, validUntil: undefined };
    const newEntry = buildUpdateEntry(legacyRow, PATCH, EVIDENCE, {});
    assert.equal(newEntry.validFrom, 0);
    assert.equal(newEntry.validUntil, 0);
  });

  it("real safeUpdate() path: a content-changing update on a bi-temporal row preserves its validity window on the new version", async () => {
    const storeCalls = [];
    const db = {
      getById: async () => OLD_ROW,
      store: async (entry) => storeCalls.push(entry),
      update: async () => {},
    };
    const result = await safeUpdate(db, OLD_ROW.id, PATCH, EVIDENCE, {
      agentId: "agent-a", skipDriftGate: true,
    });
    assert.equal(result.inline, false, "text change must create a new version, not an inline update");
    assert.equal(storeCalls.length, 1);
    assert.equal(storeCalls[0].validFrom, OLD_ROW.validFrom, "the stored new version must carry the validity window forward, not reset it to unknown");
    assert.equal(storeCalls[0].validUntil, OLD_ROW.validUntil);
  });
});

// ─── Tests 9 & 15 (§12): capture-side wiring — real memory_store tool path ─
//
// The full plugin is instantiated (plugin.register(api) + the tool factory)
// the same way tests/memory-store-merge-safety.test.js and
// tests/memory-store-decision-trace.test.js already do — this exercises the
// live memory_store tool handler (index.js's inline copy), not a hand-built
// stand-in, per the task brief's "tests over echte Pfade" requirement.
//
// Fresh-table bootstrap now includes the complete Phase 1/2 schema. The
// helper below initializes one real MemoryDB instance and asserts the two
// Valid-Time columns before store-path tests seed historical rows.

const VALIDTIME_STORE_VECTOR_DIM = 384;

function validTimeStoreVector(offset = 0) {
  const vec = Array(VALIDTIME_STORE_VECTOR_DIM).fill(0.1);
  vec[0] = 0.1 + offset;
  return vec;
}

async function initValidTimeSchema(dbPath) {
  const first = trackMemoryDb(new MemoryDB(dbPath, VALIDTIME_STORE_VECTOR_DIM));
  await first.init();
  const schema = await first.table.schema();
  assert.ok(schema.fields.some((f) => f.name === "validFrom"), "schema warm-up must leave validFrom present before the real test body runs");
  assert.ok(schema.fields.some((f) => f.name === "validUntil"), "schema warm-up must leave validUntil present before the real test body runs");
  return first;
}

describe("valid-time — Test 9 (§12): capture-time relative phrases stay verbatim, no false precision (real memory_store tool)", () => {
  let basePath, workspaceDir, openclawHome, originalOpenClawHome, originalEmbed, originalQueryEmbed;

  before(() => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-validtime-store9-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-validtime-store9-ws-"));
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-test-validtime9-"));
    process.env.OPENCLAW_HOME = openclawHome;
    mkdirSync(join(openclawHome, ".openclaw", "memory", "_archive"), { recursive: true });
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    originalQueryEmbed = LocalTransformersEmbeddingProvider.prototype.embedQuery;
  });

  after(async () => {
    await shutdownTestResources();
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalQueryEmbed;
    rmSync(basePath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(openclawHome, { recursive: true, force: true });
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
  });

  function makeMockApi() {
    const noop = () => {};
    const api = {
      on(event, handler) {
        if (event === "gateway_stop") gatewayStopHandlers.add(handler);
      },
    };
    return {
      pluginConfig: {
        baseDbPath: basePath,
        embedding: { provider: "local-transformers", local: { dimensions: VALIDTIME_STORE_VECTOR_DIM } },
        merging: { enabled: false },
        duplicateThreshold: 0.9,
        obsidianBridge: { enabled: false },
        autoCapture: false,
        autoRecall: false,
        neo: { enabled: false },
        gc: { enabled: false },
        emotion: { t3: { enabled: false } },
      },
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      resolvePath: (p) => p,
      registerCommand: noop,
      registerTool(factory) { this._toolFactory = factory; },
      ...api,
      registerService: noop,
    };
  }

  it("Test 9: a memory_store call with no params.validFrom, on text using a vague relative-time phrase, stores validFrom:0 and leaves text untouched", async () => {
    const agentId = "testagent-validtime-relative";
    const schemaDb = await initValidTimeSchema(join(basePath, agentId));
    await shutdownMemoryDb(schemaDb);
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return validTimeStoreVector(0.001);
    };
    const api = makeMockApi();
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");
    assert.ok(storeTool);

    const text = "arbeite seit letztem Monat bei Firma B";
    const result = await storeTool.execute("call-relative-9", { text, category: "fact" });
    assert.equal(result.details.action, "stored", `expected a plain store, got: ${JSON.stringify(result.details)}`);

    const db = trackMemoryDb(new MemoryDB(join(basePath, agentId), VALIDTIME_STORE_VECTOR_DIM));
    await db.init();
    const rows = await db.table.query().toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, text, "the relative-time phrase must be preserved verbatim in the stored text");
    assert.ok(rows[0].validFrom == 0, "validFrom must remain 0 (unknown) — never guessed from 'seit letztem Monat'");
    assert.ok(rows[0].validUntil == 0, "validUntil was never supplied either, must stay 0");
    await shutdownMemoryDb(db);
  });

  it("positive control: a memory_store call WITH a real params.validFrom actually persists it (proves Test 9's 0 isn't a schema-migration-default artifact)", async () => {
    const agentId = "testagent-validtime-relative-positive";
    const schemaDb = await initValidTimeSchema(join(basePath, agentId));
    await shutdownMemoryDb(schemaDb);
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return validTimeStoreVector(0.002);
    };
    const api = makeMockApi();
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");

    const result = await storeTool.execute("call-relative-9-positive", {
      text: "arbeitet seit März 2026 bei Firma C",
      category: "fact",
      validFrom: "2026-03-01",
    });
    assert.equal(result.details.action, "stored");

    const db = trackMemoryDb(new MemoryDB(join(basePath, agentId), VALIDTIME_STORE_VECTOR_DIM));
    await db.init();
    const rows = await db.table.query().toArray();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].validFrom == Date.parse("2026-03-01"), `an explicit, resolvable validFrom must be persisted verbatim, got ${rows[0].validFrom}`);
    await shutdownMemoryDb(db);
  });

  it("an inverted memory_store validity window degrades both bounds to unknown", async () => {
    const agentId = "testagent-validtime-inverted";
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return validTimeStoreVector(0.003);
    };
    const api = makeMockApi();
    plugin.register(api);
    const storeTool = api._toolFactory({ agentId, workspaceDir });
    const memoryStore = storeTool.find((tool) => tool.name === "memory_store");

    const result = await memoryStore.execute("call-inverted-window", {
      text: "This fact has caller-supplied inverted bounds.",
      category: "fact",
      validFrom: "2026-06-01",
      validUntil: "2026-01-01",
    });
    assert.equal(result.details.action, "stored");

    const db = trackMemoryDb(new MemoryDB(join(basePath, agentId), VALIDTIME_STORE_VECTOR_DIM));
    await db.init();
    const rows = await db.table.query().toArray();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].validFrom == 0);
    assert.ok(rows[0].validUntil == 0);
    await shutdownMemoryDb(db);
  });

  it("registered memory_recall without validAt returns historical rows with visible validity labels", async () => {
    const agentId = "testagent-validtime-recall-label";
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return validTimeStoreVector(0.004);
    };
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async function mockedQueryEmbed() {
      return validTimeStoreVector(0.004);
    };

    const api = makeMockApi();
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((tool) => tool.name === "memory_store");
    await storeTool.execute("call-recall-label-seed", {
      text: "Alex worked at Firma A.",
      category: "fact",
      validFrom: "2025-01-01T00:00:00.000Z",
      validUntil: "2025-06-01T00:00:00.000Z",
    });
    const recallTool = tools.find((tool) => tool.name === "memory_recall");
    assert.doesNotMatch(recallTool.parameters.properties.validAt.description, /current[- ]state/i);
    const result = await recallTool.execute("call-recall-label", { query: "Where did Alex work?", limit: 5 });
    assert.match(result.content[0].text, /valid: \[2025-01-01T00:00:00\.000Z, 2025-06-01T00:00:00\.000Z\)/);
  });
});

describe("valid-time — Test 15 (§12): store-time LLM merge aborts on disjoint validity windows (real memory_store tool, §8a)", () => {
  let basePath, workspaceDir, openclawHome, originalOpenClawHome, originalCreate, originalEmbed, originalQueryEmbed;

  before(() => {
    basePath = mkdtempSync(join(tmpdir(), "plur1bus-validtime-store15-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-validtime-store15-ws-"));
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = mkdtempSync(join(tmpdir(), "openclaw-test-validtime15-"));
    process.env.OPENCLAW_HOME = openclawHome;
    mkdirSync(join(openclawHome, ".openclaw", "memory", "_archive"), { recursive: true });
    originalCreate = OpenAI.Chat.Completions.prototype.create;
    originalEmbed = LocalTransformersEmbeddingProvider.prototype.embedPassage;
    originalQueryEmbed = LocalTransformersEmbeddingProvider.prototype.embedQuery;
  });

  after(async () => {
    await shutdownTestResources();
    OpenAI.Chat.Completions.prototype.create = originalCreate;
    LocalTransformersEmbeddingProvider.prototype.embedPassage = originalEmbed;
    LocalTransformersEmbeddingProvider.prototype.embedQuery = originalQueryEmbed;
    rmSync(basePath, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(openclawHome, { recursive: true, force: true });
    if (originalOpenClawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = originalOpenClawHome;
  });

  function makeMockApi() {
    const noop = () => {};
    const api = {
      on(event, handler) {
        if (event === "gateway_stop") gatewayStopHandlers.add(handler);
      },
    };
    return {
      pluginConfig: {
        baseDbPath: basePath,
        embedding: { provider: "local-transformers", local: { dimensions: VALIDTIME_STORE_VECTOR_DIM } },
        merging: { enabled: true, autoApply: true, model: "mock-model", apiKey: "sk-test" },
        emotion: { t3: { enabled: false } },
        duplicateThreshold: 0.9999,
        obsidianBridge: { enabled: false },
        autoCapture: false,
        autoRecall: false,
        neo: { enabled: false },
        gc: { enabled: false },
        recall: { decisionTrace: { enabled: true, includeInPrompt: true, persist: false } },
      },
      logger: { info: noop, warn: noop, error: noop, debug: noop },
      resolvePath: (p) => p,
      registerCommand: noop,
      registerTool(factory) { this._toolFactory = factory; },
      ...api,
      registerService: noop,
    };
  }

  it("Test 15: a merge candidate with a known, disjoint validUntil aborts the LLM merge and falls through to a normal, separate store", async () => {
    const agentId = "testagent-validtime-disjoint-merge";
    const candidateId = "55555555-5555-5555-5555-555555555555";

    let llmCalls = 0;
    OpenAI.Chat.Completions.prototype.create = async function mockedCreate() {
      llmCalls++;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              merge: true,
              reason: "test-llm-would-merge",
              // Superset of both source texts' salient terms so
              // validateMergedTextPreservesFacts passes and the disjoint
              // validity-window guard is what actually blocks the merge.
              mergedText: "Projekt Delta nutzt den Auth-Service intern und extern.",
            }),
          },
        }],
      };
    };
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return validTimeStoreVector(0.25);
    };

    // Seed the merge candidate directly, with a known, CLOSED validity window
    // (validUntil in the past) — this is the "old" fact. Store it via the
    // initialized instance (see initValidTimeSchema's note above the describe
    // block) so validFrom/validUntil are real schema columns BEFORE the
    // write, not silently dropped by normalizeEntryForTable's whitelist.
    const localDb = await initValidTimeSchema(join(basePath, agentId));
    await localDb.store({
      id: candidateId,
      text: "Projekt Delta nutzt den Auth-Service intern.",
      vector: validTimeStoreVector(0.2),
      category: "fact",
      createdAt: Date.now(),
      storedBy: agentId,
      validFrom: at(-60 * DAY),
      validUntil: at(-30 * DAY),
    });
    await shutdownMemoryDb(localDb);

    const api = makeMockApi();
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const storeTool = tools.find((t) => t.name === "memory_store");
    assert.ok(storeTool);

    // The incoming fact's validFrom starts AFTER the candidate's validUntil —
    // known, disjoint windows. Text is a near-duplicate of the candidate
    // (single-word variant) so it clears the merge-candidate similarity band
    // and would otherwise merge if the disjoint-window guard didn't fire.
    const result = await storeTool.execute("call-disjoint-15", {
      text: "Projekt Delta nutzt den Auth-Service extern.",
      category: "fact",
      validFrom: new Date(at(-10 * DAY)).toISOString(),
    });

    assert.equal(llmCalls, 1, "the LLM merge check must still run — the disjoint-window guard fires on its result, not instead of it");
    assert.equal(result.details.action, "stored", `expected a fallback to a normal, separate store, got: ${JSON.stringify(result.details)}`);

    const decision = result.details.decisionTrace?.storeDecisions?.find((d) => d.action === "merge_aborted");
    assert.ok(decision, `expected a merge_aborted trace entry, got: ${JSON.stringify(result.details.decisionTrace?.storeDecisions)}`);
    assert.equal(decision.reason, "disjoint validity windows");

    const checkDb = trackMemoryDb(new MemoryDB(join(basePath, agentId), VALIDTIME_STORE_VECTOR_DIM));
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.equal(rows.length, 2, "both the original candidate and the new fact must exist as separate rows, not merged");
    assert.ok(rows.some((r) => r.id === candidateId && r.text.includes("intern")), "the original, historically-closed row must be untouched");
    assert.ok(rows.some((r) => r.text.includes("extern") && r.id !== candidateId), "the new fact must be stored separately, not merged into the candidate");
    await shutdownMemoryDb(checkDb);
  });

  it("exact text with a disjoint known window is stored as a separate historical row, not rejected as duplicate", async () => {
    const agentId = "testagent-validtime-disjoint-duplicate";
    const candidateId = "66666666-6666-4666-8666-666666666666";
    const text = "Alex worked on Project Delta.";
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return validTimeStoreVector(0.3);
    };
    const localDb = await initValidTimeSchema(join(basePath, agentId));
    await localDb.store({
      id: candidateId,
      text,
      vector: validTimeStoreVector(0.3),
      category: "fact",
      createdAt: Date.now() - 1000,
      storedBy: agentId,
      validFrom: Date.parse("2025-01-01"),
      validUntil: Date.parse("2025-06-01"),
    });
    await shutdownMemoryDb(localDb);

    const api = makeMockApi();
    api.pluginConfig.merging.enabled = false;
    plugin.register(api);
    const memoryStore = api._toolFactory({ agentId, workspaceDir }).find((tool) => tool.name === "memory_store");
    const result = await memoryStore.execute("call-disjoint-exact", {
      text,
      category: "fact",
      validFrom: "2025-07-01",
      validUntil: "2025-12-01",
    });
    assert.equal(result.details.action, "stored");

    const checkDb = trackMemoryDb(new MemoryDB(join(basePath, agentId), VALIDTIME_STORE_VECTOR_DIM));
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.status === "active").length, 2);
    assert.ok(rows.some((row) => row.id === candidateId));
    assert.ok(rows.some((row) => row.id !== candidateId && row.validFrom == Date.parse("2025-07-01")));
    await shutdownMemoryDb(checkDb);
  });

  it("exact text with an overlapping but different window remains available after the old window closes", async () => {
    const agentId = "testagent-validtime-overlap-duplicate";
    const candidateId = "77777777-7777-4777-8777-777777777778";
    const text = "Alex worked on Project Delta.";
    LocalTransformersEmbeddingProvider.prototype.embedPassage = async function mockedEmbed() {
      return validTimeStoreVector(0.31);
    };
    LocalTransformersEmbeddingProvider.prototype.embedQuery = async function mockedQueryEmbed() {
      return validTimeStoreVector(0.31);
    };
    const localDb = await initValidTimeSchema(join(basePath, agentId));
    await localDb.store({
      id: candidateId,
      text,
      vector: validTimeStoreVector(0.31),
      category: "fact",
      createdAt: Date.now() - 1000,
      storedBy: agentId,
      validFrom: Date.parse("2020-01-01"),
      validUntil: Date.parse("2025-01-01"),
    });
    await shutdownMemoryDb(localDb);

    const api = makeMockApi();
    api.pluginConfig.merging.enabled = false;
    plugin.register(api);
    const tools = api._toolFactory({ agentId, workspaceDir });
    const memoryStore = tools.find((tool) => tool.name === "memory_store");
    const result = await memoryStore.execute("call-overlap-exact", {
      text,
      category: "fact",
      validFrom: "2024-01-01",
      validUntil: "2030-01-01",
    });
    assert.equal(result.details.action, "stored");

    const checkDb = trackMemoryDb(new MemoryDB(join(basePath, agentId), VALIDTIME_STORE_VECTOR_DIM));
    await checkDb.init();
    const rows = await checkDb.table.query().toArray();
    assert.equal(rows.filter((row) => row.status === "active").length, 2);
    assert.ok(rows.some((row) => row.id === result.details.id && row.validUntil == Date.parse("2030-01-01")));
    await shutdownMemoryDb(checkDb);

    const memoryRecall = tools.find((tool) => tool.name === "memory_recall");
    const recalled = await memoryRecall.execute("call-overlap-recall", {
      query: "Where did Alex work?",
      limit: 5,
      validAt: "2027-01-01",
    });
    assert.match(recalled.content[0].text, /Alex worked on Project Delta\./);
    assert.match(recalled.content[0].text, /valid: \[2024-01-01T00:00:00\.000Z, 2030-01-01T00:00:00\.000Z\)/);
  });
});
