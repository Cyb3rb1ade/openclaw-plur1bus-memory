/**
 * Tests für /vergiss + /korrigier (Direkteingriff).
 *
 * Pure Funktionen + DB-Methoden mit Fake-Adapter. NIEMALS echte Daten
 * verändern. Archive-First-Garantie wird hier verifiziert.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCorrection,
  resolveCandidates,
  forgetCard,
  correctCard,
  renderCandidateChoice,
} from '../lib/telegram-commands/memory-edit.js';
import { createDbAdapter } from '../lib/db-adapter.js';

// ─── parseCorrection ────────────────────────────────────────────────────

test('parseCorrection erkennt "alt zu neu" Syntax', () => {
  assert.deepStrictEqual(parseCorrection('Evas Geburtstag ist 3. Juni zu 3. Juli'), {
    old: 'Evas Geburtstag ist 3. Juni',
    new: '3. Juli',
  });
});

test('parseCorrection erkennt "alt → neu" Syntax', () => {
  const r = parseCorrection('PinchTab 0.8 → 0.11');
  assert.strictEqual(r.old, 'PinchTab 0.8');
  assert.strictEqual(r.new, '0.11');
});

test('parseCorrection gibt null bei fehlendem Separator', () => {
  assert.strictEqual(parseCorrection('nur ein Text'), null);
});

test('parseCorrection ignoriert "zu" innerhalb von Wörtern', () => {
  // "zubereitet" enthält "zu", darf aber nicht splitten — wir splitten nur am
  // letzten freistehenden " zu " oder " → " als Separator.
  const r = parseCorrection('Essen wurde zubereitet zu Kaffee');
  assert.strictEqual(r.old, 'Essen wurde zubereitet');
  assert.strictEqual(r.new, 'Kaffee');
});

// ─── resolveCandidates ──────────────────────────────────────────────────

test('resolveCandidates gibt eindeutigen Treffer bei 1 Match', async () => {
  const fakeDb = {
    searchByTopic: async () => [{ id: 'card-1', title: 'Eva Geburtstag 3. Juni', score: 0.95 }],
  };
  const result = await resolveCandidates(fakeDb, 'agent', 'Eva Geburtstag');
  assert.strictEqual(result.unique, true);
  assert.strictEqual(result.card.id, 'card-1');
});

test('resolveCandidates gibt Auswahl bei ≥2 Matches', async () => {
  const fakeDb = {
    searchByTopic: async () => [
      { id: 'a', title: 'Eva 3. Juni', score: 0.8 },
      { id: 'b', title: 'Eva geht 3. Juli weg', score: 0.78 },
    ],
  };
  const result = await resolveCandidates(fakeDb, 'agent', 'Eva');
  assert.strictEqual(result.unique, false);
  assert.strictEqual(result.candidates.length, 2);
});

test('resolveCandidates gibt none bei leerer Ergebnisliste', async () => {
  const fakeDb = { searchByTopic: async () => [] };
  const result = await resolveCandidates(fakeDb, 'agent', 'nichts');
  assert.strictEqual(result.unique, false);
  assert.strictEqual(result.candidates.length, 0);
  assert.strictEqual(result.none, true);
});

// ─── forgetCard — Archive-First-Garantie ─────────────────────────────────

test('forgetCard archiviert ZUERST, dann löscht', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'plur1bus-forget-'));
  try {
    const order = [];
    const fakeDb = {
      getCard: async (agent, id) => {
        order.push('getCard');
        return { id, title: 'Test', text: 'Test-Inhalt', source: 'notiz', date: '2026-05-28' };
      },
      deleteCard: async (agent, id) => {
        order.push('deleteCard');
        return { ok: true, id };
      },
    };
    const result = await forgetCard(fakeDb, 'agent-x', 'card-123', { archiveDir: tmpRoot });
    assert.strictEqual(result.ok, true);
    // Reihenfolge: getCard → archive-write → deleteCard
    assert.deepStrictEqual(order, ['getCard', 'deleteCard']);
    // Archive existiert
    const agentDir = join(tmpRoot, 'agent-x');
    assert.ok(existsSync(agentDir), 'agent-dir existiert');
    const files = readdirSync(agentDir);
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /card-123\.json$/);
    const archived = JSON.parse(readFileSync(join(agentDir, files[0]), 'utf8'));
    assert.strictEqual(archived.id, 'card-123');
    assert.strictEqual(archived.title, 'Test');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('forgetCard scheitert wenn Card nicht existiert', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'plur1bus-forget-'));
  try {
    const fakeDb = {
      getCard: async () => null,
      deleteCard: async () => { throw new Error('should not delete'); },
    };
    const result = await forgetCard(fakeDb, 'agent', 'nope', { archiveDir: tmpRoot });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /nicht gefunden/i);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('forgetCard löscht NICHT wenn Archive-Schreiben fehlschlägt', async () => {
  // archiveDir zeigt auf eine EXISTIERENDE Datei (nicht Verzeichnis) → mkdir scheitert
  const tmpRoot = mkdtempSync(join(tmpdir(), 'plur1bus-fail-'));
  const fakeFile = join(tmpRoot, 'a-file-not-a-dir');
  writeFileSync(fakeFile, 'not a dir');
  let deleted = false;
  const fakeDb = {
    getCard: async (a, id) => ({ id, title: 'T', text: 'x' }),
    deleteCard: async () => { deleted = true; return { ok: true }; },
  };
  try {
    const result = await forgetCard(fakeDb, 'agent', 'card-1', { archiveDir: fakeFile });
    assert.strictEqual(result.ok, false, 'sollte fehlschlagen');
    assert.strictEqual(deleted, false, 'deleteCard wurde NICHT aufgerufen');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── correctCard ────────────────────────────────────────────────────────

test('correctCard archiviert + ruft updateCard', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'plur1bus-correct-'));
  try {
    const calls = [];
    const fakeDb = {
      getCard: async (a, id) => ({ id, title: 'T', text: 'alt-Inhalt' }),
      updateCard: async (a, id, content) => {
        calls.push({ id, content });
        return { ok: true };
      },
    };
    const result = await correctCard(fakeDb, 'agent', 'card-1', 'neu-Inhalt', { archiveDir: tmpRoot });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].content, 'neu-Inhalt');
    const agentDir = join(tmpRoot, 'agent');
    assert.ok(existsSync(agentDir));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('correctCard fängt updateCard-Error ab und gibt freundliche Nachricht', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'plur1bus-correct-'));
  try {
    const fakeDb = {
      getCard: async (a, id) => ({ id, title: 'T', text: 'x' }),
      updateCard: async () => { throw new Error('updateCard gesperrt in Phase 4b'); },
    };
    const result = await correctCard(fakeDb, 'agent', 'card-1', 'neu', { archiveDir: tmpRoot });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /Phase 4b|gesperrt|nicht unterstützt|nicht möglich/i);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── renderCandidateChoice ──────────────────────────────────────────────

// ─── db-adapter updateCard mit Embedder ─────────────────────────────────

/**
 * Baut einen In-Memory-Stub für eine LanceDB-Tabelle, der die in db-adapter
 * benutzten Methoden simuliert (query/where/limit/toArray, delete, add, update,
 * schema, addColumns).
 */
