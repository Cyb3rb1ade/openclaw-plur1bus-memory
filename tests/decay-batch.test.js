import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { buildBatchDecaySql, applyDailyDecayBatch } from "../lib/jobs/memory-dynamics-maintenance.js";
import { computeDecayedStrength } from "../lib/memory-dynamics.js";

const DAY = 86_400_000;

describe("7.12.47: Batch-Decay als ein Update-Statement", () => {
  it("baut Where und SQL-Ausdruck aus Partition und Schema", () => {
    const fields = new Set(["id", "scope", "agentId", "storedBy", "status", "memoryClass", "neverForget", "memoryStrength", "halfLifeDays", "lastDynamicsAt", "lastStrengthenedAt", "createdAt"]);
    const sql = buildBatchDecaySql({ partition: { scope: "agent-private", agentId: "main" }, fields, now: 1_000_000 });
    assert.match(sql.where, /scope = 'agent-private'/);
    assert.match(sql.where, /agentId = 'main'/);
    assert.match(sql.where, /storedBy = 'main'/);
    assert.match(sql.where, /status IS NULL OR status = 'active'/);
    assert.match(sql.where, /memoryClass <> 'core'/);
    assert.match(sql.where, /neverForget = 0/);
    const boolFields = new Map([["id", "Utf8"], ["neverForget", "Bool"], ["memoryStrength", "Float64"]]);
    assert.match(buildBatchDecaySql({ fields: boolFields, now: 1 }).where, /neverForget = false/);
    assert.match(sql.where, /id LIKE '________-____-____-____-____________'/);
    assert.match(sql.valuesSql.memoryStrength, /power\(0\.5/);
    assert.match(sql.valuesSql.memoryStrength, /GREATEST\(0\.0, 1000000\.0 - GREATEST\(/);
    assert.match(sql.valuesSql.memoryStrength, /GREATEST\(CAST\(COALESCE\(lastDynamicsAt, 0\) AS DOUBLE\), CAST\(COALESCE\(lastStrengthenedAt, 0\) AS DOUBLE\), CAST\(COALESCE\(createdAt, 0\) AS DOUBLE\)\)/);
    assert.ok(!/NULLIF|SIGN|CASE/.test(sql.valuesSql.memoryStrength), "nur Funktionen, die Lance kennt");
    assert.equal(sql.valuesSql.lastDynamicsAt, "1000000");
    assert.ok(!/CASE/.test(sql.valuesSql.memoryStrength), "Lance kennt kein CASE");
    // Ohne die optionalen Spalten fallen die Klauseln weg.
    const minimal = buildBatchDecaySql({ partition: null, fields: new Set(["id", "memoryStrength"]), now: 5 });
    assert.ok(!/status/.test(minimal.where));
    assert.ok(!/lastDynamicsAt|halfLifeDays/.test(minimal.valuesSql.memoryStrength));
    assert.match(minimal.valuesSql.memoryStrength, /GREATEST\(0\.0, 5\.0 - 0\.0\)/);
  });

  it("decayt auf einer echten LanceDB-Tabelle genau wie die JS-Kurve und laesst fremde, Kern- und Hash-ID-Zeilen in Ruhe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "decay-batch-"));
    try {
      const now = Date.now();
      const base = { scope: "agent-private", storedBy: "main", agentId: "", status: "active", memoryClass: "", neverForget: 0, lastStrengthenedAt: 0 };
      const rows = [
        { ...base, id: "11111111-1111-4111-8111-111111111111", memoryStrength: 1.0, halfLifeDays: 30, lastDynamicsAt: now - 40 * DAY, createdAt: now - 100 * DAY },
        { ...base, id: "22222222-2222-4222-8222-222222222222", memoryStrength: 0.5, halfLifeDays: 0, lastDynamicsAt: 0, createdAt: now - 10 * DAY },
        { ...base, id: "33333333-3333-4333-8333-333333333333", memoryStrength: 0.4, halfLifeDays: 30, lastDynamicsAt: now + 5 * DAY, createdAt: now },
        { ...base, id: "44444444-4444-4444-8444-444444444444", memoryStrength: 0.9, halfLifeDays: 30, lastDynamicsAt: now - 40 * DAY, createdAt: now - 100 * DAY, memoryClass: "core" },
        { ...base, id: "55555555-5555-4555-8555-555555555555", memoryStrength: 0.9, halfLifeDays: 30, lastDynamicsAt: now - 40 * DAY, createdAt: now - 100 * DAY, neverForget: 1 },
        { ...base, id: "66666666-6666-4666-8666-666666666666", memoryStrength: 0.9, halfLifeDays: 30, lastDynamicsAt: now - 40 * DAY, createdAt: now - 100 * DAY, status: "archived" },
        { ...base, id: "77777777-7777-4777-8777-777777777777", memoryStrength: 0.9, halfLifeDays: 30, lastDynamicsAt: now - 40 * DAY, createdAt: now - 100 * DAY, scope: "user" },
        { ...base, id: "88888888-8888-4888-8888-888888888888", memoryStrength: 0.9, halfLifeDays: 30, lastDynamicsAt: now - 40 * DAY, createdAt: now - 100 * DAY, storedBy: "bernhardine" },
        { ...base, id: "a".repeat(64), memoryStrength: 0.9, halfLifeDays: 30, lastDynamicsAt: now - 40 * DAY, createdAt: now - 100 * DAY },
        // Ohne jeden Zeitstempel: faellt wie im Zeilenpfad auf 0,01 (firstValidTimestamp liefert 0).
        { ...base, id: "99999999-9999-4999-8999-999999999999", memoryStrength: 0.7, halfLifeDays: 30, lastDynamicsAt: 0, createdAt: 0 },
      ];
      const db = await lancedb.connect(dir);
      const table = await db.createTable("memories", rows);
      const logs = [];
      const result = await applyDailyDecayBatch({ table }, { partition: { scope: "agent-private", agentId: "main" }, now, logger: { info: (m) => logs.push(m), warn() {}, error() {} } });
      assert.equal(result.mode, "batch");
      assert.equal(result.decayed, 4, "rows 1-3 and the timestamp-less row");
      assert.equal(result.errors, 0);
      assert.ok(logs.some((m) => /batch decay rows=4/.test(m)));
      const after = new Map((await table.query().toArray()).map((r) => [r.id, r]));
      const expect = (id) => computeDecayedStrength(rows.find((r) => r.id === id), now);
      for (const id of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "99999999-9999-4999-8999-999999999999"]) {
        assert.ok(Math.abs(Number(after.get(id).memoryStrength) - expect(id)) < 1e-6, `${id}: ${after.get(id).memoryStrength} vs ${expect(id)}`);
        assert.equal(Number(after.get(id).lastDynamicsAt), now);
      }
      for (const id of ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", "a".repeat(64)]) {
        assert.equal(Number(after.get(id).memoryStrength), 0.9, `${id} untouched`);
        assert.equal(Number(after.get(id).lastDynamicsAt), now - 40 * DAY, `${id} timestamp untouched`);
      }
      // Dry-run zaehlt nur.
      const dry = await applyDailyDecayBatch({ table }, { partition: { scope: "agent-private", agentId: "main" }, now: now + DAY, dryRun: true, logger: { info() {}, warn() {}, error() {} } });
      assert.equal(dry.decayed, 4);
      assert.equal(Number((await table.query().where("id = '11111111-1111-4111-8111-111111111111'").toArray())[0].lastDynamicsAt), now, "dry-run writes nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wirft ohne table.update, damit der Aufrufer auf den Zeilenpfad zurueckfaellt", async () => {
    await assert.rejects(() => applyDailyDecayBatch({ table: { query() { return {}; } } }, {}), /table\.update missing/);
  });
});
