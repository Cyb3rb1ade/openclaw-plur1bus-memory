/**
 * tests/helpers/golden-prefix-driver.js
 *
 * Runs one golden-prefix scenario through the real `before_prompt_build`
 * handler with a stub OpenClaw `api`, a frozen clock and a deterministic
 * embedding provider. No network, no model download, no write outside
 * os.tmpdir(). The string it returns is the exact `prependContext` the model
 * would have seen.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import plugin, { MemoryDB } from "../../index.js";
import { writePlur1busStartNotice } from "../../lib/setup/feature-profiles.js";

/** 2026-01-15T12:00:00Z — every scenario is evaluated at this instant. */
export const FROZEN_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** intfloat/multilingual-e5-small is fixed at 384 dims; the config contract
 *  rejects any other value (lib/providers/config-normalize.js:27). */
export const VECTOR_DIM = 384;

/**
 * Replace globalThis.Date with a frozen subclass. `Date.now()` and `new Date()`
 * return `now`; every other static (UTC, parse) is inherited.
 * @param {number} [now]
 * @returns {() => void} restore function
 */
export function freezeClock(now = FROZEN_NOW) {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }
  globalThis.Date = FrozenDate;
  return () => { globalThis.Date = RealDate; };
}

/**
 * One topic -> one unit vector on one axis. Two texts with the same topic get
 * distance 0; two texts with different topics get distance sqrt(2).
 * @param {string} topic
 * @returns {number[]}
 */
export function topicVector(topic) {
  const digest = createHash("sha256").update(String(topic)).digest();
  const axis = ((digest[0] << 8) | digest[1]) % VECTOR_DIM;
  const out = new Array(VECTOR_DIM).fill(0);
  out[axis] = 1;
  return out;
}

/**
 * A deterministic embedding provider, handed to the engine through its
 * internals seam (createEngine's testOptions.internals, via plugin.register's
 * `engineInternals`) in place of the local-transformers provider, so nothing
 * can reach the real model. Task 13c replaced the earlier prototype patch with
 * it; the golden corpus stayed byte-identical and a tripwire on the real
 * provider's _computeBatch/_embedBatchForPurpose saw zero calls.
 *
 * `hang: true` makes every call settle only (by rejecting) when
 * `options.signal` aborts, exercising the abort path (PR-05); `probe`, when
 * given, records call counts and the abort instant.
 * @param {(text: string) => string} topicOf
 * @param {{hang?: boolean, probe?: {calls: number, abortedAt: number|null}|null}} [opts]
 * @returns {object}
 */
function stubProvider(topicOf, { hang = false, probe = null } = {}) {
  const batch = async (texts, options = {}) => {
    if (probe) probe.calls += 1;
    if (hang) {
      return await new Promise((_, reject) => {
        const signal = options?.signal;
        if (!signal) return; // no signal: hangs until the scenario's timeout; the recall still resolves via the scheduler
        signal.addEventListener("abort", () => {
          if (probe) probe.abortedAt = performance.now();
          reject(signal.reason);
        }, { once: true });
      });
    }
    return texts.map((text) => topicVector(topicOf(text)));
  };
  const one = async (text, options) => (await batch([text], options))[0];
  return {
    embed: one,
    embedQuery: one,
    embedPassage: one,
    embedRaw: (text, _purpose, _retries, options) => one(text, options),
    embedBatch: (texts, _retries, options) => batch(texts, options),
    shutdown: async () => {},
  };
}

const routingCapability = Object.freeze({
  parseAgentSessionKey(value) {
    const match = /^agent:([^:]+):(.+)$/.exec(value);
    return match ? { agentId: match[1], rest: match[2] } : null;
  },
  parseThreadSessionSuffix(value) { return { baseSessionKey: value, threadId: "" }; },
  normalizeOptionalAccountId(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
  normalizeMessageChannel(value) {
    return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
  },
});

/**
 * @param {object} pluginConfig
 * @param {((entry: {agentId: string, phases: object, totalMs: number}) => void)|null} [recallTimingSink]
 *   Forwarded as `api.__recallTimingSinkForTests`, the one test-only property
 *   `index.js` reads with `??` when building the recall-hook ctx
 *   (`recallTimingSink: api.__recallTimingSinkForTests ?? null`). No real
 *   OpenClaw host ever sets this property.
 */
function makeApi(pluginConfig, recallTimingSink = null) {
  const handlers = new Map();
  const noop = () => {};
  return {
    pluginConfig,
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (value) => value,
    registerCommand: noop,
    registerTool(factory) { this.toolFactory = factory; },
    registerService: noop,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return { dispose: noop };
    },
    handlers,
    __recallTimingSinkForTests: recallTimingSink,
  };
}

