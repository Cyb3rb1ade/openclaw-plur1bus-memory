import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { makeTempDir } from './helpers/temp-dir.js';
import { patchExecContextDirectory, patchNativePromptSource, patchPromptHelperSource } from '../scripts/telegramTts/patch-exec-speech-context.mjs';
import { createJevEmotionRuntime, createSharedJevEmotionalPool } from '../lib/jevEmotionRuntime.js';
import { planTelegramSpeech } from '../lib/telegramSpeech.js';

const fixture = name => readFileSync(new URL(`./fixtures/telegramSpeech/${name}-host.mjs`, import.meta.url), 'utf8');
const names = ['bash-tools', 'builtin-openclaw', 'context-engine-maintenance'];
function directory() {
  const root = makeTempDir('native-host-');
  for (const name of names) writeFileSync(join(root, `${name}-fixture.mjs`), fixture(name));
  return root;
}
function nativeCaller(root) {
  const sandbox = {
    createRuntimeConfigReader: config => () => config,
    resolveInternalEventPromptBody: prompt => prompt,
    buildInterSessionPromptContext: () => undefined,
    buildEmbeddedAgentHookContext: attempt => attempt.ctx,
    freezeDiagnosticTraceContext: trace => trace,
    pruneProcessedHistoryImages: messages => messages,
    drainPluginNextTurnInjectionContext: async () => ({ queuedInjections: [] }),
    buildPluginAgentTurnPrepareContext: () => ({}),
    joinPresentTextSegments: values => values.filter(Boolean).join('\n'),
    wrapPluginSystemContextSection: value => value,
    log: { warn: () => { throw new Error('unexpected host hook failure'); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, 'context-engine-maintenance-fixture.mjs'), 'utf8') + '\n' + readFileSync(join(root, 'builtin-openclaw-fixture.mjs'), 'utf8'), sandbox);
  return async ({ message, ctx, hookRunner, attemptPatch = {} }) => {
    const attempt = { ctx, prompt: 'ASSEMBLED TOOL/MEMORY PROMPT', config: {}, model: { provider: 'fixture', id: 'fixture' }, inputProvenance: { kind: 'external_user' }, userTurnTranscriptRecorder: { resolveMessage: async () => message }, ...attemptPatch };
    const preparedUserTurnMessage = await sandbox.resolveFixturePreparedUserTurnMessage(attempt);
    return sandbox.runEmbeddedAttemptPromptPhase({
      attempt, isRawModelRun: attemptPatch.isRawModelRun,
      prepared: { sessionRuntime: {
        agentSession: { activeSession: { messages: [{ role: 'user', content: 'STALE HISTORY' }] }, hookRunner },
        boundary: {}, preparedUserTurnMessage, state: { systemPromptText: '' }, transcriptPolicy: {}, transport: {},
      }, systemPrompt: { runtimeInfo: {} }, toolCatalog: { toolSearch: {} } },
      setup: { sessionAgentId: 'main' }, preparedStreamRuntime: { history: {}, stream: {} }, sessionLock: {}, diagnostics: {}, runAbortController: {},
    }, {});
  };
}
async function setup(t, mode = 'shadow') {
  const dist = directory();
  patchExecContextDirectory(dist, true);
  const root = makeTempDir('native-runtime-');
  const config = { baseDbPath: root, emotion: { jev: { enabled: true, agents: { main: true }, mode } } };
  const pool = createSharedJevEmotionalPool(config);
  const inputs = [], events = [], contexts = [];
  const runtime = createJevEmotionRuntime({ api: { on() {} }, config, emotionalPool: pool, isEligible: (event, ctx) => ctx.denied !== true, assessor: async input => {
    inputs.push(input);
    return { ok: true, reaction: { joy: .5, sadness: 0, anger: 0, fear: 0, disgust: 0, surprise: 0, trust: .5, anticipation: 0 }, confidence: 1, sections: [] };
  } });
  const ctx = { agentId: 'main', sessionKey: 'agent:main:telegram:fixture', sessionId: 'session', runId: 'run', workspaceDir: root, assertMemoryAudienceCurrent() {} };
  const hookRunner = { hasHooks: name => name === 'before_prompt_build', runBeforePromptBuild: async (event, context) => {
    events.push(event); contexts.push(context); return runtime.beforePrompt(event, context);
  } };
  t.after(() => runtime.endRun({}, ctx));
  const call = (message, attemptPatch, context = ctx) => nativeCaller(dist)({ message, ctx: context, hookRunner, attemptPatch });
  const exec = await import('data:text/javascript;base64,' + Buffer.from(readFileSync(join(dist, 'bash-tools-fixture.mjs'), 'utf8')).toString('base64'));
  const env = context => exec.call({ agentId: 'main', defaults: {} }, { hookContext: context || ctx }, { env: { PLUR1BUS_SPEECH_RUN_ID: 'forged' }, workdir: '/forged' }, { runResolveExecEnv: (event, context) => runtime.resolveExecEnv(event, context) });
  return { root, config, pool, inputs, events, contexts, runtime, ctx, call, env };
}

