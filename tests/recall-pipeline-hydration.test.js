// tests/recall-pipeline-hydration.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hydrateGraphResults as hydrateGraphResultsRaw } from "../lib/recall-pipeline.js";
import { TimeoutError } from "../lib/with-timeout.js";

function numberedUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

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
  const authorizedRows = rows.map((row) => ({
    scope: "agent-private",
    agentId: "agent-a",
    storedBy: "agent-a",
    ...row,
  }));
  return {
    query() {
      return {
        where(whereClause) {
          const ids = extractWhereIds(whereClause);
          return {
            limit() {
              return {
                async toArray() {
                  return authorizedRows.filter(r => ids.size === 0 || ids.has(r.id));
                },
              };
            },
          };
        },
      };
    },
  };
}

function inReadFailureTable(row, readFailure) {
  let queryCount = 0;
  return {
    dbTable: {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw readFailure;
                    return [row];
                  },
                };
              },
            };
          },
        };
      },
    },
    get queryCount() { return queryCount; },
  };
}

const ACL_CTX = Object.freeze({
  agentId: "agent-a",
  workspaceId: "",
  workspaceIdentity: "",
  userPrincipal: "",
  workspaceAliases: Object.freeze({ paths: Object.freeze([]), aliases: Object.freeze([]) }),
});

