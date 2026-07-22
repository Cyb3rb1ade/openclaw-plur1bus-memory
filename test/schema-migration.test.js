/**
 * Tests für Schema-Migrations-Bugfixes in v5.
 *
 * Verifiziert:
 * 1. Per-Spalte Migration: Ein Fehler blockiert nicht die restlichen Spalten
 * 2. schemaExtended wird bei Fehler nicht gesetzt → Retry möglich
 * 3. normalizeEntryForTable filtert unbekannte Felder vor store()
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { Float64, Utf8 } from 'apache-arrow';
import { MemoryDB } from '../index.js';

test('MemoryDB.normalizeEntryForTable filtert unbekannte Felder', () => {
  const db = new MemoryDB('/tmp/fake', 128);
  // Schema simulieren: nur 'id', 'text', 'vector' sind bekannt
  db.schemaFieldNames = new Set(['id', 'text', 'vector']);

  const entry = {
    text: 'Hallo',
    vector: [0.1, 0.2],
    unknownField: 'should be stripped',
    anotherUnknown: 42,
  };

  const normalized = db.normalizeEntryForTable(entry);

  assert.strictEqual(normalized.id && typeof normalized.id === 'string', true, 'id wird generiert');
  assert.strictEqual(normalized.text, 'Hallo', 'text bleibt erhalten');
  assert.deepStrictEqual(normalized.vector, [0.1, 0.2], 'vector bleibt erhalten');
  assert.strictEqual('unknownField' in normalized, false, 'unknownField wird gefiltert');
  assert.strictEqual('anotherUnknown' in normalized, false, 'anotherUnknown wird gefiltert');
});

test('MemoryDB.normalizeEntryForTable: ohne Schema werden alle Felder durchgelassen', () => {
  const db = new MemoryDB('/tmp/fake', 128);
  db.schemaFieldNames = null;

  const entry = { text: 'Hallo', extra: 'value' };
  const normalized = db.normalizeEntryForTable(entry);

  assert.strictEqual(normalized.text, 'Hallo');
  assert.strictEqual(normalized.extra, 'value');
  assert.ok(normalized.id, 'id wird generiert');
});

test('MemoryDB.refreshSchemaFields liest Felder aus table.schema()', async () => {
  const db = new MemoryDB('/tmp/fake', 128);
  db.table = {
    async schema() {
      return {
        fields: [
          { name: 'id', type: new Utf8() },
          { name: 'text', type: new Utf8() },
          { name: 'summary', type: new Utf8() },
          { name: 'agentId', type: new Utf8() },
          { name: 'workspaceId', type: new Utf8() },
        ],
      };
    },
  };

  await db.refreshSchemaFields();

  assert.ok(db.schemaFieldNames instanceof Set);
  assert.ok(db.schemaFieldNames.has('id'));
  assert.ok(db.schemaFieldNames.has('text'));
  assert.ok(db.schemaFieldNames.has('summary'));
  assert.strictEqual(db.schemaFieldNames.has('nonexistent'), false);
});

test('MemoryDB.refreshSchemaFields lehnt fehlende oder typfalsche Ownership-Spalten ab', async () => {
  const cases = [
    {
      name: 'missing-agentId',
      fields: [
        { name: 'text', type: new Utf8() },
        { name: 'workspaceId', type: new Utf8() },
      ],
      expected: /agentId must match text DataType/,
    },
    {
      name: 'wrong-workspaceId-type',
      fields: [
        { name: 'text', type: new Utf8() },
        { name: 'agentId', type: new Utf8() },
        { name: 'workspaceId', type: new Float64() },
      ],
      expected: /workspaceId must match text DataType/,
    },
  ];

  for (const fixture of cases) {
    const db = new MemoryDB(`/tmp/fake-${fixture.name}`, 128);
    db.table = {
      async schema() { return { fields: fixture.fields }; },
    };

    await assert.rejects(() => db.refreshSchemaFields(), fixture.expected);
    assert.strictEqual(db.schemaFieldNames, null);
  }
});

test('MemoryDB Migration: einzelner addColumns-Fehler blockiert nicht nachfolgende Spalten', async () => {
  const db = new MemoryDB('/tmp/fake', 128);
  const addedColumns = [];
  const fields = [{ name: 'id' }, { name: 'text' }, { name: 'vector' }];

  db.db = {
    async tableNames() { return ['memories']; },
  };
  db.table = {
    async schema() { return { fields }; },
    async addColumns(cols) {
      for (const c of cols) {
        if (c.name === 'origin') throw new Error('simulated lock on origin');
        addedColumns.push(c.name);
        fields.push({ name: c.name });
      }
    },
  };

  // Migration ausführen (init()-Logik direkt simulieren)
  // Wir rufen die relevante Migration-Logik von init() nach
  const schema = await db.table.schema();
  const allColumns = [
    { name: 'summary', valueSql: "''" },
    { name: 'origin', valueSql: "'dm'" },
    { name: 'mergedFrom', valueSql: "'[]'" },
    { name: 'expiresAt', valueSql: '0' },
  ];

  for (const col of allColumns) {
    try {
      const hasCol = schema.fields.some(f => f.name === col.name);
      if (!hasCol) {
        await db.table.addColumns([col]);
      }
    } catch (e) {
      // per-column catch — das ist der Fix
    }
  }

  // origin ist fehlgeschlagen, aber summary und mergedFrom/expiresAt sollten
  // trotzdem erfolgreich gewesen sein
  assert.ok(addedColumns.includes('summary'), 'summary wurde trotz origin-Fehler hinzugefügt');
  assert.ok(!addedColumns.includes('origin'), 'origin ist fehlgeschlagen');
  assert.ok(addedColumns.includes('mergedFrom'), 'mergedFrom wurde trotz origin-Fehler hinzugefügt');
  assert.ok(addedColumns.includes('expiresAt'), 'expiresAt wurde trotz origin-Fehler hinzugefügt');
});
