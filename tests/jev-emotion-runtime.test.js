import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEffectiveConfig } from '../lib/setup/config-contract.js';

const vector = (joy = 0.8) => ({ joy, sadness: 0, anger: 0, fear: 0, disgust: 0, surprise: 0.2, trust: 0.7, anticipation: 0.5 });
const accepted = (joy) => ({ ok: true, reaction: vector(joy), confidence: 0.9, sections: [] });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jev-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mod = await import('../lib/jevEmotionRuntime.js');
  const config = { baseDbPath: root, emotion: { jev: { enabled: true, agents: { main: true }, mode: 'active', ...options.jev } } };
  const emotionalPool = mod.createSharedJevEmotionalPool(config);
  const hooks = new Map();
  const api = { on(name, fn) { hooks.set(name, fn); } };
  const inputs = [];
  const runtime = mod.createJevEmotionRuntime({ api, config, emotionalPool, isEligible: options.isEligible || (() => true), assessor: options.assessor || (async input => { inputs.push(input); return accepted(); }) });
  const ctx = { agentId: 'main', sessionKey: 'agent:main:telegram:1', sessionId: 'session-1', runId: 'run-1', workspaceDir: root };
  const event = { currentUserMessage: 'Ja!', currentUserMessageId: 'message-1', prompt: 'DO NOT ANALYZE assembled memory prompt' };
  t.after(() => runtime.endRun({}, {}));
  return { mod, root, config, emotionalPool, runtime, ctx, event, inputs, hooks, api };
}

test('Jev config defaults are opt-in with exact bounded timing and strict enum', () => {
  const cfg = resolveEffectiveConfig({});
  assert.equal(cfg.emotion.jev?.enabled, false);
  assert.deepEqual(cfg.emotion.jev.agents, { main: false, bernhardine: false, heisenberg: false });
  assert.equal(cfg.emotion.jev.mode, 'shadow');
  assert.equal(cfg.emotion.jev.timeoutMs, 1000);
  assert.equal(cfg.emotion.jev.approachHalfLifeMs, 300000);
  assert.equal(cfg.emotion.jev.evidenceHoldMs, 120000);
  assert.equal(cfg.emotion.jev.passiveHalfLivesMs.trust, 3600000);
  assert.throws(() => resolveEffectiveConfig({ emotion: { jev: { mode: 'other' } } }));
  assert.throws(() => resolveEffectiveConfig({ emotion: { jev: { timeoutMs: 1001 } } }));
});

test('short authored input gets independent assessment, private atomic mood and matching speech context', async t => {
  const f = await fixture(t);
  const result = await f.runtime.beforePrompt(f.event, f.ctx);
  assert.match(result.prependContext, /current meaning and intent/i);
  assert.equal(f.inputs[0].text, 'Ja!');
  assert.deepEqual(f.inputs[0].context, []);
  const statePath = join(f.root, '.emotional-state.json');
  const persisted = readFileSync(statePath, 'utf8');
  assert.equal(persisted.includes('Ja!'), false);
  assert.equal(JSON.parse(persisted).state.version, 3);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.ok(existsSync(join(f.root, '.current-mood.txt')));
  const env = await f.runtime.resolveExecEnv({}, f.ctx);
  assert.deepEqual(Object.keys(env).sort(), ['PLUR1BUS_SPEECH_CONTEXT_FILE', 'PLUR1BUS_SPEECH_RUN_ID']);
  const snapshot = JSON.parse(readFileSync(env.PLUR1BUS_SPEECH_CONTEXT_FILE, 'utf8'));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.runId, f.ctx.runId);
  assert.equal(snapshot.sessionId, f.ctx.sessionId);
  assert.equal(snapshot.expiresAt - snapshot.createdAt, 900000);
  assert.equal(snapshot.context.at(-1).content, 'Ja!');
  assert.equal(statSync(env.PLUR1BUS_SPEECH_CONTEXT_FILE).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.root, '.plur1bus/speech-context')).mode & 0o777, 0o700);
  for (const patch of [{ runId: undefined }, { workspaceDir: undefined }, { runId: 'other' }, { sessionId: 'other' }, { agentId: 'bernhardine' }, { sessionKey: 'other' }]) {
    assert.deepEqual(await f.runtime.resolveExecEnv({}, { ...f.ctx, ...patch }), {});
  }
  await f.runtime.endRun({}, f.ctx);
  assert.equal(existsSync(env.PLUR1BUS_SPEECH_CONTEXT_FILE), false);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, f.ctx), {});
  assert.equal(await f.runtime.beforePrompt(f.event, f.ctx), undefined);
});