function makeFakeTable(initialRows = [], schemaFields = []) {
  let rows = [...initialRows];
  let fields = schemaFields.length > 0 ? [...schemaFields] : [
    { name: 'id' }, { name: 'text' }, { name: 'summary' }, { name: 'vector' },
    { name: 'createdAt' }, { name: 'origin' }, { name: 'category' },
  ];
  const table = {
    _rows: () => rows,
    query() {
      let _where = null;
      let _limit = Infinity;
      const builder = {
        where(expr) { _where = expr; return builder; },
        limit(n) { _limit = n; return builder; },
        async toArray() {
          let out = rows;
          if (_where) {
            // Sehr einfacher Parser: handhabt `id = "X"`, `id = 'X'`,
            // `createdAt >= NUM`, `createdAt <= NUM`, AND-Kombinationen.
            out = rows.filter(r => evalWhere(r, _where));
          }
          return out.slice(0, _limit);
        },
      };
      return builder;
    },
    async delete(expr) {
      rows = rows.filter(r => !evalWhere(r, expr));
    },
    async add(newRows) {
      for (const r of newRows) rows.push({ ...r });
    },
    async update(opts) {
      const where = opts.where;
      const values = opts.values || {};
      let count = 0;
      for (const r of rows) {
        if (evalWhere(r, where)) {
          for (const k of Object.keys(values)) r[k] = values[k];
          count += 1;
        }
      }
      return { rowsUpdated: count };
    },
    async schema() { return { fields }; },
    async addColumns(cols) {
      for (const c of cols) {
        if (!fields.some(f => f.name === c.name)) {
          fields.push({ name: c.name });
          // Default-Wert aus valueSql interpretieren (sehr lax)
          let def = null;
          if (c.valueSql === "''") def = '';
          else if (c.valueSql === '0') def = 0;
          for (const r of rows) if (!(c.name in r)) r[c.name] = def;
        }
      }
    },
  };
  return table;
}

