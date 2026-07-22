/**
 * tests/temporal-filter.test.js
 *
 * Timeout fallback tests for lib/temporal-filter.js (Scope C).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTemporalFilter, temporalRangeFromAnchor } from "../lib/temporal-filter.js";
import { TimeoutError } from "../lib/with-timeout.js";

describe("applyTemporalFilter", () => {
  it("returns all results when temporal is null", () => {
    const results = [{ entry: { createdAt: 1 }, score: 0.5 }];
    assert.deepStrictEqual(applyTemporalFilter(results, null), results);
  });

  it("filters results by range", () => {
    const results = [
      { entry: { createdAt: 1000 }, score: 0.5 },
      { entry: { createdAt: 5000 }, score: 0.6 },
      { entry: { createdAt: 9000 }, score: 0.7 },
    ];
    const filtered = applyTemporalFilter(results, { type: "range", from: 2000, to: 8000 });
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].entry.createdAt, 5000);
  });
});

describe("temporalRangeFromAnchor", () => {
  it("resolves a normal anchor query", async () => {
    const createdAt = 1750000000000;
    const embeddingContext = Object.freeze({ agentId: "agent-a" });
    const embeddingCalls = [];
    const dbTable = {
      vectorSearch: () => ({
        limit: () => ({
          toArray: async () => [{ createdAt }],
        }),
      }),
    };
    const embeddings = {
      async embed(text, context) {
        embeddingCalls.push([text, context]);
        return [0.1, 0.2, 0.3];
      },
    };
    const range = await temporalRangeFromAnchor("docker setup", dbTable, embeddings, { embeddingContext });
    assert.ok(range);
    assert.strictEqual(range.type, "range");
    assert.strictEqual(range.from, createdAt);
    assert.strictEqual(range.to, createdAt + 48 * 3600_000);
    assert.deepEqual(embeddingCalls, [["docker setup", { agentId: "agent-a" }]]);
    assert.equal(embeddingCalls[0][1], embeddingContext);
  });

  it("returns null when vectorSearch hangs past the timeout", async () => {
    const dbTable = {
      vectorSearch: () => ({
        limit: () => ({
          toArray: () => new Promise(() => {}),
        }),
      }),
    };
    const embeddings = {
      embed: async () => [0.1, 0.2, 0.3],
    };
    const range = await temporalRangeFromAnchor("docker setup", dbTable, embeddings);
    assert.strictEqual(range, null);
  });

  it("returns null when embeddings fail", async () => {
    const dbTable = {
      vectorSearch: () => ({
        limit: () => ({
          toArray: async () => [{ createdAt: 1750000000000 }],
        }),
      }),
    };
    const embeddings = {
      embed: async () => {
        throw new Error("embedding down");
      },
    };
    const diagnostics = [];
    const range = await temporalRangeFromAnchor("docker setup", dbTable, embeddings, {
      logger: {
        debug(message) { diagnostics.push(message); },
      },
    });
    assert.strictEqual(range, null);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /temporal-filter\.anchor.*embedding down/);
  });

  it("propagates an attached anchor-read timeout only in strict mode", async () => {
    const rawSettlement = Promise.resolve([]);
    const timeout = new TimeoutError("temporal anchor read", 10, rawSettlement);
    const dbTable = {
      vectorSearch: () => ({
        limit: () => ({
          async toArray() { throw timeout; },
        }),
      }),
    };
    const embeddings = { embed: async () => [0.1, 0.2, 0.3] };

    await assert.rejects(
      temporalRangeFromAnchor("docker setup", dbTable, embeddings, { strictReadErrors: true }),
      (error) => error === timeout && error.settlement === rawSettlement,
    );
  });
});
