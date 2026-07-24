import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  canonicalMemoryOriginKey,
  mergeNamespaceRecallResults,
  runRecallPipeline,
} from "../lib/recall-pipeline.js";
import { withAccessReadDbs } from "../lib/shared-memory.js";
import {
  projectMemoryQueryCard,
  queryMemoryAcrossAccessPools,
} from "../lib/telegram-commands/memory-query.js";

function tableFor(rows, calls = []) {
  return {
    vectorSearch(vector) {
      calls.push(["vectorSearch", vector]);
      return {
        where(clause) { calls.push(["where", clause]); return this; },
        limit(limit) { calls.push(["limit", limit]); return this; },
        async toArray() { return rows; },
      };
    },
    query() {
      return {
        where(clause) { calls.push(["where", clause]); return this; },
        limit(limit) { calls.push(["limit", limit]); return this; },
        async toArray() { return rows; },
      };
    },
  };
}

function dbFor(rows, calls = []) {
  return {
    table: tableFor(rows, calls),
    async init() { calls.push(["init"]); return true; },
  };
}

describe("B13 authorized shared recall composition", () => {
  it("keeps private reads and adds only bound optional access pools", async () => {
    const privatePool = {
      async withReadDbs(agentId, fn) {
        assert.equal(agentId, "agent-a");
        return fn([{ namespace: "active", db: { id: "private" } }]);
      },
    };
    const leased = [];
    const sharedPool = {
      async withWorkspaceReadDb(ctx, fn) {
        leased.push(["workspace", ctx.workspaceIdentity]);
        return fn({ id: "workspace" });
      },
      async withUserReadDb(ctx, fn) {
        leased.push(["user", ctx.userPrincipal]);
        return fn({ id: "user" });
      },
    };

    const privateOnly = await withAccessReadDbs(privatePool, sharedPool, "agent-a", {}, async (sources) => sources);
    assert.deepEqual(privateOnly.map((source) => source.sourceKind), ["private"]);

    const workspaceOnly = await withAccessReadDbs(
      privatePool, sharedPool, "agent-a", { workspaceIdentity: "workspace-a" }, async (sources) => sources,
    );
    assert.deepEqual(workspaceOnly.map((source) => source.sourceKind), ["private", "workspace"]);

    const userOnly = await withAccessReadDbs(
      privatePool, sharedPool, "agent-a", { userPrincipal: "user-a" }, async (sources) => sources,
    );
    assert.deepEqual(userOnly.map((source) => source.sourceKind), ["private", "user"]);

    const all = await withAccessReadDbs(
      privatePool,
      sharedPool,
      "agent-a",
      { workspaceIdentity: "workspace-a", userPrincipal: "user-a" },
      async (sources) => sources,
    );
    assert.deepEqual(all.map((source) => source.sourceKind), ["private", "workspace", "user"]);
    assert.deepEqual(leased, [
      ["workspace", "workspace-a"],
      ["user", "user-a"],
      ["workspace", "workspace-a"],
      ["user", "user-a"],
    ]);
  });

  it("isolates optional acquisition failures without swallowing entered callback failures", async () => {
    const warnings = [];
    const privatePool = {
      withReadDbs(_agentId, fn) { return fn([{ namespace: "active", db: { id: "private" } }]); },
    };
    const sharedPool = {
      withWorkspaceReadDb() { throw new Error("workspace acquisition"); },
      withUserReadDb(_ctx, fn) { return fn({ id: "user" }); },
    };
    const sources = await withAccessReadDbs(
      privatePool,
      sharedPool,
      "agent-a",
      { workspaceIdentity: "workspace-a", userPrincipal: "user-a", logger: { warn: (message) => warnings.push(message) } },
      async (items) => items,
    );
    assert.deepEqual(sources.map((source) => source.sourceKind), ["private", "user"]);
    assert.equal(warnings.length, 1);

    await assert.rejects(
      () => withAccessReadDbs(
        privatePool,
        { withWorkspaceReadDb(_ctx, fn) { return fn({ id: "workspace" }); } },
        "agent-a",
        { workspaceIdentity: "workspace-a" },
        async () => { throw new Error("query failed"); },
      ),
      /query failed/,
    );
  });

  it("deduplicates canonical origins before the one global cap with stable source priority", () => {
    const privateEntry = { id: "source-id", agentId: "agent-a", text: "same origin" };
    const workspaceEntry = {
      id: "workspace-copy", sourceAgentId: "agent-a", sourceMemoryId: "source-id", text: "same origin",
    };
    const userEntry = {
      id: "user-copy", sourceAgentId: "agent-a", sourceMemoryId: "source-id", text: "same origin",
    };
    assert.equal(canonicalMemoryOriginKey(privateEntry), "agent-a:source-id");
    assert.equal(canonicalMemoryOriginKey(workspaceEntry), "agent-a:source-id");

    const merged = mergeNamespaceRecallResults([
      { namespace: "shared-user", sourceKind: "user", memories: [{ entry: userEntry, score: 0.99 }] },
      { namespace: "shared-workspace", sourceKind: "workspace", memories: [{ entry: workspaceEntry, score: 0.98 }] },
      { namespace: "active", sourceKind: "private", memories: [
        { entry: privateEntry, score: 0.5 },
        { entry: { id: "other", agentId: "agent-a", text: "unrelated" }, score: 0.8 },
      ] },
    ], { maxOut: 2, dedupEnabled: false });

    assert.deepEqual(merged.memories.map((item) => item.entry.id), ["other", "source-id"]);
  });

  it("filters malformed and boundary expiry before downstream content embedding", async () => {
    const now = 10_000;
    const passageCalls = [];
    const rows = [
      { id: "live", text: "live", agentId: "agent-a", status: "active", expiresAt: now + 1, _distance: 0 },
      { id: "boundary", text: "boundary", agentId: "agent-a", status: "active", expiresAt: now, _distance: 0 },
      { id: "malformed", text: "malformed", agentId: "agent-a", status: "active", expiresAt: "20000", _distance: 0 },
    ];
    const result = await runRecallPipeline({
      query: "query",
      dbTable: tableFor(rows),
      embeddings: {
        embedQuery: async (_text, ctx) => { assert.deepEqual(ctx, { agentId: "agent-a" }); return [1]; },
        embed: async (text, ctx) => { passageCalls.push([text, ctx]); return [1]; },
      },
      agentId: "agent-a",
      memoryCtx: { agentId: "agent-a" },
      now,
      topN: 10,
      budget: 10,
      recallMinScore: 0,
      canonicalEnabled: false,
      associativeEnabled: false,
      dedupEnabled: false,
    });
    assert.deepEqual(result.memories.map((item) => item.entry.id), ["live"]);
    assert.equal(passageCalls.some(([text]) => text === "malformed" || text === "boundary"), false);
  });
});

