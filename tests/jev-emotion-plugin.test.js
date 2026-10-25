import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import plugin from '../index.js';
import { EMOTION_DIMENSIONS } from '../lib/jevEmotion.js';

async function fixture(t, overrides = {}, routing = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jev-plugin-'));
  const hooks = new Map();
  const fetchOriginal = globalThis.fetch;
  const requests = [];
  const logs = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    const answers = Object.fromEntries(Object.keys(request.questions).map(key => [key, key.endsWith('_source') ? { choice: 'own', confidence: 0.9 } : { score: 2, confidence: 0.9 }]));
    return { ok: true, json: async () => ({ answers }) };
  };
  const api = {
    pluginConfig: { baseDbPath: root, embedding: { provider: 'local-transformers', local: { dimensions: 384 } }, autoCapture: false, autoRecall: false, neo: { enabled: false }, obsidianBridge: { enabled: false }, gc: { enabled: false }, captureChunkingJev: { apiKey: 'offline-test-only' }, emotion: { jev: { enabled: true, agents: { main: true }, mode: 'active' } }, ...overrides },
    logger: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(level => [level, (...args) => logs.push([level, ...args])])),
    resolvePath: value => value, registerTool() {}, registerCommand() {}, registerService() {},
    on(name, handler, options) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push({ handler, priority: options?.priority || 0 }); },
  };
  plugin.register(api, { importRouting: async () => ({ isIncognitoSessionKey: () => false, parseAgentSessionKey: value => { const m = /^agent:([^:]+):(.+)$/.exec(value); return m ? { agentId: m[1], rest: m[2] } : null; }, parseThreadSessionSuffix: value => ({ baseSessionKey: value, threadId: '' }), normalizeOptionalAccountId: value => value, normalizeMessageChannel: value => value, ...routing }) });
  const ctx = { agentId: 'main', sessionKey: 'agent:main:telegram:fixture', sessionId: 'session-fixture', runId: 'run-fixture', workspaceDir: root };
  const event = { currentUserMessage: 'Ja', currentUserMessageId: 'fixture-input', prompt: 'Ja' };
  async function prompt() {
    const results = [];
    for (const { handler } of [...(hooks.get('before_prompt_build') || [])].sort((a, b) => b.priority - a.priority)) results.push(await handler(event, ctx));
    return results;
  }
  t.after(async () => {
    for (const { handler } of hooks.get('gateway_stop') || []) await handler({}, {});
    globalThis.fetch = fetchOriginal;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, api, hooks, ctx, event, requests, prompt, logs };
}

test('real plugin registers independent owner with recall disabled and accepts short input', async t => {
  const f = await fixture(t);
  const results = await f.prompt();
  assert.equal(f.requests.length, 1);
  assert.ok(results.some(result => result?.prependContext?.includes('<jev-emotion>')));
  assert.ok(existsSync(join(f.root, '.emotional-state.json')));
  assert.ok(f.hooks.has('resolve_exec_env'));
});

test('real policy denies incognito/classifier failure/background internal memory command before Jev', async t => {
  for (const routing of [{ isIncognitoSessionKey: () => true }, { isIncognitoSessionKey: () => { throw new Error('unavailable'); } }]) {
    const f = await fixture(t, {}, routing);
    await f.prompt();
    assert.equal(f.requests.length, 0);
    assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
  }
  const f = await fixture(t);
  f.event.prompt = '/recall'; f.ctx.source = 'background';
  await f.prompt();
  assert.equal(f.requests.length, 0);
});

test('real recall path cannot prevent independent state when DB open fails', async t => {
  const f = await fixture(t, { autoRecall: true });
  writeFileSync(join(f.root, 'main'), 'blocks database directory');
  f.event.prompt = 'A real authored short request';
  f.event.currentUserMessage = f.event.prompt;
  const results = await f.prompt();
  assert.equal(f.requests.length, 1);
  assert.ok(results.some(result => result?.prependContext?.includes('<jev-emotion>')));
  assert.ok(existsSync(join(f.root, '.emotional-state.json')));
  assert.match(JSON.stringify(f.logs), /recall (?:scheduler )?failed.*(directory|ENOTDIR|EEXIST|Path traversal blocked)/i);
});

test('standalone injector suppresses active enabled agent but retains shadow/other agents', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jev-injector-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.emotional-state.json'), JSON.stringify({ label: 'ruhig', details: Object.fromEntries(EMOTION_DIMENSIONS.map(key => [key, 0.1])) }));
  const register = createRequire(import.meta.url)('../.openclaw/extensions/emotional-state-injector/index.js');
  let handler;
  const config = { plugins: { entries: { 'memory-lancedb-namespaced': { config: { emotion: { jev: { enabled: true, mode: 'active', agents: { main: true } } } } } } } };
  register({ config, on(_name, fn) { handler = fn; } });
  assert.equal(await handler({}, { agentId: 'main', workspaceDir: root }), undefined);
  assert.ok((await handler({}, { agentId: 'bernhardine', workspaceDir: root }))?.prependContext);
  config.plugins.entries['memory-lancedb-namespaced'].config.emotion.jev.mode = 'shadow';
  assert.ok((await handler({}, { agentId: 'main', workspaceDir: root }))?.prependContext);
});

test('actual legacy block skips inference, fallback and file writer in active mode', async t => {
  const { compileFunction } = await import('node:vm');
  const { createEmotionalStatePool, formatMoodFile, extractMessageText } = await import('../lib/emotional-state.js');
  const { resolveInside } = await import('../lib/sql-safety.js');
  const { throwIfAborted } = await import('../lib/abort.js');
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const begin = source.indexOf('          const emoState = emotionalPool.get(agentId);', source.indexOf('api.on("before_prompt_build"'));
  const end = source.indexOf('          // v5.4.0 — Graph-Edges', begin);
  const block = compileFunction(`return (async () => { ${source.slice(begin, end)} })();`, ['emotionalPool', 'agentId', 'jevEmotionRuntime', 'ctx', 'event', 'voiceMessages', 'signal', 'inferEmotionalValenceAsync', 'throwIfAborted', 'dbg', 'writeFileSync', 'join', 'formatMoodFile', 'extractMessageText', 'resolveInside']);
  const root = mkdtempSync(join(tmpdir(), 'jev-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pool = createEmotionalStatePool();
  const before = pool.snapshot('main');
  const offlineInference = async () => { throw new Error('offline external model failure'); };
  const args = [pool, 'main', { isEnabled: () => true }, { workspaceDir: root }, { prompt: 'Ich bin traurig und einsam.' }, [{ role: 'user', content: 'Ich bin traurig und einsam.' }], undefined, offlineInference, throwIfAborted, () => {}, writeFileSync, join, formatMoodFile, extractMessageText, resolveInside];
  await block(...args);
  assert.deepEqual(pool.snapshot('main'), before);
  assert.equal(existsSync(join(root, '.emotional-state.json')), false);
  args[2] = { isEnabled: () => false };
  await block(...args);
  assert.ok(existsSync(join(root, '.emotional-state.json')));
  assert.ok(existsSync(join(root, '.current-mood.txt')));
  assert.notDeepEqual(pool.snapshot('main'), before);
});
