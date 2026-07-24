import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storeSharedMemory } from "../lib/shared-memory.js";

function db() {
  const rows = []; const fields = ["id", "text", "vector", "agentId", "workspaceId"].map((name) => ({ name, type: {} }));
  return { vectorDim: 2, rows, async init() {}, async refreshSchemaFields() {}, table: {
    async schema() { return { fields }; }, async addColumns(cols) { fields.push(...cols); },
    query() { return { where: () => ({ limit: () => ({ toArray: async () => [] }) }) }; },
  }, async store(row) { rows.push(row); }, async getById(id) { return rows.find((row) => row.id === id); } };
}
const source = { id: "11111111-1111-4111-8111-111111111111", agentId: "agent-1", text: "fact", status: "active" };

describe("storeSharedMemory safety guard", () => {
  it("rejects core and neverForget memories without explicit sensitive approval", async () => {
    for (const extra of [{ memoryClass: "core" }, { neverForget: 1 }]) {
      await assert.rejects(() => storeSharedMemory(db(), { ...source, ...extra }, { workspaceIdentity: "ws" }, { targetScope: "workspace", sourceAgentId: "agent-1", vector: [1, 2] }), /sensitive shared memory requires explicit approval/);
    }
  });
  it("rejects sensitive category and type independently", async () => {
    await assert.rejects(() => storeSharedMemory(db(), { ...source, category: "note", type: "password" }, { workspaceIdentity: "ws" }, { targetScope: "workspace", sourceAgentId: "agent-1", vector: [1, 2] }), /sensitive shared memory requires explicit approval/);
  });
});
