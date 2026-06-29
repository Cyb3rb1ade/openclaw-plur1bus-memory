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

test("pending sync does not swallow the active sync error", async () => {
  let calls = 0;
  const { service } = makeService({
    onSync: async () => {
      calls++;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("boom");
      }
    },
  });

  const first = service.syncOnce();
  const pending = service.syncOnce();

  await pending;
  await assert.rejects(first, /boom/, "first sync must reject even when a pending sync runs afterward");
  assert.strictEqual(calls, 2, "failed active sync plus one pending follow-up should run");
});

test("manual successful sync resumes watch loop after failure suspension", async () => {
  let calls = 0;
  let fail = true;
  const { service } = makeService({
    onSync: async () => {
      calls++;
      if (fail) throw new Error("boom");
    },
  });

  await service.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 5600));
    const suspendedAt = calls;
    assert.ok(suspendedAt >= 5, `expected watch to hit failure suspension, got ${suspendedAt} calls`);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.strictEqual(calls, suspendedAt, "watch should be suspended after repeated failures");

    fail = false;
    await service.syncOnce();
    const afterManual = calls;
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.ok(calls > afterManual, "manual successful sync should resume future watch ticks");
  } finally {
    await service.stop();
  }
});
