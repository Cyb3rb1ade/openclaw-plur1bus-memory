// Capture-Pfad: Principal im verzoegerten Light-Traum, Watermark je Session,
// monotones Watermark, Tombstone-blockierte Items (Audit capture-dedupe F1-F4).
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createEngine } from "../engine/create-engine.js";
import { internalsOf } from "../engine/internals.js";
import { createStubHost } from "../lib/host-services.js";
import { createPostTurnWorkers, postTurnContext } from "../engine/capture/post-turn-work.js";
import { createNeoStore } from "../lib/neo-arch.js";
import { SESSION_WATERMARK_CAP, planLegacyWatermarkClaim, planWatermarkAdvance, planWatermarkFailure, readSessionWatermark } from "../lib/episode-watermark.js";
import { appendTombstoneToRegistry, buildTombstone, tombstoneRegistryDir } from "../lib/tombstone.js";
import { POST_TURN_QUEUE_DIR } from "../lib/post-turn-queue.js";
import { flatEmbedder, principal, USER_PRINCIPAL } from "./helpers/shared-workspace-engine.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const AGENT = "agent-a";
const OTHER_USER = `user:v1:${"b".repeat(64)}`;

function rig({ capability = true, llm } = {}) {
  const stateDir = makeTempDir("cap-pw-state-");
  const baseDbPath = join(makeTempDir("cap-pw-root-"), "lancedb-namespaced");
  const workspace = join(stateDir, "workspaces", "main");
  mkdirSync(workspace, { recursive: true });
  const host = createStubHost({
    stateDir,
    workspaceDir: async () => workspace,
    capabilities: { postTurnRefineScheduled: capability },
    runtime: { llm: llm || { async complete() { return { text: "[]", provider: "test", model: "test", usage: {} }; } } },
  });
  const engine = createEngine(host, {
    baseDbPath,
    embedding: { provider: "local-transformers", local: { dimensions: 384 } },
    autoCapture: true,
    autoRecall: false,
    neo: { enabled: true },
    gc: { enabled: false },
    obsidianBridge: { enabled: false },
    merging: { enabled: true },
    dreaming: { enabled: false },
    skillMiner: { enabled: false },
    temporalContext: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    reranker: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 },
    duplicateThreshold: 1.01,
  }, { internals: { embeddings: flatEmbedder(), reranker: null } });
  return { engine, baseDbPath, internals: internalsOf(engine), workspace };
}

function messages(prefix, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(i % 2 === 0
      ? { role: "user", content: `${prefix} question ${i}: please remember that the ${prefix} project milestone ${i} is due next quarter.` }
      : { role: "assistant", content: `${prefix} answer ${i}: noted, milestone ${i} of the ${prefix} project is due next quarter.` });
  }
  return out;
}

const turnOf = (sessionKey, msgs, who = principal(AGENT, { user: USER_PRINCIPAL })) => ({
  agentId: AGENT,
  principal: who,
  agent: { origin: "user", background: false },
  messages: msgs,
  sessionKey,
  runId: `run-${sessionKey}-${msgs.length}`,
  incognito: false,
  signal: AbortSignal.timeout(20_000),
});

