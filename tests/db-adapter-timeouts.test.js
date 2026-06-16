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

const never = () => new Promise(() => {});
let counter = 0;

function makeFakeTable(overrides = {}) {
  const queryFn = overrides.query || (() => Promise.resolve([]));
  const vectorSearchFn = overrides.vectorSearch || (() => Promise.resolve([]));
  return {
    query: () => ({
      where: () => ({ limit: () => ({ toArray: queryFn }) }),
      limit: () => ({ toArray: queryFn }),
    }),
    vectorSearch: () => ({
      where: () => ({ limit: () => ({ toArray: vectorSearchFn }) }),
      limit: () => ({ toArray: vectorSearchFn }),
    }),
    delete: overrides.delete || (() => Promise.resolve()),
    update: overrides.update || (() => Promise.resolve()),
    add: overrides.add || (() => Promise.resolve()),
    close: overrides.close || (() => Promise.resolve()),
  };
}

function makeAdapter(fakeTable, opts = {}) {
  return createDbAdapter({
    basePath: `/tmp/db-adapter-timeout-test-${counter++}`,
    getTable: async () => fakeTable,
    readTimeoutMs: 50,
    writeTimeoutMs: 50,
    ...opts,
  });
}

describe("db-adapter LanceDB timeouts", () => {
  it("times out a hanging getCard and includes the label", async () => {
    const db = makeAdapter(makeFakeTable({ query: never }));
    await assert.rejects(
      () => db.getCard("agent", "11111111-1111-1111-1111-111111111111"),
      (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.ok(err.message.includes("db-adapter.getCard"));
        return true;
      },
    );
  });

  it("times out a hanging queryByTimeRange and includes the label", async () => {
    const db = makeAdapter(makeFakeTable({ query: never }));
    await assert.rejects(
      () => db.queryByTimeRange("agent", "today"),
      /db-adapter.queryByTimeRange/,
    );
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
    const db = makeAdapter(makeFakeTable({ delete: never }));
    await assert.rejects(
      () => db.deleteCard("agent", "11111111-1111-1111-1111-111111111111"),
      (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.ok(err.message.includes("db-adapter.deleteCard"));
        return true;
      },
    );
  });

  it("times out a hanging updateCardType and includes the label", async () => {
    const db = makeAdapter(makeFakeTable({ update: never }));
    await assert.rejects(
      () => db.updateCardType("agent", "11111111-1111-1111-1111-111111111111", "person"),
      /db-adapter.updateCardType/,
    );
  });

  it("times out a hanging markConfirmed and includes the label", async () => {
    const db = makeAdapter(makeFakeTable({ update: never }));
    await assert.rejects(
      () => db.markConfirmed("agent", "11111111-1111-1111-1111-111111111111"),
      /db-adapter.markConfirmed/,
    );
  });

  it("keeps successful writes unchanged", async () => {
    let updated = false;
    const db = makeAdapter(makeFakeTable({ update: async () => { updated = true; } }));
    const result = await db.markConfirmed("agent", "11111111-1111-1111-1111-111111111111");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(updated, true);
  });

  it("propagates non-timeout write errors", async () => {
    const db = makeAdapter(makeFakeTable({ update: () => Promise.reject(new Error("table gone")) }));
    await assert.rejects(
      () => db.markConfirmed("agent", "11111111-1111-1111-1111-111111111111"),
      /table gone/,
    );
  });

  it("times out updateCard write when query succeeds", async () => {
    const row = {
      id: "11111111-1111-1111-1111-111111111111",
      text: "old text",
      summary: "old",
      createdAt: Date.now(),
      status: "active",
    };
    const db = makeAdapter(
      makeFakeTable({
        query: () => Promise.resolve([row]),
        update: never,
      }),
      { embedder: { embed: async () => [0.1, 0.2, 0.3] } },
    );
    await assert.rejects(
      () => db.updateCard("agent", row.id, "new text"),
      (err) => err instanceof TimeoutError && /db-adapter.updateCard/.test(err.message),
    );
  });

  it("times out a hanging searchByTopic vector search and includes the label", async () => {
    const db = makeAdapter(makeFakeTable({ vectorSearch: never }), {
      getEmbedding: async () => [1, 0, 0],
    });
    await assert.rejects(
      () => db.searchByTopic("agent", "hello"),
      /db-adapter.searchByTopic.vectorSearch/,
    );
  });
});
