import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers/temp-dir.js';
import { compileFunction } from 'node:vm';
import { createJevEmotionRuntime, createSharedJevEmotionalPool } from '../lib/jevEmotionRuntime.js';
import { formatMoodFile, extractMessageText } from '../lib/emotional-state.js';
import { resolveInside } from '../lib/sql-safety.js';
import { throwIfAborted } from '../lib/abort.js';
import { planTelegramSpeech } from '../lib/telegramSpeech.js';
import { patchExecContextSource } from '../scripts/telegramTts/patch-exec-speech-context.mjs';
import { prepareSpeechText } from '../lib/speechText.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const begin = source.indexOf('          const emoState = emotionalPool.get(agentId);', source.indexOf('api.on("before_prompt_build"'));
const end = source.indexOf('          // v5.4.0 — Graph-Edges', begin);
assert.ok(begin >= 0 && end > begin);
const legacy = compileFunction(`return (async () => { ${source.slice(begin, end)} })();`, ['emotionalPool', 'agentId', 'jevEmotionRuntime', 'ctx', 'event', 'voiceMessages', 'signal', 'inferEmotionalValenceAsync', 'throwIfAborted', 'dbg', 'writeFileSync', 'join', 'formatMoodFile', 'extractMessageText', 'resolveInside']);
const reaction = joy => ({ ok: true, reaction: { joy, sadness: 0, anger: 0, fear: 0, disgust: 0, surprise: 0, trust: 0, anticipation: 0 }, reactionDimensions: ['joy'], elapsedMs: 12, confidence: 1, sections: [] });
function fixture(t, mode = 'shadow', options = {}) {
  const root = makeTempDir('jev-final-');
  const config = { baseDbPath: root, emotion: { jev: { enabled: mode !== 'disabled', mode: mode === 'disabled' ? 'shadow' : mode, agents: { main: true } } } };
  const pool = createSharedJevEmotionalPool(config);
  const runtimes = [];
  const create = (mode, overrides = {}) => {
    const nextConfig = { ...config, emotion: { jev: { ...config.emotion.jev, enabled: mode !== 'disabled', mode: mode === 'disabled' ? 'shadow' : mode } } };
    const runtime = createJevEmotionRuntime({ config: nextConfig, emotionalPool: pool, isEligible: () => true, assessor: async () => reaction(.8), ...options, ...overrides });
    runtimes.push(runtime);
    return runtime;
  };
  t.after(async () => { for (const runtime of runtimes) await runtime.endRun({}, { agentId: 'main', sessionKey: 'telegram:fixture' }); rmSync(root, { recursive: true, force: true }); });
  const ctx = { agentId: 'main', sessionKey: 'telegram:fixture', sessionId: 'session', runId: 'run', workspaceDir: root };
  const event = { currentUserMessage: 'Authored private request', currentUserMessageId: 'message' };
  return { root, config, pool, ctx, event, create, runtime: create(mode) };
}

for (const mode of ['shadow', 'disabled']) for (const outcome of ['success', 'reject']) {
  test(`production legacy ${mode} ${outcome} keeps its ordinary update and files`, async t => {
    const f = fixture(t, mode);
    const state = f.pool.get('main');
    const before = state.serializeState().current;
    await legacy(f.pool, 'main', f.runtime, f.ctx, { prompt: 'Ich bin traurig und einsam.' }, [{ role: 'user', content: 'Ich bin traurig und einsam.' }], undefined,
      async () => { if (outcome === 'reject') throw new Error('external inference failed'); return { sadness: 1, emotionalIntensity: 1 }; }, throwIfAborted, () => {}, writeFileSync, join, formatMoodFile, extractMessageText, resolveInside);
    assert.notDeepEqual(state.serializeState().current, before);
    assert.ok(existsSync(join(f.root, '.emotional-state.json')));
    assert.ok(existsSync(join(f.root, '.current-mood.txt')));
  });
}

for (const transition of ['active', 'active-then-shadow']) for (const outcome of ['success', 'reject']) {
  test(`production pending legacy ${outcome} loses ownership after ${transition} with zero stale mutation or writes`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
    const f = fixture(t);
    let settle;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pendingInference = new Promise((resolve, reject) => { settle = () => outcome === 'success' ? resolve({ sadness: 1, emotionalIntensity: 1 }) : reject(new Error('external inference failed')); });
    const writes = [];
    const signal = new AbortController().signal;
    const pending = legacy(f.pool, 'main', f.runtime, f.ctx, { prompt: 'Ich bin traurig und einsam.' }, [{ role: 'user', content: 'Ich bin traurig und einsam.' }], signal,
      () => { started(); return pendingInference; }, throwIfAborted, () => {}, (path, ...args) => { writes.push(path); return writeFileSync(path, ...args); }, join, formatMoodFile, extractMessageText, resolveInside);
    await ready;
    const active = f.create('active');
    await active.beforePrompt(f.event, f.ctx);
    assert.equal(f.pool.get('main').serializeState().timedMood.eventIds.length, 1);
    if (transition === 'active-then-shadow') f.create('shadow');
    const stateBefore = f.pool.get('main').serializeState();
    const filesBefore = ['.emotional-state.json', '.current-mood.txt'].map(name => readFileSync(join(f.root, name), 'utf8'));
    settle();
    await pending;
    assert.equal(signal.aborted, false);
    assert.deepEqual(writes, [], 'old inference must not replace either mood file');
    assert.deepEqual(f.pool.get('main').serializeState().current, stateBefore.current, 'neither success nor fallback may blend stale sadness');
    assert.deepEqual(['.emotional-state.json', '.current-mood.txt'].map(name => readFileSync(join(f.root, name), 'utf8')), filesBefore);
  });
}

