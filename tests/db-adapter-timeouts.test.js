/**
 * tests/db-adapter-timeouts.test.js
 *
 * Regressionstests für Operation-Level-Timeouts im db-adapter.
 * Alle LanceDB-Operationen werden mit withTimeout() eingewickelt; diese Tests
 * mocken die Table-Methoden so, dass sie hängen oder sofort auflösen.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { createDbAdapter } from "../lib/db-adapter.js";
import { TimeoutError } from "../lib/with-timeout.js";

function makeFakeTable(overrides = {}) {
  const never = () => new Promise(() => {});
  return {
    query: () => ({
      where: () => ({ limit: () => ({ toArray: overrides.query || (() => Promise.resolve([])) }) }),
      limit: () => ({ toArray: overrides.query || (() => Promise.resolve([])) }),
    }),
    vectorSearch: () => ({
      where: () => ({ limit: () => ({ toArray: overrides.vectorSearch || (() => Promise.resolve([])) }) }),
      limit: () => ({ toArray: overrides.vectorSearch || (() => Promise.resolve([])) }),
    }),
    delete: overrides.delete || (() => Promise.resolve()),
    update: overrides.update || (() => Promise.resolve()),
    add: overrides.add || (() => Promise.resolve()),
    close: overrides.close || (() => Promise.resolve()),
  };
}

function makeAdapter(fakeTable, opts = {}) {
  return createDbAdapter({
    getTable: async () => fakeTable,
    readTimeoutMs: 50,
    writeTimeoutMs: 50,
    ...opts,
  });
}

describe("db-adapter LanceDB timeouts", () => {
  it("returns null for a hanging getCard (safe fallback, timeout logged)", async () => {
    const db = makeAdapter(makeFakeTable({ query: () => new Promise(() => {}) }));
    const card = await db.getCard("agent", "11111111-1111-1111-1111-111111111111");
    assert.strictEqual(card, null);
  });

  it("does not change successful getCard results", async () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      text: "hello",
      summary: "hi",
      createdAt: Date.now(),
      status: "active",
    };
    const db = makeAdapter(makeFakeTable({ query: () => Promise.resolve([row]) }));
    const card = await db.getCard("agent", row.id);
    assert.ok(card);
    assert.strictEqual(card.id, row.id);
    assert.strictEqual(card.text, row.text);
  });

  it("times out a hanging deleteCard and includes the label", async () => {
    const db = makeAdapter(makeFakeTable({ delete: () => new Promise(() => {}) }));
    await assert.rejects(
      () => db.deleteCard("agent", "11111111-1111-1111-1111-111111111111"),
      (err) => err instanceof TimeoutError && /db-adapter.deleteCard/.test(err.message),
    );
  });

  it("times out a hanging updateCardType and includes the label", async () => {
    const db = makeAdapter(makeFakeTable({ update: () => new Promise(() => {}) }));
    await assert.rejects(
      () => db.updateCardType("agent", "11111111-1111-1111-1111-111111111111", "person"),
      (err) => err instanceof TimeoutError && /db-adapter.updateCardType/.test(err.message),
    );
  });

  it("times out a hanging searchByTopic vector search and falls back to empty results", async () => {
    const db = makeAdapter(makeFakeTable({ vectorSearch: () => new Promise(() => {}) }), {
      getEmbedding: async () => [1, 0, 0],
    });
    const results = await db.searchByTopic("agent", "hello");
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
  });

  it("swallows non-timeout read errors and returns safe fallbacks", async () => {
    const db = makeAdapter(makeFakeTable({ query: () => Promise.reject(new Error("table gone")) }));
    const card = await db.getCard("agent", "11111111-1111-1111-1111-111111111111");
    assert.strictEqual(card, null);
  });

  it("propagates TimeoutError for updateCard write", async () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      text: "old",
      summary: "old",
      createdAt: Date.now(),
      status: "active",
    };
    const db = makeAdapter(makeFakeTable({
      query: () => Promise.resolve([row]),
      update: () => new Promise(() => {}),
    }), { embedder: { embed: async () => [0.1, 0.2, 0.3] } });

    await assert.rejects(
      () => db.updateCard("agent", row.id, "new text"),
      (err) => err instanceof TimeoutError && /db-adapter.updateCard/.test(err.message),
    );
  });

  it("uses configurable read/write timeouts", async () => {
    const start = performance.now();
    const db = makeAdapter(makeFakeTable({ query: () => new Promise(() => {}) }), {
      readTimeoutMs: 20,
    });
    await db.getCard("agent", "11111111-1111-1111-1111-111111111111");
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 100, `expected sub-100ms timeout, got ${elapsed}ms`);
  });
});
