import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDynamicsDecayCursor, recordDynamicsDecayCursor } from "../lib/jobs/daily-consolidation.js";
import { applyDailyDecayToAll } from "../lib/jobs/memory-dynamics-maintenance.js";

function fakeNeoStore() {
  const hooks = {};
  return {
    hooks,
    readHooks: () => JSON.parse(JSON.stringify(hooks)),
    recordHook: (name, meta) => { hooks[name] = { ...(hooks[name] || {}), count: ((hooks[name] || {}).count || 0) + 1, ...meta }; return hooks[name]; },
  };
}

describe("7.12.46: Decay-Cursor lebt im partitionseigenen Neo-Store", () => {
  it("schreibt und liest den Cursor ueber den Hook-Record, ohne fremde Partitionen oder Hook-Felder zu verlieren", async () => {
    const store = fakeNeoStore();
    store.recordHook("daily-consolidation", { lastRun: "x" });
    assert.equal(readDynamicsDecayCursor(null, "heisenberg", "workspace-heisenberg", null, store), null);
    assert.equal(await recordDynamicsDecayCursor(null, "heisenberg", "workspace-heisenberg", "aaaa-1", store), true);
    assert.equal(await recordDynamicsDecayCursor(null, "heisenberg", "other-ws", "bbbb-2", store), true);
    assert.equal(readDynamicsDecayCursor(null, "heisenberg", "workspace-heisenberg", null, store), "aaaa-1");
    assert.equal(readDynamicsDecayCursor(null, "heisenberg", "other-ws", null, store), "bbbb-2");
    assert.equal(store.hooks["daily-consolidation"].lastRun, "x", "other hook fields survive");
    // Fortschritt ueberschreibt den eigenen Eintrag.
    await recordDynamicsDecayCursor(null, "heisenberg", "workspace-heisenberg", "cccc-3", store);
    assert.equal(readDynamicsDecayCursor(null, "heisenberg", "workspace-heisenberg", null, store), "cccc-3");
    assert.equal(await recordDynamicsDecayCursor(null, "heisenberg", "workspace-heisenberg", "", store), false, "empty cursor is not stored");
  });

  it("faellt ohne Store auf run-state.json zurueck und schreibt bei Store UND Datei beides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decay-cursor-"));
    const statePath = join(dir, "run-state.json");
    assert.equal(readDynamicsDecayCursor(statePath, "main", "workspace", null, null), null);
    await recordDynamicsDecayCursor(statePath, "main", "workspace", "dddd-4", null);
    assert.equal(readDynamicsDecayCursor(statePath, "main", "workspace", null, null), "dddd-4");
    assert.ok(existsSync(statePath));
    const store = fakeNeoStore();
    await recordDynamicsDecayCursor(statePath, "main", "workspace", "eeee-5", store);
    assert.equal(readDynamicsDecayCursor(statePath, "main", "workspace", null, store), "eeee-5", "store wins");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).memoryDynamicsDecay["main:workspace"].cursorId, "eeee-5", "file kept in sync");
    // Store ohne Eintrag, Datei mit Eintrag → Datei zaehlt.
    assert.equal(readDynamicsDecayCursor(statePath, "main", "workspace", null, fakeNeoStore()), "eeee-5");
  });
});

describe("7.12.46: Decay-Zeitbudget", () => {
  const DAY = 86_400_000;
  const old = Date.now() - 40 * DAY;
  function row(i) {
    return { id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, status: "active", memoryStrength: 1, halfLifeDays: 30, lastDynamicsAt: old, createdAt: old, importance: 0.5 };
  }
  function makeDb(rows, updateDelayMs = 0) {
    const updates = [];
    return {
      updates,
      table: { query() { const st = { limit: rows.length, offset: 0 }; const b = { limit(n) { st.limit = n; return b; }, offset(n) { st.offset = n; return b; }, async toArray() { return rows.slice(st.offset, st.offset + st.limit); } }; return b; } },
      async update(id, patch) { if (updateDelayMs) await new Promise((r) => setTimeout(r, updateDelayMs)); updates.push({ id, patch }); },
    };
  }

  it("bricht nach Ablauf des Budgets ab, meldet deadlineHit und laesst den Cursor auf der letzten Zeile", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i + 1));
    const db = makeDb(rows, 30);
    const res = await applyDailyDecayToAll(db, { maxRows: 20, deadlineMs: 100 });
    assert.ok(res.decayed >= 1 && res.decayed < 20, `expected a partial run, got ${res.decayed}`);
    assert.equal(res.deadlineHit, true);
    assert.equal(res.truncated, true);
    assert.equal(res.nextCursorId, db.updates[db.updates.length - 1].id);
    // Naechster Lauf setzt hinter dem Cursor fort.
    const next = await applyDailyDecayToAll(makeDb(rows), { maxRows: 5, cursorId: res.nextCursorId });
    assert.ok(next.decayed === 5);
    assert.ok(next.nextCursorId > res.nextCursorId);
  });

  it("ohne Budget wie bisher: alle Zeilen bis maxRows, deadlineHit false", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1));
    const res = await applyDailyDecayToAll(makeDb(rows), { maxRows: 10 });
    assert.equal(res.decayed, 6);
    assert.equal(res.deadlineHit, false);
    assert.equal(res.truncated, false);
  });
});