test('native admitted structured text reaches real runtime and adapter once per stable admission, shadow remains neutral', async t => {
  const f = await setup(t);
  const before = f.pool.get('main').serializeState().current;
  const message = { role: 'user', content: [{ type: 'text', text: ' Authored\n' }, { type: 'image', text: 'NOT TEXT' }, { type: 'text', text: 'words 🐈 ' }], idempotencyKey: 'logical-turn:stable', provenance: { kind: 'external_user' }, modelPromptProjection: { text: 'ADVERSARIAL PROJECTION', idempotencyKey: 'forged' } };
  const first = await f.call(message);
  await f.call(message);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].text, ' Authored\nwords 🐈 ');
  assert.equal(f.events[0].currentUserMessageId, 'logical-turn:stable');
  assert.equal(f.contexts[0].workspaceDir, f.root);
  assert.equal(f.contexts[0].assertMemoryAudienceCurrent, f.ctx.assertMemoryAudienceCurrent);
  assert.equal(f.contexts[0].inputProvenance.kind, 'external_user');
  assert.equal(first.prependContext, '');
  assert.deepEqual(f.pool.get('main').serializeState().current, before);
  assert.equal(existsSync(join(f.root, '.emotional-state.json')), false);
  assert.equal(existsSync(join(f.root, '.current-mood.txt')), false);
  const env = await f.env();
  assert.ok(env.PLUR1BUS_SPEECH_CONTEXT_FILE);
  assert.equal(statSync(env.PLUR1BUS_SPEECH_CONTEXT_FILE).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.root, '.plur1bus/speech-context')).mode & 0o777, 0o700);
  const result = await planTelegramSpeech({ agentId: 'main', versions: [{ id: 'default', text: 'Final words.' }] }, { config: f.config, workspace: f.root, env, planner: async input => {
    assert.equal(input.context.at(-1).content, ' Authored\nwords 🐈 ');
    return { ok: true, versions: input.versions.map(v => ({ ...v, segments: [{ start: 0, end: 12, intent: 'praise', delivery: 'warm', action: 'none', confidence: 1 }] })) };
  } });
  assert.equal(result.versions[0].speech, 'Final words.');
  assert.deepEqual(await f.env({ ...f.ctx, runId: 'wrong' }), {});
  await f.call({ ...message, content: 'Changed same admission' });
  assert.equal(f.inputs.length, 1);
});

for (const [name, message, attemptPatch] of [
  ['missing', undefined],
  ['skip', { role: 'user', content: 'New text', idempotencyKey: 'stable' }, { skipPreparedUserTurnMessage: true }],
  ['excluded', { role: 'user', content: 'New text', idempotencyKey: 'stable', excludeFromContext: true }],
  ['nonuser', { role: 'assistant', content: 'New text', idempotencyKey: 'stable' }],
  ['missing identity', { role: 'user', content: 'New text' }],
  ['invalid identity', { role: 'user', content: 'New text', idempotencyKey: ' stable ' }],
  ['no text blocks', { role: 'user', content: [{ type: 'image', text: 'Fake' }], idempotencyKey: 'stable' }],
  ['malformed text block', { role: 'user', content: [{ type: 'text', text: 7 }], idempotencyKey: 'stable' }],
  ['empty', { role: 'user', content: '  ', idempotencyKey: 'stable' }],
  ['internal admitted provenance', { role: 'user', content: 'New text', idempotencyKey: 'stable', provenance: { kind: 'internal_system' } }],
]) test(`native ${name} never substitutes prompt, projection, or history`, async t => {
  const f = await setup(t);
  await f.call(message, attemptPatch);
  assert.equal(f.inputs.length, 0);
  assert.equal('currentUserMessage' in f.events[0], false);
  assert.equal('currentUserMessageId' in f.events[0], false);
  assert.deepEqual(await f.env(), {});
});

