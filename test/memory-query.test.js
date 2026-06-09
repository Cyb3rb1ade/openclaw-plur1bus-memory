/**
 * Tests für /memory (Inspektions-Command).
 *
 * Reine Funktionen (parseQuery, formatResults) und queryMemory mit Fake-DB.
 * NIEMALS die echte LanceDB anfassen.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseQuery,
  formatResults,
  queryMemory,
} from '../lib/telegram-commands/memory-query.js';

// ─── parseQuery: Zeit-Modus ──────────────────────────────────────────────

test('parseQuery erkennt "diese Woche"', () => {
  assert.deepStrictEqual(parseQuery('diese Woche'), { mode: 'time', range: 'this_week' });
});

test('parseQuery erkennt "heute"', () => {
  assert.deepStrictEqual(parseQuery('heute'), { mode: 'time', range: 'today' });
});

test('parseQuery erkennt "gestern"', () => {
  assert.deepStrictEqual(parseQuery('gestern'), { mode: 'time', range: 'yesterday' });
});

test('parseQuery erkennt Monatsnamen', () => {
  assert.deepStrictEqual(parseQuery('Mai'), { mode: 'time', range: 'month:Mai' });
  assert.deepStrictEqual(parseQuery('Januar'), { mode: 'time', range: 'month:Januar' });
});

// ─── parseQuery: Topic-Modus ─────────────────────────────────────────────

test('parseQuery erkennt "über X" Syntax', () => {
  assert.deepStrictEqual(parseQuery('über Eva'), { mode: 'topic', topic: 'Eva' });
});

test('parseQuery erkennt "was weißt du über X"', () => {
  assert.deepStrictEqual(parseQuery('was weißt du über Riva'), { mode: 'topic', topic: 'Riva' });
});

test('parseQuery default = topic mit ganzem Text wenn kein Schlüsselwort', () => {
  const result = parseQuery('PinchTab Bug');
  assert.strictEqual(result.mode, 'topic');
  assert.strictEqual(result.topic, 'PinchTab Bug');
});

test('parseQuery mit leerem Input → mode=help', () => {
  assert.deepStrictEqual(parseQuery(''), { mode: 'help' });
  assert.deepStrictEqual(parseQuery('   '), { mode: 'help' });
});

// ─── formatResults ──────────────────────────────────────────────────────

test('formatResults zeigt Titel + Quelle + Datum', () => {
  const items = [
    { title: 'PinchTab 0.11 läuft stabil', source: 'notiz', date: '2026-05-27' },
    { title: 'Wochenend-Trip mit Eva geplant', source: 'konversation', date: '2026-05-26' },
  ];
  const out = formatResults(items, { mode: 'time', range: 'this_week' });
  assert.ok(out.includes('🧠'), 'enthält Memory-Emoji');
  assert.ok(out.includes('PinchTab 0.11'), 'enthält ersten Titel');
  assert.ok(out.includes('Wochenend-Trip'), 'enthält zweiten Titel');
  assert.ok(out.includes('notiz') || out.includes('Notiz'), 'enthält Quelle');
});

test('formatResults zeigt "Mehr"-Hinweis bei >5 Treffern', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({
    title: `Item ${i}`,
    source: 'notiz',
    date: '2026-05-27',
  }));
  const out = formatResults(items, { mode: 'time', range: 'this_week' });
  assert.ok(out.includes('Mehr'), 'enthält Mehr-Hinweis');
});

test('formatResults bei leerer Liste → freundliche Nachricht', () => {
  const out = formatResults([], { mode: 'time', range: 'this_week' });
  assert.ok(/keine|nichts|leer/i.test(out), 'enthält leere-Liste-Nachricht');
});

test('formatResults bei mode=help → Hilfe-Text', () => {
  const out = formatResults([], { mode: 'help' });
  assert.ok(/memory/i.test(out), 'enthält Hilfe');
  assert.ok(/über/i.test(out) || /Woche/i.test(out), 'enthält Beispiel');
});

// ─── queryMemory mit Fake-DB ─────────────────────────────────────────────

test('queryMemory ruft queryByTimeRange bei mode=time', async () => {
  const calls = [];
  const fakeDb = {
    queryByTimeRange: async (agent, range) => {
      calls.push({ agent, range });
      return [{ title: 'T', source: 'notiz', date: '2026-05-27' }];
    },
    searchByTopic: async () => {
      throw new Error('should not be called');
    },
  };
  const result = await queryMemory(fakeDb, 'bernd', { mode: 'time', range: 'this_week' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].agent, 'bernd');
  assert.strictEqual(calls[0].range, 'this_week');
  assert.strictEqual(result.length, 1);
});

test('queryMemory ruft searchByTopic bei mode=topic', async () => {
  const calls = [];
  const fakeDb = {
    queryByTimeRange: async () => {
      throw new Error('should not be called');
    },
    searchByTopic: async (agent, topic) => {
      calls.push({ agent, topic });
      return [];
    },
  };
  await queryMemory(fakeDb, 'bernd', { mode: 'topic', topic: 'Eva' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].topic, 'Eva');
});

test('queryMemory gibt [] bei mode=help', async () => {
  const fakeDb = {
    queryByTimeRange: async () => { throw new Error('no'); },
    searchByTopic: async () => { throw new Error('no'); },
  };
  const result = await queryMemory(fakeDb, 'bernd', { mode: 'help' });
  assert.deepStrictEqual(result, []);
});
