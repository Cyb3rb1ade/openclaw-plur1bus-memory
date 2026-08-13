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

test('classifyMemory propagiert Modell-Fehler statt sie als "fakt" zu klassifizieren', async () => {
  const providerError = new Error('secret-bearing provider failure');
  const fakeModel = { complete: async () => { throw providerError; } };
  await assert.rejects(() => classifyMemory('x', fakeModel), (error) => error === providerError);
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

test('buildPushMessage rendert verständliche Textbefehle ohne Buttons', () => {
  const card = {
    id: 'card-1',
    type: 'geburtstag',
    title: 'Evas Geburtstag 3. Juni',
    text: 'Eva hat am 3. Juni Geburtstag.',
    source: 'konversation',
    date: '2026-05-28',
    shortRef: '9a018',
  };
  const msg = buildPushMessage(card);
  assert.ok(msg.text.includes('🧠'));
  assert.ok(msg.text.includes('Geburtstag'));
  // Keine toten Schalter: keine inline_keyboard / callback-Daten.
  assert.strictEqual(msg.inline_keyboard, undefined);
  assert.ok(!msg.text.includes('crit:ok'));
  assert.ok(!msg.text.includes('crit:no'));
  assert.ok(!msg.text.includes('crit:edit'));
  // Funktionierende Textbefehle mit Kurzreferenz.
  assert.ok(msg.text.includes('/plur1bus critical accept 9a018'));
  assert.ok(msg.text.includes('/plur1bus critical reject 9a018'));
  assert.ok(msg.text.includes('/plur1bus critical edit 9a018'));
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

test('runClassifier: Modell-Fehler überspringt Mutation und sanitisiert Diagnostik', async () => {
  const secret = 'sk-live-secret prompt=private x-api-key=hidden';
  const secretName = 'SecretProviderName-private-prompt';
  const logs = [];
  const updates = [];
  const fakeDb = {
    findRecentUnclassified: async () => [
      { id: 'card-secret', content: 'private memory prompt', title: 'private memory prompt' },
    ],
    updateCardType: async (...args) => { updates.push(args); },
  };
  const providerError = new Error(secret);
  providerError.name = secretName;
  const result = await runClassifier(fakeDb, 'agent-secret', {
    model: { complete: async () => { throw providerError; } },
    logger: { info() {}, warn(message) { logs.push(message); } },
  });

  assert.strictEqual(result.processed, 0);
  assert.strictEqual(result.classified, 0);
  assert.strictEqual(result.errors, 1);
  assert.strictEqual(updates.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /sk-live-secret|private memory prompt|x-api-key|SecretProviderName/i);
  assert.doesNotMatch(JSON.stringify(logs), /sk-live-secret|private memory prompt|x-api-key|SecretProviderName/i);
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

// ─── Source-Role / Provenienz im Classifier ────────────────────────────────

const CRIT_UUID_A = 'a4563cc9-7611-4528-992a-075f8889a018';
const CRIT_UUID_B = 'b4563cc9-7611-4528-992a-075f8889a019';

test('runClassifier: Assistant-False-Positive wird nicht gepusht (kein explizites Signal)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'plur1bus-cls-prov-'));
  try {
    const updates = [];
    const fakeDb = {
      findRecentUnclassified: async () => [
        { id: CRIT_UUID_A, content: 'Dein API-Key ist nicht konfiguriert.', title: 'x', sourceMessageRole: 'assistant' },
      ],
      updateCardType: async (agent, id, type) => { updates.push({ id, type }); },
    };
    const fakeModel = { complete: async () => ({ text: 'zugang_passwort' }) };
    const result = await runClassifier(fakeDb, 'agent-prov', {
      model: fakeModel,
      statePath: stateDir,
    });
    assert.strictEqual(result.pushed, 0, 'Assistenten-Klassifikation ohne Wichtigkeitssignal darf nicht pushen');
    assert.strictEqual((result.pushMessages || []).length, 0);
    assert.deepStrictEqual(updates, [{ id: CRIT_UUID_A, type: 'note' }], 'Treffer wird auf gewöhnliche Notiz deklassifiziert');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runClassifier: neverForget in Assistentenquelle bleibt wirksam', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'plur1bus-cls-prov2-'));
  try {
    const updates = [];
    const fakeDb = {
      findRecentUnclassified: async () => [
        { id: CRIT_UUID_B, content: 'Wichtige Regel', title: 'x', sourceMessageRole: 'assistant', neverForget: 1 },
      ],
      updateCardType: async (agent, id, type) => { updates.push({ id, type }); },
    };
    const fakeModel = { complete: async () => ({ text: 'person' }) };
    const result = await runClassifier(fakeDb, 'agent-prov2', {
      model: fakeModel,
      statePath: stateDir,
    });
    assert.strictEqual(result.pushed, 1);
    assert.deepStrictEqual(updates, [{ id: CRIT_UUID_B, type: 'person' }], 'neverForget bleibt als kritisch klassifiziert');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('runClassifier: Push-Nachricht enthält Kurzreferenz statt voller UUID', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'plur1bus-cls-ref-'));
  try {
    const fakeDb = {
      findRecentUnclassified: async () => [
        { id: CRIT_UUID_A, content: 'Eva ist Projektleiterin.', title: 'x', sourceMessageRole: 'user' },
      ],
      updateCardType: async () => {},
    };
    const fakeModel = { complete: async () => ({ text: 'person' }) };
    const result = await runClassifier(fakeDb, 'agent-ref', {
      model: fakeModel,
      statePath: stateDir,
    });
    assert.strictEqual(result.pushed, 1);
    const msg = result.pushMessages[0];
    assert.strictEqual(msg.shortRef, '9a018');
    assert.ok(msg.text.includes('9a018'));
    assert.ok(!msg.text.includes(CRIT_UUID_A), 'vollständige UUID darf nicht im Benutzertext erscheinen');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