function queueEntries(baseDbPath, agentId = AGENT) {
  const dir = join(baseDbPath, POST_TURN_QUEUE_DIR, agentId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe("F1: deferred light dream keeps the Principal", () => {
  it("writes a proved user's deferred dream at user scope, as the inline path does", async () => {
    const f = rig();
    try {
      const outcome = await f.engine.capture(turnOf("agent:agent-a:dm-u1", messages("alpha", 4)), { deferPostTurnLlm: true }).done;
      assert.ok(outcome.stored >= 1, JSON.stringify(outcome));
      const [entry] = queueEntries(f.baseDbPath);
      assert.ok(entry?.lightDream, "light dream was deferred");
      const drained = await f.engine.jobs.run("post-turn-refine", AGENT);
      assert.equal(drained.outcome, "completed");
      const dreams = createNeoStore(f.internals.neoRoot, entry.neoWorkspaceKey, { readOnly: true }).readDreams(10).filter((d) => d.type === "light_dream");
      assert.equal(dreams.length, 1);
      assert.equal(dreams[0].visibility.scope, "user");
      assert.equal(dreams[0].visibility.ownerUserId, USER_PRINCIPAL);
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });

  it("counter-test: an inferred principal still defers to workspace scope", async () => {
    const f = rig();
    try {
      await f.engine.capture(turnOf("agent:agent-a:dm-anon", messages("beta", 4), { ...principal(AGENT), trust: "inferred" }), { deferPostTurnLlm: true }).done;
      const [entry] = queueEntries(f.baseDbPath);
      await f.engine.jobs.run("post-turn-refine", AGENT);
      const dreams = createNeoStore(f.internals.neoRoot, entry.neoWorkspaceKey, { readOnly: true }).readDreams(10).filter((d) => d.type === "light_dream");
      assert.equal(dreams.length, 1);
      assert.equal(dreams[0].visibility.scope, "workspace");
      assert.equal(dreams[0].visibility.ownerUserId, "");
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });

  it("serializes the principal as the stable user hash, without the raw user id or message text", () => {
    const memoryCtx = Object.freeze({ agentId: AGENT, workspaceIdentity: "workspace:v1:main", workspaceId: "workspace:v1:main", userId: "raw-user-42", userPrincipal: USER_PRINCIPAL, channel: "telegram", accountId: "default", chatId: "c1", chatKind: "private", trust: "proved" });
    const ctx = postTurnContext({ workspaceDir: "/w", sessionKey: "s" }, memoryCtx);
    assert.equal(ctx.principal.user, USER_PRINCIPAL);
    assert.equal(ctx.principal.trust, "proved");
    assert.equal(JSON.stringify(ctx).includes("raw-user-42"), false);
    assert.equal("principal" in postTurnContext({ workspaceDir: "/w" }), false, "adapter entries stay as before");
  });

  describe("worker identity", () => {
    function workers() {
      const dreams = [];
      const deps = {
        embeddings: { embed: async () => [], embedQuery: async () => [] }, conversationInsightsLlmCfg: {}, dreamNarrativeLlmCfg: {}, dreamEchoLlmCfg: {}, personaVoiceLlmCfg: {},
        skillMinerEnabled: false, mergingEnabled: true, callLlm: async () => { throw new Error("no llm"); },
        logger: { info() {}, warn() {}, debug() {} }, dreamNarrativeCfg: { enabled: false }, resolveTemperamentName: () => "x",
        cfg: { personaVoice: { enabled: false } }, memoryWorkspaceAliases: undefined, baseDbPath: makeTempDir("cap-pw-w-"), emotionalPool: { describe: () => null }, episodeExtractionLlmCfg: {},
      };
      const neoStore = { appendDreams: (items) => dreams.push(...items), recordHook() {}, readReactions: () => [] };
      const db = { table: null, async search() { return []; } };
      const turns = ["a", "b", "c"].map((c, i) => ({ id: `t${i}`, role: i % 2 ? "assistant" : "user", content: `message ${c} with some text`, agentId: AGENT, workspaceKey: "workspace:v1:main", createdAt: new Date().toISOString() }));
      return { run: (extra) => createPostTurnWorkers(deps).runLightDreamPostTurn({ agentId: AGENT, neoStore, db, normalizedTurns: turns, digestHash: "d", ...extra }), dreams };
    }
    const proved = { agentId: AGENT, channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, user: USER_PRINCIPAL, trust: "proved" };

    it("a queued proved principal yields user scope", async () => {
      const w = workers();
      assert.equal(await w.run({ ctx: { workspaceDir: makeTempDir("cap-pw-ws-"), principal: proved } }), true);
      assert.deepEqual([w.dreams[0].visibility.scope, w.dreams[0].visibility.ownerUserId], ["user", USER_PRINCIPAL]);
    });

    it("a queued principal that cannot be rebuilt is never widened to workspace scope", async () => {
      const w = workers();
      assert.equal(await w.run({ ctx: { workspaceDir: makeTempDir("cap-pw-ws-"), channel: "telegram", accountId: "default", userId: "u", principal: { ...proved, agentId: "../bad" } } }), true);
      assert.equal(w.dreams[0].visibility.scope, "agent_private");
      assert.equal(w.dreams[0].visibility.ownerUserId, "");
    });

    it("counter-test: an adapter entry without a principal still resolves from the hook-context fields", async () => {
      const w = workers();
      await w.run({ ctx: { workspaceDir: makeTempDir("cap-pw-ws-"), userId: "u1", channel: "telegram", accountId: "default" } });
      assert.equal(w.dreams[0].visibility.scope, "user");
    });
  });
});


describe("F4: a tombstone-blocked item does not make the turn capture-incomplete", () => {
  const FORGOTTEN = "Please remember the old vault door code is hunter2 for the archive room.";
  const forget = (baseDbPath, text) => appendTombstoneToRegistry(baseDbPath, AGENT, buildTombstone({
    card: { id: randomUUID(), text, scope: "agent-private", storedBy: AGENT }, agentId: AGENT, actor: "owner", sourceOp: "forget",
  }));

  it("an all-blocked turn is recorded as handled, so a replay does not rerun the pipeline", async () => {
    const f = rig({ capability: false });
    try {
      forget(f.baseDbPath, FORGOTTEN);
      const t = turnOf("agent:agent-a:dm-f4", [{ role: "user", content: FORGOTTEN }]);
      const first = await f.engine.capture(t).done;
      assert.equal(first.stored, 0);
      assert.equal(first.reason, undefined, JSON.stringify(first));
      assert.ok(first.skipped >= 1, "the blocked item is counted as skipped");
      const replay = await f.engine.capture(t).done;
      assert.equal(replay.reason, "duplicate-turn", "the replay guard recorded the turn");
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });

  it("counter-test: other items of the same turn are still stored", async () => {
    const f = rig({ capability: false });
    try {
      forget(f.baseDbPath, FORGOTTEN);
      const outcome = await f.engine.capture(turnOf("agent:agent-a:dm-f4b", [
        { role: "user", content: FORGOTTEN },
        { role: "assistant", content: "Understood, I will remember the release freeze begins two days earlier." },
      ])).done;
      assert.ok(outcome.stored >= 1, JSON.stringify(outcome));
      assert.equal(outcome.reason, undefined, JSON.stringify(outcome));
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });

  it("counter-test: an unreadable tombstone registry still fails closed and keeps the turn incomplete", async () => {
    const f = rig({ capability: false });
    try {
      forget(f.baseDbPath, "something else entirely that was forgotten earlier on.");
      appendFileSync(join(tombstoneRegistryDir(f.baseDbPath), `${AGENT}.jsonl`), "{not json at all}\n");
      const outcome = await f.engine.capture(turnOf("agent:agent-a:dm-f4c", [{ role: "user", content: FORGOTTEN }])).done;
      assert.equal(outcome.stored, 0);
      assert.equal(outcome.reason, "capture-incomplete", JSON.stringify(outcome));
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });
});


const entriesFor = (f) => queueEntries(f.baseDbPath);
const lastEntry = (f) => entriesFor(f).at(-1);

describe("F2: the watermark is kept per session", () => {
  it("a second session in the same workspace is processed from its own start", async () => {
    const f = rig();
    try {
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 6)), { deferPostTurnLlm: true }).done;
      await settle();
      await f.engine.capture(turnOf("agent:agent-a:group", messages("group", 10)), { deferPostTurnLlm: true }).done;
      assert.deepEqual(entriesFor(f).map((e) => e.turns.length), [6, 10], "the group session's first 6 messages must not be skipped");
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });

  it("a shorter second session is not reprocessed from scratch against the first session's mark, and the first is not replayed", async () => {
    const f = rig();
    try {
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 8)), { deferPostTurnLlm: true }).done;
      await settle();
      await f.engine.capture(turnOf("agent:agent-a:group", messages("group", 4)), { deferPostTurnLlm: true }).done;
      await settle();
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 10)), { deferPostTurnLlm: true }).done;
      assert.deepEqual(entriesFor(f).map((e) => e.turns.length), [8, 4, 2], "dm continues at 8, not at the group's 4");
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });

  it("counter-test: one session still advances incrementally and resets after a compaction", async () => {
    const f = rig();
    try {
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 4)), { deferPostTurnLlm: true }).done;
      await settle();
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 8)), { deferPostTurnLlm: true }).done;
      await settle();
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("compacted", 6)), { deferPostTurnLlm: true }).done;
      assert.deepEqual(entriesFor(f).map((e) => e.turns.length), [4, 4, 6]);
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });

  it("migration: the first session after the upgrade inherits the old workspace mark, later and new sessions do not", async () => {
    const f = rig();
    try {
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 4)), { deferPostTurnLlm: true }).done;
      await settle();
      const store = createNeoStore(f.internals.neoRoot, lastEntry(f).neoWorkspaceKey);
      // The state an installation had before this change: only the old counter.
      store.recordHook("agent_end", { sessionWatermarks: undefined, lastProcessedMessageCount: 4, postProcessingFailures: 0 });
      assert.equal(store.readHooks().agent_end.sessionWatermarks, undefined);

      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 6)), { deferPostTurnLlm: true }).done;
      await settle();
      assert.equal(lastEntry(f).turns.length, 2, "nothing already processed is processed twice");
      await f.engine.capture(turnOf("agent:agent-a:fresh", messages("fresh", 3)), { deferPostTurnLlm: true }).done;
      assert.equal(lastEntry(f).turns.length, 3, "a new session does not inherit the old mark");
    } finally { await f.engine.close({ budgetMs: 5000 }); }
  });
});

