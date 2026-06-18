import { test } from "node:test";
import assert from "node:assert/strict";
import { createObsidianBridgeService } from "../lib/obsidian-bridge.js";

function makeService(overrides = {}) {
  const calls = [];
  const service = createObsidianBridgeService(
    {
      enabled: true,
      watch: true,
      intervalMs: 10,
      workspaces: [{ workspace_id: "ws1", agent_id: "a1", path: "/tmp" }],
      ...overrides.config,
    },
    {
      syncWorkspace: async (workspace, opts) => {
        calls.push({ workspace, opts });
        if (overrides.onSync) await overrides.onSync(workspace, opts);
        return { actions: [] };
      },
      logger: { info() {}, warn() {} },
      ...overrides.options,
    },
  );
  return { service, calls };
}

test("overlapping interval calls start only one active sync", async () => {
  let active = 0;
  let maxActive = 0;

  const { service } = makeService({
    onSync: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    },
  });

  const p1 = service.syncOnce();
  const p2 = service.syncOnce();
  const p3 = service.syncOnce();
  await Promise.all([p1, p2, p3]);

  assert.ok(maxActive === 1, "only one sync should be active at a time");
});

test("pending tick is completed exactly once after the active sync finishes", async () => {
  const { service, calls } = makeService({
    onSync: async () => {
      await new Promise((r) => setTimeout(r, 10));
    },
  });

  const p1 = service.syncOnce();
  const p2 = service.syncOnce();
  const p3 = service.syncOnce();
  await Promise.all([p1, p2, p3]);

  // Erster Lauf + genau ein pending-Nachholer; weitere Calls während pending
  // werden zusammengefasst, da pendingSync ein Boolean ist.
  assert.strictEqual(calls.length, 2, "exactly one pending sync should run after completion");
});

test("sync error resets syncRunning so the next tick can run", async () => {
  let calls = 0;
  const { service } = makeService({
    onSync: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    },
  });

  let firstError = null;
  try {
    await service.syncOnce();
  } catch (e) {
    firstError = e;
  }
  assert.ok(firstError, "first sync should throw");

  const second = await service.syncOnce();
  assert.ok(second, "second sync should run after error reset");
  assert.strictEqual(calls, 2, "two sync calls should have executed");
});