/**
 * Every feature that would reach the network, a model file or a background
 * scheduler is off. Scenario `config` is merged on top.
 *
 * The merge is a shallow top-level spread, not a deep merge: a scenario that
 * sets `config.recall` replaces this whole default `recall` object rather than
 * overriding single keys, so such a scenario must restate every `recall` key it
 * still wants.
 *
 * @param {string} baseDbPath
 * @param {object} [overrides]
 */
export function baseConfig(baseDbPath, overrides = {}) {
  return {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
    autoCapture: false,
    autoRecall: true,
    merging: { enabled: false },
    duplicateThreshold: 0.9999,
    obsidianBridge: { enabled: false },
    neo: { enabled: false },
    gc: { enabled: false },
    continuityEngine: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    replyOutcomeTracking: { enabled: false },
    temporalContext: { enabled: false },
    personaVoice: { enabled: false },
    emotion: { t3: { enabled: false } },
    dreaming: { enabled: false },
    skillMiner: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 },
    recall: {
      dedup: false,
      canonicalFirst: true,
      canonicalMaxItems: 1,
      maxPromptMemories: 5,
      decisionTrace: { enabled: false, includeInPrompt: false },
      globalInjectMaxChars: 17_000,
    },
    ...overrides,
  };
}

/**
 * @param {object} scenario
 * @param {{freezeClock?: boolean, recallTimingSink?: ((entry: {agentId: string, phases: object, totalMs: number}) => void)|null, onTiming?: ((entry: {setupMs: number, recallMs: number, totalMs: number}) => void)|null, hostEvents?: {emit: (name: string, payload: unknown) => void}|null}} [options]
 *   `freezeClock: false` keeps the real clock, which the latency probe needs;
 *   the golden test leaves it on. `recallTimingSink`, when given, is threaded
 *   onto the stub `api` as `__recallTimingSinkForTests` (see `makeApi`) and
 *   called once per attempted recall with the pipeline's phase timings.
 *   `onTiming`, when given, is called once, right before this function
 *   returns normally (not on a thrown error), with `setupMs` (temp dirs,
 *   clock stub, the fixture `db.store()` loop, `plugin.register()`)
 *   measured separately from `recallMs` (just the one `before_prompt_build`
 *   hook invocation) — fix round 2: the wall-clock total the probe reported
 *   before this conflated both, and setup dominates at larger `--scale`.
 *   `hostEvents`: forwarded to plugin.register as the hostEvents dependency.
 *   `embedderProbe`: forwarded to `stubProvider`'s `probe` option (PR-05,
 *   `recall-aborted`); records embedder call count and abort timing.
 *   `callerSignal` (fix round 2): when given, this exact `AbortSignal` is
 *   handed to the assembler in place of the adapter's own
 *   `AbortSignal.timeout(recallTimeoutMs + 250)` — `register-recall-hook.js`
 *   calls `AbortSignal.timeout` fresh on every `before_prompt_build`
 *   invocation, so patching the global for just the one `hook(...)` call
 *   below swaps in the caller's real signal without touching production code.
 *   This is what lets a test drive a genuine caller-initiated abort through
 *   the real assembler/scheduler/pipeline, instead of mocking `runRecall`.
 *   `abortAfterMs` (fix round 3): prefer this over building your own
 *   `callerSignal` with a `setTimeout` armed before calling `runScenario` —
 *   that timer would start ticking before this function's own setup (temp
 *   dirs, fixture `db.store()` writes, `plugin.register()` — tens of ms, more
 *   at scale), landing the abort at an unpredictable point in the recall
 *   itself instead of right after it starts. Given a number of milliseconds,
 *   this function creates its own `AbortController` and arms the timer
 *   immediately before the one `hook(...)` call, so the delay is measured
 *   from the start of the actual recall. Takes precedence over `callerSignal`
 *   when both are given.
 *
 *   NOTE: the `AbortSignal.timeout` patch this implies is a global,
 *   non-reentrant stub — it is installed and restored around one
 *   `hook(...)` call and is not safe for concurrent `runScenario` calls
 *   (with `callerSignal` or `abortAfterMs`) racing in the same process.
 * @returns {Promise<string|null>} the exact prependContext, or null when the
 *   handler returned undefined.
 */
