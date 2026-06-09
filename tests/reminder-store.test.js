import { describe, it } from "node:test";
import assert from "node:assert";
import { saveReminder, listDueReminders, acknowledgeReminder, cancelReminder, markReminderPending, presentReminder } from "../lib/reminder-store.js";

// Realistischer Mock mit where-Filterung
describe("reminder-store", () => {
  function mockDb(initial = []) {
    let _data = [...initial];

    function makeQueryBuilder() {
      let _filter = null;
      let _limit = null;

      function parseExpr(expr) {
        return (row) => {
          const parts = expr.split(/\s+AND\s+/i);
          return parts.every(part => {
            part = part.trim();
            // IN clause
            const inMatch = part.match(/(\w+)\s+IN\s+\(([^)]+)\)/i);
            if (inMatch) {
              const col = inMatch[1];
              const vals = inMatch[2].split(",").map(s => s.trim().replace(/^'|'$/g, ""));
              return vals.includes(String(row[col]));
            }
            // <= comparison
            const leMatch = part.match(/(\w+)\s*<=\s*(.+)/);
            if (leMatch) {
              const col = leMatch[1];
              const val = parseFloat(leMatch[2]);
              return (row[col] ?? 0) <= val;
            }
            // > comparison
            const gtMatch = part.match(/(\w+)\s*>(\s*\d+)/);
            if (gtMatch) {
              const col = gtMatch[1];
              const val = parseFloat(gtMatch[2]);
              return (row[col] ?? 0) > val;
            }
            // Equality
            const eqMatch = part.match(/(\w+)\s*=\s*(.+)/);
            if (eqMatch) {
              const col = eqMatch[1];
              let val = eqMatch[2].trim();
              if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
              return String(row[col]) === val;
            }
            return true;
          });
        };
      }

      return {
        where(expr) {
          _filter = parseExpr(expr);
          return this;
        },
        limit(n) {
          _limit = n;
          return this;
        },
        async toArray() {
          let results = _data;
          if (_filter) results = results.filter(_filter);
          if (_limit) results = results.slice(0, _limit);
          return results;
        },
      };
    }

    return {
      table: {
        add: async (items) => { _data.push(...items); },
        query: () => makeQueryBuilder(),
        update: async ({ where: _where, values }) => {
          const idMatch = _where.match(/id\s*=\s*'([^']+)'/);
          const targetId = idMatch ? idMatch[1] : null;
          _data = _data.map(row => {
            if (targetId && row.id === targetId) return { ...row, ...values };
            return row;
          });
        },
      },
      store: async (raw) => {
        _data.push(raw);
        return raw;
      },
      embeddings: { embedQuery: async () => new Array(384).fill(0.1) },
    };
  }

  it("saves reminder with full defaults", async () => {
    const db = mockDb();
    const now = Date.now();
    const r = await saveReminder(db, {
      text: "Check PR",
      remindAt: now + 60000,
      agentId: "agent-1",
      workspaceKey: "ws-1",
    });
    assert.strictEqual(r.memoryKind, "reminder");
    assert.strictEqual(r.reminderStatus, "scheduled");
    assert.strictEqual(r.remindAt, now + 60000);
    assert.strictEqual(r.storedBy, "agent-1");
    assert.strictEqual(r.workspaceKey, "ws-1");
    assert.ok(r.reminderKey, "has reminderKey");
    assert.strictEqual(r.status, "active");
    assert.strictEqual(r.versionNumber, 1);
  });

  it("lists due reminders filtered by workspace+agent", async () => {
    const now = Date.now();
    const db = mockDb([
      { id: "11111111-1111-1111-1111-111111111111", memoryKind: "reminder", storedBy: "agent-1", workspaceKey: "ws-1", remindAt: now - 1000, reminderStatus: "scheduled" },
      { id: "22222222-2222-2222-2222-222222222222", memoryKind: "reminder", storedBy: "agent-1", workspaceKey: "ws-1", remindAt: now + 60000, reminderStatus: "scheduled" },
      { id: "33333333-3333-3333-3333-333333333333", memoryKind: "memory", storedBy: "agent-1", workspaceKey: "ws-1" },
      { id: "44444444-4444-4444-4444-444444444444", memoryKind: "reminder", storedBy: "agent-2", workspaceKey: "ws-1", remindAt: now - 1000, reminderStatus: "scheduled" },
      { id: "55555555-5555-5555-5555-555555555555", memoryKind: "reminder", storedBy: "agent-1", workspaceKey: "ws-2", remindAt: now - 1000, reminderStatus: "scheduled" },
    ]);
    const due = await listDueReminders(db, "agent-1", "ws-1", now);
    assert.strictEqual(due.length, 1);
    assert.strictEqual(due[0].id, "11111111-1111-1111-1111-111111111111");
  });

  it("acknowledge sets status and timestamp", async () => {
    const db = mockDb([{ id: "11111111-1111-1111-1111-111111111111", memoryKind: "reminder", reminderStatus: "scheduled" }]);
    await acknowledgeReminder(db, "11111111-1111-1111-1111-111111111111");
    const rows = await db.table.query().toArray();
    assert.strictEqual(rows[0].reminderStatus, "acknowledged");
    assert.ok(rows[0].acknowledgedAt > 0);
  });

  it("present sets presented status", async () => {
    const db = mockDb([{ id: "11111111-1111-1111-1111-111111111111", memoryKind: "reminder", reminderStatus: "scheduled" }]);
    await presentReminder(db, "11111111-1111-1111-1111-111111111111");
    const rows = await db.table.query().toArray();
    assert.strictEqual(rows[0].reminderStatus, "presented");
    assert.ok(rows[0].remindedAt > 0);
  });

  it("mark pending sets dispatchedAt and increments count", async () => {
    const db = mockDb([{ id: "11111111-1111-1111-1111-111111111111", memoryKind: "reminder", reminderStatus: "scheduled", dispatchCount: 0 }]);
    await markReminderPending(db, "11111111-1111-1111-1111-111111111111");
    const rows = await db.table.query().toArray();
    assert.strictEqual(rows[0].reminderStatus, "pending");
    assert.ok(rows[0].dispatchedAt > 0);
    assert.strictEqual(rows[0].dispatchCount, 1);
  });

  it("cancel sets cancelled status", async () => {
    const db = mockDb([{ id: "11111111-1111-1111-1111-111111111111", memoryKind: "reminder", reminderStatus: "scheduled" }]);
    await cancelReminder(db, "11111111-1111-1111-1111-111111111111");
    const rows = await db.table.query().toArray();
    assert.strictEqual(rows[0].reminderStatus, "cancelled");
    assert.ok(rows[0].cancelledAt > 0);
  });
});