test('empty/absent authored text never falls back to assembled prompt; missing admission cannot persist', async t => {
  const f = await fixture(t);
  assert.equal(await f.runtime.beforePrompt({ prompt: 'memory payload' }, f.ctx), undefined);
  assert.equal(await f.runtime.beforePrompt({ ...f.event, currentUserMessage: '' }, f.ctx), undefined);
  await f.runtime.beforePrompt({ currentUserMessage: 'Hi' }, { ...f.ctx, runId: undefined });
  assert.equal(f.inputs.length, 1);
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, f.ctx), {});
});

test('shadow assesses without changing state/persistence or competing guidance', async t => {
  const f = await fixture(t, { jev: { mode: 'shadow' } });
  const before = f.emotionalPool.get('main').serializeState();
  assert.equal(await f.runtime.beforePrompt(f.event, f.ctx), undefined);
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.emotionalPool.get('main').serializeState().current, before.current);
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, f.ctx), {});
});

test('internal/subagent/provenance/denied inputs are excluded before external assessment', async t => {
  const f = await fixture(t);
  for (const patch of [{ sessionKey: 'agent:main:subagent:x' }, { inputProvenance: { kind: 'inter_session' } }, { inputProvenance: { kind: 'internal_system' } }, { inputProvenance: { kind: 'external_user', sourceRole: 'subagent' } }, { source: 'background' }, { agentId: '../main' }]) {
    assert.equal(await f.runtime.beforePrompt(f.event, { ...f.ctx, ...patch }), undefined);
  }
  assert.equal(f.inputs.length, 0);
  const denied = await fixture(t, { isEligible() { throw new Error('classifier unavailable'); } });
  assert.equal(await denied.runtime.beforePrompt(denied.event, denied.ctx), undefined);
  assert.equal(denied.inputs.length, 0);
});

test('replayed hooks coalesce; shared pool and run ownership survive multiple plugin registrations', async t => {
  const gate = defer(); let calls = 0;
  const f = await fixture(t, { assessor: async () => { calls++; return gate.promise; } });
  const pool2 = f.mod.createSharedJevEmotionalPool(f.config);
  assert.equal(pool2, f.emotionalPool);
  const runtime2 = f.mod.createJevEmotionRuntime({ config: f.config, emotionalPool: pool2, assessor: async () => { calls++; return accepted(); }, isEligible: () => true });
  const first = f.runtime.beforePrompt(f.event, f.ctx);
  const second = runtime2.beforePrompt(f.event, f.ctx);
  await new Promise(r => setImmediate(r));
  gate.resolve(accepted());
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(results[0].prependContext, results[1].prependContext);
  assert.equal(f.emotionalPool.get('main').serializeState().timedMood.eventIds.length, 1);
});

test('out-of-order completions cannot overwrite newer observation and overlapping run contexts stay isolated', async t => {
  const first = defer(); const second = defer(); let count = 0;
  const f = await fixture(t, { assessor: () => (++count === 1 ? first.promise : second.promise) });
  const a = f.runtime.beforePrompt(f.event, f.ctx);
  await new Promise(r => setImmediate(r));
  const ctx2 = { ...f.ctx, runId: 'run-2' };
  const b = f.runtime.beforePrompt({ ...f.event, currentUserMessageId: 'message-2', currentUserMessage: 'Other' }, ctx2);
  await new Promise(r => setImmediate(r));
  second.resolve(accepted(0.2)); await b;
  first.resolve(accepted(0.9)); await a;
  const ids = f.emotionalPool.get('main').serializeState().timedMood.eventIds;
  assert.equal(ids.length, 1);
  const env1 = await f.runtime.resolveExecEnv({}, f.ctx);
  const env2 = await f.runtime.resolveExecEnv({}, ctx2);
  assert.notEqual(env1.PLUR1BUS_SPEECH_CONTEXT_FILE, env2.PLUR1BUS_SPEECH_CONTEXT_FILE);
  assert.equal(JSON.parse(readFileSync(env1.PLUR1BUS_SPEECH_CONTEXT_FILE)).context.at(-1).content, 'Ja!');
  assert.equal(JSON.parse(readFileSync(env2.PLUR1BUS_SPEECH_CONTEXT_FILE)).context.at(-1).content, 'Other');
});

