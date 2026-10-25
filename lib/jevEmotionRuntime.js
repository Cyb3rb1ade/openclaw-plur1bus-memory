import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createEmotionalStatePool, formatMoodFile, extractMessageText } from './emotional-state.js';
import { createJevEmotionAssessor, validJevText, EMOTION_DIMENSIONS } from './jevEmotion.js';
import { getProcessSingleton } from './process-singleton.js';
import { safeAgentId, resolveInside } from './sql-safety.js';
import { safeDebug } from './safe-logging.js';
import { shouldSkipAutoCaptureForInternalTurn } from './runtime-scheduler.js';
import { loadPersonaDirective } from './persona-voice.js';
import { buildJevMoodDirective } from './mood-style-directive.js';

const SINGLETON = 'plur1bus.jev-emotion-runtime.v1';
const RUN_TTL_MS = 15 * 60 * 1000;
const ALLOWED_AGENTS = ['main', 'bernhardine', 'heisenberg'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512 ? value : null;
const registry = () => getProcessSingleton(SINGLETON, () => ({ scopes: new Map() }));
const scopeKey = config => resolve(config.baseDbPath || '.');

function scopeFor(config) {
  const key = scopeKey(config);
  const all = registry().scopes;
  if (!all.has(key)) all.set(key, { pool: null, profile: null, configKey: null, generation: 0, runs: new Map(), tombstones: new Map(), admissions: new Map(), sessions: new Map(), retiredSessions: new Set(), histories: new Map(), queues: new Map(), committed: new Map(), sequence: 0, enabled: new Set() });
  const scope = all.get(key);
  // Additive initialization also supports another loaded copy of this runtime.
  scope.sessionEpochs ??= new Map();
  return scope;
}

/**
 * Share the authoritative emotional pool across plugin instances for a state root.
 * @param {object} config Normalized plugin configuration.
 * @returns {object} The shared EmotionalState pool, also used by recall readers.
 */
export function createSharedJevEmotionalPool(config = {}) {
  const scope = scopeFor(config);
  const options = { temperaments: config.emotion?.temperaments || {}, moodInfluence: config.emotion?.moodInfluence ?? 0.3 };
  const profile = hash(options);
  if (!scope.pool || scope.profile !== profile) {
    for (const run of scope.runs.values()) closeRun(scope, run);
    scope.pool = createEmotionalStatePool(options);
    scope.profile = profile;
    scope.configKey = null;
  }
  return scope.pool;
}

function privateWrite(workspaceDir, parts, text) {
  const target = resolveInside(workspaceDir, ...parts);
  const temporary = resolveInside(workspaceDir, ...parts.slice(0, -1), `${parts.at(-1)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(resolveInside(workspaceDir, ...parts.slice(0, -1), temporary));
  }
  return target;
}

function closeRun(scope, run, logger) {
  // Tombstone and abort synchronously: deletion must never reopen authority.
  scope.runs.delete(run.key);
  scope.tombstones.set(run.key, run.expiresAt);
  clearTimeout(run.timer);
  run.closed = true;
  run.admission?.runs.delete(run);
  if (run.admission && run.admission.runs.size === 0) run.admission.controller.abort();
  if (run.path) {
    try { unlinkSync(resolveInside(run.workspaceDir, run.path)); }
    catch (error) { if (error.code !== 'ENOENT') safeDebug(logger, 'jev-runtime', 'context_cleanup_failed'); }
  }
  run.context = [];
  run.persona = '';
}

function trim(scope, now, logger) {
  for (const run of scope.runs.values()) if (run.expiresAt <= now) closeRun(scope, run, logger);
  for (const [key, expiry] of scope.tombstones) if (expiry <= now) scope.tombstones.delete(key);
  for (const [key, admission] of scope.admissions) if (admission.observedAt + RUN_TTL_MS <= now && admission.runs.size === 0) scope.admissions.delete(key);
  // Limit admission history without evicting a live in-flight assessment.
  for (const [key, admission] of scope.admissions) {
    if (scope.admissions.size <= 512) break;
    if (admission.runs.size === 0) scope.admissions.delete(key);
  }
}

// A per-agent Promise queue serializes state commits; network work stays outside it.
async function serialized(scope, agentId, task, logger) {
  const previous = scope.queues.get(agentId) || Promise.resolve();
  const current = (async () => {
    try { await previous; } catch (error) { safeDebug(logger, 'jev-runtime', 'previous_commit_failed'); }
    return task();
  })();
  scope.queues.set(agentId, current);
  try { return await current; }
  finally { if (scope.queues.get(agentId) === current) scope.queues.delete(agentId); }
}

/**
 * Own incoming Jev assessment, timed state commits and strictly run-bound speech context.
 * @param {object} options API/config, shared pool, optional offline assessor, policy, clock and logger.
 * @returns {{beforePrompt:Function,resolveExecEnv:Function,endRun:Function,isEnabled:Function}} Hook handlers; exec returns a plain environment record.
 */
export function createJevEmotionRuntime({ api, config = {}, emotionalPool, assessor, isEligible = () => false, now = Date.now, logger = api?.logger } = {}) {
  const scope = scopeFor(config);
  const settings = config.emotion?.jev || {};
  const pool = emotionalPool || createSharedJevEmotionalPool(config);
  if (!scope.pool) scope.pool = pool;
  if (scope.pool !== pool) throw new Error('Jev runtime requires the shared emotional pool');
  const configKey = hash({ settings, profile: scope.profile, transport: config.captureChunkingJev || {} });
  if (scope.configKey !== configKey) {
    for (const run of scope.runs.values()) closeRun(scope, run, logger);
    scope.configKey = configKey;
    scope.generation++;
    scope.admissions.clear();
    scope.enabled = new Set(ALLOWED_AGENTS.filter(id => settings.enabled === true && settings.agents?.[id] === true && settings.mode === 'active'));
    for (const id of ALLOWED_AGENTS) pool.get(id).configureTimedMood({ ...settings, enabled: scope.enabled.has(id) });
  }
  const generation = scope.generation;
  const assess = assessor || createJevEmotionAssessor({ ...config.captureChunkingJev, timeoutMs: settings.timeoutMs ?? 1000, logger });
  const configured = id => settings.enabled === true && ALLOWED_AGENTS.includes(id) && settings.agents?.[id] === true;
  const isEnabled = id => scope.enabled.has(id);

  function coordinates(ctx = {}) {
    const agentId = identity(ctx.agentId);
    if (!agentId) return null;
    safeAgentId(agentId);
    const sessionKey = identity(ctx.sessionKey);
    const sessionId = identity(ctx.sessionId);
    const runId = identity(ctx.runId);
    const workspaceDir = typeof ctx.workspaceDir === 'string' && ctx.workspaceDir ? resolveInside(ctx.workspaceDir, '.') : null;
    return { agentId, sessionKey, sessionId, runId, workspaceDir, session: hash([agentId, sessionKey, sessionId]), key: hash([agentId, sessionKey, sessionId, runId]) };
  }
  function assertCurrent(ctx, run, invocation = false) {
    if (generation !== scope.generation || run?.closed || (run && scope.runs.get(run.key) !== run) || (run && run.expiresAt <= now())) throw new Error('inactive');
    if (run) {
      const current = coordinates(ctx);
      if (!current || current.key !== run.key || current.workspaceDir !== run.workspaceDir) throw new Error('identity_changed');
    }
    ctx.assertMemoryAudienceCurrent?.();
    if (invocation) ctx.hookInvocation?.assertActive?.();
  }
  async function eligible(event, ctx) {
    if (shouldSkipAutoCaptureForInternalTurn(event, ctx)) return false;
    const provenance = ctx.inputProvenance || event.inputProvenance;
    if (provenance && (provenance.kind !== 'external_user' || provenance.sourceRole === 'subagent')) return false;
    if (/:subagent(?::|$)/i.test(ctx.sessionKey || '')) return false;
    return (await isEligible(event, ctx)) === true;
  }
  function bindSession(c) {
    const slot = hash([c.agentId, c.sessionKey]);
    if (scope.retiredSessions.has(c.session) || scope.retiredSessions.has(hash([c.agentId, null, c.sessionId]))) return false;
    const previous = scope.sessions.get(slot);
    if (previous && previous !== c.session) {
      scope.retiredSessions.add(previous);
      scope.histories.delete(previous);
      for (const run of scope.runs.values()) if (run.session === previous) closeRun(scope, run, logger);
    }
    if (previous !== c.session) scope.sessionEpochs.set(slot, (scope.sessionEpochs.get(slot) || 0) + 1);
    scope.sessions.set(slot, c.session);
    return true;
  }
  function snapshot(run) {
    assertCurrent(run.ctx, run);
    const dir = resolveInside(run.workspaceDir, '.plur1bus');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(resolveInside(run.workspaceDir, '.plur1bus'), 0o700);
    const contextDir = resolveInside(run.workspaceDir, '.plur1bus', 'speech-context');
    mkdirSync(contextDir, { recursive: true, mode: 0o700 });
    chmodSync(resolveInside(run.workspaceDir, '.plur1bus', 'speech-context'), 0o700);
    const data = { version: 1, agentId: run.agentId, runId: run.runId, sessionId: run.sessionId, createdAt: run.createdAt, expiresAt: run.expiresAt, mood: pool.snapshot(run.agentId), persona: run.persona, context: run.context.slice(-2) };
    run.path = privateWrite(run.workspaceDir, ['.plur1bus', 'speech-context', `${run.key}.json`], JSON.stringify(data));
    return run.path;
  }

  async function beforePrompt(event = {}, ctx = {}) {
    let run;
    try {
      const c = coordinates(ctx);
      if (!c || !configured(c.agentId) || !c.workspaceDir || generation !== scope.generation) return;
      // The host has no typed proof that legacy event.prompt is authored text.
      const text = event.currentUserMessage;
      if (!validJevText(text) || !text.trim()) return;
      const observedAt = now();
      trim(scope, observedAt, logger);
      assertCurrent(ctx, null, true);
      const sessionSlot = hash([c.agentId, c.sessionKey]);
      const sessionEpoch = scope.sessionEpochs.get(sessionSlot) || 0;
      if (!await eligible(event, ctx)) return;
      assertCurrent(ctx, null, true);
      // A replacement can arrive before this admission has ever bound a run.
      // Same-incarnation replays may proceed; an obsolete admission must not
      // bind over the replacement, including on a later retry of this hook.
      if ((scope.sessionEpochs.get(sessionSlot) || 0) !== sessionEpoch && scope.sessions.get(sessionSlot) !== c.session) {
        scope.retiredSessions.add(c.session);
        return;
      }
      const stable = Boolean(c.sessionKey && c.sessionId && c.runId && identity(event.currentUserMessageId));
      if (c.sessionKey && c.sessionId && !bindSession(c)) return;
      if (c.runId && scope.tombstones.has(c.key)) return;
      const admissionKey = stable ? hash([c.agentId, c.sessionKey, c.sessionId, event.currentUserMessageId]) : null;
      let admission = admissionKey ? scope.admissions.get(admissionKey) : null;
      if (admission && admission.textHash !== hash(text)) return;
      const state = pool.get(c.agentId);
      // Configuration precedes hydration; disk metadata never activates timed mode.
      state.configureTimedMood({ ...settings, enabled: isEnabled(c.agentId) });
      if (isEnabled(c.agentId) && stable) state.hydrateOnce(resolveInside(c.workspaceDir, '.emotional-state.json'));
      const persona = config.personaVoice?.enabled === false ? '' : (loadPersonaDirective(c.workspaceDir, { maxChars: 2400 }) || '');
      if (!admission) {
        const context = (scope.histories.get(c.session) || []).slice(-2);
        admission = { observedAt, sequence: ++scope.sequence, textHash: hash(text), controller: new AbortController(), runs: new Set(), context, promise: null };
        if (admissionKey) {
          scope.admissions.set(admissionKey, admission);
          scope.histories.set(c.session, [...context, { role: 'user', content: text }].slice(-2));
        }
      }
      if (stable) {
        run = scope.runs.get(c.key);
        if (run && (run.workspaceDir !== c.workspaceDir || run.admission !== admission)) return;
        if (!run) {
          run = { ...c, ctx: { ...ctx, hookInvocation: undefined }, event: { currentUserMessageId: event.currentUserMessageId }, admission, createdAt: observedAt, expiresAt: observedAt + RUN_TTL_MS, persona, context: [...admission.context, { role: 'user', content: text }].slice(-2), closed: false };
          scope.runs.set(c.key, run);
          admission.runs.add(run);
          run.timer = setTimeout(() => closeRun(scope, run, logger), RUN_TTL_MS);
          run.timer.unref?.();
        }
      }
      if (!admission.promise) admission.promise = assess({ text, context: admission.context, persona, mood: pool.snapshot(c.agentId), signal: admission.controller.signal });
      const result = await admission.promise;
      assertCurrent(ctx, run, true);
      if (!await eligible(event, ctx)) return;
      assertCurrent(ctx, run, true);
      if (!isEnabled(c.agentId)) {
        safeDebug(logger, 'jev-runtime', result?.ok === true ? 'shadow_accepted' : 'shadow_rejected');
        return;
      }
      return await serialized(scope, c.agentId, async () => {
        if (!await eligible(event, ctx)) return;
        assertCurrent(ctx, run, true);
        if (run && resolveInside(ctx.workspaceDir, '.') !== run.workspaceDir) return;
        if (stable && result?.ok === true && !admission.controller.signal.aborted && admission.sequence > (scope.committed.get(c.agentId) || 0)) {
          const accepted = state.applyTimedEvidence(result.reaction, { eventId: admissionKey, observedAt: admission.observedAt, now: now(), dimensions: result.reactionDimensions });
          if (accepted) {
            scope.committed.set(c.agentId, admission.sequence);
            const mood = state.describeMood();
            privateWrite(c.workspaceDir, ['.emotional-state.json'], JSON.stringify({ ...mood, agentId: c.agentId, ts: now(), state: state.serializeState() }));
            privateWrite(c.workspaceDir, ['.current-mood.txt'], formatMoodFile(mood, c.agentId, now()));
          }
        }
        if (run) snapshot(run);
        assertCurrent(ctx, run, true);
        return { prependContext: buildJevMoodDirective(pool.describe(c.agentId), result?.ok === true ? Object.fromEntries(
          EMOTION_DIMENSIONS.filter(dim => (result.reactionDimensions === undefined || (Array.isArray(result.reactionDimensions) && result.reactionDimensions.includes(dim)))).map(dim => [dim, result.reaction[dim]])
        ) : null) };
      }, logger);
    } catch (error) {
      safeDebug(logger, 'jev-runtime', 'prompt_skipped');
      if (run) closeRun(scope, run, logger);
      return undefined;
    }
  }

  async function resolveExecEnv(event = {}, ctx = {}) {
    try {
      const c = coordinates(ctx);
      if (!c?.sessionKey || !c.sessionId || !c.runId || !c.workspaceDir || !isEnabled(c.agentId)) return {};
      trim(scope, now(), logger);
      const run = scope.runs.get(c.key);
      if (!run || run.workspaceDir !== c.workspaceDir || !run.path) return {};
      if (event.sessionKey && event.sessionKey !== c.sessionKey) return {};
      if (!await eligible(event, ctx)) { closeRun(scope, run, logger); return {}; }
      assertCurrent(ctx, run);
      const path = snapshot(run);
      return { PLUR1BUS_SPEECH_CONTEXT_FILE: path, PLUR1BUS_SPEECH_RUN_ID: c.runId };
    } catch (error) {
      safeDebug(logger, 'jev-runtime', 'exec_context_skipped');
      return {};
    }
  }

  async function endRun(event = {}, ctx = {}) {
    const agentId = identity(ctx.agentId ?? event.agentId);
    const sessionKey = identity(ctx.sessionKey ?? event.sessionKey);
    const sessionId = identity(ctx.sessionId ?? event.sessionId);
    const runId = identity(ctx.runId ?? event.runId);
    if (!agentId || (!runId && !sessionKey && !sessionId)) return;
    if (!runId && sessionId) {
      scope.retiredSessions.add(hash([agentId, sessionKey, sessionId]));
      scope.histories.delete(hash([agentId, sessionKey, sessionId]));
    }
    if (runId && sessionKey && sessionId) scope.tombstones.set(hash([agentId, sessionKey, sessionId, runId]), now() + RUN_TTL_MS);
    for (const run of scope.runs.values()) {
      if (run.agentId !== agentId || (sessionKey && run.sessionKey !== sessionKey) || (sessionId && run.sessionId !== sessionId) || (runId && run.runId !== runId)) continue;
      // Only assistant-authored visible text, never tools, system or injected user context.
      const assistant = Array.isArray(event.messages) ? event.messages.findLast(message => message?.role === 'assistant') : null;
      const text = assistant ? extractMessageText(assistant) : '';
      if (validJevText(text) && text.trim()) scope.histories.set(run.session, [...(scope.histories.get(run.session) || []), { role: 'assistant', content: text }].slice(-2));
      if (!runId) { scope.retiredSessions.add(run.session); scope.histories.delete(run.session); }
      closeRun(scope, run, logger);
    }
  }

  if (api?.on) {
    api.on('before_prompt_build', beforePrompt, { priority: 100 });
    api.on('resolve_exec_env', resolveExecEnv);
    api.on('agent_end', endRun, { priority: 100 });
    api.on('session_start', (event = {}, ctx = {}) => {
      const agentId = identity(ctx.agentId ?? event.agentId);
      const sessionKey = identity(ctx.sessionKey ?? event.sessionKey);
      const sessionId = identity(ctx.sessionId ?? event.sessionId);
      if (agentId && sessionKey && sessionId && configured(agentId) && generation === scope.generation) {
        bindSession({ agentId, sessionKey, sessionId, session: hash([agentId, sessionKey, sessionId]) });
      }
    }, { priority: 100 });
    api.on('session_end', (event, ctx) => endRun({ ...event, runId: undefined }, { ...ctx, runId: undefined }), { priority: 100 });
    api.on('before_reset', (event, ctx) => endRun({ ...event, runId: undefined }, { ...ctx, runId: undefined }), { priority: 100 });
    api.on('gateway_stop', () => {
      for (const run of scope.runs.values()) closeRun(scope, run, logger);
      scope.histories.clear();
    });
  }
  return { beforePrompt, resolveExecEnv, endRun, isEnabled };
}