export async function runScenario(scenario, { freezeClock: useFrozenClock = true, recallTimingSink = null, onTiming = null, hostEvents = null, embedderProbe = null, callerSignal = null, abortAfterMs = null } = {}) {
  const topics = new Map(Object.entries(scenario.topics || {}));
  const topicOf = (text) => topics.get(String(text)) ?? String(text);
  const previousHome = process.env.OPENCLAW_HOME;
  // Every global mutation and every temp dir is installed inside the `try`, with
  // its handle declared out here, so a throw at any point still unwinds all of
  // them. Installing before the `try` would leak globalThis.Date into the rest
  // of the process if a mkdtempSync failed.
  /** @type {(() => void)|null} */
  let restoreClock = null;
  let baseDbPath = "";
  let workspaceDir = "";
  let stateDir = "";
  try {
    const setupStartedAt = performance.now();
    baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-golden-db-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-golden-ws-"));
    stateDir = mkdtempSync(join(tmpdir(), "plur1bus-golden-state-"));
    process.env.OPENCLAW_HOME = stateDir;
    restoreClock = useFrozenClock ? freezeClock() : () => {};
    const engineEmbeddings = stubProvider(topicOf, { hang: scenario.hangEmbedder === true, probe: embedderProbe });
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    if (scenario.startNotice) writePlur1busStartNotice(stateDir, { text: scenario.startNotice });
    if (scenario.knowledge) {
      const knowledgePath = join(workspaceDir, "memory", "KNOWLEDGE.md");
      writeFileSync(knowledgePath, scenario.knowledge);
      // A canonical KNOWLEDGE.md hit has no row of its own, so its age comes
      // from the file's mtime (`knowledgeMtimeMs`, lib/recall-pipeline.js:902).
      // freezeClock cannot reach the filesystem, so pin the mtime too or the
      // canonical record's created-at is real wall-clock time.
      const frozenSeconds = FROZEN_NOW / 1000;
      utimesSync(knowledgePath, frozenSeconds, frozenSeconds);
    }
    const db = new MemoryDB(join(baseDbPath, scenario.agentId), VECTOR_DIM);
    for (const memory of scenario.memories) {
      await db.store({
        id: memory.id,
        text: memory.text,
        summary: memory.summary,
        vector: topicVector(topicOf(memory.text)),
        category: memory.category,
        createdAt: FROZEN_NOW - (memory.ageDays ?? 1) * 86_400_000,
        storedBy: scenario.agentId,
        workspaceKey: scenario.workspaceKey,
      });
    }
    const api = makeApi(baseConfig(baseDbPath, scenario.config), recallTimingSink);
    plugin.register(api, { importRouting: async () => routingCapability, ...(hostEvents ? { hostEvents } : {}), engineInternals: { embeddings: engineEmbeddings } });
    const hooks = api.handlers.get("before_prompt_build");
    const hook = hooks?.at(-1);
    if (typeof hook !== "function") throw new Error(`${scenario.name}: before_prompt_build not registered`);
    const setupMs = performance.now() - setupStartedAt;
    const recallStartedAt = performance.now();
    let restoreAbortTimeout = null;
    // abortAfterMs arms its timer here, immediately before hook(...), not
    // when runScenario was called — so the delay is measured from the start
    // of the actual recall, not from before this function's own setup work
    // (fix round 3).
    const effectiveCallerSignal = abortAfterMs !== null
      ? (() => {
          const controller = new AbortController();
          setTimeout(() => controller.abort(), abortAfterMs);
          return controller.signal;
        })()
      : callerSignal;
    if (effectiveCallerSignal) {
      const originalTimeout = AbortSignal.timeout;
      AbortSignal.timeout = () => effectiveCallerSignal;
      restoreAbortTimeout = () => { AbortSignal.timeout = originalTimeout; };
    }
    let result;
    try {
      result = await hook(scenario.event, { ...scenario.ctx, workspaceDir });
    } finally {
      restoreAbortTimeout?.();
    }
    const recallMs = performance.now() - recallStartedAt;
    for (const stop of api.handlers.get("gateway_stop") || []) await stop();
    onTiming?.({ setupMs, recallMs, totalMs: setupMs + recallMs });
    return result?.prependContext ?? null;
  } finally {
    if (previousHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousHome;
    restoreClock?.();
    if (baseDbPath) rmSync(baseDbPath, { recursive: true, force: true });
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  }
}