test('terminal cancellation and closed invocation discard late responses with no file revival', async t => {
  const gate = defer(); let signal;
  const f = await fixture(t, { assessor: input => { signal = input.signal; return gate.promise; } });
  const pending = f.runtime.beforePrompt(f.event, f.ctx);
  await new Promise(r => setImmediate(r));
  await f.runtime.endRun({}, f.ctx);
  assert.equal(signal.aborted, true);
  gate.resolve(accepted());
  assert.equal(await pending, undefined);
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, f.ctx), {});
  let active = true; const gate2 = defer();
  const g = await fixture(t, { assessor: () => gate2.promise });
  const p = g.runtime.beforePrompt(g.event, { ...g.ctx, hookInvocation: { assertActive() { if (!active) throw new Error('closed'); } } });
  await new Promise(r => setImmediate(r)); active = false; gate2.resolve(accepted());
  assert.equal(await p, undefined);
  assert.equal(existsSync(join(g.root, '.emotional-state.json')), false);
});

test('workspace/authority revoked during assessment denies commit and context publication', async t => {
  const gate = defer(); let allowed = true;
  const f = await fixture(t, { assessor: () => gate.promise, isEligible: () => allowed });
  const p = f.runtime.beforePrompt(f.event, f.ctx);
  await new Promise(r => setImmediate(r)); allowed = false; gate.resolve(accepted());
  assert.equal(await p, undefined);
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
});

test('session incarnation rotation invalidates old runs without cancelling unrelated sessions', async t => {
  const f = await fixture(t);
  await f.runtime.beforePrompt(f.event, f.ctx);
  const oldEnv = await f.runtime.resolveExecEnv({}, f.ctx);
  const separate = { ...f.ctx, sessionKey: 'agent:main:telegram:2', sessionId: 'separate', runId: 'separate' };
  await f.runtime.beforePrompt(f.event, separate);
  const next = { ...f.ctx, sessionId: 'session-2', runId: 'next' };
  await f.runtime.beforePrompt(f.event, next);
  assert.equal(existsSync(oldEnv.PLUR1BUS_SPEECH_CONTEXT_FILE), false);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, f.ctx), {});
  assert.ok((await f.runtime.resolveExecEnv({}, separate)).PLUR1BUS_SPEECH_CONTEXT_FILE);
  await f.runtime.endRun({ sessionKey: next.sessionKey, sessionId: next.sessionId }, { agentId: 'main' });
  assert.deepEqual(await f.runtime.resolveExecEnv({}, next), {});
  assert.ok((await f.runtime.resolveExecEnv({}, separate)).PLUR1BUS_SPEECH_CONTEXT_FILE);
});

test('native session_start replaces only its matching incarnation before any new prompt', async t => {
  const f = await fixture(t);
  await f.runtime.beforePrompt(f.event, f.ctx);
  const env = await f.runtime.resolveExecEnv({}, f.ctx);
  assert.equal(typeof f.hooks.get('session_start'), 'function');
  await f.hooks.get('session_start')({ sessionKey: f.ctx.sessionKey, sessionId: 'replacement' }, { agentId: 'main' });
  assert.equal(existsSync(env.PLUR1BUS_SPEECH_CONTEXT_FILE), false);
  assert.deepEqual(await f.runtime.resolveExecEnv({}, f.ctx), {});
  assert.equal(await f.runtime.beforePrompt(f.event, f.ctx), undefined);
});

test('session termination while admission policy is pending prevents late state and context', async t => {
  const gate = defer(); let calls = 0;
  const f = await fixture(t, { isEligible: () => ++calls === 1 ? gate.promise : true });
  const pending = f.runtime.beforePrompt(f.event, f.ctx);
  await new Promise(r => setImmediate(r));
  await f.runtime.endRun({ sessionKey: f.ctx.sessionKey, sessionId: f.ctx.sessionId }, { agentId: 'main' });
  gate.resolve(true);
  assert.equal(await pending, undefined);
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
});

test('mutated session identity during external work cannot commit to the old owner', async t => {
  const gate = defer();
  const f = await fixture(t, { assessor: () => gate.promise });
  const pending = f.runtime.beforePrompt(f.event, f.ctx);
  await new Promise(r => setImmediate(r));
  f.ctx.sessionId = 'mutated'; gate.resolve(accepted());
  assert.equal(await pending, undefined);
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
});

test('rejected Jev output never updates evidence and changed config invalidates old callbacks', async t => {
  const f = await fixture(t, { assessor: async () => ({ ...accepted(), ok: false }) });
  await f.runtime.beforePrompt(f.event, f.ctx);
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
  assert.equal(f.emotionalPool.get('main').serializeState().timedMood.eventIds.length, 0);
  const gate = defer();
  const g = await fixture(t, { assessor: () => gate.promise });
  const pending = g.runtime.beforePrompt(g.event, g.ctx);
  await new Promise(r => setImmediate(r));
  const shadow = { ...g.config, emotion: { jev: { ...g.config.emotion.jev, mode: 'shadow' } } };
  g.mod.createJevEmotionRuntime({ config: shadow, emotionalPool: g.emotionalPool, isEligible: () => true, assessor: async () => accepted() });
  gate.resolve(accepted());
  assert.equal(await pending, undefined);
  assert.equal(existsSync(join(g.root, '.emotional-state.json')), false);
});

