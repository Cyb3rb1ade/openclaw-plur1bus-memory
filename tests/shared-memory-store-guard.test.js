import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { storeSharedMemory } from "../lib/shared-memory.js";

function makePool() {
  const stored = [];
  return {
    stored,
    pool: {
      getDb() {
        return {
          store: async (entry) => {
            stored.push(entry);
          },
        };
      },
    },
  };
}

describe("storeSharedMemory safety guard", () => {
  it("rejects core and neverForget memories without explicit sensitive approval", async () => {
    const { pool, stored } = makePool();

    await assert.rejects(
      () => storeSharedMemory(pool, "agent-1", "critical private fact", { memoryClass: "core" }),
      /sensitive shared memory requires explicit approval/,
    );
    await assert.rejects(
      () => storeSharedMemory(pool, "agent-1", "critical private fact", { neverForget: 1 }),
      /sensitive shared memory requires explicit approval/,
    );
    assert.deepStrictEqual(stored, []);
  });

  it("rejects sensitive critical-push categories without explicit sensitive approval", async () => {
    const { pool, stored } = makePool();

    await assert.rejects(
      () => storeSharedMemory(pool, "agent-1", "Erik password lives in the vault", { category: "password" }),
      /sensitive shared memory requires explicit approval/,
    );
    await assert.rejects(
      () => storeSharedMemory(pool, "agent-1", "Remember this person", { criticalPushType: "person" }),
      /sensitive shared memory requires explicit approval/,
    );
    assert.deepStrictEqual(stored, []);
  });

  it("allows sensitive shared memories only when explicitly approved", async () => {
    const { pool, stored } = makePool();

    const result = await storeSharedMemory(pool, "agent-1", "approved shared fact", {
      category: "password",
      allowSensitiveShare: true,
      id: "shared-1",
    });

    assert.deepStrictEqual(result, { ok: true, id: "shared-1" });
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].scope, "workspace_shared");
  });
});