function evalWhere(row, expr) {
  if (!expr) return true;
  // AND
  if (/\sAND\s/i.test(expr)) {
    return expr.split(/\sAND\s/i).every(p => evalWhere(row, p.trim()));
  }
  // id = "X" or id = 'X'
  let m = expr.match(/^id\s*=\s*['"]([^'"]+)['"]$/);
  if (m) return String(row.id) === m[1];
  // createdAt >= N
  m = expr.match(/^createdAt\s*>=\s*([0-9.]+)$/);
  if (m) return Number(row.createdAt) >= Number(m[1]);
  m = expr.match(/^createdAt\s*<=\s*([0-9.]+)$/);
  if (m) return Number(row.createdAt) <= Number(m[1]);
  return false;
}

test('db-adapter updateCard mit Embedder: ruft embed() + persistiert neuen Text/Vektor', async () => {
  const fakeTable = makeFakeTable([
    { id: 'card-1', text: 'alt-Inhalt', summary: 'alt', vector: [0.1, 0.2], createdAt: Date.now(), origin: 'dm', category: 'fakt' },
  ]);
  let embedCalls = 0;
  const fakeEmbedder = {
    embed: async (text) => {
      embedCalls += 1;
      // Neuer Vektor: hash-artig deterministisch aus length
      return [text.length / 100, 0.5];
    },
  };
  const adapter = createDbAdapter({
    getTable: async () => fakeTable,
    embedder: fakeEmbedder,
  });
  const res = await adapter.updateCard('agent', 'card-1', 'neuer-Inhalt');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(embedCalls, 1, 'embed wurde genau 1x aufgerufen');
  const rows = fakeTable._rows();
  assert.strictEqual(rows.length, 1, 'Row-Count bleibt 1');
  assert.strictEqual(rows[0].id, 'card-1', 'ID identisch');
  assert.strictEqual(rows[0].text, 'neuer-Inhalt', 'Text aktualisiert');
  assert.deepStrictEqual(rows[0].vector, ['neuer-Inhalt'.length / 100, 0.5], 'Vektor aktualisiert');
});

test('db-adapter updateCard ohne Embedder: hard-fail (rückwärts-kompatibel)', async () => {
  const fakeTable = makeFakeTable([
    { id: 'card-1', text: 'alt', vector: [0.1], createdAt: 0, origin: 'dm' },
  ]);
  const adapter = createDbAdapter({ getTable: async () => fakeTable });
  await assert.rejects(
    () => adapter.updateCard('agent', 'card-1', 'neu'),
    /Embedder-Injection|gesperrt|nicht möglich/i,
  );
});

test('db-adapter findRecentUnclassified: filtert leeres type + sinceMinutes', async () => {
  const now = Date.now();
  const fakeTable = makeFakeTable([
    { id: 'r1', text: 'frisch ohne type', vector: [0], createdAt: now - 5 * 60_000, origin: 'dm' },
    { id: 'r2', text: 'frisch mit type', vector: [0], createdAt: now - 5 * 60_000, origin: 'dm', type: 'person' },
    { id: 'r3', text: 'alt ohne type', vector: [0], createdAt: now - 60 * 60_000, origin: 'dm' },
  ]);
  const adapter = createDbAdapter({ getTable: async () => fakeTable });
  const out = await adapter.findRecentUnclassified('agent', { sinceMinutes: 30 });
  // r1 ist drin (frisch + ohne type), r2 nicht (hat type), r3 nicht (zu alt)
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'r1');
  assert.ok('content' in out[0], 'content-Feld für Classifier vorhanden');
});

test('db-adapter updateCardType: setzt type-Spalte', async () => {
  const fakeTable = makeFakeTable([
    { id: 'r1', text: 'foo', vector: [0], createdAt: 0, origin: 'dm' },
  ]);
  const adapter = createDbAdapter({ getTable: async () => fakeTable });
  const res = await adapter.updateCardType('agent', 'r1', 'person');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(fakeTable._rows()[0].type, 'person');
});

test('db-adapter findUnconfirmedCritical: filtert CRITICAL + unconfirmed + älter als olderThan', async () => {
  const now = Date.now();
  const old = now - 25 * 3600_000;
  const fresh = now - 1 * 3600_000;
  const fakeTable = makeFakeTable([
    { id: 'c1', text: 'old critical unconfirmed', vector: [0], createdAt: old, origin: 'dm', type: 'person', confirmed: 0 },
    { id: 'c2', text: 'old critical confirmed', vector: [0], createdAt: old, origin: 'dm', type: 'person', confirmed: 1 },
    { id: 'c3', text: 'old non-critical', vector: [0], createdAt: old, origin: 'dm', type: 'fakt', confirmed: 0 },
    { id: 'c4', text: 'fresh critical unconfirmed', vector: [0], createdAt: fresh, origin: 'dm', type: 'person', confirmed: 0 },
  ]);
  const adapter = createDbAdapter({ getTable: async () => fakeTable });
  const cutoff = now - 24 * 3600_000;
  const out = await adapter.findUnconfirmedCritical('agent', { olderThan: cutoff });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'c1');
});