describe("F3: the watermark never moves backwards", () => {
  it("a slow older post-processing run cannot overwrite a younger turn's watermark", async () => {
    let holding = true;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const held = [];
    const llm = { async complete() {
      if (holding) { const p = gate; held.push(p); await p; }
      return { text: "[]", provider: "test", model: "test", usage: {} };
    } };
    const f = rig({ llm });
    try {
      // Turn A: its light dream and episode LLM calls hang.
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 4)), { deferPostTurnLlm: false }).done;
      holding = false;
      // Turn B overtakes it: it reads the old mark (0) and finishes first.
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 8)), { deferPostTurnLlm: false }).done;
      await settle(400);
      holding = false;
      assert.ok(held.length > 0, "turn A's post-processing was held");
      release();
      await settle(400);
      // Turn C must start after B's mark (8), not at A's stale 4.
      await f.engine.capture(turnOf("agent:agent-a:dm", messages("dm", 12)), { deferPostTurnLlm: true }).done;
      assert.equal(lastEntry(f).turns.length, 4);
    } finally { release(); await f.engine.close({ budgetMs: 5000 }); }
  });
});

describe("watermark planning (pure)", () => {
  const advance = (agentEnd, to, baseline, key = "dm") => ({ ...agentEnd, ...planWatermarkAdvance(agentEnd, key, { baseline, to }) });

  it("advances, and ignores a stale writer whose baseline is gone and whose target is lower", () => {
    const afterB = advance({}, 24, 10);
    assert.equal(readSessionWatermark(afterB, "dm").count, 24);
    assert.equal(planWatermarkAdvance(afterB, "dm", { baseline: 10, to: 20 }), null);
    assert.equal(readSessionWatermark(advance(afterB, 28, 24), "dm").count, 28);
  });

  it("a younger turn's higher target wins even when it finishes after an older one", () => {
    const afterOlder = advance({}, 20, 10);
    assert.equal(readSessionWatermark(advance(afterOlder, 24, 10), "dm").count, 24);
  });

  it("allows the reset after a compaction only from the baseline the turn read", () => {
    const state = advance({}, 274, 0);
    assert.equal(readSessionWatermark(advance(state, 221, 274), "dm").count, 221);
    assert.equal(planWatermarkAdvance(state, "dm", { baseline: 100, to: 50 }), null);
  });

  it("keeps sessions apart and mirrors the latest value for older versions", () => {
    const state = advance(advance({}, 30, 0, "dm"), 50, 0, "group");
    assert.deepEqual([readSessionWatermark(state, "dm").count, readSessionWatermark(state, "group").count], [30, 50]);
    assert.equal(state.lastProcessedMessageCount, 50);
    assert.equal(readSessionWatermark(state, "__proto__").known, false);
  });

  it("counts failures only while the watermark still sits where the turn read it", () => {
    const state = advance({}, 10, 0);
    assert.equal(readSessionWatermark({ ...state, ...planWatermarkFailure(state, "dm", { baseline: 10, failures: 2 }) }, "dm").failures, 2);
    assert.equal(planWatermarkFailure(state, "dm", { baseline: 4, failures: 2 }), null);
  });

  it("claims the legacy counter exactly once, only while no session has an entry", () => {
    const legacy = { lastProcessedMessageCount: 30, postProcessingFailures: 2 };
    const claimed = { ...legacy, ...planLegacyWatermarkClaim(legacy, "dm") };
    assert.deepEqual(readSessionWatermark(claimed, "dm"), { key: "s:dm", known: true, count: 30, failures: 2 });
    assert.equal(planLegacyWatermarkClaim(claimed, "group"), null);
    assert.equal(planLegacyWatermarkClaim({}, "dm"), null);
    assert.equal(planLegacyWatermarkClaim({ lastProcessedMessageCount: 0 }, "dm"), null);
  });

  it("bounds the number of session entries and drops the oldest", () => {
    let state = {};
    for (let i = 0; i < SESSION_WATERMARK_CAP + 5; i += 1) {
      state = { ...state, ...planWatermarkAdvance(state, `s${i}`, { baseline: 0, to: 1 }) };
      state.sessionWatermarks[`s:s${i}`].at = new Date(1_700_000_000_000 + i).toISOString();
    }
    assert.equal(Object.keys(state.sessionWatermarks).length, SESSION_WATERMARK_CAP);
    assert.equal(readSessionWatermark(state, "s0").known, false);
    assert.equal(readSessionWatermark(state, `s${SESSION_WATERMARK_CAP + 4}`).known, true);
  });

  it("recordHook runs a patch function under the lock and skips the write on null", () => {
    const store = createNeoStore(makeTempDir("cap-pw-neo-"), "ws");
    store.recordHook("agent_end", { lastProcessedMessageCount: 5 });
    const before = store.readHooks().agent_end;
    assert.deepEqual(store.recordHook("agent_end", () => null), before);
    assert.deepEqual(store.readHooks().agent_end, before, "a null patch writes nothing");
    store.recordHook("agent_end", (prev) => ({ lastProcessedMessageCount: prev.lastProcessedMessageCount + 1 }));
    assert.equal(store.readHooks().agent_end.lastProcessedMessageCount, 6);
  });
});
