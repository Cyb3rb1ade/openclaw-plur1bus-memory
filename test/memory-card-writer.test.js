/**
 * Tests für Memory-Card-Writer.
 *
 * - polishContent ruft Modell mit Klartext-Prompt auf
 * - buildCardMarkdown enthält alle 5 Felder + Frontmatter
 * - writeCard speichert nach memory/cards/YYYY/MM/<datum>-<slug>.md
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  polishContent,
  buildCardMarkdown,
  writeCard,
  slugifyTitle,
} from '../lib/memory-card-writer.js';

// ─── polishContent ──────────────────────────────────────────────────────

test('polishContent ruft Modell mit Klartext-Prompt auf', async () => {
  const fakeModel = {
    calls: [],
    complete: async function ({ prompt }) {
      this.calls.push(prompt);
      return { text: 'Die Riva-STT-Bridge braucht Vorrang für den Umgebungs-Token (Bug behoben am 9. Mai).' };
    },
  };
  const result = await polishContent('riva env-token bug fix', fakeModel);
  assert.ok(result.startsWith('Die '));
  assert.ok(fakeModel.calls[0].includes('grammatikalisch vollständig'));
});

test('polishContent gibt Original zurück wenn Modell fehlt', async () => {
  const result = await polishContent('original', null);
  assert.strictEqual(result, 'original');
});

test('polishContent gibt Original zurück wenn Modell scheitert', async () => {
  const fakeModel = { complete: async () => { throw new Error('boom'); } };
  const result = await polishContent('original input', fakeModel);
  assert.strictEqual(result, 'original input');
});

// ─── buildCardMarkdown ──────────────────────────────────────────────────

test('buildCardMarkdown enthält alle 5 Felder + Frontmatter', () => {
  const md = buildCardMarkdown({
    id: 'abc-123',
    type: 'fakt',
    created: '2026-05-28T10:00:00Z',
    source: 'konversation-xyz',
    title: 'Test',
    polishedContent: 'Test-Inhalt als ganzer Satz.',
    why: 'Aus Gespräch mit Cy',
    learnedAt: '2026-05-28 10:00',
  });
  assert.ok(md.startsWith('---'), 'YAML-Frontmatter am Anfang');
  assert.ok(md.includes('id: abc-123'));
  assert.ok(md.includes('type: fakt'));
  assert.ok(md.includes('source: konversation-xyz'));
  // 5 Felder im Body
  assert.ok(md.includes('**Was:** Test-Inhalt als ganzer Satz.'));
  assert.ok(md.includes('Aus Gespräch mit Cy'), 'why field');
  assert.ok(md.includes('2026-05-28 10:00'), 'learnedAt field');
});

test('buildCardMarkdown hat eindeutige H1 + Frontmatter-End', () => {
  const md = buildCardMarkdown({
    id: 'x',
    type: 'fakt',
    created: '2026-05-28T00:00:00Z',
    source: 'test',
    title: 'Mein Titel',
    polishedContent: 'Inhalt.',
    why: 'Weil',
    learnedAt: '2026-05-28',
  });
  // Frontmatter zwischen --- und ---
  const matches = md.match(/^---\n/gm);
  assert.ok(matches && matches.length >= 2, 'genau 2 Frontmatter-Marker');
  assert.ok(md.includes('# Mein Titel'), 'H1 mit Titel');
});

// ─── slugifyTitle ───────────────────────────────────────────────────────

test('slugifyTitle macht ASCII-slug', () => {
  assert.strictEqual(slugifyTitle('Eva Geburtstag 3. Juni'), 'eva-geburtstag-3-juni');
  assert.strictEqual(slugifyTitle('PinchTab 0.11 läuft stabil'), 'pinchtab-0-11-laeuft-stabil');
});

test('slugifyTitle kappt auf vernünftige Länge', () => {
  const long = 'a'.repeat(200);
  const slug = slugifyTitle(long);
  assert.ok(slug.length <= 80);
});

test('slugifyTitle gibt fallback bei leerem Input', () => {
  assert.match(slugifyTitle(''), /^card-/);
});

// ─── writeCard ──────────────────────────────────────────────────────────

test('writeCard speichert nach vault/memory/cards/YYYY/MM/<datum>-<slug>.md', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'plur1bus-vault-'));
  try {
    const fakeModel = {
      complete: async () => ({ text: 'Geglätteter Satz.' }),
    };
    const card = {
      id: 'aaa-bbb',
      type: 'fakt',
      created: '2026-05-28T10:30:00Z',
      source: 'konversation',
      title: 'Mein Test',
      content: 'roh',
      why: 'Weil Test',
      learnedAt: '2026-05-28 10:30',
    };
    const result = await writeCard(card, { vaultPath: vault, model: fakeModel });
    assert.strictEqual(result.ok, true);
    const expectedDir = join(vault, 'memory', 'cards', '2026', '05');
    assert.ok(existsSync(expectedDir), 'YYYY/MM dir created');
    const files = readdirSync(expectedDir);
    assert.strictEqual(files.length, 1);
    assert.match(files[0], /^2026-05-28-mein-test\.md$/);
    const md = readFileSync(join(expectedDir, files[0]), 'utf8');
    assert.ok(md.includes('Geglätteter Satz.'));
    assert.ok(md.includes('id: aaa-bbb'));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('writeCard returned Pfad zur geschriebenen Datei', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'plur1bus-vault-'));
  try {
    const fakeModel = { complete: async () => ({ text: 'X.' }) };
    const result = await writeCard(
      {
        id: 'id-1', type: 'fakt', created: '2026-05-28T00:00:00Z',
        source: 's', title: 'T', content: 'c', why: 'w', learnedAt: '2026-05-28',
      },
      { vaultPath: vault, model: fakeModel },
    );
    assert.ok(result.path);
    assert.ok(result.path.includes('memory/cards/2026/05'));
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
