import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveMemoryRequestContext } from "../lib/memory-request-context.js";
import { runRecallPipeline } from "../lib/recall-pipeline.js";

const IDS = Object.freeze({
  seed: "11111111-1111-4111-8111-111111111111",
  high: "22222222-2222-4222-8222-222222222222",
  low: "33333333-3333-4333-8333-333333333333",
  foreign: "44444444-4444-4444-8444-444444444444",
  disconnectedOne: "55555555-5555-4555-8555-555555555555",
  disconnectedTwo: "66666666-6666-4666-8666-666666666666",
  missingRow: "77777777-7777-4777-8777-777777777777",
  inactive: "88888888-8888-4888-8888-888888888888",
  unbound: "99999999-9999-4999-8999-999999999999",
});

function numberedUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function extractWhereIds(whereClause) {
  if (typeof whereClause !== "string") return new Set();
  const inMatch = whereClause.trim().match(/^id\s+IN\s*\((.+)\)$/i);
  if (inMatch) {
    return new Set(inMatch[1].match(/'([^']*)'/g)?.map((value) => value.slice(1, -1)) ?? []);
  }
  const eqMatch = whereClause.trim().match(/^id\s*=\s*'([^']*)'$/i);
  return eqMatch ? new Set([eqMatch[1]]) : new Set();
}

function makeTable(vectorRows, lookupRows, queryLog = []) {
  return {
    vectorSearch() {
      return { limit() { return { async toArray() { return vectorRows; } }; } };
    },
    query() {
      return {
        where(whereClause) {
          const ids = extractWhereIds(whereClause);
          queryLog.push(ids);
          return {
            limit() {
              return {
                async toArray() {
                  return lookupRows.filter((row) => ids.has(row.id));
                },
              };
            },
          };
        },
      };
    },
  };
}

function makeRow(id, text, ownership = {}) {
  return {
    id,
    text,
    summary: "",
    category: "fact",
    origin: "dm",
    status: "active",
    importance: 0.5,
    memoryStrength: 1,
    _distance: 0,
    ...ownership,
  };
}

function makeOwnerContext() {
  return resolveMemoryRequestContext({
    agentId: "agent-a",
    workspaceId: "workspace:v1:ws-a",
    channel: "telegram",
    accountId: "default",
    userId: "owner",
  });
}

function silence() {
  return { info() {}, warn() {} };
}

