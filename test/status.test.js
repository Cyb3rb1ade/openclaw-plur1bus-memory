import { test } from 'node:test';
import assert from 'node:assert';
import { renderStatus } from '../lib/telegram-commands/status.js';

test('status zeigt grün wenn alles OK', () => {
  const result = renderStatus({
    memory: { cardCount: 4218, lastUpdateMinutes: 12 },
    sync: { active: true, devices: 3 },
    plausibility: { lastRun: '2026-05-27T20:30:00Z' },
    issues: [],
  }, { lang: 'de' });
  assert.ok(result.includes('🟢'));
  assert.ok(result.includes('4218'));
  assert.ok(result.includes('3 Geräten'));
});

test('status zeigt jeden issue mit grund + einschalt-anleitung', () => {
  const result = renderStatus({
    memory: { cardCount: 100, lastUpdateMinutes: 5 },
    sync: { active: false, devices: 0 },
    plausibility: { lastRun: '2026-05-27T20:30:00Z' },
    issues: [{
      key: 'vaultSync',
      title: 'Vault-Sync ist aus',
      reason: 'in /tmp/openclaw.json steht "plugins.entries[memory-lancedb-namespaced].config.obsidianBridge.enabled: false"',
      howToFix: '/einschalten vaultSync',
      whatItDoes: 'spiegelt deine Erinnerungen in den Obsidian-Vault',
      whatYouLose: 'du siehst Erinnerungen nur über /memory, nicht im Vault',
    }],
  }, { lang: 'de' });
  assert.ok(result.includes('🟡'));
  assert.ok(result.includes('Vault-Sync ist aus'));
  assert.ok(result.includes('Grund:'));
  assert.ok(result.includes('/einschalten vaultSync'));
  assert.ok(result.includes('Was es macht:'));
  assert.ok(result.includes('Was du ohne es verlierst:'));
});
