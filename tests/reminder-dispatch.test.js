import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { runReminderDispatch } from "../lib/jobs/reminder-dispatch.js";
import { readPendingReminders, clearPendingReminders } from "../lib/reminder-pending.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDir } from "./helpers/temp-dir.js";
import { bindHostNetwork, resetHostNetwork } from "../lib/host-network.js";

describe("reminder-dispatch", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = makeTempDir("dispatch-");
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

  it("cleans up stale locks using the dispatch lockStaleMs", async () => {
    const db = mockDb([]);
    const locksDir = join(tmpDir, "locks");
    mkdirSync(locksDir, { recursive: true });
    const lockPath = join(locksDir, "reminder-dispatch-agent-1.lock");
    writeFileSync(lockPath, "stale", "utf8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const result = await runReminderDispatch(db, "agent-1", {
      workspaceDir: tmpDir,
      workspaceKey: "ws-1",
      deliveryMode: "pending_only",
      lockStaleMs: 1,
    });

    assert.strictEqual(result.skipped, false);
    assert.strictEqual(existsSync(lockPath), false);
  });
});

// F5 (engine-jobs audit): the webhook POST and the status write share one try.
// A failing status write after a delivered POST used to land in the catch,
// which marked the row `failed` with a retry time, so the next sweep POSTed the
// same reminder again, without bound.
describe("reminder-dispatch webhook re-delivery", () => {
  const ID = "22222222-2222-2222-2222-222222222222";
  let tmpDir;
  beforeEach(() => { tmpDir = makeTempDir("dispatch-webhook-"); });
  afterEach(() => {
    resetHostNetwork();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Faithful enough for the dispatcher: id lookups return that row, any other
  // query returns what listDueReminders would select.
  function statefulDb({ failDispatchedUpdates = 0 } = {}) {
    const row = { id: ID, memoryKind: "reminder", storedBy: "agent-1", workspaceKey: "ws-1", remindAt: Date.now() - 1000, reminderStatus: "scheduled", dispatchCount: 0, nextDispatchAttemptAt: 0 };
    let failuresLeft = failDispatchedUpdates;
    const db = {
      row,
      init: async () => {},
      table: {
        query() {
          let byId = false;
          const q = {
            where(expr) { byId = /^id\s*=/.test(expr); return q; },
            limit() { return q; },
            toArray: async () => {
              if (byId) return [{ ...row }];
              const due = ["scheduled", "due"].includes(row.reminderStatus)
                || (row.reminderStatus === "failed" && row.nextDispatchAttemptAt > 0 && row.nextDispatchAttemptAt <= Date.now());
              return due ? [{ ...row }] : [];
            },
          };
          return q;
        },
        update: async ({ values }) => {
          if (values.reminderStatus === "dispatched" && failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error("NEO write backpressure");
          }
          Object.assign(row, values);
        },
      },
    };
    return db;
  }

  async function sweep(db, opts = {}) {
    // The dispatcher rate-limits to one run per 5 minutes and parks failed rows
    // for 5 minutes; make both elapse so that every sweep is a real retry.
    rmSync(join(tmpDir, "run-state.json"), { force: true });
    if (db.row.nextDispatchAttemptAt > 0) db.row.nextDispatchAttemptAt = Date.now() - 1;
    return runReminderDispatch(db, "agent-1", {
      workspaceDir: tmpDir, workspaceKey: "ws-1", deliveryMode: "webhook", webhookUrl: "https://hooks.example.test/reminder", ...opts,
    });
  }

  it("does not POST again when only the status write after a successful POST failed", async () => {
    let posts = 0;
    bindHostNetwork({ fetch: async () => { posts += 1; return new Response("ok", { status: 200 }); } });
    const db = statefulDb({ failDispatchedUpdates: 100 });
    for (let i = 0; i < 4; i++) await sweep(db);
    assert.strictEqual(posts, 1, "one delivered POST must stay one POST");
    assert.notStrictEqual(db.row.reminderStatus, "failed", "a delivered reminder is not a failed one");
  });

  it("settles on dispatched when the status write succeeds on the immediate retry", async () => {
    let posts = 0;
    bindHostNetwork({ fetch: async () => { posts += 1; return new Response("ok", { status: 200 }); } });
    const db = statefulDb({ failDispatchedUpdates: 1 });
    await sweep(db);
    await sweep(db);
    assert.strictEqual(posts, 1);
    assert.strictEqual(db.row.reminderStatus, "dispatched");
  });

  it("stops re-sending a webhook that keeps failing after the attempt cap", async () => {
    let posts = 0;
    bindHostNetwork({ fetch: async () => { posts += 1; throw new Error("ECONNREFUSED"); } });
    const db = statefulDb();
    for (let i = 0; i < 10; i++) await sweep(db);
    assert.strictEqual(posts, 5, "default cap is 5 delivery attempts");
    assert.strictEqual(db.row.reminderStatus, "failed");
    assert.strictEqual(db.row.nextDispatchAttemptAt, 0, "no further retry is scheduled");
  });

  it("honours a custom cap via maxDispatchAttempts", async () => {
    let posts = 0;
    bindHostNetwork({ fetch: async () => { posts += 1; throw new Error("ECONNREFUSED"); } });
    const db = statefulDb();
    for (let i = 0; i < 6; i++) await sweep(db, { maxDispatchAttempts: 2 });
    assert.strictEqual(posts, 2);
  });

  it("keeps the legitimate retry: a transient webhook failure is re-sent and then dispatched", async () => {
    let posts = 0;
    bindHostNetwork({ fetch: async () => { posts += 1; if (posts === 1) throw new Error("ECONNRESET"); return new Response("ok", { status: 200 }); } });
    const db = statefulDb();
    await sweep(db);
    assert.strictEqual(db.row.reminderStatus, "failed");
    assert.ok(db.row.nextDispatchAttemptAt > 0, "a transient failure schedules a retry");
    await sweep(db);
    assert.strictEqual(posts, 2);
    assert.strictEqual(db.row.reminderStatus, "dispatched");
  });

  it("sends a stable Idempotency-Key so that a receiver can drop duplicates", async () => {
    const seen = [];
    bindHostNetwork({ fetch: async (_url, init) => { seen.push(init.headers["Idempotency-Key"]); return new Response("ok", { status: 200 }); } });
    await sweep(statefulDb());
    assert.deepStrictEqual(seen, [ID]);
  });
});