function hydrateGraphResults(dbTable, results, logger, opts = {}) {
  const authorizedResults = results.map((result) => ({
    ...result,
    entry: {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
      ...result.entry,
    },
  }));
  return hydrateGraphResultsRaw(dbTable, authorizedResults, logger, {
    aclCtx: ACL_CTX,
    ...opts,
  });
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
      sourceMemoryId: "source-m2",
      sourceAgentId: "source-agent",
      shareIdempotencyKey: "share-m2",
      shareProvenance: JSON.stringify({ source: "hydration-fixture" }),
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
    assert.deepEqual({
      sourceMemoryId: m2.entry.sourceMemoryId,
      sourceAgentId: m2.entry.sourceAgentId,
      shareIdempotencyKey: m2.entry.shareIdempotencyKey,
      shareProvenance: m2.entry.shareProvenance,
    }, {
      sourceMemoryId: "source-m2",
      sourceAgentId: "source-agent",
      shareIdempotencyKey: "share-m2",
      shareProvenance: JSON.stringify({ source: "hydration-fixture" }),
    });
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

  it("chunks UUID IN reads and falls back only for the unsupported chunk", async () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({
      id: numberedUuid(index + 1),
      text: `allowed row ${index + 1}`,
      summary: "",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    }));
    const results = rows.map((row) => ({
      entry: { id: row.id },
      score: 0.5,
      source: "graph",
      depth: 1,
    }));
    const queryLog = [];
    const debugLog = [];
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            const ids = extractWhereIds(whereClause);
            const isInQuery = /\bIN\b/.test(whereClause);
            queryLog.push({ ids, isInQuery });
            return {
              limit() {
                return {
                  async toArray() {
                    if (isInQuery && ids.has(rows[100].id)) {
                      const error = new Error("opaque provider failure");
                      error.code = "ERR_UNSUPPORTED_IN_QUERY";
                      throw error;
                    }
                    return rows.filter((row) => ids.has(row.id));
                  },
                };
              },
            };
          },
        };
      },
    };

    const out = await hydrateGraphResults(dbTable, results, {
      info() {},
      warn() {},
      debug(message) { debugLog.push(message); },
    });

    assert.equal(out.length, 150);
    assert.equal(queryLog.length, 52, "two IN chunks plus 50 single-ID fallbacks are expected");
    assert.equal(queryLog.filter((query) => query.isInQuery).length, 2);
    assert.equal(queryLog.filter((query) => query.ids.has(rows[0].id)).length, 1, "loaded chunks are not queried again");
    assert.equal(queryLog.filter((query) => query.ids.has(rows[100].id)).length, 2, "only the unsupported chunk falls back");
    assert.ok(debugLog.some((message) => message.includes("recall-pipeline.getByIds.in-unsupported")));
  });

  it("does not classify query unavailable as unsupported in non-strict mode", async () => {
    const id = numberedUuid(151);
    const row = {
      id,
      text: "must not arrive through fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("query unavailable");
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw readFailure;
                    return [row];
                  },
                };
              },
            };
          },
        };
      },
    };

    const out = await hydrateGraphResults(dbTable, [
      { entry: { id }, score: 0.5, source: "graph", depth: 1 },
    ], { info() {}, warn() {}, debug() {} });

    assert.deepEqual(out, []);
    assert.equal(queryCount, 1, "a transient query failure must not start per-ID fallback");
  });

  it("rethrows the original query unavailable error in strict mode without fallback", async () => {
    const id = numberedUuid(152);
    const row = {
      id,
      text: "must not arrive through strict fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("query unavailable");
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw readFailure;
                    return [row];
                  },
                };
              },
            };
          },
        };
      },
    };

    await assert.rejects(
      hydrateGraphResults(dbTable, [
        { entry: { id }, score: 0.5, source: "graph", depth: 1 },
      ], { info() {}, warn() {}, debug() {} }, { strictReadErrors: true }),
      (error) => error === readFailure,
    );
    assert.equal(queryCount, 1, "strict transient query failure must preserve the original read boundary");
  });

  it("does not treat lowercase prepositional in as unsupported IN syntax in non-strict mode", async () => {
    const id = numberedUuid(153);
    const row = {
      id,
      text: "must not arrive through lowercase-preposition fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("storage capability unsupported in this environment");
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw readFailure;
                    return [row];
                  },
                };
              },
            };
          },
        };
      },
    };

    const out = await hydrateGraphResults(dbTable, [
      { entry: { id }, score: 0.5, source: "graph", depth: 1 },
    ], { info() {}, warn() {}, debug() {} });

    assert.deepEqual(out, []);
    assert.equal(queryCount, 1, "a generic lowercase preposition must not start per-ID fallback");
  });

  it("rethrows a lowercase-preposition error unchanged in strict mode without fallback", async () => {
    const id = numberedUuid(154);
    const row = {
      id,
      text: "must not arrive through strict lowercase-preposition fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("storage capability unsupported in this environment");
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw readFailure;
                    return [row];
                  },
                };
              },
            };
          },
        };
      },
    };

    await assert.rejects(
      hydrateGraphResults(dbTable, [
        { entry: { id }, score: 0.5, source: "graph", depth: 1 },
      ], { info() {}, warn() {}, debug() {} }, { strictReadErrors: true }),
      (error) => error === readFailure,
    );
    assert.equal(queryCount, 1, "strict generic errors must preserve the original read boundary");
  });

  it("does not treat an all-caps generic capability message as unsupported IN syntax in non-strict mode", async () => {
    const id = numberedUuid(155);
    const row = {
      id,
      text: "must not arrive through all-caps capability fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("OPERATION UNSUPPORTED IN CAPABILITY MODE");
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw readFailure;
                    return [row];
                  },
                };
              },
            };
          },
        };
      },
    };

    const out = await hydrateGraphResults(dbTable, [
      { entry: { id }, score: 0.5, source: "graph", depth: 1 },
    ], { info() {}, warn() {}, debug() {} });

    assert.deepEqual(out, []);
    assert.equal(queryCount, 1, "a generic all-caps capability message must not start per-ID fallback");
  });

  it("rethrows an all-caps generic capability error unchanged in strict mode without fallback", async () => {
    const id = numberedUuid(156);
    const row = {
      id,
      text: "must not arrive through strict all-caps capability fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("OPERATION UNSUPPORTED IN CAPABILITY MODE");
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw readFailure;
                    return [row];
                  },
                };
              },
            };
          },
        };
      },
    };

    await assert.rejects(
      hydrateGraphResults(dbTable, [
        { entry: { id }, score: 0.5, source: "graph", depth: 1 },
      ], { info() {}, warn() {}, debug() {} }, { strictReadErrors: true }),
      (error) => error === readFailure,
    );
    assert.equal(queryCount, 1, "strict generic all-caps errors must preserve the original read boundary");
  });

  it("does not infer fallback from an all-caps filter-in-query message in non-strict mode", async () => {
    const row = {
      id: numberedUuid(157),
      text: "must not arrive through filter-in-query fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("USE OF FILTER IN QUERY IS NOT SUPPORTED");
    const probe = inReadFailureTable(row, readFailure);

    const out = await hydrateGraphResults(probe.dbTable, [
      { entry: { id: row.id }, score: 0.5, source: "graph", depth: 1 },
    ], { info() {}, warn() {}, debug() {} });

    assert.deepEqual(out, []);
    assert.equal(probe.queryCount, 1);
  });

  it("rethrows an all-caps filter-in-query error unchanged in strict mode", async () => {
    const row = {
      id: numberedUuid(158),
      text: "must not arrive through strict filter-in-query fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("USE OF FILTER IN QUERY IS NOT SUPPORTED");
    const probe = inReadFailureTable(row, readFailure);

    await assert.rejects(
      hydrateGraphResults(probe.dbTable, [
        { entry: { id: row.id }, score: 0.5, source: "graph", depth: 1 },
      ], { info() {}, warn() {}, debug() {} }, { strictReadErrors: true }),
      (error) => error === readFailure,
    );
    assert.equal(probe.queryCount, 1);
  });

  it("does not infer fallback from an all-caps operation-in-query message in non-strict mode", async () => {
    const row = {
      id: numberedUuid(159),
      text: "must not arrive through operation-in-query fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("OPERATION IN QUERY IS UNSUPPORTED");
    const probe = inReadFailureTable(row, readFailure);

    const out = await hydrateGraphResults(probe.dbTable, [
      { entry: { id: row.id }, score: 0.5, source: "graph", depth: 1 },
    ], { info() {}, warn() {}, debug() {} });

    assert.deepEqual(out, []);
    assert.equal(probe.queryCount, 1);
  });

  it("rethrows an all-caps operation-in-query error unchanged in strict mode", async () => {
    const row = {
      id: numberedUuid(160),
      text: "must not arrive through strict operation-in-query fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("OPERATION IN QUERY IS UNSUPPORTED");
    const probe = inReadFailureTable(row, readFailure);

    await assert.rejects(
      hydrateGraphResults(probe.dbTable, [
        { entry: { id: row.id }, score: 0.5, source: "graph", depth: 1 },
      ], { info() {}, warn() {}, debug() {} }, { strictReadErrors: true }),
      (error) => error === readFailure,
    );
    assert.equal(probe.queryCount, 1);
  });

  it("never infers unsupported-IN fallback from arbitrary error text", async () => {
    const messages = [
      "IN predicate syntax is not supported",
      "SQL ENGINE DOES NOT SUPPORT IN OPERATOR",
      "QUERY ERROR: IN CLAUSE UNSUPPORTED",
      "RANDOM UPPERCASE TEXT",
    ];

    for (const [index, message] of messages.entries()) {
      const row = {
        id: numberedUuid(162 + index),
        text: "must not arrive through arbitrary-message fallback",
        status: "active",
        scope: "agent-private",
        agentId: "agent-a",
        storedBy: "agent-a",
      };
      const probe = inReadFailureTable(row, new Error(message));

      const out = await hydrateGraphResults(probe.dbTable, [
        { entry: { id: row.id }, score: 0.5, source: "graph", depth: 1 },
      ], { info() {}, warn() {}, debug() {} });

      assert.deepEqual(out, [], message);
      assert.equal(probe.queryCount, 1, message);
    }
  });

  it("uses explicit unsupported-IN error code fallback in strict mode", async () => {
    const row = {
      id: numberedUuid(161),
      text: "allowed through structured strict fallback",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const readFailure = new Error("opaque provider failure");
    readFailure.code = "ERR_UNSUPPORTED_IN_QUERY";
    const probe = inReadFailureTable(row, readFailure);

    const out = await hydrateGraphResults(probe.dbTable, [
      { entry: { id: row.id }, score: 0.5, source: "graph", depth: 1 },
    ], { info() {}, warn() {}, debug() {} }, { strictReadErrors: true });

    assert.equal(out.length, 1);
    assert.equal(out[0].entry.id, row.id);
    assert.equal(probe.queryCount, 2);
  });

  it("fails closed and logs a non-timeout IN read error without single-ID retries", async () => {
    const id = numberedUuid(201);
    const row = {
      id,
      text: "confidential row payload",
      status: "active",
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    };
    const warnings = [];
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw new Error("database read unavailable");
                    return [row];
                  },
                };
              },
            };
          },
        };
      },
    };

    const out = await hydrateGraphResults(dbTable, [
      { entry: { id }, score: 0.5, source: "graph", depth: 1 },
    ], {
      info() {},
      warn(message) { warnings.push(message); },
    });

    assert.deepEqual(out, []);
    assert.equal(queryCount, 1, "ordinary DB errors must not trigger compatibility fallbacks");
    assert.ok(warnings.some((message) => message.includes("recall-pipeline.getByIds.in")));
    assert.equal(warnings.some((message) => message.includes(row.text)), false, "logs must not contain row text");
  });

  it("keeps fail-soft hydration empty when warning delivery throws", async () => {
    const id = numberedUuid(204);
    const readFailure = new Error("database read failure");
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where() {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() { throw readFailure; },
                };
              },
            };
          },
        };
      },
    };

    const out = await hydrateGraphResults(dbTable, [
      { entry: { id }, score: 0.5, source: "graph", depth: 1 },
    ], {
      info() {},
      warn() { throw new Error("logger unavailable"); },
    });

    assert.deepEqual(out, []);
    assert.equal(queryCount, 1);
  });

  it("logs single-ID fallback errors without exposing row content", async () => {
    const id = numberedUuid(202);
    const warnings = [];
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) {
                      const error = new Error("IN query syntax unsupported");
                      error.code = "ERR_UNSUPPORTED_IN_QUERY";
                      throw error;
                    }
                    throw new Error("single lookup database failure");
                  },
                };
              },
            };
          },
        };
      },
    };

    const out = await hydrateGraphResults(dbTable, [
      { entry: { id }, score: 0.5, source: "graph", depth: 1 },
    ], {
      info() {},
      debug() {},
      warn(message) { warnings.push(message); },
    });

    assert.deepEqual(out, []);
    assert.equal(queryCount, 2);
    assert.ok(warnings.some((message) => message.includes("recall-pipeline.getByIds.fallback")));
    assert.equal(warnings.some((message) => message.includes("confidential row payload")), false);
  });

  it("returns within the read deadline and never retries a timed-out IN chunk", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => numberedUuid(203 + index));
    const rawSettlement = Promise.resolve([]);
    const timeout = new TimeoutError("graph endpoint IN read", 10, rawSettlement);
    const laterRead = deferred();
    const warnings = [];
    let queryCount = 0;
    const dbTable = {
      query() {
        return {
          where() {
            queryCount++;
            return {
              limit() {
                return {
                  async toArray() {
                    if (queryCount === 1) throw timeout;
                    return laterRead.promise;
                  },
                };
              },
            };
          },
        };
      },
    };
    const hydration = hydrateGraphResults(dbTable, ids.map((id) => (
      { entry: { id }, score: 0.5, source: "graph", depth: 1 }
    )), {
      info() {},
      warn(message) { warnings.push(message); },
    });
    let deadlineTimer;
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), 50);
    });

    const first = await Promise.race([
      hydration.then((value) => ({ kind: "result", value })),
      deadline,
    ]);
    clearTimeout(deadlineTimer);
    laterRead.resolve([]);
    const out = await hydration;

    assert.equal(first.kind, "result", "the fallback must finish before the overall deadline");
    assert.deepEqual(out, []);
    assert.equal(queryCount, 1, "a timed-out IN chunk must stop later chunks and per-ID fallbacks");
    assert.ok(warnings.some((message) => message.includes("recall-pipeline.getByIds.in")));
  });

  it("propagates every attached hydration timeout after all batch reads settle", async (t) => {
    let releaseRawFirst;
    let releaseRawSecond;
    const rawFirst = new Promise((resolve) => { releaseRawFirst = resolve; });
    const rawSecond = new Promise((resolve) => { releaseRawSecond = resolve; });
    const timeouts = [
      new TimeoutError("graph hydration read 1", 10, rawFirst),
      new TimeoutError("graph hydration read 2", 10, rawSecond),
    ];
    let markSiblingStarted;
    let releaseSibling;
    const siblingStarted = new Promise((resolve) => { markSiblingStarted = resolve; });
    const siblingPending = new Promise((resolve) => { releaseSibling = resolve; });
    const dbTable = {
      query() {
        return {
          where(whereClause) {
            return {
              limit() {
                return {
                  async toArray() {
                    if (/\bIN\b/.test(whereClause)) throw new Error("IN lookup unavailable");
                    if (whereClause.includes("m2")) throw timeouts[0];
                    if (whereClause.includes("m3")) throw timeouts[1];
                    markSiblingStarted();
                    await siblingPending;
                    return [];
                  },
                };
              },
            };
          },
        };
      },
    };
    const results = [
      { entry: { id: "m2" }, score: 0.5, source: "graph", depth: 1 },
      { entry: { id: "m3" }, score: 0.4, source: "graph", depth: 1 },
      { entry: { id: "m4" }, score: 0.3, source: "graph", depth: 1 },
    ];
    t.after(() => {
      releaseSibling();
      releaseRawFirst();
      releaseRawSecond();
    });

    let hydrationSettled = false;
    const hydration = hydrateGraphResults(dbTable, results, console, { strictReadErrors: true })
      .then(
        () => { hydrationSettled = true; throw new Error("expected strict hydration failure"); },
        (error) => { hydrationSettled = true; return error; },
      );
    await siblingStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hydrationSettled, false, "strict hydration waits for every batch read");
    releaseSibling();
    const error = await hydration;
    assert.equal(error, timeouts[0]);

    let rawReadsSettled = false;
    const combinedSettlement = error.settlement.then(() => { rawReadsSettled = true; });
    releaseRawFirst();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rawReadsSettled, false, "combined settlement retains the second timed-out read");
    releaseRawSecond();
    await combinedSettlement;
  });
});