test('shadow runtime through trusted host and real adapter carries authored persona/context/current mood, closes terminal and revoked runs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  let allowed = true;
  const inputs = [];
  const f = fixture(t, 'shadow', { isEligible: () => allowed, assessor: async input => { inputs.push(input); return reaction(.8); } });
  writeFileSync(join(f.root, 'persona-voice.md'), '<!-- persona:begin -->\n- Private gentle persona\n<!-- persona:end -->');
  f.pool.get('main').applyEmotionScore({ sadness: 1, emotionalIntensity: 1 });
  const before = f.pool.get('main').serializeState();
  const beforeMood = f.pool.snapshot('main');
  assert.equal(await f.runtime.beforePrompt(f.event, f.ctx), undefined);
  await f.runtime.endRun({ messages: [{ role: 'assistant', content: 'Authored private reply' }, { role: 'tool', content: 'FORBIDDEN tool result' }] }, f.ctx);
  const ctx = { ...f.ctx, runId: 'second' };
  const event = { currentUserMessage: 'Authored second request', currentUserMessageId: 'second' };
  assert.equal(await f.runtime.beforePrompt(event, ctx), undefined);
  const host = readFileSync(new URL('./fixtures/telegramSpeech/bash-tools-host.mjs', import.meta.url), 'utf8');
  const { call } = await import('data:text/javascript;base64,' + Buffer.from(patchExecContextSource(host)).toString('base64'));
  const hook = { runResolveExecEnv: (event, ctx) => f.runtime.resolveExecEnv(event, ctx) };
  const env = await call({ agentId: 'main', defaults: {} }, { hookContext: ctx }, { env: { PLUR1BUS_SPEECH_RUN_ID: 'forged' }, workdir: '/forged' }, hook);
  assert.ok(env.PLUR1BUS_SPEECH_CONTEXT_FILE, 'configured shadow must publish exact run context');
  assert.equal(statSync(env.PLUR1BUS_SPEECH_CONTEXT_FILE).mode & 0o777, 0o600);
  let planned;
  const result = await planTelegramSpeech({ agentId: 'main', versions: [{ id: 'de', text: 'Gut gemacht.' }] }, { config: f.config, workspace: f.root, env, planner: async input => {
    planned = input;
    return { ok: true, versions: input.versions.map(v => ({ ...v, segments: [{ start: 0, end: [...v.text].length, intent: 'praise', delivery: 'warm', action: 'none', confidence: 1 }] })) };
  } });
  assert.equal(result.context, 'run');
  assert.deepEqual(planned.context, [{ role: 'assistant', content: 'Authored private reply' }, { role: 'user', content: 'Authored second request' }]);
  assert.match(planned.persona, /Private gentle persona/);
  assert.equal(planned.persona, inputs[1].persona);
  assert.deepEqual(planned.mood, beforeMood);
  assert.equal(result.versions[0].speech, 'Gut gemacht.');
  assert.deepEqual(result.versions[0].proposed, [{ section: 0, intent: 'praise', delivery: 'warm', action: 'none' }]);
  assert.deepEqual(f.pool.get('main').serializeState(), before, 'shadow must not add timed evidence or change mood');
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
  assert.equal(existsSync(join(f.root, '.current-mood.txt')), false);
  await f.runtime.endRun({}, ctx);
  assert.equal(existsSync(env.PLUR1BUS_SPEECH_CONTEXT_FILE), false);
  assert.equal(await f.runtime.beforePrompt(event, ctx), undefined);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, ctx), {});
  const revoked = { ...ctx, runId: 'revoked' };
  await f.runtime.beforePrompt({ ...event, currentUserMessageId: 'third' }, revoked);
  const revokedEnv = await f.runtime.resolveExecEnv({}, revoked);
  allowed = false;
  assert.deepEqual(await f.runtime.resolveExecEnv({}, revoked), {});
  assert.equal(existsSync(revokedEnv.PLUR1BUS_SPEECH_CONTEXT_FILE), false);
  allowed = true;
  assert.equal(await f.runtime.beforePrompt({ ...event, currentUserMessageId: 'third' }, revoked), undefined);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, revoked), {});
});

