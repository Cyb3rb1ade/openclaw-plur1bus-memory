import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shareCard } from "../lib/telegram-commands/memory-edit.js";

const source = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111", text: "shareable fact", summary: "fact",
  scope: "agent-private", agentId: "agent-a", storedBy: "agent-a", status: "active",
  category: "note", type: "fact", origin: "dm", importance: 0.5, createdAt: 1,
  expiresAt: 0, vector: [0.1, 0.2, 0.3, 0.4],
});

function targetDb(rows = []) {
  const fields = ["id", "text", "vector", "agentId", "workspaceId"].map((name) => ({ name, type: { name: name === "vector" ? "fixed" : "utf8" } }));
  return {
    vectorDim: 4, rows, table: {
      async schema() { return { fields }; },
      async addColumns(columns) { for (const column of columns) fields.push({ name: column.name, type: column.type }); },
      query() { return { where: () => ({ limit: () => ({ toArray: async () => rows.filter((row) => row.shareIdempotencyKey) }) }) }; },
    },
    async init() {}, async refreshSchemaFields() {},
    async getById(id) { return rows.find((row) => row.id === id) || null; },
    async store(row) { rows.push(row); },
  };
}

describe("B13 shared-copy storage", () => {
  it("stores one complete workspace copy for parallel identical promotions", async () => {
    const rows = []; const target = targetDb(rows); let sourceLeases = 0;
    const privatePool = { async withWriteDb(agent, fn) { sourceLeases++; assert.equal(agent, "agent-a"); return fn({ init: async () => {}, getById: async () => source }); } };
    const sharedPool = { async withWorkspaceDb(ctx, fn) { assert.equal(ctx.workspaceIdentity, "workspace-a"); return fn(target); } };
    const embeddings = { async embed(text, ctx) { assert.equal(text, source.text); assert.deepEqual(ctx, { agentId: "agent-a" }); return [0.25, 0.5, 0.75, 1]; } };
    const opts = { ctx: { agentId: "agent-a", workspaceIdentity: "workspace-a" }, targetScope: "workspace" };
    const results = await Promise.all([shareCard(privatePool, sharedPool, embeddings, "agent-a", source.id, opts), shareCard(privatePool, sharedPool, embeddings, "agent-a", source.id, opts)]);
    assert.equal(new Set(results.map((result) => result.sharedId)).size, 1);
    assert.equal(rows.length, 1); assert.deepEqual(rows[0].vector, [0.25, 0.5, 0.75, 1]);
    assert.equal(rows[0].scope, "workspace"); assert.equal(rows[0].agentId, "agent-a");
    assert.equal(rows[0].workspaceId, "workspace-a"); assert.equal(rows[0].workspaceKey, "workspace-a");
    assert.equal(rows[0].ownerUserId, ""); assert.equal(rows[0].sourceMemoryId, source.id);
    assert.equal(rows[0].sourceAgentId, "agent-a"); assert.ok(rows[0].shareIdempotencyKey); assert.equal(sourceLeases, 2);
  });

  it("stores an owner-bound user copy in the user pool", async () => {
    const rows = []; const target = targetDb(rows);
    const privatePool = { async withWriteDb(_agent, fn) { return fn({ init: async () => {}, getById: async () => source }); } };
    const sharedPool = { async withUserDb(ctx, fn) { assert.equal(ctx.userPrincipal, "user-a"); return fn(target); } };
    const result = await shareCard(privatePool, sharedPool, { embed: async () => [0.25, 0.5, 0.75, 1] }, "agent-a", source.id, { targetScope: "user", ctx: { agentId: "agent-a", userPrincipal: "user-a" } });
    assert.equal(result.ok, true); assert.equal(rows[0].scope, "user"); assert.equal(rows[0].agentId, "agent-a");
    assert.equal(rows[0].workspaceId, ""); assert.equal(rows[0].workspaceKey, ""); assert.equal(rows[0].ownerUserId, "user-a");
  });
});
