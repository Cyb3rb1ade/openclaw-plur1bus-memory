import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURE_WHITELIST,
  toggleFeature,
  renderToggleResult,
  listFeatures,
} from '../lib/telegram-commands/feature-toggle.js';

function makeTmpConfig(initial = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'plur1bus-toggle-'));
  const path = join(dir, 'openclaw.json');
  writeFileSync(path, JSON.stringify(initial, null, 2));
  return { path, dir };
}

test('FEATURE_WHITELIST enthält Legacy-Aliase und Full-Experience-Core-Features', () => {
  assert.ok(FEATURE_WHITELIST.vaultSync);
  assert.ok(FEATURE_WHITELIST.kritischPush);
  assert.ok(FEATURE_WHITELIST.dailyConsolidation);
  assert.ok(FEATURE_WHITELIST.emotionTier);
  assert.ok(FEATURE_WHITELIST.temporalContext);
  assert.ok(FEATURE_WHITELIST.embeddingCache);
  assert.ok(FEATURE_WHITELIST.reranker);
  assert.ok(FEATURE_WHITELIST.metaCognition);
  assert.ok(FEATURE_WHITELIST.skillMiner);
  assert.ok(FEATURE_WHITELIST.semanticGraph);
  assert.ok(FEATURE_WHITELIST.soulPatch);
  assert.deepStrictEqual(
    FEATURE_WHITELIST.vaultSync.configPath,
    ['plugins', 'entries', 'memory-lancedb-namespaced', 'config', 'obsidianBridge', 'enabled'],
  );
});

test('toggleFeature schreibt enabled=true an den richtigen Pfad', () => {
  const { path, dir } = makeTmpConfig({
    plugins: {
      entries: {
        'memory-lancedb-namespaced': {
          config: { obsidianBridge: { enabled: false } },
        },
      },
    },
  });
  try {
    const res = toggleFeature('vaultSync', true, { configPath: path });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.feature, 'vaultSync');
    assert.strictEqual(res.enabled, true);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(
      after.plugins.entries['memory-lancedb-namespaced'].config.obsidianBridge.enabled,
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toggleFeature erstellt fehlende Zwischenebenen an', () => {
  const { path, dir } = makeTmpConfig({});
  try {
    const res = toggleFeature('dailyConsolidation', true, { configPath: path });
    assert.strictEqual(res.ok, true);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(
      after.plugins.entries['memory-lancedb-namespaced'].config.dailyConsolidation.enabled,
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review toggles write the canonical nested paths without creating legacy aliases', () => {
  const { path, dir } = makeTmpConfig({
    plugins: {
      entries: {
        'memory-lancedb-namespaced': {
          config: {
            obsidianBridge: {
              morningReview: { enabled: false },
              eveningReview: { enabled: false },
            },
          },
        },
      },
    },
  });
  try {
    assert.strictEqual(toggleFeature('morningReview', true, { configPath: path }).ok, true);
    assert.strictEqual(toggleFeature('eveningReview', true, { configPath: path }).ok, true);
    const config = JSON.parse(readFileSync(path, 'utf8'))
      .plugins.entries['memory-lancedb-namespaced'].config;

    assert.strictEqual(config.obsidianBridge.morningReview.enabled, true);
    assert.strictEqual(config.obsidianBridge.eveningReview.enabled, true);
    assert.strictEqual(Object.hasOwn(config, 'morningReview'), false);
    assert.strictEqual(Object.hasOwn(config, 'eveningReview'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toggleFeature ablehnt unbekanntes Feature', () => {
  const { path, dir } = makeTmpConfig({});
  try {
    const res = toggleFeature('unknownThing', true, { configPath: path, lang: 'de' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /unbekannt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderToggleResult Erfolg enthält Restart-Hinweis', () => {
  const out = renderToggleResult({
    ok: true, feature: 'vaultSync', enabled: true,
  }, { lang: 'de' });
  assert.match(out, /✅/);
  assert.match(out, /Vault-Sync \(Obsidian-Bridge\)/);
  assert.match(out, /jetzt an/);
  assert.match(out, /systemctl --user restart openclaw-gateway/);
});

test('renderToggleResult Erfolg für disable', () => {
  const out = renderToggleResult({
    ok: true, feature: 'vaultSync', enabled: false,
  }, { lang: 'de' });
  assert.match(out, /jetzt aus/);
});

test('renderToggleResult Fehler enthält Feature-Liste', () => {
  const out = renderToggleResult({
    ok: false, error: 'Feature "foo" unbekannt.',
    knownFeatures: ['vaultSync', 'kritischPush', 'dailyConsolidation', 'emotionTier'],
  }, { lang: 'de' });
  assert.match(out, /❌/);
  assert.match(out, /Bekannt:/);
  assert.match(out, /vaultSync/);
  assert.match(out, /kritischPush/);
  assert.match(out, /dailyConsolidation/);
  assert.match(out, /emotionTier/);
});

test('listFeatures liefert Legacy- und Core-Featurenamen', () => {
  const list = listFeatures();
  for (const expected of ['dailyConsolidation', 'emotionTier', 'kritischPush', 'vaultSync', 'temporalContext', 'embeddingCache', 'reranker', 'metaCognition', 'skillMiner', 'semanticGraph', 'soulPatch']) {
    assert.ok(list.includes(expected), `missing ${expected}`);
  }
});
