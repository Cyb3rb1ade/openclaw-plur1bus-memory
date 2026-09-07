import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runRecallPipeline,
  projectRecallEntry,
  isRecallEntryLive,
  toEpochNumber,
} from "../lib/recall-pipeline.js";

// LanceDB liefert Int64-Spalten als BigInt. Bis 7.12.5 galt ein BigInt 0n als
// abgelaufene Erinnerung, und die Pipeline verwarf jeden Kandidaten im
// Lifecycle-Filter — Auto-Recall injizierte in jedem Turn null Erinnerungen.

const DIM = 4;
const embeddings = {
  dim: DIM,
  async embed() { return Array(DIM).fill(0.1); },
  async embedQuery() { return Array(DIM).fill(0.1); },
};

function bigintRow(id, overrides = {}) {
  return {
    id,
    text: `Nord Stream Gespräch ${id}`,
    summary: "",
    category: "fact",
    origin: "dm",
    status: "active",
    importance: 0.7,
    createdAt: 1788794634807,
    _distance: 0.77,
    scope: "agent-private",
    agentId: "",
    storedBy: "main",
    workspaceId: "",
    workspaceKey: "",
    ownerUserId: "",
    expiresAt: 0n,
    validFrom: 0n,
    validUntil: 0n,
    updatedAt: 0n,
    remindAt: 0n,
    lastRetrievedAt: 0n,
    confirmed: 0n,
    ...overrides,
  };
}

function mockTable(rows) {
  return {
    vectorSearch() {
      return { limit() { return { async toArray() { return rows; } }; } };
    },
    query() {
      return { where() { return { limit() { return { async toArray() { return []; } }; } }; } };
    },
  };
}

describe("recall pipeline — Int64 columns arrive as BigInt", () => {
  it("toEpochNumber maps BigInt to safe numbers and keeps fallbacks", () => {
    assert.equal(toEpochNumber(0n), 0);
    assert.equal(toEpochNumber(1788794634807n), 1788794634807);
    assert.equal(toEpochNumber(undefined, 5), 5);
    assert.equal(toEpochNumber(null, null), null);
    assert.equal(toEpochNumber(Number.NaN, 0), 0);
    assert.equal(toEpochNumber(2n ** 70n, 0), 0);
  });

  it("projects BigInt fields to numbers", () => {
    const entry = projectRecallEntry(bigintRow("m1", { expiresAt: 42n, validUntil: 7n, confirmed: 1n }));
    for (const key of ["expiresAt", "validFrom", "validUntil", "updatedAt", "remindAt", "lastRetrievedAt", "confirmed"]) {
      assert.equal(typeof entry[key], "number", `${key} should be a number`);
    }
    assert.equal(entry.expiresAt, 42);
    assert.equal(entry.validUntil, 7);
    assert.equal(entry.confirmed, 1);
  });

  it("treats a BigInt zero expiry as no expiry and honours real BigInt expiries", () => {
    const now = Date.now();
    assert.equal(isRecallEntryLive(projectRecallEntry(bigintRow("live")), now), true);
    assert.equal(isRecallEntryLive({ status: "active", expiresAt: 0n }, now), true);
    assert.equal(isRecallEntryLive({ status: "active", expiresAt: BigInt(now - 1000) }, now), false);
    assert.equal(isRecallEntryLive({ status: "active", expiresAt: BigInt(now + 100000) }, now), true);
  });

  it("returns memories from BigInt-backed rows end to end", async () => {
    const rows = [
      bigintRow("a", { text: "Nord Stream Anklage gegen Serhii K. durch den Generalbundesanwalt" }),
      bigintRow("b", { _distance: 0.9, text: "Goethe-Institute in Russland werden als Vergeltung geschlossen" }),
    ];
    const result = await runRecallPipeline({
      query: "Nord Stream Gespräch",
      dbTable: mockTable(rows),
      embeddings,
      agentId: "main",
      topN: 5,
      recallMinScore: 0.15,
      reranker: null,
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    assert.equal(result.memories.length, 2, "both live rows must survive the lifecycle filter");
    assert.ok(result.memories.every((m) => typeof m.entry.expiresAt === "number"));
  });

  it("still drops rows whose BigInt expiry lies in the past", async () => {
    const rows = [
      bigintRow("old", { expiresAt: BigInt(Date.now() - 60_000), text: "Alte Meldung zum Drohnenvorfall in Leipzig" }),
      bigintRow("fresh", { text: "Aktuelle Einordnung zur Nord-Stream-Anklage" }),
    ];
    const result = await runRecallPipeline({
      query: "Nord Stream Gespräch",
      dbTable: mockTable(rows),
      embeddings,
      agentId: "main",
      topN: 5,
      recallMinScore: 0.15,
      reranker: null,
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    assert.deepEqual(result.memories.map((m) => m.entry.id), ["fresh"]);
  });
});