test('incoming shadow proposals expose only known finite dimensions and bounded closed diagnostics', async t => {
  const logs = [];
  const results = [
    { ...reaction(.8), reaction: { ...reaction(.8).reaction, trust: NaN, SECRET: 'SECRET' }, reactionDimensions: ['joy', 'trust', 'SECRET'], text: 'SECRET', persona: 'SECRET' },
    { ...reaction(.2), elapsedMs: Infinity },
    { ok: false, reason: 'invalid_or_uncertain_answer', elapsedMs: 20, reaction: { joy: .9 } },
    { ok: false, reason: 'SECRET arbitrary model prose', elapsedMs: -2, secret: 'SECRET' },
  ];
  const f = fixture(t, 'shadow', { logger: { debug: (...args) => logs.push(args) }, assessor: async () => results.shift() });
  for (let i = 0; i < 4; i++) await f.runtime.beforePrompt({ ...f.event, currentUserMessageId: `message-${i}` }, { ...f.ctx, runId: `run-${i}` });
  const summaries = logs.filter(([message]) => /shadow_(accepted|rejected)/.test(message)).map(([, metadata]) => metadata);
  assert.deepEqual(summaries, [
    { outcome: 'accepted', reason: 'accepted', elapsedMs: 12, reaction: { joy: .8 } },
    { outcome: 'accepted', reason: 'accepted', elapsedMs: null, reaction: { joy: .2 } },
    { outcome: 'rejected', reason: 'invalid_or_uncertain_answer', elapsedMs: 20, reaction: {} },
    { outcome: 'rejected', reason: 'rejected', elapsedMs: null, reaction: {} },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|Authored|persona|trust|sadness/);
});

for (const [input, expected] of [
  ['<span hidden>Hallo</span>', 'Hallo'],
  ['<span hidden inert title="x > y">Hallo</span><br hidden/>Welt', 'HalloWelt'],
  ["<div hidden class='x > y' inert>Grüße</div>", 'Grüße'],
  ['a < b and c > d; <span maybe comparison > bleibt', 'a < b and c > d; <span maybe comparison > bleibt'],
  ['x <span hiddenness> y; x <span hidden > y', 'x <span hiddenness> y; x  y'],
]) test(`canonical HTML boolean attributes preserve prose: ${input}`, () => assert.deepEqual(prepareSpeechText(input), { text: expected, blocked: false }));

test('stale shadow exec handler cannot delete the replacement generation context', async t => {
  const f = fixture(t);
  await f.runtime.beforePrompt(f.event, f.ctx);
  const active = f.create('active');
  const ctx = { ...f.ctx, runId: 'replacement' };
  await active.beforePrompt(f.event, ctx);
  const currentEnv = await active.resolveExecEnv({}, ctx);
  assert.ok(currentEnv.PLUR1BUS_SPEECH_CONTEXT_FILE);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, ctx), {});
  assert.ok(existsSync(currentEnv.PLUR1BUS_SPEECH_CONTEXT_FILE));
  assert.deepEqual(await active.resolveExecEnv({}, ctx), currentEnv);
});