test('db-adapter markConfirmed: setzt confirmed=1', async () => {
  const fakeTable = makeFakeTable([
    { id: 'r1', text: 'foo', vector: [0], createdAt: 0, origin: 'dm', confirmed: 0 },
  ]);
  const adapter = createDbAdapter({ getTable: async () => fakeTable });
  const res = await adapter.markConfirmed('agent', 'r1');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(fakeTable._rows()[0].confirmed, 1);
});

// ─── Schema-Migration Bug-Fixes (v5) ─────────────────────────────────────

test('db-adapter ensureClassificationColumns: einzelner addColumns-Fehler blockiert nicht die restlichen Spalten', async () => {
  const fields = [{ name: 'id' }, { name: 'text' }];
  let addCalls = [];
  const fakeTable = {
    _rows: () => [],
    query() { return { where() { return this; }, limit() { return this; }, async toArray() { return []; } }; },
    async schema() { return { fields }; },
    async addColumns(cols) {
      for (const c of cols) {
        addCalls.push(c.name);
        if (c.name === 'type') throw new Error('simulated type column lock');
        if (!fields.some(f => f.name === c.name)) fields.push({ name: c.name });
      }
    },
  };
  const adapter = createDbAdapter({ getTable: async () => fakeTable });
  await adapter._ensureClassificationColumns('agent', fakeTable);
  // 'type' ist fehlgeschlagen, aber 'confirmed' sollte trotzdem versucht worden sein
  assert.ok(addCalls.includes('confirmed'), 'confirmed-Spalte wurde trotz type-Fehler versucht');
  // Weil type fehlgeschlagen ist, darf schemaExtended NICHT gesetzt sein
  // → nächster Aufruf retryt 'type', aber 'confirmed' ist bereits im Schema
  addCalls = [];
  await adapter._ensureClassificationColumns('agent', fakeTable);
  assert.ok(addCalls.includes('type'), 'type wird bei Retry erneut versucht');
  assert.ok(!addCalls.includes('confirmed'), 'confirmed wird bei Retry NICHT erneut versucht (bereits erfolgreich)');
});

test('db-adapter ensureClassificationColumns: schemaExtended wird bei Fehler NICHT gesetzt', async () => {
  const fields = [{ name: 'id' }];
  const fakeTable = {
    query() { return { where() { return this; }, limit() { return this; }, async toArray() { return []; } }; },
    async schema() { return { fields }; },
    async addColumns() { throw new Error('lock'); },
  };
  const adapter = createDbAdapter({ getTable: async () => fakeTable });
  await adapter._ensureClassificationColumns('agent', fakeTable);
  // Retry sollte erneut addColumns aufrufen, weil schemaExtended nicht gesetzt ist
  let secondCall = false;
  const failingTable2 = {
    query() { return { where() { return this; }, limit() { return this; }, async toArray() { return []; } }; },
    async schema() { return { fields }; },
    async addColumns() { secondCall = true; },
  };
  await adapter._ensureClassificationColumns('agent', failingTable2);
  assert.ok(secondCall, 'Retry fand statt, weil schemaExtended bei Fehler nicht gesetzt wurde');
});

// ─── renderCandidateChoice ──────────────────────────────────────────────

test('renderCandidateChoice gibt numerierte Liste + Buttons', () => {
  const candidates = [
    { id: 'a', title: 'Eva 3. Juni', source: 'notiz', date: '2026-05-27' },
    { id: 'b', title: 'Eva geht 3. Juli weg', source: 'konversation', date: '2026-05-28' },
  ];
  const result = renderCandidateChoice(candidates, 'forget');
  assert.ok(result.text.includes('1.'));
  assert.ok(result.text.includes('2.'));
  assert.ok(result.text.includes('Eva 3. Juni'));
  // Inline-Keyboard mit callback_data forget:<id>
  assert.ok(Array.isArray(result.inline_keyboard));
  assert.strictEqual(result.inline_keyboard.length, 2);
  assert.strictEqual(result.inline_keyboard[0][0].callback_data, 'forget:a');
  assert.strictEqual(result.inline_keyboard[1][0].callback_data, 'forget:b');
});