for (const [name, attemptPatch, contextPatch] of [
  ['internal provenance', { inputProvenance: { kind: 'internal_system' } }, {}],
  ['subagent', {}, { sessionKey: 'agent:main:subagent:fixture' }],
  ['policy denied', {}, { denied: true }],
  ['workspace missing', {}, { workspaceDir: undefined }],
  ['not current', {}, { assertMemoryAudienceCurrent() { throw new Error('stale'); } }],
]) test(`native forwarding preserves ${name} runtime gate`, async t => {
  const f = await setup(t);
  await f.call({ role: 'user', content: 'Authored text', idempotencyKey: 'stable' }, attemptPatch, { ...f.ctx, ...contextPatch });
  assert.equal(f.inputs.length, 0);
  assert.deepEqual(await f.env(), {});
});

test('directory preflights all native targets before any mutation and supports idempotent inspection', () => {
  const root = directory();
  const before = names.map(name => readFileSync(join(root, `${name}-fixture.mjs`), 'utf8'));
  const report = patchExecContextDirectory(root);
  assert.ok(Array.isArray(report.files));
  assert.equal(report.files.length, 3);
  assert.equal(report.file, join(root, 'bash-tools-fixture.mjs'));
  assert.deepEqual(names.map(name => readFileSync(join(root, `${name}-fixture.mjs`), 'utf8')), before);
  patchExecContextDirectory(root, true);
  assert.equal(patchExecContextDirectory(root, true).changed, false);
  for (const broken of ['builtin-openclaw', 'context-engine-maintenance']) {
    const dir = directory();
    writeFileSync(join(dir, `${broken}-fixture.mjs`), 'unsupported');
    assert.throws(() => patchExecContextDirectory(dir, true));
    assert.equal(readFileSync(join(dir, 'bash-tools-fixture.mjs'), 'utf8'), fixture('bash-tools'));
  }
});


test('native plain authored string keeps exact bytes and a stable admission commits once across rebuild runs', async t => {
  const f = await setup(t, 'active');
  const message = { role: 'user', content: ' Plain\ntext 🐈 ', idempotencyKey: 'native-stable' };
  const result = await f.call(message);
  assert.ok(result.prependContext);
  const firstEnv = await f.env();
  const retryCtx = { ...f.ctx, runId: 'retry' };
  t.after(() => f.runtime.endRun({}, retryCtx));
  await f.call(message, {}, retryCtx);
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].text, ' Plain\ntext 🐈 ');
  assert.equal(f.pool.get('main').serializeState().timedMood.eventIds.length, 1);
  const retryEnv = await f.env(retryCtx);
  assert.notEqual(firstEnv.PLUR1BUS_SPEECH_CONTEXT_FILE, retryEnv.PLUR1BUS_SPEECH_CONTEXT_FILE);
});

for (const operation of ['raw', 'settled-tool-finalization']) test(`native ${operation} exact-prompt path keeps its original hook suppression`, async t => {
  const f = await setup(t);
  await f.call({ role: 'user', content: 'Text', idempotencyKey: 'stable' }, operation === 'raw' ? { isRawModelRun: true } : { operation });
  assert.equal(f.events.length, 0);
  assert.equal(f.inputs.length, 0);
});

test('native partial, duplicate, and drifted supported shapes refuse all writes', () => {
  const source = fixture('builtin-openclaw');
  const patched = patchNativePromptSource(source);
  assert.equal(patchNativePromptSource(patched), patched);
  assert.throws(() => patchNativePromptSource(source + source));
  assert.throws(() => patchNativePromptSource(patched.replace('\n\t\t...currentUserFields,', '')));
  assert.throws(() => patchNativePromptSource(patched.replace('inputProvenance: attempt.inputProvenance', 'inputProvenance: {}')));
  const helper = fixture('context-engine-maintenance');
  assert.throws(() => patchPromptHelperSource(helper + helper));
  assert.throws(() => patchPromptHelperSource(helper.replace('messages: params.messages\n', 'messages: []\n')));
  const root = directory();
  writeFileSync(join(root, 'builtin-openclaw-duplicate.mjs'), source);
  assert.throws(() => patchExecContextDirectory(root, true));
  assert.equal(readFileSync(join(root, 'bash-tools-fixture.mjs'), 'utf8'), fixture('bash-tools'));
});