for (const mode of ['shadow', 'active']) test(`${mode} exposes matching authored contextual inputs to outgoing comparison`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const f = fixture(t, mode, { assessor: async () => ({ ok: false, reason: 'invalid_or_uncertain_answer' }) });
  writeFileSync(join(f.root, 'persona-voice.md'), '<!-- persona:begin -->\n- Private gentle persona\n<!-- persona:end -->');
  f.pool.get('main').applyEmotionScore({ sadness: 1, emotionalIntensity: 1 });
  await f.runtime.beforePrompt(f.event, f.ctx);
  await f.runtime.endRun({ messages: [{ role: 'assistant', content: 'Authored private reply' }] }, f.ctx);
  const ctx = { ...f.ctx, runId: 'second' };
  await f.runtime.beforePrompt({ currentUserMessage: 'Authored second request', currentUserMessageId: 'second' }, ctx);
  const env = await f.runtime.resolveExecEnv({}, ctx);
  const result = await planTelegramSpeech({ agentId: 'main', versions: [{ id: 'de', text: 'Gut gemacht.' }] }, { config: f.config, workspace: f.root, env, planner: async input => {
    assert.deepEqual(input.context, [{ role: 'assistant', content: 'Authored private reply' }, { role: 'user', content: 'Authored second request' }]);
    assert.match(input.persona, /Private gentle persona/);
    assert.equal(input.mood.sadness, .632);
    return { ok: true, versions: input.versions.map(v => ({ ...v, segments: [{ start: 0, end: [...v.text].length, intent: 'praise', delivery: 'warm', action: 'none', confidence: 1 }] })) };
  } });
  assert.equal(result.context, 'run');
  assert.equal(result.versions[0].speech, mode === 'shadow' ? 'Gut gemacht.' : '[warm]Gut gemacht.');
  assert.deepEqual(result.versions[0].proposed, [{ section: 0, intent: 'praise', delivery: 'warm', action: 'none' }]);
});

for (const ending of ['terminal', 'revoked']) test(`pending shadow ${ending} cannot publish or revive context`, async t => {
  let release;
  let allowed = true;
  const f = fixture(t, 'shadow', { isEligible: () => allowed, assessor: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.runtime.beforePrompt(f.event, f.ctx);
  await new Promise(resolve => setImmediate(resolve));
  if (ending === 'terminal') await f.runtime.endRun({}, f.ctx);
  else allowed = false;
  release(reaction(.8));
  assert.equal(await pending, undefined);
  allowed = true;
  assert.deepEqual(await f.runtime.resolveExecEnv({}, f.ctx), {});
  assert.equal(await f.runtime.beforePrompt(f.event, f.ctx), undefined);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, f.ctx), {});
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
});