test('authored history excludes tools/injections, incoming uses prior two and outgoing includes current user', async t => {
  const f = await fixture(t);
  await f.runtime.beforePrompt(f.event, f.ctx);
  await f.runtime.endRun({ messages: [{ role: 'toolResult', content: 'untrusted tool output' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Prior authored reply' }] }] }, f.ctx);
  const next = { ...f.ctx, runId: 'next' };
  await f.runtime.beforePrompt({ currentUserMessage: 'Current user request', currentUserMessageId: 'next', messages: [{ role: 'system', content: 'injected system' }, { role: 'user', content: 'assembled prior memory' }] }, next);
  assert.deepEqual(f.inputs[1].context, [{ role: 'user', content: 'Ja!' }, { role: 'assistant', content: 'Prior authored reply' }]);
  const env = await f.runtime.resolveExecEnv({}, next);
  const data = JSON.parse(readFileSync(env.PLUR1BUS_SPEECH_CONTEXT_FILE));
  assert.deepEqual(data.context, [{ role: 'assistant', content: 'Prior authored reply' }, { role: 'user', content: 'Current user request' }]);
});

test('custom timed configuration is applied before persisted-state hydration', async t => {
  const { EmotionalState } = await import('../lib/emotional-state.js');
  const { writeFileSync } = await import('node:fs');
  const start = 1800000000000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const seed = new EmotionalState({ sensitivity: 1 });
  seed.configureTimedMood();
  seed.applyTimedEvidence(vector(0.8), { eventId: 'seed', observedAt: start });
  const serialized = seed.serializeState();
  t.mock.timers.setTime(start + 1000);
  const f = await fixture(t, { jev: { approachHalfLifeMs: 1000 }, assessor: async () => ({ ok: false }) });
  writeFileSync(join(f.root, '.emotional-state.json'), JSON.stringify({ state: serialized }));
  await f.runtime.beforePrompt(f.event, f.ctx);
  assert.ok(Math.abs(f.emotionalPool.snapshot('main').joy - (serialized.current.joy + serialized.timedMood.target.joy) / 2) < 1e-9);
});

test('session_start during initial policy await rejects the old admission without retiring its replacement', async t => {
  const gate = defer(); let policyCalls = 0;
  const f = await fixture(t, { isEligible: () => ++policyCalls === 1 ? gate.promise : true });
  const pending = f.runtime.beforePrompt(f.event, f.ctx);
  await new Promise(r => setImmediate(r));
  const replacement = { ...f.ctx, sessionId: 'replacement-session', runId: 'replacement-run' };
  await f.hooks.get('session_start')({ sessionKey: replacement.sessionKey, sessionId: replacement.sessionId }, { agentId: replacement.agentId });
  gate.resolve(true);
  const oldResult = await pending;
  const oldEnv = await f.runtime.resolveExecEnv({}, f.ctx);
  assert.deepEqual({
    assessed: f.inputs.length,
    returnedDirective: Boolean(oldResult?.prependContext),
    persistedState: existsSync(join(f.root, '.emotional-state.json')),
    publishedContext: Object.keys(oldEnv).length > 0,
    committedEvidence: f.emotionalPool.get('main').serializeState().timedMood.eventIds.length,
  }, { assessed: 0, returnedDirective: false, persistedState: false, publishedContext: false, committedEvidence: 0 });
  // A replay of the superseded hook must not revoke the replacement either.
  assert.equal(await f.runtime.beforePrompt(f.event, f.ctx), undefined);
  assert.equal(f.inputs.length, 0);
  const replacementResult = await f.runtime.beforePrompt({ ...f.event, currentUserMessageId: 'replacement-message' }, replacement);
  assert.ok(replacementResult?.prependContext);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.emotionalPool.get('main').serializeState().timedMood.eventIds.length, 1);
  const replacementEnv = await f.runtime.resolveExecEnv({}, replacement);
  assert.equal(replacementEnv.PLUR1BUS_SPEECH_RUN_ID, 'replacement-run');
  assert.equal(JSON.parse(readFileSync(replacementEnv.PLUR1BUS_SPEECH_CONTEXT_FILE)).sessionId, 'replacement-session');
  await f.runtime.endRun({}, replacement);
});
