import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isInjectedContextText,
  pruneNeoJsonlFile,
  turnEventsFromMessages,
  memoryCandidatesFromTurns,
  createNeoStore,
} from '../lib/neo-arch.js';

test('isInjectedContextText flags recall/system/cron blocks but keeps real facts', () => {
  assert.equal(isInjectedContextText('<plur1bus-recall untrusted="true">stuff</plur1bus-recall>'), true);
  assert.equal(isInjectedContextText('<relevant-memories>...'), true);
  assert.equal(isInjectedContextText('RECALL SAFETY RULES:\n- foo'), true);
  assert.equal(isInjectedContextText('<knowledge-update-reminder>'), true);
  assert.equal(isInjectedContextText('<adaptive-learning>\nNamespace: bernhardine'), true);
  assert.equal(isInjectedContextText('TTS-STATUS: ok'), true);
  assert.equal(isInjectedContextText('[cron: heartbeat] running'), true);
  assert.equal(isInjectedContextText('Reference UTC: 2026-05-29'), true);
  // echte User-/Projektfakten bleiben drin
  assert.equal(isInjectedContextText('Bernd bevorzugt kurze Antworten auf Deutsch.'), false);
  assert.equal(isInjectedContextText('Die WordPress-Seite ist über 20GB groß.'), false);
});

test('turnEventsFromMessages skips injected context, keeps real turns', () => {
  const turns = turnEventsFromMessages([
    { role: 'user', content: 'Ich mag prägnante Antworten.' },
    { role: 'assistant', content: '<plur1bus-recall untrusted="true">RECALL SAFETY RULES: ...</plur1bus-recall>' },
    { role: 'user', content: '<knowledge-update-reminder>remember to ...</knowledge-update-reminder>' },
    { role: 'assistant', content: 'Verstanden, ich fasse mich kurz.' },
  ], { workspaceKey: 'test', agentId: 'main' });
  const texts = turns.map(t => t.content);
  assert.equal(turns.length, 2);
  assert.ok(texts.includes('Ich mag prägnante Antworten.'));
  assert.ok(texts.includes('Verstanden, ich fasse mich kurz.'));
});

test('memoryCandidatesFromTurns does not emit candidates for injected content (defense in depth)', () => {
  // künstlicher Turn mit injiziertem Content, der den ersten Filter umginge
  const fakeTurn = {
    id: 'x', workspaceKey: 'test', agentId: 'main', role: 'user',
    content: '<relevant-memories>leak</relevant-memories>',
    categories: ['project_fact'],
    origin: { trustLevel: 'user_asserted' },
    visibility: { recallable: true },
    quality: { promptInjectionSuspected: false, confidence: 0.7 },
    createdAt: new Date().toISOString(),
  };
  const candidates = memoryCandidatesFromTurns([fakeTurn]);
  assert.equal(candidates.length, 0);
});

test('pruneNeoJsonlFile removes injected lines, dedups, caps; dry-run does not write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-prune-'));
  const file = join(dir, 'memory-candidates.jsonl');
  const lines = [
    JSON.stringify({ statement: 'Echter Fakt A', normalizedStatement: 'echter fakt a' }),
    JSON.stringify({ statement: 'Echter Fakt A (dup)', normalizedStatement: 'echter fakt a' }),
    JSON.stringify({ statement: '<plur1bus-recall>garbage</plur1bus-recall>' }),
    JSON.stringify({ statement: 'Echter Fakt B', normalizedStatement: 'echter fakt b' }),
  ];
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const dry = pruneNeoJsonlFile(file, { dryRun: true });
  assert.equal(dry.before, 4);
  assert.equal(dry.removedInjected, 1);
  assert.equal(dry.removedDup, 1);
  assert.equal(dry.after, 2);
  // dry-run darf nicht schreiben
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 4);

  const applied = pruneNeoJsonlFile(file, { dryRun: false });
  assert.equal(applied.after, 2);
  const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).statement);
  assert.deepEqual(kept, ['Echter Fakt A', 'Echter Fakt B']);
});

test('pruneNeoJsonlFile caps to maxRecords keeping the newest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-cap-'));
  const file = join(dir, 'turn-journal.jsonl');
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(JSON.stringify({ content: `fact ${i}`, normalizedStatement: `fact ${i}` }));
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const res = pruneNeoJsonlFile(file, { maxRecords: 10, dryRun: false });
  assert.equal(res.removedCap, 40);
  assert.equal(res.after, 10);
  const kept = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).content);
  assert.equal(kept[0], 'fact 40');
  assert.equal(kept[9], 'fact 49');
});

test('createNeoStore pruneAll cleans candidates and turns, skips dedup on embedding-queue', () => {
  const root = mkdtempSync(join(tmpdir(), 'neo-store-'));
  const store = createNeoStore(root, 'main');
  store.appendCandidates([
    { statement: 'Fakt', normalizedStatement: 'fakt' },
    { statement: 'Fakt dup', normalizedStatement: 'fakt' },
    { statement: '<plur1bus-recall>x</plur1bus-recall>' },
  ]);
  const report = store.pruneAll({ dryRun: false });
  assert.equal(report.candidates.removedInjected, 1);
  assert.equal(report.candidates.removedDup, 1);
  assert.equal(report.candidates.after, 1);
});

test('store roundtrip: appendCandidates then readCandidates returns recent records via efficient tail', () => {
  const root = mkdtempSync(join(tmpdir(), 'neo-tail-'));
  const store = createNeoStore(root, 'main');
  const items = [];
  for (let i = 0; i < 20; i++) items.push({ statement: `s${i}`, normalizedStatement: `s${i}` });
  store.appendCandidates(items);
  const tail = store.readCandidates(5);
  assert.equal(tail.length, 5);
  assert.equal(tail[tail.length - 1].statement, 's19');
});
