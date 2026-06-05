import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { runReminderDispatch } from "../lib/jobs/reminder-dispatch.js";
import { readPendingReminders, clearPendingReminders } from "../lib/reminder-pending.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("reminder-dispatch", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dispatch-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockDb(reminders = []) {
    let _data = [...reminders];
    return {
      init: async () => {},
      table: {
        query: () => mockDb(reminders).table,
        where: function() { return this; },
        limit: function() { return this; },
        toArray: async () => _data,
        update: async ({ where, values }) => {
          const idMatch = where.match(/id\s*=\s*'([^']+)'/);
          const targetId = idMatch ? idMatch[1] : null;
          _data = _data.map(row => (row.id === targetId ? { ...row, ...values } : row));
        },
      },
    };
  }

  it("dispatches due reminders to pending queue", async () => {
    const now = Date.now();
    const db = mockDb([
      { id: "11111111-1111-1111-1111-111111111111", memoryKind: "reminder", storedBy: "agent-1", workspaceKey: "ws-1", remindAt: now - 1000, reminderStatus: "scheduled" },
    ]);

    const result = await runReminderDispatch(db, "agent-1", {
      workspaceDir: tmpDir,
      workspaceKey: "ws-1",
      deliveryMode: "pending_only",
    });

    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.dispatched, 1);

    const pending = await readPendingReminders(tmpDir, "ws-1", "agent-1");
    assert.ok(pending.pending["11111111-1111-1111-1111-111111111111"], "reminder should be in pending queue");
  });

  it("is idempotent on retry", async () => {
    const now = Date.now();
    const db = mockDb([
      { id: "11111111-1111-1111-1111-111111111111", memoryKind: "reminder", storedBy: "agent-1", workspaceKey: "ws-1", remindAt: now - 1000, reminderStatus: "scheduled" },
    ]);

    await runReminderDispatch(db, "agent-1", { workspaceDir: tmpDir, workspaceKey: "ws-1", deliveryMode: "pending_only" });
    await runReminderDispatch(db, "agent-1", { workspaceDir: tmpDir, workspaceKey: "ws-1", deliveryMode: "pending_only" });

    const pending = await readPendingReminders(tmpDir, "ws-1", "agent-1");
    assert.strictEqual(Object.keys(pending.pending).length, 1, "should not duplicate");
  });

  it("respects rate limit on second run", async () => {
    const now = Date.now();
    const db = mockDb([]);

    await runReminderDispatch(db, "agent-1", { workspaceDir: tmpDir, workspaceKey: "ws-1", deliveryMode: "pending_only" });
    const result2 = await runReminderDispatch(db, "agent-1", { workspaceDir: tmpDir, workspaceKey: "ws-1", deliveryMode: "pending_only" });
    assert.strictEqual(result2.skipped, true);
    assert.strictEqual(result2.reason, "rate_limited");
  });
});