describe("B13 /memory access-pool parity", () => {
  it("projects formatter and ownership fields without losing lifecycle metadata", () => {
    const card = projectMemoryQueryCard({
      id: "id-a",
      summary: "A useful title\nmore",
      origin: "voice",
      createdAt: Date.UTC(2026, 6, 1),
      sourceAgentId: "agent-a",
      sourceMemoryId: "source-a",
      expiresAt: 0,
      type: "fact",
      memoryKind: "memory",
    });
    assert.equal(card.title, "A useful title");
    assert.equal(card.source, "sprachnotiz");
    assert.equal(card.date, "2026-07-01");
    assert.equal(card.sourceAgentId, "agent-a");
    assert.equal(card.sourceMemoryId, "source-a");
    assert.equal(card.expiresAt, 0);
  });

  it("uses request-bound query embeddings, ACL/lifecycle gates, global origin dedup, and one hard source bound", async () => {
    const now = Date.now();
    const calls = [];
    const origin = {
      text: "topic",
      summary: "topic",
      status: "active",
      expiresAt: now + 1_000,
      createdAt: now,
      origin: "dm",
      _distance: 0,
    };
    const privateDb = dbFor([{ ...origin, id: "source", agentId: "agent-a" }], calls);
    const workspaceDb = dbFor([{
      ...origin,
      id: "workspace-copy",
      sourceAgentId: "agent-a",
      sourceMemoryId: "source",
      scope: "workspace",
      workspaceId: "workspace-a",
    }], calls);
    const userDb = dbFor([{
      ...origin,
      id: "user-copy",
      sourceAgentId: "agent-a",
      sourceMemoryId: "source",
      scope: "user",
      ownerUserId: "user-a",
    }], calls);
    const privatePool = { withReadDbs(_agent, fn) { return fn([{ namespace: "active", db: privateDb }]); } };
    const sharedPool = {
      withWorkspaceReadDb(_ctx, fn) { return fn(workspaceDb); },
      withUserReadDb(_ctx, fn) { return fn(userDb); },
    };
    const embeddingCalls = [];
    const cards = await queryMemoryAcrossAccessPools({
      privatePool,
      sharedPool,
      embeddings: {
        embedQuery: async (text, ctx) => { embeddingCalls.push([text, ctx]); return [1]; },
        embed: async () => { throw new Error("topic queries must preserve query purpose"); },
      },
      agent: "agent-a",
      parsed: { mode: "topic", topic: "topic", filters: { category: "fact" } },
      ctx: { agentId: "agent-a", workspaceIdentity: "workspace-a", userPrincipal: "user-a" },
      now,
    });
    assert.deepEqual(embeddingCalls, [["topic", { agentId: "agent-a" }]]);
    assert.deepEqual(cards.map((card) => card.id), ["source"]);
    assert.equal(calls.filter(([name, value]) => name === "limit" && value === 100).length, 3);
    assert.equal(calls.some(([name, value]) => name === "where" && /expiresAt >/.test(value)), true);
  });
});