describe("B13 recall provider and graph ACL", () => {
  it("fails closed before graph traversal and providers when canonical request context is absent", async () => {
    const seed = makeRow(IDS.seed, "seed", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    });
    const foreign = makeRow(IDS.foreign, "foreign graph secret", {
      scope: "workspace",
      workspaceId: "workspace:v1:ws-b",
      workspaceKey: "workspace:v1:ws-b",
    });
    const embeddingCalls = [];
    const embeddings = {
      async embedQuery(text, context) {
        embeddingCalls.push([text, context]);
        return [1, 0];
      },
      async embed(text, context) {
        embeddingCalls.push([text, context]);
        return [1, 0];
      },
    };

    const result = await runRecallPipeline({
      query: "graph without context",
      dbTable: makeTable([seed], [seed, foreign]),
      embeddings,
      topN: 5,
      budget: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: true,
      graphEdges: [{
        source: IDS.seed,
        target: IDS.foreign,
        type: "semantic",
        strength: 0.9,
        directed: false,
      }],
      graphConfig: { graphHydrationRelevanceThreshold: 0 },
      dedupEnabled: false,
      decisionTrace: true,
      logger: silence(),
    });

    assert.deepEqual(result.memories, []);
    assert.deepEqual(embeddingCalls.map(([text]) => text), ["graph without context"]);
    assert.ok(result.trace.decisions.some((entry) => (
      entry.memoryId === IDS.seed
      && entry.stage === "initial-acl"
      && entry.reason === "acl.request.missing_agent"
    )));
  });

  it("propagates strict graph endpoint read failures instead of returning the seed", async () => {
    const ownerCtx = makeOwnerContext();
    const seed = makeRow(IDS.seed, "seed", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    });
    const neighbor = makeRow(IDS.high, "allowed neighbor", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    });
    const readFailure = new Error("injected graph endpoint read failure");
    const dbTable = {
      vectorSearch() {
        return { limit() { return { async toArray() { return [seed]; } }; } };
      },
      query() {
        return {
          where() {
            return { limit() { return { async toArray() { throw readFailure; } }; } };
          },
        };
      },
    };

    await assert.rejects(
      runRecallPipeline({
        query: "strict graph read",
        dbTable,
        embeddings: {
          async embedQuery() { return [1, 0]; },
          async embed() { return [1, 0]; },
        },
        topN: 5,
        budget: 5,
        importanceBoost: 0,
        canonicalEnabled: false,
        associativeEnabled: true,
        graphEdges: [{
          source: seed.id,
          target: neighbor.id,
          type: "semantic",
          strength: 0.9,
          directed: false,
        }],
        agentId: ownerCtx.agentId,
        workspaceId: ownerCtx.workspaceIdentity,
        userPrincipal: ownerCtx.userPrincipal,
        memoryCtx: ownerCtx,
        strictReadErrors: true,
        dedupEnabled: false,
        logger: silence(),
      }),
      (error) => error === readFailure,
    );
  });

  it("authorizes reachable graph endpoints before traversal and preserves allowed ordering", async () => {
    const ownerCtx = makeOwnerContext();
    const seed = makeRow(IDS.seed, "seed", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    });
    const high = makeRow(IDS.high, "allowed high", {
      scope: "workspace",
      workspaceId: ownerCtx.workspaceIdentity,
      workspaceKey: ownerCtx.workspaceIdentity,
    });
    const low = makeRow(IDS.low, "allowed low", {
      scope: "user",
      ownerUserId: ownerCtx.userPrincipal,
    });
    const foreign = makeRow(IDS.foreign, "foreign secret", {
      scope: "workspace",
      workspaceId: "workspace:v1:ws-b",
      workspaceKey: "workspace:v1:ws-b",
    });
    const disconnectedOne = makeRow(IDS.disconnectedOne, "disconnected one", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    });
    const disconnectedTwo = makeRow(IDS.disconnectedTwo, "disconnected two", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    });
    const graphEdges = [
      { source: IDS.high, target: IDS.low, type: "semantic", strength: 0.5, directed: false },
      { source: IDS.disconnectedOne, target: IDS.disconnectedTwo, type: "semantic", strength: 1, directed: false },
      { source: IDS.seed, target: IDS.foreign, type: "semantic", strength: 0.99, directed: false },
      { source: IDS.seed, target: IDS.high, type: "semantic", strength: 0.9, directed: false },
    ];
    const queryLog = [];
    const embeddingCalls = [];
    const embeddings = {
      async embedQuery(text, context) {
        embeddingCalls.push([text, context]);
        return [1, 0];
      },
      async embed(text, context) {
        embeddingCalls.push([text, context]);
        return [1, 0];
      },
    };

    const result = await runRecallPipeline({
      query: "graph acl",
      dbTable: makeTable([seed], [seed, high, low, foreign, disconnectedOne, disconnectedTwo], queryLog),
      embeddings,
      topN: 10,
      budget: 10,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: true,
      graphEdges,
      graphConfig: { graphHydrationRelevanceThreshold: 0 },
      agentId: ownerCtx.agentId,
      workspaceId: ownerCtx.workspaceIdentity,
      userPrincipal: ownerCtx.userPrincipal,
      memoryCtx: ownerCtx,
      dedupEnabled: false,
      logger: silence(),
    });

    assert.deepEqual(result.memories.map((item) => item.entry.id), [IDS.seed, IDS.high, IDS.low]);
    assert.equal(queryLog.length, 2, "one bounded endpoint read plus one hydration read");
    assert.equal(queryLog[0].has(IDS.disconnectedOne), false, "unreachable endpoints must not be resolved");
    assert.equal(queryLog[0].has(IDS.disconnectedTwo), false, "unreachable endpoints must not be resolved");
    assert.deepEqual(embeddingCalls.map(([text]) => text), ["graph acl", "allowed high", "allowed low"]);
    assert.equal(embeddingCalls.some(([text]) => text === "foreign secret"), false);
    for (const [, context] of embeddingCalls) {
      assert.deepEqual(context, { agentId: "agent-a" });
      assert.ok(Object.isFrozen(context), "all request-bound embedding contexts must be immutable");
    }
  });

  it("caps oversized graph inspection and endpoint resolution before DB or provider work", async () => {
    const ownerCtx = makeOwnerContext();
    const seed = makeRow(IDS.seed, "seed", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    });
    const foreignRows = Array.from({ length: 450 }, (_, index) => makeRow(
      numberedUuid(index + 1),
      `foreign secret ${index + 1}`,
      {
        scope: "workspace",
        workspaceId: "workspace:v1:ws-b",
        workspaceKey: "workspace:v1:ws-b",
      },
    ));
    const graphEdges = foreignRows.map((row) => ({
      source: IDS.seed,
      target: row.id,
      type: "semantic",
      strength: 0.9,
      directed: false,
    }));
    const queryLog = [];
    const embeddingCalls = [];
    const embeddings = {
      async embedQuery(text, context) {
        embeddingCalls.push([text, context]);
        return [1, 0];
      },
      async embed(text, context) {
        embeddingCalls.push([text, context]);
        return [1, 0];
      },
    };

    const result = await runRecallPipeline({
      query: "oversized graph",
      dbTable: makeTable([seed], [seed, ...foreignRows], queryLog),
      embeddings,
      topN: 5,
      budget: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: true,
      graphEdges,
      graphConfig: { graphHydrationRelevanceThreshold: 0 },
      agentId: ownerCtx.agentId,
      workspaceId: ownerCtx.workspaceIdentity,
      userPrincipal: ownerCtx.userPrincipal,
      memoryCtx: ownerCtx,
      decisionTrace: true,
      logger: silence(),
    });

    assert.deepEqual(result.memories.map((item) => item.entry.id), [IDS.seed]);
    assert.equal(queryLog.length, 2, "200 endpoints must use exactly two bounded IN queries");
    assert.ok(queryLog.every((ids) => ids.size <= 100), "each IN query must stay within safeUuidList's limit");
    const queriedIds = new Set(queryLog.flatMap((ids) => [...ids]));
    assert.equal(queriedIds.size, 200, "each selected endpoint must be queried once without fallback reloads");
    assert.equal(queriedIds.has(numberedUuid(400)), false, "endpoint-cap tail must not reach the DB");
    assert.equal(queriedIds.has(numberedUuid(450)), false, "edge-inspection tail must not reach the DB");
    assert.deepEqual(embeddingCalls, [["oversized graph", { agentId: "agent-a" }]]);
    assert.ok(
      result.trace.guards.some((guard) => guard.name === "graph_acl_endpoint_cap" && guard.passed === false),
      "oversized tails must be visible in the decision trace",
    );
  });

  it("denies and traces missing, inactive, and unbound graph endpoints before providers", async () => {
    const ownerCtx = makeOwnerContext();
    const seed = makeRow(IDS.seed, "seed", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
    });
    const inactive = makeRow(IDS.inactive, "inactive secret", {
      scope: "agent-private",
      agentId: "agent-a",
      storedBy: "agent-a",
      status: "archived",
    });
    const unbound = makeRow(IDS.unbound, "unbound secret", {
      scope: "agent-private",
    });
    const graphEdges = [IDS.missingRow, IDS.inactive, IDS.unbound].map((target) => ({
      source: IDS.seed,
      target,
      type: "semantic",
      strength: 0.9,
      directed: false,
    }));
    const embeddingCalls = [];
    const embeddings = {
      async embedQuery(text, context) {
        embeddingCalls.push([text, context]);
        return [1, 0];
      },
      async embed(text, context) {
        embeddingCalls.push([text, context]);
        return [1, 0];
      },
    };

    const result = await runRecallPipeline({
      query: "endpoint trace",
      dbTable: makeTable([seed], [seed, inactive, unbound]),
      embeddings,
      topN: 5,
      budget: 5,
      importanceBoost: 0,
      canonicalEnabled: false,
      associativeEnabled: true,
      graphEdges,
      graphConfig: { graphHydrationRelevanceThreshold: 0 },
      agentId: ownerCtx.agentId,
      workspaceId: ownerCtx.workspaceIdentity,
      userPrincipal: ownerCtx.userPrincipal,
      memoryCtx: ownerCtx,
      dedupEnabled: false,
      decisionTrace: true,
      logger: silence(),
    });

    assert.deepEqual(result.memories.map((item) => item.entry.id), [IDS.seed]);
    assert.deepEqual(embeddingCalls.map(([text]) => text), ["endpoint trace"]);
    assert.ok(result.trace.decisions.some((entry) => (
      entry.memoryId === IDS.missingRow
      && entry.stage === "graph-endpoint-acl"
      && entry.reason === "missing endpoint row"
    )));
    assert.ok(result.trace.decisions.some((entry) => (
      entry.memoryId === IDS.inactive
      && entry.stage === "graph-endpoint-acl"
      && entry.reason === "inactive status: archived"
    )));
    assert.ok(result.trace.decisions.some((entry) => (
      entry.memoryId === IDS.unbound
      && entry.stage === "graph-endpoint-acl"
      && entry.reason === "acl.agent_private.missing_owner"
    )));
  });
});
