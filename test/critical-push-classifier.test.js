/**
 * Tests für Critical-Push Classifier + State.
 *
 * - classifyMemory ruft Fake-Modell auf, parst Antwort
 * - shouldPush prüft Typ + Per-Day-Limit
 * - buildPushMessage formatiert Telegram-Karte mit 3 Buttons
 * - State (Datei-basiert) lädt + speichert Counts pro Tag
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyMemory,
  shouldPush,
  buildPushMessage,
  CRITICAL_TYPES,
} from '../lib/critical-push-classifier.js';
import {
  loadCounts,
  incrementCount,
  cleanupOldCounts,
} from '../lib/critical-push-state.js';
import { runClassifier } from '../lib/jobs/critical-classifier.js';
import { autoAcceptStale } from '../lib/jobs/auto-accept-stale-criticals.js';

// ─── CRITICAL_TYPES ──────────────────────────────────────────────────────

test('CRITICAL_TYPES enthält die 6 erwarteten Typen', () => {
  for (const t of ['person', 'beziehung', 'geburtstag', 'geld_konto', 'gesundheit', 'zugang_passwort']) {
    assert.ok(CRITICAL_TYPES.includes(t), `${t} fehlt`);
  }
});

// ─── classifyMemory ──────────────────────────────────────────────────────

test('classifyMemory ruft Modell mit content-Prompt auf', async () => {
  const calls = [];
  const fakeModel = {
    complete: async ({ prompt }) => {
      calls.push(prompt);
      return { text: 'person' };
    },
  };
  const result = await classifyMemory('Eva mag Kaffee', fakeModel);
  assert.strictEqual(result, 'person');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].includes('Eva mag Kaffee'));
});

test('classifyMemory akzeptiert nur Typen aus Whitelist, sonst "fakt"', async () => {
  const fakeModel = { complete: async () => ({ text: 'random_junk_type' }) };
  const result = await classifyMemory('Inhalt', fakeModel);
  assert.strictEqual(result, 'fakt');
});

test('classifyMemory trimmt Whitespace und matched case-insensitive', async () => {
  const fakeModel = { complete: async () => ({ text: '  PERSON  ' }) };
  const result = await classifyMemory('x', fakeModel);
  assert.strictEqual(result, 'person');
});

test('classifyMemory wirft nicht bei Modell-Fehler, gibt "fakt"', async () => {
  const fakeModel = { complete: async () => { throw new Error('boom'); } };
  const result = await classifyMemory('x', fakeModel);
  assert.strictEqual(result, 'fakt');
});

// ─── shouldPush ─────────────────────────────────────────────────────────

test('shouldPush gibt true für kritischen Typ unter Limit', () => {
  assert.strictEqual(
    shouldPush({ type: 'person', date: '2026-05-28' }, { '2026-05-28': 2 }, { maxPerDay: 3 }),
    true,
  );
});

test('shouldPush gibt false bei erreichtem Limit', () => {
  assert.strictEqual(
    shouldPush({ type: 'person', date: '2026-05-28' }, { '2026-05-28': 3 }, { maxPerDay: 3 }),
    false,
  );
});

test('shouldPush gibt false für nicht-kritischen Typ', () => {
  assert.strictEqual(
    shouldPush({ type: 'fakt', date: '2026-05-28' }, {}, {}),
    false,
  );
});

test('shouldPush benutzt Default-Limit wenn opts leer', () => {
  // Default = 3
  assert.strictEqual(
    shouldPush({ type: 'person', date: '2026-05-28' }, { '2026-05-28': 5 }, {}),
    false,
  );
});

// ─── buildPushMessage ────────────────────────────────────────────────────

test('buildPushMessage rendert Telegram-Karte mit 3 Buttons', () => {
  const card = {
    id: 'card-1',
    type: 'geburtstag',
    title: 'Evas Geburtstag 3. Juni',
    text: 'Eva hat am 3. Juni Geburtstag.',
    source: 'konversation',
    date: '2026-05-28',
  };
  const msg = buildPushMessage(card);
  assert.ok(msg.text.includes('🔔') || msg.text.includes('🧠'));
  assert.ok(msg.text.includes('Geburtstag'));
  assert.ok(Array.isArray(msg.inline_keyboard));
  // Erwartet 3 Buttons: OK / nein / korrigieren
  const flat = msg.inline_keyboard.flat();
  assert.strictEqual(flat.length, 3);
  assert.ok(flat.some(b => b.callback_data === 'crit:ok:card-1'));
  assert.ok(flat.some(b => b.callback_data === 'crit:no:card-1'));
  assert.ok(flat.some(b => b.callback_data === 'crit:edit:card-1'));
});

// ─── State ──────────────────────────────────────────────────────────────

test('loadCounts gibt leeres Object wenn Datei nicht existiert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plur1bus-cps-'));
  try {
    const counts = loadCounts('agent-x', { stateDir: dir });
    assert.deepStrictEqual(counts, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incrementCount erhöht den Counter und persistiert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plur1bus-cps-'));
  try {
    incrementCount('agent-x', '2026-05-28', { stateDir: dir });
    incrementCount('agent-x', '2026-05-28', { stateDir: dir });
    incrementCount('agent-x', '2026-05-27', { stateDir: dir });
    const counts = loadCounts('agent-x', { stateDir: dir });
    assert.strictEqual(counts['2026-05-28'], 2);
    assert.strictEqual(counts['2026-05-27'], 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Cron-Job runClassifier (verkabelt mit db-adapter Methoden) ───────────

test('runClassifier: skipt graceful wenn db.findRecentUnclassified fehlt', async () => {
  const result = await runClassifier({}, 'agent-x');
  assert.strictEqual(result.processed, 0);
  assert.strictEqual(result.pushed, 0);
  assert.match(result.note, /findRecentUnclassified missing/);
});

test('runClassifier: klassifiziert, updated type, pushed wenn eligible', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'plur1bus-cls-'));
  try {
    const updates = [];
    const sends = [];
    const fakeDb = {
      findRecentUnclassified: async () => [
        { id: 'card-a', content: 'Eva mag Kaffee', title: 'Eva mag Kaffee' },
        { id: 'card-b', content: 'random fakt', title: 'random fakt' },
      ],
      updateCardType: async (agent, id, type) => {
        updates.push({ id, type });
      },
    };
    let callIdx = 0;
    const fakeModel = {
      complete: async () => ({ text: ['person', 'fakt'][callIdx++] }),
    };
    const fakeSend = async (msg) => { sends.push(msg); };

    const result = await runClassifier(fakeDb, 'agent-x', {
      model: fakeModel,
      telegramSend: fakeSend,
      statePath: stateDir,
    });
    assert.strictEqual(result.processed, 2, 'beide cards processed');
    assert.strictEqual(result.classified, 2, 'beide cards classified');
    assert.strictEqual(result.pushed, 1, '1 push für person, 0 für fakt');
    assert.strictEqual(updates.length, 2);
    assert.deepStrictEqual(updates[0], { id: 'card-a', type: 'person' });
    assert.deepStrictEqual(updates[1], { id: 'card-b', type: 'fakt' });
    assert.strictEqual(sends.length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runClassifier: no-op-result wenn keine recent cards', async () => {
  const fakeDb = {
    findRecentUnclassified: async () => [],
  };
  const result = await runClassifier(fakeDb, 'agent-x');
  assert.strictEqual(result.processed, 0);
  assert.strictEqual(result.pushed, 0);
});

test('runClassifier: zählt errors korrekt wenn updateCardType wirft', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'plur1bus-cls-'));
  try {
    const fakeDb = {
      findRecentUnclassified: async () => [
        { id: 'card-a', content: 'foo', title: 'foo' },
      ],
      updateCardType: async () => { throw new Error('db boom'); },
    };
    const fakeModel = { complete: async () => ({ text: 'fakt' }) };
    const result = await runClassifier(fakeDb, 'agent-x', {
      model: fakeModel,
      statePath: stateDir,
    });
    assert.strictEqual(result.processed, 1);
    assert.strictEqual(result.classified, 0);
    assert.strictEqual(result.errors, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ─── Cron-Job autoAcceptStale ───────────────────────────────────────────

test('autoAcceptStale: skipt graceful wenn db.findUnconfirmedCritical fehlt', async () => {
  const result = await autoAcceptStale({}, 'agent-x');
  assert.strictEqual(result.autoAccepted, 0);
  assert.match(result.note, /findUnconfirmedCritical missing/);
});

test('autoAcceptStale: markiert pending cards als confirmed', async () => {
  const marked = [];
  const fakeDb = {
    findUnconfirmedCritical: async () => [
      { id: 'c1', type: 'person' },
      { id: 'c2', type: 'geburtstag' },
    ],
    markConfirmed: async (agent, id) => {
      marked.push(id);
    },
  };
  const result = await autoAcceptStale(fakeDb, 'agent-x', { hours: 24 });
  assert.strictEqual(result.autoAccepted, 2);
  assert.strictEqual(result.scanned, 2);
  assert.deepStrictEqual(marked.sort(), ['c1', 'c2']);
});

test('autoAcceptStale: zählt errors wenn markConfirmed wirft', async () => {
  const fakeDb = {
    findUnconfirmedCritical: async () => [{ id: 'c1', type: 'person' }],
    markConfirmed: async () => { throw new Error('mark boom'); },
  };
  const result = await autoAcceptStale(fakeDb, 'agent-x', { hours: 24 });
  assert.strictEqual(result.autoAccepted, 0);
  assert.strictEqual(result.errors, 1);
});

test('cleanupOldCounts entfernt Einträge älter als 7 Tage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plur1bus-cps-'));
  try {
    // Heute = 2026-05-28
    const today = '2026-05-28';
    const file = join(dir, 'agent-x.json');
    writeFileSync(file, JSON.stringify({
      '2026-05-20': 5,  // 8 Tage alt → raus
      '2026-05-21': 3,  // 7 Tage → bleibt (Cutoff inclusive)
      '2026-05-28': 2,  // heute → bleibt
    }));
    cleanupOldCounts('agent-x', today, { stateDir: dir });
    const counts = loadCounts('agent-x', { stateDir: dir });
    assert.strictEqual(counts['2026-05-20'], undefined);
    assert.strictEqual(counts['2026-05-21'], 3);
    assert.strictEqual(counts['2026-05-28'], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
